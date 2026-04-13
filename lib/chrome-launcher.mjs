/**
 * Chrome for Testing 启动器。
 *
 * 默认只使用 Playwright 提供的 Chrome for Testing。
 * 如果需要其他可执行文件，必须显式通过 CHROME_PATH 指定，
 * 不会再自动回退到本机安装的稳定版浏览器：
 *   - 随机可用端口
 *   - 支持外部传入 userDataDir（用于 profile-manager 持久化）
 *   - 反检测参数 + CDP 页面级注入
 *
 * 环境变量:
 *   CHROME_PATH=<path>  - 显式指定浏览器可执行文件路径
 */

import { createServer } from 'node:net';
import { execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ANTI_DETECT_ARGS, ANTI_DETECT_INIT_SCRIPT } from './anti-detect.mjs';
import { writeStderr } from './logger.mjs';

const CHROME_READY_TIMEOUT_MS = 15000;
const MAX_CHROME_OUTPUT_CHARS = 4000;
/**
 * 获取一个随机可用端口。
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * 轮询 Chrome DevTools /json/version 直到就绪。
 * @param {number} port
 * @param {number} [timeoutMs=15000]
 */
async function waitForChrome(port, timeoutMs = CHROME_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/json/version`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome did not become ready on port ${port} within ${timeoutMs}ms`);
}

function resolveChromeExecutablePath() {
  const candidates = [];

  if (process.env.CHROME_PATH) {
    candidates.push(process.env.CHROME_PATH);
  }

  try {
    const playwrightPath = chromium.executablePath();
    if (playwrightPath) {
      candidates.push(playwrightPath);
    }
  } catch {
    // Playwright executablePath 失败时继续检查显式传入的 CHROME_PATH
  }

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  const found = uniqueCandidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `No allowed Chrome executable found. Checked: ${uniqueCandidates.join(', ') || 'none'}. ` +
      `Install Playwright browsers or set CHROME_PATH explicitly.`,
    );
  }

  return found;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergePrefs(base, extra) {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergePrefs(result[key], value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function seedChromeProfile(userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(join(userDataDir, 'Default'), { recursive: true });

  const localStatePath = join(userDataDir, 'Local State');
  const preferencesPath = join(userDataDir, 'Default', 'Preferences');
  const firstRunPath = join(userDataDir, 'First Run');

  const localState = mergePrefs(readJsonFile(localStatePath), {
    browser: {
      enabled_labs_experiments: [],
      has_seen_welcome_page: true,
    },
    privacy_sandbox: {
      m1: {
        consent_decision_made: true,
        row_notice_acknowledged: true,
        eea_notice_acknowledged: true,
      },
    },
  });

  const preferences = mergePrefs(readJsonFile(preferencesPath), {
    autofill: {
      credit_card_enabled: false,
      profile_enabled: false,
    },
    browser: {
      check_default_browser: false,
      has_seen_welcome_page: true,
      show_home_button: false,
    },
    credentials_enable_service: false,
    distribution: {
      import_bookmarks: false,
      import_history: false,
      import_search_engine: false,
      make_chrome_default: false,
      skip_first_run_ui: true,
      suppress_first_run_bubble: true,
    },
    password_manager_enabled: false,
    profile: {
      avatar_bubble_tutorial_shown: true,
      default_content_setting_values: {
        notifications: 2,
      },
      password_manager_enabled: false,
      password_manager_leak_detection: false,
    },
    safebrowsing: {
      enabled: false,
      enhanced: false,
      scout_reporting_enabled: false,
    },
    signin: {
      allowed: false,
    },
  });

  writeFileSync(localStatePath, JSON.stringify(localState, null, 2));
  writeFileSync(preferencesPath, JSON.stringify(preferences, null, 2));
  writeFileSync(firstRunPath, '');
}

function clearStaleSingletonArtifacts(userDataDir) {
  const staleEntries = [
    'SingletonCookie',
    'SingletonLock',
    'SingletonSocket',
    'RunningChromeVersion',
  ];

  for (const entry of staleEntries) {
    try {
      rmSync(join(userDataDir, entry), { force: true, recursive: true });
    } catch {
      // best effort
    }
  }
}

/**
 * 通过 CDP 注入反检测脚本到所有现有页面。
 * 使用 Page.addScriptToEvaluateOnNewDocument 确保后续导航也会自动执行。
 *
 * @param {number} port
 */
async function injectAntiDetectViaCDP(port) {
  try {
    // 获取所有 page targets
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) return;
    const targets = await res.json();
    const pages = targets.filter((t) => t.type === 'page');

    for (const page of pages) {
      const wsUrl = page.webSocketDebuggerUrl;
      if (!wsUrl) continue;

      try {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
          setTimeout(() => reject(new Error('ws timeout')), 3000);
        });

        let msgId = 1;
        const send = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = msgId++;
            const handler = (evt) => {
              const data = JSON.parse(typeof evt === 'string' ? evt : evt.data);
              if (data.id === id) {
                ws.removeEventListener('message', handler);
                if (data.error) reject(new Error(data.error.message));
                else resolve(data.result);
              }
            };
            ws.addEventListener('message', handler);
            ws.send(JSON.stringify({ id, method, params }));
          });

        // 注入 addScriptToEvaluateOnNewDocument — 后续导航自动执行
        await send('Page.addScriptToEvaluateOnNewDocument', { source: ANTI_DETECT_INIT_SCRIPT });

        // 立即在当前页面执行一次
        await send('Runtime.evaluate', {
          expression: ANTI_DETECT_INIT_SCRIPT,
          returnByValue: false,
        }).catch(() => {}); // best effort

        ws.close();
      } catch {
        // 单个页面注入失败不影响整体
      }
    }
    writeStderr(`[chrome-launcher] Anti-detect injected into ${pages.length} page(s)\n`);
  } catch (err) {
    writeStderr(`[chrome-launcher] CDP injection warning: ${err.message}\n`);
  }
}

