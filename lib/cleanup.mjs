/**
 * 进程生命周期管理和清理。
 */

import { rmSync } from 'node:fs';

/** @type {Set<() => void>} */
const cleanupCallbacks = new Set();

/** @type {Set<() => Promise<void>>} */
const asyncCleanupCallbacks = new Set();

let registered = false;

/**
 * 执行所有清理回调（先同步，再异步）。
 * @returns {Promise<void>}
 */
async function runCleanup() {
  // 同步回调
  for (const cb of cleanupCallbacks) {
    try { cb(); } catch { /* best effort */ }
  }
  cleanupCallbacks.clear();

  // 异步回调
  for (const cb of asyncCleanupCallbacks) {
    try { await cb(); } catch { /* best effort */ }
  }
  asyncCleanupCallbacks.clear();
}

function ensureHandlers() {
  if (registered) return;
  registered = true;

  // exit 事件只能同步执行 — 作为最后的安全网
  process.on('exit', () => {
    for (const cb of cleanupCallbacks) {
      try { cb(); } catch { /* best effort */ }
    }
    cleanupCallbacks.clear();
  });
}

/**
 * 注册一个同步清理回调，在进程退出时执行。
 * @param {() => void} fn
 */
export function onCleanup(fn) {
  cleanupCallbacks.add(fn);
  ensureHandlers();
}

/**
 * 注册一个异步清理回调，在 SIGINT/SIGTERM 时执行（同步回调之后）。
 * 注意：process 'exit' 事件中无法执行异步操作，
 *       异步回调仅在 signal 触发时执行。
 * @param {() => Promise<void>} fn
 */
export function onAsyncCleanup(fn) {
  asyncCleanupCallbacks.add(fn);
  ensureHandlers();
}

/**
 * 手动触发所有清理回调（用于 shutdown 函数主动调用）。
 * @returns {Promise<void>}
 */
export async function runAllCleanup() {
  return runCleanup();
}

/**
 * 注册子进程清理 — kill 子进程。
 * @param {import('child_process').ChildProcess} child
 * @param {string} [label]
 */
export function trackChildProcess(child, _label = 'child') {
  onCleanup(() => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  });
}

/**
 * 注册临时目录清理。
 * @param {string} dir
 */
export function trackTempDir(dir) {
  onCleanup(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });
}
