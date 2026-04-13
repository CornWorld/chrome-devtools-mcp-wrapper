/**
 * Chrome 进程复用管理器 — 基于 profile 隔离。
 *
 * 目录结构:
 *   ~/.cache/cdp-wrapper/<profile>/
 *     ├── .lock/           # mkdir 原子锁目录
 *     │   └── holder       # { pid, time }
 *     ├── chrome.lock      # Chrome 实例信息 + 客户端列表
 *     └── user-data/       # Chrome userDataDir（持久化）
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger.mjs';

const logger = createLogger('profile');

const CACHE_ROOT = join(homedir(), '.cache', 'cdp-wrapper');
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10000;
const LOCK_HEARTBEAT_MS = 1000;

/**
 * 检测 PID 是否存活。
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检测 Chrome 端口是否可响应。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function isPortResponding(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    const ok = res.ok;
    logger.debug(`Port check result: ${port}`, { ok });
    return ok;
  } catch (err) {
    logger.debug(`Port check failed: ${port}`, { error: err.message });
    return false;
  }
}


/**
 * 获取 profile 目录路径。
 * @param {string} profile
 */
function profileDir(profile) {
  return join(CACHE_ROOT, profile);
}

/**
 * 确保 profile 目录结构存在。
 * @param {string} dir
 */
function ensureProfileDir(dir) {
  mkdirSync(join(dir, 'user-data'), { recursive: true });
}

function clearSingletonArtifacts(userDataDir) {
  for (const entry of ['SingletonCookie', 'SingletonLock', 'SingletonSocket', 'RunningChromeVersion']) {
    try {
      rmSync(join(userDataDir, entry), { force: true, recursive: true });
    } catch {
      // best effort
    }
  }
}

// ==================== 文件锁 ====================

/**
 * 获取文件锁（mkdir 原子操作）。
 * @param {string} dir profile 目录
 * @param {number} [timeoutMs]
 */
