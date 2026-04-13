/**
 * 简单的日志模块，自动按会话创建日志文件，并支持滚动与速率熔断。
 *
 * 环境变量:
 *   DEBUG=*                    - 启用所有调试日志
 *   DEBUG=wrapper:*            - 仅启用 wrapper 相关日志
 *   LOG_DIR=<path>             - 日志目录（默认 ~/.cache/cdp-wrapper/logs）
 *   LOG_MAX_BYTES=<bytes>      - 单个日志文件最大大小，默认 10485760（10 MiB）
 *   LOG_MAX_FILES=<count>      - 单次会话滚动保留文件数，默认 5
 *   LOG_RATE_LIMIT_COUNT=<n>   - 窗口内最多允许写入多少条日志，默认 200
 *   LOG_RATE_LIMIT_WINDOW_MS   - 速率窗口大小，默认 1000ms
 *   LOG_MESSAGE_BOX=<bool>     - 是否弹消息框，默认开启
 */

import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { showMessageBox } from './notifier.mjs';

/** @type {'DEBUG' | 'INFO' | 'WARN' | 'ERROR'} */
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/** @type {number} */
let currentLevel = LEVELS.INFO;

/** @type {string | null} */
let logFilePath = null;

/** @type {Set<string>} */
let debugPatterns = new Set();

let stderrDisabled = false;
let fileLoggingDisabled = false;
let loggingInterrupted = false;
let fileSizeBytes = 0;
let rateWindowStartedAt = 0;
let rateWindowCount = 0;
let rotationIndex = 0;

const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_LOG_FILES = 5;
const DEFAULT_RATE_LIMIT_COUNT = 200;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;
const MAX_META_VALUE_CHARS = 1000;
const LOG_DIR = process.env.LOG_DIR || join(homedir(), '.cache', 'cdp-wrapper', 'logs');
const MAX_LOG_BYTES = parseLogMaxBytes(process.env.LOG_MAX_BYTES);
const MAX_LOG_FILES = parsePositiveInteger(process.env.LOG_MAX_FILES, DEFAULT_MAX_LOG_FILES);
const RATE_LIMIT_COUNT = parsePositiveInteger(process.env.LOG_RATE_LIMIT_COUNT, DEFAULT_RATE_LIMIT_COUNT);
const RATE_LIMIT_WINDOW_MS = parsePositiveInteger(process.env.LOG_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS);
const SESSION_STAMP = buildSessionStamp();
const LOG_FILE_PATHS = [];

// 解析 DEBUG 环境变量
const debugEnv = process.env.DEBUG || '';
if (debugEnv === '*' || debugEnv === '1' || debugEnv === 'true') {
  currentLevel = LEVELS.DEBUG;
  debugPatterns.add('*');
} else if (debugEnv) {
  currentLevel = LEVELS.DEBUG;
  debugEnv.split(',').forEach((p) => debugPatterns.add(p.trim()));
}

if (typeof process.stderr?.on === 'function') {
  process.stderr.on('error', (err) => {
    if (isBrokenStreamError(err)) {
      stderrDisabled = true;
    }
  });
}

function parseLogMaxBytes(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return DEFAULT_MAX_LOG_BYTES;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MAX_LOG_BYTES;
  }

  if (parsed === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor(parsed);
}

function parsePositiveInteger(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function isBrokenStreamError(err) {
  return err?.code === 'EPIPE' ||
    err?.code === 'ERR_STREAM_DESTROYED' ||
    err?.code === 'ERR_STREAM_WRITE_AFTER_END';
}

function buildSessionStamp() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
  return {
    startedAt: now.toISOString(),
    pid: process.pid,
    date,
    time,
    baseName: `wrapper-${date}-${time}-${process.pid}`,
  };
}

function buildLogPath(index) {
  const suffix = index === 0 ? '.log' : `.${index}.log`;
  return join(LOG_DIR, `${SESSION_STAMP.baseName}${suffix}`);
}

