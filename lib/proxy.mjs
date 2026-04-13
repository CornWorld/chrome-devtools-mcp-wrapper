/**
 * MCP Proxy 核心 — 同时作为 MCP Server（面向 Claude Code）和 MCP Client（面向上游 chrome-devtools-mcp）。
 *
 * 使用低级 Server API 直接透传上游 JSON Schema 格式的工具定义。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { trackChildProcess } from './cleanup.mjs';
import { createLogger, writeStderr } from './logger.mjs';

const logger = createLogger('proxy');
const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';
const CALLER_META_HINT = /(caller|agent|session|thread|conversation)/i;

function createMutex() {
  let tail = Promise.resolve();
  return async (fn) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function getSchemaProperties(tool) {
  return tool?.inputSchema?.properties || {};
}

function getPageAwareToolNames(tools) {
  return new Set(
    tools
      .filter((tool) => Object.prototype.hasOwnProperty.call(getSchemaProperties(tool), 'pageId'))
      .map((tool) => tool.name),
  );
}

function getCallerKey(request, extra = {}) {
  const relatedTaskId = request.params?._meta?.[RELATED_TASK_META_KEY]?.taskId;
  if (extra.taskId) {
    return { key: `task:${extra.taskId}`, stable: true, source: 'extra.taskId' };
  }
  if (relatedTaskId) {
    return { key: `related-task:${relatedTaskId}`, stable: true, source: '_meta.related-task.taskId' };
  }
  if (extra.sessionId) {
    return { key: `session:${extra.sessionId}`, stable: true, source: 'extra.sessionId' };
  }

  const meta = request.params?._meta;
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      if (key === RELATED_TASK_META_KEY || key === 'progressToken') {
        continue;
      }
      if (!CALLER_META_HINT.test(key)) {
        continue;
      }
      if (typeof value === 'string' || typeof value === 'number') {
        return { key: `meta:${key}:${value}`, stable: true, source: `_meta.${key}` };
      }
      if (value && typeof value === 'object') {
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          if (!CALLER_META_HINT.test(nestedKey)) {
            continue;
          }
          if (typeof nestedValue === 'string' || typeof nestedValue === 'number') {
            return {
              key: `meta:${key}.${nestedKey}:${nestedValue}`,
              stable: true,
              source: `_meta.${key}.${nestedKey}`,
            };
          }
        }
      }
    }
  }

  return {
    key: `request:${extra.requestId ?? 'unknown'}`,
    stable: false,
    source: 'requestId-fallback',
  };
}

function getStructuredPagesData(result) {
  const structured = result?.structuredContent || {};
  return {
    pages: Array.isArray(structured.pages) ? structured.pages : [],
    extensionPages: Array.isArray(structured.extensionPages) ? structured.extensionPages : [],
    extensionServiceWorkers: Array.isArray(structured.extensionServiceWorkers)
      ? structured.extensionServiceWorkers
      : [],
  };
}

function getAllPages(pagesData) {
  return [...pagesData.pages, ...pagesData.extensionPages];
}

function hasPage(pagesData, pageId) {
  return getAllPages(pagesData).some((page) => page.id === pageId);
}

function rewriteSelection(pagesData, selectedPageId) {
  const rewritePages = (pages) => pages.map((page) => ({
    ...page,
    selected: page.id === selectedPageId,
  }));

  return {
    ...pagesData,
    pages: rewritePages(pagesData.pages),
    extensionPages: rewritePages(pagesData.extensionPages),
  };
}

function buildPagesText(pagesData, message) {
  const lines = [];

  if (message) {
    lines.push(message);
  }

  if (pagesData.pages.length > 0) {
    lines.push('## Pages');
    for (const page of pagesData.pages) {
      const isolatedContext = page.isolatedContext ? ` isolatedContext=${page.isolatedContext}` : '';
      lines.push(`${page.id}: ${page.url}${page.selected ? ' [selected]' : ''}${isolatedContext}`);
    }
  }

  if (pagesData.extensionPages.length > 0) {
    lines.push('## Extension Pages');
    for (const page of pagesData.extensionPages) {
      const isolatedContext = page.isolatedContext ? ` isolatedContext=${page.isolatedContext}` : '';
      lines.push(`${page.id}: ${page.url}${page.selected ? ' [selected]' : ''}${isolatedContext}`);
    }
  }

  if (pagesData.extensionServiceWorkers.length > 0) {
    lines.push('## Extension Service Workers');
    for (const worker of pagesData.extensionServiceWorkers) {
      lines.push(`${worker.id}: ${worker.url}`);
    }
  }

  return lines.join('\n');
}

function buildPagesResult(pagesData, message) {
  const text = buildPagesText(pagesData, message);
  const structuredContent = {
    pages: pagesData.pages,
    extensionPages: pagesData.extensionPages,
    extensionServiceWorkers: pagesData.extensionServiceWorkers,
  };

  if (message) {
    structuredContent.message = message;
  }

  return {
    content: text ? [{ type: 'text', text }] : [],
    structuredContent,
  };
}

function pickNewPageId(beforePagesData, afterPagesData) {
  const beforeIds = new Set(getAllPages(beforePagesData).map((page) => page.id));
  const additions = getAllPages(afterPagesData).filter((page) => !beforeIds.has(page.id));
  if (additions.length === 1) {
    return additions[0].id;
  }
  if (additions.length > 1) {
    return Math.max(...additions.map((page) => page.id));
  }

  const selectedPage = getAllPages(afterPagesData).find((page) => page.selected);
  if (selectedPage) {
    return selectedPage.id;
  }

  const allPages = getAllPages(afterPagesData);
  return allPages.length > 0 ? Math.max(...allPages.map((page) => page.id)) : null;
}

function pickFallbackPageId(pagesData) {
  return getAllPages(pagesData)[0]?.id ?? null;
}

/**
 * @typedef {Object} CustomTool
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema
 * @property {(args: object) => Promise<object>} handler
 */

