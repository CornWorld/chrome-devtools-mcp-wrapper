/**
 * 工具过滤 — 白名单/黑名单模式。
 */

/** 默认屏蔽的工具（防止 agent 误操作） */
const DEFAULT_BLOCKED = new Set([
  'new_page',
  'close_page',
  'upload_file',
]);

/**
 * 构建工具过滤函数。
 *
 * @param {{ blockTools?: string[], allowOnly?: string[] }} opts
 * @returns {(tool: {name: string}) => boolean}
 */
export function buildToolFilter({ blockTools, allowOnly } = {}) {
  // allowOnly 优先：只暴露白名单中的工具
  if (allowOnly && allowOnly.length > 0) {
    const allowed = new Set(allowOnly);
    return (tool) => allowed.has(tool.name);
  }

  // blockTools：合并到默认黑名单
  const blocked = new Set(DEFAULT_BLOCKED);
  if (blockTools) {
    for (const t of blockTools) blocked.add(t);
  }
  return (tool) => !blocked.has(tool.name);
}
