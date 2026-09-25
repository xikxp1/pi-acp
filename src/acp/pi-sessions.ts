import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { titleFromContent } from './session-title.js'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 64 * 1024

function getPiAgentDir(): string {
  // pi supports overriding config dir via PI_CODING_AGENT_DIR.
  // See pi README.
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

function readSessionDirFromSettings(agentDir: string): string | null {
  const settingsPath = join(agentDir, 'settings.json')
  try {
    if (!existsSync(settingsPath)) return null
    const raw = readFileSync(settingsPath, 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null

    const sessionDir = (data as Record<string, unknown>).sessionDir
    if (typeof sessionDir !== 'string' || !sessionDir.trim()) return null

    return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir)
  } catch {
    return null
  }
}

export function getPiSessionsDir(): string {
  const agentDir = getPiAgentDir()
  return readSessionDirFromSettings(agentDir) ?? join(agentDir, 'sessions')
}

function walkJsonlFiles(dir: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    // Force string names.
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as unknown as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const e of entries) {
    const name = typeof (e as any).name === 'string' ? (e as any).name : String((e as any).name)
    const p = join(dir, name)
    if (e.isDirectory()) walkJsonlFiles(p, out)
    else if (e.isFile() && name.endsWith('.jsonl')) out.push(p)
  }
}

function readFirstLine(path: string): string | null {
  // Avoid reading the whole file.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return null
    const s = buf.subarray(0, n).toString('utf-8')
    const idx = s.indexOf('\n')
    return idx === -1 ? s.trim() : s.slice(0, idx).trim()
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function readTail(path: string, tailBytes = DEFAULT_TAIL_BYTES): string {
  const st = statSync(path)
  const start = Math.max(0, st.size - tailBytes)
  const len = st.size - start

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function parseSessionHeader(firstLine: string): { sessionId: string; cwd: string } | null {
  try {
    const obj = JSON.parse(firstLine) as any
    if (obj?.type !== 'session' || obj.piSubagent === true) return null
    const sessionId = typeof obj?.id === 'string' ? obj.id : null
    const cwd = typeof obj?.cwd === 'string' ? obj.cwd : null
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  }
}

function sessionInfoNameFromLine(line: string): string | null {
  try {
    const obj = JSON.parse(line) as unknown
    if (
      obj &&
      typeof obj === 'object' &&
      'type' in obj &&
      obj.type === 'session_info' &&
      'name' in obj &&
      typeof obj.name === 'string' &&
      obj.name.trim()
    ) {
      return obj.name.trim()
    }
  } catch {
    // ignore
  }
  return null
}

function pickTitleFromTail(tail: string): string | null {
  // Try to find the *latest* session_info entry (stores the user-provided name).
  // We scan backwards line-by-line.
  const lines = tail.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    const name = sessionInfoNameFromLine(line)
    if (name) return name
  }
  return null
}

function scanSessionInfoNameFromFile(path: string): string | null {
  // Fallback when the session_info entry is older than our tail window.
  // Scan the whole file line-by-line and remember the last session_info.name.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const decoder = new StringDecoder('utf8')
    let leftover = ''
    let offset = 0
    let lastName: string | null = null

    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n <= 0) break
      offset += n

      const chunk = leftover + decoder.write(buf.subarray(0, n))
      const lines = chunk.split(/\r?\n/)
      leftover = lines.pop() ?? ''

      for (const line0 of lines) {
        const line = line0.trim()
        if (!line) continue
        const name = sessionInfoNameFromLine(line)
        if (name) lastName = name
      }
    }

    // Best-effort: parse leftover if it was a full line without trailing newline.
    const name = sessionInfoNameFromLine((leftover + decoder.end()).trim())
    if (name) lastName = name

    return lastName
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function pickUpdatedAtFromTail(tail: string): string | null {
  // pi's `/resume` effectively orders sessions by last *message* activity.
  // We scan backwards and pick the timestamp of the most recent entry with type === "message".
  const lines = tail.split(/\r?\n/)

  // 1) Prefer the most recent message entry.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type !== 'message') continue
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  // 2) Fallback: any valid timestamp (covers sessions that somehow have no messages).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  return null
}