function buildHeader(partIndex) {
  return `=== Chrome DevTools MCP Wrapper Log ===\n` +
    `Started: ${SESSION_STAMP.startedAt}\n` +
    `PID: ${SESSION_STAMP.pid}\n` +
    `Version: 1.0.0\n` +
    `Debug: ${currentLevel === LEVELS.DEBUG ? 'enabled' : 'disabled'}\n` +
    `MaxLogBytes: ${Number.isFinite(MAX_LOG_BYTES) ? MAX_LOG_BYTES : 'unlimited'}\n` +
    `MaxLogFiles: ${MAX_LOG_FILES}\n` +
    `RateLimit: ${RATE_LIMIT_COUNT}/${RATE_LIMIT_WINDOW_MS}ms\n` +
    `Part: ${partIndex + 1}\n` +
    `${'='.repeat(50)}\n\n`;
}

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function openLogFile(index) {
  try {
    ensureLogDir();
    const path = buildLogPath(index);
    const header = buildHeader(index);
    writeFileSync(path, header);
    logFilePath = path;
    fileSizeBytes = Buffer.byteLength(header);
    LOG_FILE_PATHS.push(path);
    pruneRolledFiles();
    return true;
  } catch {
    fileLoggingDisabled = true;
    return false;
  }
}

function pruneRolledFiles() {
  while (LOG_FILE_PATHS.length > MAX_LOG_FILES) {
    const oldPath = LOG_FILE_PATHS.shift();
    try {
      unlinkSync(oldPath);
    } catch {
      // 删除历史滚动文件失败时不阻断主流程
    }
  }
}

function rotateLogFile() {
  rotationIndex += 1;
  return openLogFile(rotationIndex);
}

// 启动时初始化日志文件
openLogFile(rotationIndex);

/**
 * 格式化时间戳
 */
function timestamp() {
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${now.toISOString().replace('T', ' ').replace('Z', '')}.${ms}`;
}

/**
 * 检查是否应该输出此调试日志
 * @param {string} namespace
 */
function shouldDebug(namespace) {
  if (currentLevel > LEVELS.DEBUG) return false;
  if (debugPatterns.has('*')) return true;

  const ns = namespace.toLowerCase();
  for (const pattern of debugPatterns) {
    const p = pattern.toLowerCase().replace('*', '');
    if (p === '*' || ns.startsWith(p) || ns.endsWith(p) || ns.includes(p)) {
      return true;
    }
  }
  return false;
}

function shouldInterruptForRate() {
  if (loggingInterrupted) {
    return true;
  }

  const now = Date.now();
  if (rateWindowStartedAt === 0 || now - rateWindowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    rateWindowStartedAt = now;
    rateWindowCount = 0;
  }

  rateWindowCount += 1;
  if (rateWindowCount <= RATE_LIMIT_COUNT) {
    return false;
  }

  interruptLogging('rate-limit', {
    count: rateWindowCount,
    windowMs: RATE_LIMIT_WINDOW_MS,
    file: logFilePath,
  });
  return true;
}

function interruptLogging(reason, meta) {
  if (loggingInterrupted) {
    return;
  }

  loggingInterrupted = true;
  fileLoggingDisabled = true;

  const notice = `[${timestamp()}] [ERROR] [logger] Logging interrupted {reason=${reason} ${formatMeta(meta).slice(1, -1)}}\n`;

  if (logFilePath) {
    try {
      appendFileSync(logFilePath, notice);
      fileSizeBytes += Buffer.byteLength(notice);
    } catch {
      // 文件本身不可写时忽略
    }
  }

  writeStderr(notice);

  showMessageBox({
    title: 'chrome-devtools-mcp-wrapper',
    message: `Logging has been interrupted.\nReason: ${reason}\nWindow: ${RATE_LIMIT_COUNT}/${RATE_LIMIT_WINDOW_MS}ms\nFile: ${logFilePath || 'unavailable'}`,
  });
}

/**
 * 写入日志
 * @param {string} level
 * @param {string} namespace
 * @param {string} message
 * @param {object} [meta]
 */
function writeLog(level, namespace, message, meta) {
  if (shouldInterruptForRate()) {
    return;
  }

  const ts = timestamp();
  const prefix = `[${ts}] [${level}] [${namespace}]`;
  const msg = meta ? `${message} ${formatMeta(meta)}` : message;
  const line = `${prefix} ${msg}\n`;

  writeToFile(line);
  writeStderr(line);
}

/**
 * 格式化元数据
 */
function formatMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    parts.push(`${k}=${serializeMetaValue(v)}`);
  }
  return parts.length > 0 ? `{${parts.join(' ')}}` : '';
}

function serializeMetaValue(value) {
  try {
    if (typeof value === 'string') {
      return truncate(value);
    }
    if (typeof value === 'object' && value !== null) {
      return truncate(JSON.stringify(value));
    }
    return truncate(String(value));
  } catch (err) {
    return `[unserializable:${err?.message || 'unknown'}]`;
  }
}

function truncate(value) {
  if (value.length <= MAX_META_VALUE_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_META_VALUE_CHARS)}...<truncated>`;
}

