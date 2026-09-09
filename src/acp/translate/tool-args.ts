import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { ToolCallContent, ToolCallLocation } from '@agentclientprotocol/sdk'

export function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
export function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

export function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

/**
 * Reconstruct diff content for a historic edit/write call from its arguments alone
 * (no file snapshots exist for replayed history). Edits yield one hunk per replacement;
 * writes yield a full-file diff with unknown prior content.
 */
export function historicDiffContent(toolName: string, args: unknown): ToolCallContent[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  if (toolName === 'edit') {
    const edits = getParsedEdits(args)
    if (!edits.length) return undefined
    return edits.map(edit => ({ type: 'diff', path, oldText: edit.oldText, newText: edit.newText }))
  }

  if (toolName === 'write') {
    const content = (args as { content?: unknown } | null | undefined)?.content
    if (typeof content !== 'string') return undefined
    return [{ type: 'diff', path, oldText: null, newText: content }]
  }

  return undefined
}