function pickFallbackTitleFromHead(path: string): string | null {
  // Fallback to the first usable user message in the first 2000 lines.
  try {
    const raw = readFileSync(path, { encoding: 'utf8' })
    const lines = raw.split(/\r?\n/)
    for (const line0 of lines.slice(0, 2000)) {
      const line = line0.trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line) as unknown
        if (!obj || typeof obj !== 'object' || !('type' in obj) || obj.type !== 'message' || !('message' in obj)) {
          continue
        }
        const message = obj.message
        if (
          message &&
          typeof message === 'object' &&
          'role' in message &&
          message.role === 'user' &&
          'content' in message
        ) {
          const title = titleFromContent(message.content)
          if (title) return title
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  return null
}

export function readPiSessionTitle(path: string, tail?: string): string | null {
  try {
    const title = pickTitleFromTail(tail ?? readTail(path))
    if (title) return title
  } catch {
    // ignore
  }

  try {
    return scanSessionInfoNameFromFile(path) ?? pickFallbackTitleFromHead(path)
  } catch {
    return null
  }
}

export function listPiSessions(): PiSessionListItem[] {
  const sessionsDir = getPiSessionsDir()
  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  const items: PiSessionListItem[] = []

  for (const file of files) {
    const first = readFirstLine(file)
    if (!first) continue
    const header = parseSessionHeader(first)
    if (!header) continue

    let updatedAt: string | null = null

    let tail: string | undefined
    try {
      tail = readTail(file)
      updatedAt = pickUpdatedAtFromTail(tail)
    } catch {
      // ignore
    }

    const title = readPiSessionTitle(file, tail)

    // Fallback for updatedAt when we couldn't parse timestamps from tail.
    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString()
      } catch {
        updatedAt = null
      }
    }

    items.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file
    })
  }

  // Sort most recent first.
  items.sort((a, b) => {
    const aa = a.updatedAt ?? ''
    const bb = b.updatedAt ?? ''
    return bb.localeCompare(aa)
  })

  return items
}

export function readPiSessionBranch(path: string): Record<string, unknown>[] {
  const entries = new Map<string, Record<string, unknown>>()
  let leaf: Record<string, unknown> | undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      // Pi also skips malformed lines (including interrupted appends).
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (entry.type === 'session') continue
    if (
      typeof entry.id !== 'string' ||
      !entry.id ||
      entries.has(entry.id) ||
      (entry.parentId !== null && typeof entry.parentId !== 'string')
    )
      throw new Error('Invalid Pi session tree entry')
    entries.set(entry.id, entry)
    leaf = entry
  }
  // On cold open Pi selects the last persisted entry, not every entry in the file.
  const branch: Record<string, unknown>[] = []
  const visited = new Set<unknown>()
  while (leaf) {
    if (visited.has(leaf.id)) throw new Error('Cycle in Pi session tree')
    visited.add(leaf.id)
    branch.push(leaf)
    if (leaf.parentId === null) break
    leaf = entries.get(leaf.parentId as string)
    if (!leaf) throw new Error('Missing parent in Pi session tree')
  }
  return branch.reverse()
}

export function findPiSession(sessionId: string): PiSessionListItem | null {
  const all = listPiSessions()
  return all.find(s => s.sessionId === sessionId) ?? null
}

export function findPiSessionFile(sessionId: string): string | null {
  return findPiSession(sessionId)?.sessionFile ?? null
}

/**
 * Copy a pi session file next to its source with a fresh header id, so a new pi
 * process can open it as an independent session. The full append-only entry tree
 * is preserved, giving the fork the same fidelity as `session/load`.
 */
export function forkPiSessionFile(sourceFile: string, cwd: string): { sessionId: string; sessionFile: string } {
  const raw = readFileSync(sourceFile, 'utf8')
  const newline = raw.indexOf('\n')
  const firstLine = newline === -1 ? raw : raw.slice(0, newline)
  const rest = newline === -1 ? '' : raw.slice(newline)

  let header: Record<string, unknown>
  try {
    header = JSON.parse(firstLine) as Record<string, unknown>
  } catch {
    throw new Error(`Invalid pi session header in ${sourceFile}`)
  }
  if (header?.type !== 'session' || typeof header.id !== 'string') {
    throw new Error(`Invalid pi session header in ${sourceFile}`)
  }

  const sessionId = randomUUID()
  const timestamp = new Date().toISOString()
  const forkedHeader = { ...header, id: sessionId, timestamp, cwd, parentSession: sourceFile }
  const sessionFile = join(dirname(sourceFile), `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`)

  writeFileSync(sessionFile, JSON.stringify(forkedHeader) + rest, { flag: 'wx' })
  return { sessionId, sessionFile }
}