/**
 * 启动 Chrome for Testing 实例。
 *
 * Chrome 生命周期由 profile-manager 管理，此函数不负责 cleanup。
 *
 * @param {{ headless?: boolean, extraArgs?: string[], userDataDir: string }} opts
 * @returns {Promise<{
 *   port: number,
 *   process: import('child_process').ChildProcess,
 *   versionInfo: object,
 *   onExit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => () => void,
 *   onError: (listener: (err: Error) => void) => () => void,
 * }>}
 */
export async function launchChrome({ headless = true, extraArgs = [], userDataDir } = {}) {
  const port = await getFreePort();
  const execPath = resolveChromeExecutablePath();
  seedChromeProfile(userDataDir);
  clearStaleSingletonArtifacts(userDataDir);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    headless ? '--headless=new' : '',
    ...ANTI_DETECT_ARGS,
    ...extraArgs,
  ].filter(Boolean);

  writeStderr(`[chrome-launcher] Launching browser from ${execPath}\n`);

  // 在启动 Chrome 前记录当前前台应用（仅非 headless 模式需要）
  let previousFrontmostApp = null;
  if (!headless && process.platform === 'darwin') {
    try {
      previousFrontmostApp = execSync(
        'osascript -e \'tell application "System Events" to get name of first process whose frontmost is true\'',
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();
      writeStderr(`[chrome-launcher] Previous frontmost app: ${previousFrontmostApp}\n`);
    } catch {
      // best effort — 如果获取失败就跳过切回逻辑
    }
  }

  const child = spawn(execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let stdoutTail = '';
  let stderrTail = '';
  let ready = false;
  /** @type {{ code: number | null, signal: NodeJS.Signals | null } | null} */
  let exitInfo = null;
  /** @type {Error | null} */
  let errorInfo = null;
  /** @type {Set<(code: number | null, signal: NodeJS.Signals | null) => void>} */
  const exitListeners = new Set();
  /** @type {Set<(err: Error) => void>} */
  const errorListeners = new Set();

  const collectTail = (current, chunk) => {
    const next = `${current}${chunk}`;
    if (next.length <= MAX_CHROME_OUTPUT_CHARS) {
      return next;
    }
    return next.slice(-MAX_CHROME_OUTPUT_CHARS);
  };

  // 将 Chrome stderr/stdout 写到我们的 stderr（不干扰 MCP stdio）
  child.stdout?.on('data', (d) => {
    const text = d.toString();
    stdoutTail = collectTail(stdoutTail, text);
    writeStderr(d);
  });
  child.stderr?.on('data', (d) => {
    const text = d.toString();
    stderrTail = collectTail(stderrTail, text);
    writeStderr(d);
  });

  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };

    if (!ready) {
      for (const listener of exitListeners) {
        listener(code, signal);
      }
      exitListeners.clear();
      return;
    }

    writeStderr(`[chrome-launcher] Chrome exited with code ${code}\n`);
    for (const listener of exitListeners) {
      listener(code, signal);
    }
    exitListeners.clear();
  });

  child.once('error', (err) => {
    errorInfo = err;
    for (const listener of errorListeners) {
      listener(err);
    }
    errorListeners.clear();
  });

  const exitBeforeReady = new Promise((_, reject) => {
    child.once('error', (err) => {
      reject(new Error(`Chrome process error before ready: ${err.message}`));
    });
    child.once('exit', (code, signal) => {
      if (ready) {
        return;
      }
      const details = [stderrTail.trim(), stdoutTail.trim()].filter(Boolean).join('\n');
      reject(new Error(`Chrome exited before ready (code=${code}, signal=${signal || 'none'})${details ? `\n${details}` : ''}`));
    });
  });

  let versionInfo;
  try {
    versionInfo = await Promise.race([
      waitForChrome(port, CHROME_READY_TIMEOUT_MS),
      exitBeforeReady,
    ]);
  } catch (err) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    const details = [stderrTail.trim(), stdoutTail.trim()].filter(Boolean).join('\n');
    if (details && !String(err.message).includes(details)) {
      throw new Error(`${err.message}\n${details}`);
    }
    throw err;
  }

  ready = true;
  writeStderr(`[chrome-launcher] Chrome ready on port ${port}\n`);

  // 注入反检测脚本到现有页面
  await injectAntiDetectViaCDP(port);

  // Chrome 启动完成后，切回之前的前台应用（不打断开发者工作流）
  if (previousFrontmostApp) {
    try {
      execSync(
        `osascript -e 'tell application "${previousFrontmostApp.replace(/'/g, "'")}" to activate'`,
        { encoding: 'utf-8', timeout: 3000 },
      );
      writeStderr(`[chrome-launcher] Restored focus to ${previousFrontmostApp}\n`);
    } catch (err) {
      writeStderr(`[chrome-launcher] Failed to restore focus: ${err.message}\n`);
    }
  }

  return {
    port,
    process: child,
    versionInfo,
    onExit(listener) {
      if (exitInfo) {
        queueMicrotask(() => listener(exitInfo.code, exitInfo.signal));
        return () => {};
      }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onError(listener) {
      if (errorInfo) {
        queueMicrotask(() => listener(errorInfo));
        return () => {};
      }
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };
}

/**
 * 获取反检测 init script 内容（供 chrome-devtools-mcp 的 initScript 使用）。
 */
export { ANTI_DETECT_INIT_SCRIPT };
