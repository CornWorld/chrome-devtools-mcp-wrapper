#!/usr/bin/env node
/**
 * chrome-devtools-mcp-wrapper 入口。
 *
 * 用法:
 *   node index.mjs [options] [-- upstream-args...]
 *
 * 选项:
 *   --headless              无头模式（默认 true）
 *   --no-headless           有头模式
 *   --profile=<name>        Chrome profile 名称（默认按策略选择）
 *   --init-script=<path>    项目初始化脚本
 *   --block-tools=t1,t2     屏蔽指定工具
 *   --allow-only=t1,t2      仅暴露指定工具（优先于 block-tools）
 *   --chrome-arg=<arg>      追加 Chrome 启动参数（可多次使用）
 *   --no-chrome             不启动 Chrome（使用外部浏览器）
 *   --browser-url=<url>     外部浏览器地址（搭配 --no-chrome）
 *   --debug                 启用调试日志
 *
 * 环境变量:
 *   DEBUG=*                 启用所有调试日志
 *   DEBUG=wrapper:*         仅启用 wrapper 相关调试日志
 *   LOG_DIR=<path>          日志目录（默认 ~/.cache/cdp-wrapper/logs）
 *   LOG_MAX_BYTES=<bytes>   单个日志文件最大大小，默认 10485760（10 MiB）
 *   LOG_MAX_FILES=<count>   单次会话滚动保留日志文件数，默认 5
 *   LOG_RATE_LIMIT_COUNT    速率窗口内最多允许写入多少条日志，默认 200
 *   LOG_RATE_LIMIT_WINDOW_MS 速率窗口大小，默认 1000ms
 *   LOG_MESSAGE_BOX=<bool>  触发熔断时是否弹消息框，默认 true
 *
 * 日志文件：
 *   每次启动自动创建：~/.cache/cdp-wrapper/logs/wrapper-YYYYMMDD-HHMMSS-<pid>.log
 *   超过单文件大小后自动滚动为 .1.log / .2.log ...
 *   启动时会输出日志文件路径到 stderr
 */

import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChrome } from './lib/chrome-launcher.mjs';
import { acquireChrome, releaseChrome } from './lib/profile-manager.mjs';
import { createProxy } from './lib/proxy.mjs';
import { buildToolFilter } from './lib/tool-filter.mjs';
import { onCleanup, runAllCleanup } from './lib/cleanup.mjs';
import { createLogger, getLogFilePath, writeStderr } from './lib/logger.mjs';

const logger = createLogger('wrapper');
const SHARED_PROFILE_NAME = 'shared-lite';
const AUTO_PROFILE_PREFIX = 'auto';

// ---------- CLI 参数解析 ----------

function parseArgs(argv) {
  const opts = {
    headless: true,
    profile: null,
    initScript: null,
    blockTools: [],
    allowOnly: [],
    chromeArgs: [],
    noChrome: false,
    browserUrl: null,
    upstreamArgs: [],
    debug: false,
  };

  let afterSeparator = false;
  for (const arg of argv.slice(2)) {
    if (afterSeparator) {
      opts.upstreamArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      afterSeparator = true;
      continue;
    }
    if (arg === '--headless') { opts.headless = true; continue; }
    if (arg === '--no-headless') { opts.headless = false; continue; }
    if (arg === '--no-chrome') { opts.noChrome = true; continue; }
    if (arg.startsWith('--profile=')) {
      opts.profile = arg.slice('--profile='.length) || null;
      continue;
    }
    if (arg.startsWith('--init-script=')) { opts.initScript = arg.slice('--init-script='.length); continue; }
    if (arg.startsWith('--block-tools=')) { opts.blockTools = arg.slice('--block-tools='.length).split(',').filter(Boolean); continue; }
    if (arg.startsWith('--allow-only=')) { opts.allowOnly = arg.slice('--allow-only='.length).split(',').filter(Boolean); continue; }
    if (arg.startsWith('--chrome-arg=')) { opts.chromeArgs.push(arg.slice('--chrome-arg='.length)); continue; }
    if (arg.startsWith('--browser-url=')) { opts.browserUrl = arg.slice('--browser-url='.length); continue; }
    if (arg === '--debug') { opts.debug = true; continue; }
    // 未知参数当作上游参数透传
    opts.upstreamArgs.push(arg);
  }
  return opts;
}