/**
 * 创建 MCP proxy。
 *
 * @param {{
 *   upstreamCommand: string,
 *   upstreamArgs: string[],
 *   upstreamEnv?: Record<string,string>,
 *   toolFilter: (tool: {name:string}) => boolean,
 *   customTools?: CustomTool[],
 * }} opts
 */
export async function createProxy({
  upstreamCommand,
  upstreamArgs,
  upstreamEnv,
  toolFilter,
  customTools = [],
}) {
  // --- 1. 连接上游 chrome-devtools-mcp ---
  const clientTransport = new StdioClientTransport({
    command: upstreamCommand,
    args: upstreamArgs,
    env: { ...process.env, ...upstreamEnv },
    stderr: 'pipe',
  });

  // 透传上游 stderr
  clientTransport.stderr?.on('data', (d) => {
    writeStderr(d);
    logger.debug('Upstream stderr', { data: d.toString().slice(0, 200) });
  });

  const client = new Client(
    { name: 'cdp-wrapper-client', version: '1.0.0' },
    {},
  );

  await client.connect(clientTransport);
  logger.lifecycle('Connected to upstream chrome-devtools-mcp');

  const upstreamTools = await client.listTools();
  const pageAwareToolNames = getPageAwareToolNames(upstreamTools.tools);
  logger.debug('Page-aware tools detected', { count: pageAwareToolNames.size });

  // 跟踪上游子进程以便清理（_process 是 StdioClientTransport 的内部属性，无公开 API）
  if (clientTransport._process) {
    trackChildProcess(clientTransport._process, 'upstream-mcp');
    logger.debug('Tracking upstream MCP process', { pid: clientTransport._process.pid });
  } else {
    logger.warn('Upstream process not available for tracking');
  }

  // --- 2. 创建下游 MCP Server ---
  const server = new Server(
    { name: 'chrome-devtools-mcp-wrapper', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const withToolCallLock = createMutex();
  const callerState = new Map();
  const pageClaims = new Map();

  const warnedCallerFallbackSources = new Set();

  const getStateForCaller = (caller) => {
    if (!caller.stable) {
      return { selectedPageId: null };
    }
    if (!callerState.has(caller.key)) {
      callerState.set(caller.key, { selectedPageId: null });
    }
    return callerState.get(caller.key);
  };

  const dropMissingPageClaims = (pagesData) => {
    const livePageIds = new Set(getAllPages(pagesData).map((page) => page.id));
    for (const [pageId] of pageClaims) {
      if (!livePageIds.has(pageId)) {
        pageClaims.delete(pageId);
      }
    }
    for (const state of callerState.values()) {
      if (state.selectedPageId !== null && !livePageIds.has(state.selectedPageId)) {
        state.selectedPageId = null;
      }
    }
  };

  const claimPageForCaller = (caller, state, pageId) => {
    if (typeof pageId !== 'number') {
      return;
    }
    state.selectedPageId = pageId;
    if (!caller.stable) {
      return;
    }
    for (const [claimedPageId, claimedCallerKey] of pageClaims) {
      if (claimedCallerKey === caller.key && claimedPageId !== pageId) {
        pageClaims.delete(claimedPageId);
      }
    }
    pageClaims.set(pageId, caller.key);
  };

  const choosePageForCaller = (caller, state, pagesData) => {
    if (typeof state.selectedPageId === 'number' && hasPage(pagesData, state.selectedPageId)) {
      const owner = pageClaims.get(state.selectedPageId);
      if (!owner || owner === caller.key) {
        return state.selectedPageId;
      }
      state.selectedPageId = null;
    }

    const allPages = getAllPages(pagesData);
    const globallySelectedPage = allPages.find((page) => page.selected);
    if (globallySelectedPage) {
      const owner = pageClaims.get(globallySelectedPage.id);
      if (!owner || owner === caller.key) {
        return globallySelectedPage.id;
      }
    }

    const firstUnclaimedPage = allPages.find((page) => {
      const owner = pageClaims.get(page.id);
      return !owner || owner === caller.key;
    });
    if (firstUnclaimedPage) {
      return firstUnclaimedPage.id;
    }

    return allPages[0]?.id ?? null;
  };

  const fetchPagesData = async () => {
    const result = await client.callTool({ name: 'list_pages', arguments: {} });
    const pagesData = getStructuredPagesData(result);
    dropMissingPageClaims(pagesData);
    return pagesData;
  };

  // --- 3. tools/list — 过滤上游 + 合并自定义 ---
  const customToolDefs = customTools.map(({ handler, ...def }) => def);
  const customHandlers = new Map(customTools.map((t) => [t.name, t.handler]));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('Listing tools from upstream');
    logger.debug('Upstream tools received', { count: upstreamTools.tools.length });
    const filtered = upstreamTools.tools.filter(toolFilter);
    logger.debug('Tools after filtering', { count: filtered.length, blocked: upstreamTools.tools.length - filtered.length });
    return { tools: [...filtered, ...customToolDefs] };
  });

  // --- 4. tools/call — 路由 ---
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => withToolCallLock(async () => {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();
    const caller = getCallerKey(request, extra);
    const callerKey = caller.key;
    const state = getStateForCaller(caller);

    if (!caller.stable && !warnedCallerFallbackSources.has(caller.source)) {
      warnedCallerFallbackSources.add(caller.source);
      logger.warn('No stable caller identity found; page isolation is limited for this request', {
        source: caller.source,
        requestId: extra?.requestId,
      });
    }

    logger.lifecycle(`Tool call started: ${name}`, {
      callerKey,
      args: JSON.stringify(args).slice(0, 300),
    });

    // 自定义工具：本地处理
    if (customHandlers.has(name)) {
      try {
        const result = await customHandlers.get(name)(request.params.arguments);
        const duration = Date.now() - startTime;
        logger.toolCall(name, args, result, duration);
        return result;
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Custom tool error: ${name}`, { error: err.message, duration });
        return {
          content: [{ type: 'text', text: `Custom tool error: ${err.message}` }],
          isError: true,
        };
      }
    }

    try {
      if (name === 'list_pages') {
        const pagesData = rewriteSelection(await fetchPagesData(), state.selectedPageId);
        const result = buildPagesResult(pagesData);
        const duration = Date.now() - startTime;
        logger.toolCall(name, args, result, duration);
        return result;
      }

      if (name === 'select_page') {
        const pageId = args?.pageId;
        const pagesData = await fetchPagesData();
        if (typeof pageId !== 'number' || !hasPage(pagesData, pageId)) {
          return {
            content: [{ type: 'text', text: 'No page found' }],
            isError: true,
          };
        }

        claimPageForCaller(caller, state, pageId);
        if (args?.bringToFront) {
          await client.callTool({ name, arguments: args });
        }

        const result = buildPagesResult(
          rewriteSelection(pagesData, pageId),
          `Selected page ${pageId} for this session.`,
        );
        const duration = Date.now() - startTime;
        logger.toolCall(name, args, result, duration);
        return result;
      }

      let effectiveArgs = args || {};
      let beforePagesData = null;

      if (pageAwareToolNames.has(name)) {
        const explicitPageId = typeof effectiveArgs.pageId === 'number' ? effectiveArgs.pageId : null;
        if (explicitPageId !== null) {
          claimPageForCaller(caller, state, explicitPageId);
        } else {
          const pagesData = await fetchPagesData();
          const assignedPageId = choosePageForCaller(caller, state, pagesData);
          if (assignedPageId !== null) {
            claimPageForCaller(caller, state, assignedPageId);
            effectiveArgs = { ...effectiveArgs, pageId: assignedPageId };
          }
        }
      }

      if (name === 'new_page' || name === 'close_page') {
        beforePagesData = await fetchPagesData();
      }

      logger.debug(`Forwarding to upstream: ${name}`, { callerKey, effectiveArgs: JSON.stringify(effectiveArgs).slice(0, 300) });
      const result = await client.callTool({
        ...request.params,
        arguments: effectiveArgs,
      });

      if (result.isError) {
        const duration = Date.now() - startTime;
        logger.toolCall(name, args, result, duration);
        return result;
      }

      if (name === 'new_page') {
        const afterPagesData = getStructuredPagesData(result);
        dropMissingPageClaims(afterPagesData);
        const newPageId = pickNewPageId(beforePagesData || { pages: [], extensionPages: [], extensionServiceWorkers: [] }, afterPagesData);
        if (newPageId !== null) {
          claimPageForCaller(caller, state, newPageId);
        }
      } else if (name === 'close_page') {
        const closedPageId = typeof effectiveArgs.pageId === 'number' ? effectiveArgs.pageId : state.selectedPageId;
        const afterPagesData = getStructuredPagesData(result);
        dropMissingPageClaims(afterPagesData);
        if (caller.stable && typeof closedPageId === 'number') {
          pageClaims.delete(closedPageId);
        }
        if (state.selectedPageId === closedPageId || !hasPage(afterPagesData, state.selectedPageId)) {
          const fallbackPageId = pickFallbackPageId(afterPagesData);
          if (fallbackPageId !== null) {
            claimPageForCaller(caller, state, fallbackPageId);
          } else {
            state.selectedPageId = null;
          }
        }
      } else if (pageAwareToolNames.has(name) && typeof effectiveArgs.pageId === 'number') {
        claimPageForCaller(caller, state, effectiveArgs.pageId);
      }

      const duration = Date.now() - startTime;
      logger.toolCall(name, args, result, duration);

      // 检测是否有错误
      if (result.content?.some(c => c.type === 'text' && c.text.includes('error'))) {
        logger.warn(`Tool call可能包含错误: ${name}`);
      }

      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.error(`Upstream tool call failed: ${name}`, { error: err.message, stack: err.stack, duration });
      throw err;
    }
  }));

  // --- 5. 暴露给 Claude Code ---
  const serverTransport = new StdioServerTransport();
  await server.connect(serverTransport);
  logger.lifecycle('MCP server ready on stdio');

  // 监听连接关闭
  serverTransport.onerror?.((err) => {
    logger.error('Server transport error', { error: err.message });
  });

  return { server, client, clientTransport };
}