async function acquireLock(dir, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockDir = join(dir, '.lock');
  const holderFile = join(lockDir, 'holder');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      // 写入 holder 信息
      writeHolderFile(holderFile);
      const heartbeat = startLockHeartbeat(holderFile);
      return () => releaseLock(dir, heartbeat);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // 锁已被持有 — 检查是否 stale
      try {
        const holder = JSON.parse(readFileSync(holderFile, 'utf-8'));
        const holderAlive = isPidAlive(holder.pid);
        const isStale = !holderAlive;
        if (isStale) {
          logger.warn(`Stale lock detected, force clearing`, { pid: holder.pid, age: Date.now() - holder.time });
          rmSync(lockDir, { recursive: true, force: true });
          continue; // 重试
        }
        logger.debug(`Lock held by live process, waiting`, { pid: holder.pid, age: Date.now() - holder.time });
      } catch {
        // holder 文件读取失败，强制清除
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Failed to acquire lock for profile dir: ${dir} (timeout ${timeoutMs}ms, stale threshold ${LOCK_STALE_MS}ms)`);
}

/**
 * 释放文件锁。
 * @param {string} dir profile 目录
 */
function releaseLock(dir, heartbeat) {
  if (heartbeat) {
    clearInterval(heartbeat);
  }
  rmSync(join(dir, '.lock'), { recursive: true, force: true });
}

function writeHolderFile(holderFile) {
  writeFileSync(holderFile, JSON.stringify({ pid: process.pid, time: Date.now() }));
}

function startLockHeartbeat(holderFile) {
  const timer = setInterval(() => {
    try {
      writeHolderFile(holderFile);
    } catch {
      // 锁目录被清掉时停止心跳，最终由 acquire/release 路径处理失败
      clearInterval(timer);
    }
  }, LOCK_HEARTBEAT_MS);
  timer.unref?.();
  return timer;
}

// ==================== chrome.lock 读写 ====================

/**
 * @typedef {{
 *   pid: number,
 *   port: number,
 *   headless: boolean,
 *   startTime: number,
 *   clients: Array<{ pid: number, startTime: number }>
 * }} ChromeLock
 */

/**
 * 读取 chrome.lock。
 * @param {string} dir
 * @returns {ChromeLock | null}
 */
function readChromeLock(dir) {
  const lockFile = join(dir, 'chrome.lock');
  try {
    return JSON.parse(readFileSync(lockFile, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 写入 chrome.lock。
 * @param {string} dir
 * @param {ChromeLock} data
 */
function writeChromeLock(dir, data) {
  writeFileSync(join(dir, 'chrome.lock'), JSON.stringify(data, null, 2));
}

/**
 * 删除 chrome.lock。
 * @param {string} dir
 */
function deleteChromeLock(dir) {
  try {
    rmSync(join(dir, 'chrome.lock'), { force: true });
  } catch { /* best effort */ }
}

/**
 * 清理 clients 列表中已死的 PID。
 * @param {ChromeLock} lock
 * @returns {ChromeLock} 清理后的 lock
 */
function cleanDeadClients(lock) {
  lock.clients = lock.clients.filter((c) => isPidAlive(c.pid));
  return lock;
}

// ==================== 公开 API ====================

/**
 * 获取或复用一个 Chrome 实例。
 *
 * @param {string} profile  profile 名称
 * @param {{
 *   headless?: boolean,
 *   extraArgs?: string[],
 *   launchChrome: (opts: { headless: boolean, extraArgs: string[], userDataDir: string }) => Promise<{ port: number, process: import('child_process').ChildProcess }>
 * }} opts
 * @returns {Promise<{
 *   port: number,
 *   isNew: boolean,
 *   clientCount: number,
 *   chromeProcess?: import('child_process').ChildProcess,
 *   onChromeExit?: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => () => void,
 *   onChromeError?: (listener: (err: Error) => void) => () => void,
 * }>}
 */
export async function acquireChrome(profile, opts) {
  const dir = profileDir(profile);
  ensureProfileDir(dir);
  const userDataDir = join(dir, 'user-data');

  logger.lifecycle(`Acquiring Chrome`, { profile, headless: opts.headless, myPid: process.pid });

  const releaseProfileLock = await acquireLock(dir);
  try {
    let lock = readChromeLock(dir);

    if (lock) {
      logger.debug(`Existing lock found`, { pid: lock.pid, port: lock.port, clients: lock.clients.length });
      cleanDeadClients(lock);

      // 检测 Chrome 是否仍然活跃
      const chromeAlive = isPidAlive(lock.pid) && await isPortResponding(lock.port);
      logger.debug(`Chrome alive check`, { pid: lock.pid, alive: chromeAlive });

      if (chromeAlive) {
        // headless 模式冲突检测
        if (lock.headless !== (opts.headless ?? true)) {
          logger.warn(`Headless mode mismatch, reusing anyway`, { existing: lock.headless, requested: opts.headless ?? true });
        }

        // 加入 clients
        lock.clients.push({ pid: process.pid, startTime: Date.now() });
        writeChromeLock(dir, lock);
        logger.lifecycle(`Reusing existing Chrome`, { pid: lock.pid, port: lock.port, totalClients: lock.clients.length });
        return { port: lock.port, isNew: false, clientCount: lock.clients.length };
      }

      // Chrome 已死 — 清理旧 lock
      logger.warn(`Stale Chrome detected, launching new instance`, { oldPid: lock.pid, age: Date.now() - lock.startTime });
    }

    // 启动新 Chrome
    logger.lifecycle(`Launching new Chrome instance`, { userDataDir });
    const result = await opts.launchChrome({
      headless: opts.headless ?? true,
      extraArgs: opts.extraArgs || [],
      userDataDir,
    });

    const newLock = {
      pid: result.process.pid,
      port: result.port,
      headless: opts.headless ?? true,
      startTime: Date.now(),
      clients: [{ pid: process.pid, startTime: Date.now() }],
    };
    writeChromeLock(dir, newLock);

    logger.lifecycle(`New Chrome launched`, { pid: result.process.pid, port: result.port });
    return {
      port: result.port,
      isNew: true,
      clientCount: 1,
      chromeProcess: result.process,
      onChromeExit: result.onExit,
      onChromeError: result.onError,
    };
  } finally {
    releaseProfileLock();
  }
}

/**
 * 释放 Chrome 实例引用。引用计数归零时 kill Chrome。
 *
 * @param {string} profile
 * @returns {Promise<void>}
 */
export async function releaseChrome(profile) {
  const dir = profileDir(profile);
  if (!existsSync(dir)) {
    logger.warn(`Release requested but profile dir not found`, { profile });
    return;
  }

  logger.lifecycle(`Releasing Chrome`, { profile, myPid: process.pid });

  const releaseProfileLock = await acquireLock(dir);
  try {
    let lock = readChromeLock(dir);
    if (!lock) {
      logger.warn(`No lock found during release`, { profile });
      return;
    }

    // 移除自己的 PID
    const beforeCount = lock.clients.length;
    lock.clients = lock.clients.filter((c) => c.pid !== process.pid);
    const afterCount = lock.clients.length;
    cleanDeadClients(lock);
    const finalCount = lock.clients.length;

    logger.debug(`Client removed from lock`, { beforeCount, afterCount, finalCount, myPid: process.pid });

    if (lock.clients.length === 0) {
      // 最后一个客户端 — kill Chrome
      logger.lifecycle(`Last client, killing Chrome`, { pid: lock.pid });
      await killChrome(lock.pid);
      clearSingletonArtifacts(join(dir, 'user-data'));
      deleteChromeLock(dir);
      logger.lifecycle(`Chrome terminated and lock deleted`);
    } else {
      writeChromeLock(dir, lock);
      logger.lifecycle(`Released, clients remaining`, { count: lock.clients.length });
    }
  } finally {
    releaseProfileLock();
  }
}

/**
 * Kill Chrome 进程：先 SIGTERM，3s 后 SIGKILL。
 * @param {number} pid
 */
async function killChrome(pid) {
  if (!isPidAlive(pid)) {
    logger.debug(`Chrome already dead, no need to kill`, { pid });
    return;
  }

  logger.lifecycle(`Sending SIGTERM to Chrome`, { pid });

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    logger.debug(`SIGTERM failed`, { pid, error: err.message });
    return;
  }

  // 等待最多 3s
  const deadline = Date.now() + 3000;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      logger.lifecycle(`Chrome terminated gracefully`, { pid, attempts });
      return;
    }
    attempts++;
    await new Promise((r) => setTimeout(r, 200));
  }

  // 强制 kill
  logger.warn(`Chrome did not exit gracefully, sending SIGKILL`, { pid });
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    logger.debug(`SIGKILL also failed`, { pid });
  }
}