function sanitizeProfileSegment(value, maxLength = 24) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength) || 'project';
}

function deriveProfileFromInitScript(initScript) {
  const cwd = process.cwd();
  const initScriptPath = resolve(cwd, initScript);
  const projectSlug = sanitizeProfileSegment(basename(cwd));
  const hash = createHash('sha1')
    .update(`${cwd}\0${initScriptPath}`)
    .digest('hex')
    .slice(0, 10);

  return {
    profile: `${AUTO_PROFILE_PREFIX}-${projectSlug}-${hash}`,
    source: 'auto-init-script',
    initScriptPath,
  };
}

function resolveProfileSelection(opts) {
  if (opts.profile) {
    return {
      profile: opts.profile,
      source: 'explicit',
      initScriptPath: null,
    };
  }

  if (opts.initScript) {
    return deriveProfileFromInitScript(opts.initScript);
  }

  return {
    profile: SHARED_PROFILE_NAME,
    source: 'shared-default',
    initScriptPath: null,
  };
}

// ---------- init-script 加载 ----------

async function loadInitScript(scriptPath, context) {
  const absPath = resolve(process.cwd(), scriptPath);
  const mod = await import(pathToFileURL(absPath).href);
  const init = mod.default || mod;
  if (typeof init !== 'function') {
    throw new Error(`init-script must export a default function: ${scriptPath}`);
  }
  const result = await init(context);
  return result?.tools || [];
}

// ---------- 统一 shutdown ----------

let shuttingDown = false;
/** @type {string | null} */
let activeProfile = null;
let proxyInfo = null; // 保存 proxy 信息以便调试
let fatalErrorSeen = false;

async function shutdown(reason) {
  if (shuttingDown) {
    logger.warn(`Shutdown already in progress, ignoring additional request`, { reason });
    return;
  }
  shuttingDown = true;

  logger.lifecycle(`Shutting down`, { reason, activeProfile });

  if (activeProfile) {
    try {
      await releaseChrome(activeProfile);
    } catch (err) {
      logger.error(`Release error during shutdown`, { error: err.message, stack: err.stack });
    }
  }

  logger.lifecycle(`Running cleanup handlers`);
  await runAllCleanup();

  logger.lifecycle(`Exiting`);
  process.exit(0);
}

// ---------- 主流程 ----------

