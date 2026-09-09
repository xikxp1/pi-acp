import { isAbsolute, relative } from 'node:path'
import type { ToolKind } from '@agentclientprotocol/sdk'
import { isSubagentTool, subagentToolTitle } from './subagents.js'

const MAX_TITLE_ARG = 80

const SEARCH_TOOLS = new Set(['grep', 'find', 'ls', 'glob', 'ffgrep', 'fffind'])
const FETCH_TOOLS = new Set([
  'web_search',
  'fetch_content',
  'source_check',
  'get_search_content',
  'webfetch',
  'websearch'
])
const THINK_TOOLS = new Set(['todo', 'think'])

export function toToolKind(toolName: string): ToolKind {
  const name = toolName.toLowerCase()
  if (name === 'read') return 'read'
  if (name === 'write' || name === 'edit') return 'edit'
  if (name === 'bash' || name === 'powershell') return 'execute'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (FETCH_TOOLS.has(name)) return 'fetch'
  if (THINK_TOOLS.has(name)) return 'think'
  return 'other'
}

/** Compact `name primary-arg` title, e.g. `read src/index.ts` or `grep "foo" in src/`. */
export function toToolTitle(toolName: string, args: unknown, cwd: string): string {
  if (isSubagentTool(toolName)) return subagentToolTitle(toolName, args)
  const a = record(args)
  const path = displayPath(str(a.path) ?? str(a.file_path), cwd)

  switch (toolName.toLowerCase()) {
    case 'read':
    case 'write':
    case 'edit':
    case 'ls':
      return join(toolName, path)
    case 'grep':
    case 'ffgrep': {
      const pattern = quote(str(a.pattern))
      return join(toolName, pattern, path ? `in ${path}` : undefined)
    }
    case 'find':
    case 'fffind':
    case 'glob': {
      const pattern = str(a.pattern)
      return join(toolName, pattern, path ? `in ${path}` : undefined)
    }
    case 'web_search':
    case 'source_check':
      return join(toolName, quote(str(a.query) ?? str(a.claim) ?? firstString(a.queries)))
    case 'fetch_content':
      return join(toolName, str(a.url) ?? firstString(a.urls))
    default:
      return join(toolName, path)
  }
}

function join(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(' ')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > MAX_TITLE_ARG ? `${trimmed.slice(0, MAX_TITLE_ARG - 1)}…` : trimmed
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) ? str(value[0]) : undefined
}

function quote(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `"${value}"`
}

function displayPath(path: string | undefined, cwd: string): string | undefined {
  if (!path) return undefined
  if (!isAbsolute(path)) return path
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel : path
}