function writeToFile(line) {
  if (!logFilePath || fileLoggingDisabled || loggingInterrupted) {
    return;
  }

  const lineBytes = Buffer.byteLength(line);
  if (Number.isFinite(MAX_LOG_BYTES) && lineBytes > MAX_LOG_BYTES) {
    interruptLogging('entry-too-large', {
      entryBytes: lineBytes,
      limitBytes: MAX_LOG_BYTES,
      file: logFilePath,
    });
    return;
  }

  if (Number.isFinite(MAX_LOG_BYTES) && fileSizeBytes + lineBytes > MAX_LOG_BYTES) {
    const rotated = rotateLogFile();
    if (!rotated) {
      fileLoggingDisabled = true;
      return;
    }
  }

  try {
    appendFileSync(logFilePath, line);
    fileSizeBytes += lineBytes;
  } catch {
    fileLoggingDisabled = true;
  }
}

export function writeStderr(chunk) {
  if (stderrDisabled) {
    return;
  }

  const data = Buffer.isBuffer(chunk) ? chunk : String(chunk);
  const stream = process.stderr;
  if (!stream || stream.destroyed || stream.writableEnded === true || stream.writable === false) {
    stderrDisabled = true;
    return;
  }

  try {
    stream.write(data, (err) => {
      if (isBrokenStreamError(err)) {
        stderrDisabled = true;
      }
    });
  } catch {
    stderrDisabled = true;
  }
}

/**
 * 创建命名空间 logger
 * @param {string} namespace
 */
export function createLogger(namespace) {
  return {
    debug: (message, meta) => {
      if (shouldDebug(namespace)) {
        writeLog('DEBUG', namespace, message, meta);
      }
    },
    info: (message, meta) => {
      if (currentLevel <= LEVELS.INFO) {
        writeLog('INFO', namespace, message, meta);
      }
    },
    warn: (message, meta) => {
      if (currentLevel <= LEVELS.WARN) {
        writeLog('WARN', namespace, message, meta);
      }
    },
    error: (message, meta) => {
      if (currentLevel <= LEVELS.ERROR) {
        writeLog('ERROR', namespace, message, meta);
      }
    },
    /**
     * 记录工具调用（始终记录）
     * @param {string} toolName
     * @param {object} args
     * @param {object} [result]
     * @param {number} [duration]
     */
    toolCall: (toolName, args, result, duration) => {
      const meta = { tool: toolName, duration };
      if (currentLevel === LEVELS.DEBUG) {
        meta.args = JSON.stringify(args).slice(0, 500);
        if (result) {
          meta.result = JSON.stringify(result).slice(0, 500);
        }
      }
      writeLog('TOOL', namespace, `Called ${toolName}`, meta);
    },
    /**
     * 记录生命周期事件（始终记录）
     * @param {string} event
     * @param {object} [meta]
     */
    lifecycle: (event, meta) => {
      writeLog('LIFECYCLE', namespace, event, meta);
    },
  };
}

/**
 * 预定义的 logger 实例
 */
export const logger = {
  wrapper: createLogger('wrapper'),
  profile: createLogger('profile'),
  proxy: createLogger('proxy'),
  chrome: createLogger('chrome'),
  tool: createLogger('tool'),
};

/**
 * 设置日志级别（用于测试）
 */
export function setLevel(level) {
  currentLevel = LEVELS[level] ?? LEVELS.INFO;
}

/**
 * 获取当前日志文件路径
 */
export function getLogFilePath() {
  return logFilePath;
}

export function isLoggingInterrupted() {
  return loggingInterrupted;
}