async function main() {
  const startTime = Date.now();

  const opts = parseArgs(process.argv);

  // 如果指定了 --debug，设置环境变量
  if (opts.debug && !process.env.DEBUG) {
    process.env.DEBUG = 'wrapper:*';
  }

  const profileSelection = resolveProfileSelection(opts);
  const profile = profileSelection.profile;

  logger.lifecycle(`Starting`, {
    pid: process.pid,
    args: process.argv.slice(2).join(' '),
    debug: opts.debug || !!process.env.DEBUG,
  });

  // 打印日志文件路径（始终输出到 stderr，方便定位）
  const logPath = getLogFilePath();
  if (logPath) {
    writeStderr(`[wrapper] Log file: ${logPath}\n`);
  }
  logger.debug(`Parsed options`, {
    headless: opts.headless,
    profile: opts.profile,
    noChrome: opts.noChrome,
  });
  logger.lifecycle(`Profile selected`, {
    profile,
    source: profileSelection.source,
    initScript: profileSelection.initScriptPath,
  });
  if (!opts.profile && opts.initScript) {
    logger.warn(`Profile auto-derived from init-script`, {
      profile,
      initScript: profileSelection.initScriptPath,
    });
  } else if (!opts.profile) {
    logger.warn(`Using shared profile because --profile was not provided`, { profile });
  }

  let browserUrl = opts.browserUrl;

  // 1. 启动/复用 Chrome（除非 --no-chrome）
  if (!opts.noChrome) {
    logger.lifecycle(`Acquiring Chrome`, { profile });
    const result = await acquireChrome(profile, {
      headless: opts.headless,
      extraArgs: opts.chromeArgs,
      launchChrome,
    });
    browserUrl = `http://127.0.0.1:${result.port}`;
    activeProfile = profile;

    logger.lifecycle(`Chrome acquired`, {
      isNew: result.isNew,
      browserUrl,
      clientCount: result.clientCount,
      duration: Date.now() - startTime,
    });

    // 如果我们启动了新 Chrome 进程，监听其退出
    if (result.chromeProcess) {
      result.onChromeExit?.((code, signal) => {
        logger.lifecycle(`Chrome exited`, { code, signal });
        void shutdown('chrome-exit');
      });
      result.onChromeError?.((err) => {
        logger.error(`Chrome process error`, { error: err.message });
        void shutdown('chrome-error');
      });
    }
  }

  if (!browserUrl) {
    logger.error(`No browser URL available`);
    process.exit(1);
  }

  // 2. 加载 init-script（可选）
  let customTools = [];
  if (opts.initScript) {
    logger.lifecycle(`Loading init-script`, { path: opts.initScript });
    try {
      const initContext = {
        browserUrl,
        profile,
        headless: opts.headless,
      };
      const tools = await loadInitScript(opts.initScript, initContext);
      customTools = tools;
      logger.lifecycle(`Init-script loaded`, { tools: tools.length });
    } catch (err) {
      logger.error(`Init-script error`, { error: err.message, stack: err.stack });
      logger.info(`Continuing without custom tools`);
    }
  }

  // 3. 构建工具过滤器
  const toolFilter = buildToolFilter({
    blockTools: opts.blockTools,
    allowOnly: opts.allowOnly,
  });
  logger.debug(`Tool filter configured`, { blocked: opts.blockTools, allowOnly: opts.allowOnly });

  // 4. 组装上游 chrome-devtools-mcp 参数
  const upstreamArgs = [
    'chrome-devtools-mcp@latest',
    `--browser-url=${browserUrl}`,
    '--experimentalPageIdRouting',
    '--experimentalStructuredContent',
    ...opts.upstreamArgs,
  ];
  logger.debug(`Upstream args`, { args: upstreamArgs.join(' ') });

  // 5. 启动 MCP Proxy
  logger.lifecycle(`Starting MCP proxy`);
  proxyInfo = await createProxy({
    upstreamCommand: 'npx',
    upstreamArgs,
    toolFilter,
    customTools,
  });

  // 6. 生命周期绑定
  onCleanup(() => {
    logger.debug(`Cleanup handler called`);
  });

  // 7. stdin 关闭检测（MCP 客户端断开时 stdin 会关闭）
  process.stdin.on('end', () => {
    logger.lifecycle(`stdin closed (client disconnected)`);
    shutdown('stdin-closed');
  });

  // 8. 检测上游进程退出
  if (proxyInfo?.clientTransport?._process) {
    const upstreamProc = proxyInfo.clientTransport._process;
    upstreamProc.on('exit', (code, signal) => {
      logger.lifecycle(`Upstream MCP process exited`, { code, signal });
      shutdown('upstream-exit');
    });
  }

  // 9. SIGINT/SIGTERM 也走统一 shutdown
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // 未捕获的异常
  process.on('uncaughtException', (err) => {
    if (fatalErrorSeen) {
      process.exit(1);
      return;
    }
    fatalErrorSeen = true;
    logger.error(`Uncaught exception`, { error: err.message, stack: err.stack });
    shutdown('uncaught-exception');
  });

  process.on('unhandledRejection', (reason) => {
    if (fatalErrorSeen) {
      process.exit(1);
      return;
    }
    fatalErrorSeen = true;
    logger.error(`Unhandled rejection`, { reason });
    shutdown('unhandled-rejection');
  });

  const totalDuration = Date.now() - startTime;
  logger.lifecycle(`Ready`, { duration: totalDuration, profile, browserUrl });
}

main().catch((err) => {
  logger.error(`Fatal error during startup`, { error: err.message, stack: err.stack });
  process.exit(1);
});
