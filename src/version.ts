import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function readVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
      const path = join(dir, 'package.json')
      if (existsSync(path)) {
        const json = JSON.parse(readFileSync(path, 'utf-8')) as { name?: unknown; version?: unknown }
        if (json.name === 'pi-acp' && typeof json.version === 'string') return json.version
      }
      dir = dirname(dir)
    }
  } catch {
    // fall through
  }
  return '0.0.0'
}

export const PI_ACP_VERSION = readVersion()

/** Numeric x.y.z comparison; pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map(n => Number.parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}
