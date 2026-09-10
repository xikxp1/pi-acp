import { isAbsolute, resolve } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'

/** Validate, normalize, and dedupe ACP `additionalDirectories` (dropping `cwd` itself). */
export function normalizeAdditionalDirectories(dirs: unknown, cwd: string): string[] {
  if (!Array.isArray(dirs) || dirs.length === 0) return []
  const out: string[] = []
  const normalizedCwd = resolve(cwd)
  for (const dir of dirs) {
    if (typeof dir !== 'string' || !isAbsolute(dir)) {
      throw RequestError.invalidParams(`additionalDirectories entries must be absolute paths: ${String(dir)}`)
    }
    const normalized = resolve(dir)
    if (normalized === normalizedCwd || out.includes(normalized)) continue
    out.push(normalized)
  }
  return out
}

export function sameDirectories(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((dir, i) => dir === b[i])
}

/** System-prompt addendum telling pi about extra workspace roots (pi itself is single-root). */
export function additionalDirectoriesSystemPrompt(dirs: readonly string[]): string | undefined {
  if (!dirs.length) return undefined
  return [
    'Additional workspace roots are part of this session besides the working directory.',
    'Treat them as in scope. With pi-acp-fs, read/edit/write resolve relative paths in the working directory first, then a unique matching extra root.',
    'Use root-name/path to target an extra root (including new files); ambiguous roots require an absolute path. Unqualified new files stay in the working directory.',
    'Other tools, or sessions without pi-acp-fs, must use absolute paths for extra roots.',
    ...dirs.map(dir => `- ${dir}`)
  ].join('\n')
}
