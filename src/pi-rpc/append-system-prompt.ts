import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const APPEND_SYSTEM_FILE = 'APPEND_SYSTEM.md'

/**
 * `--append-system-prompt` args for adapter text. Pi skips its own `APPEND_SYSTEM.md` discovery
 * whenever the flag is present, so the file pi would have used is passed explicitly first.
 */
export function appendSystemPromptArgs(text: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = discoverAppendSystemPromptFile(cwd, env)
  return [...(file ? ['--append-system-prompt', file] : []), '--append-system-prompt', text]
}

/** Mirrors pi's discovery: a trusted project `.pi/APPEND_SYSTEM.md` wins over the agent-dir file. */
export function discoverAppendSystemPromptFile(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentDir = piAgentDir(cwd, env)
  const projectPath = join(cwd, '.pi', APPEND_SYSTEM_FILE)
  if (existsSync(projectPath) && isProjectTrusted(cwd, agentDir)) return projectPath
  const globalPath = join(agentDir, APPEND_SYSTEM_FILE)
  return existsSync(globalPath) ? globalPath : undefined
}

// pi-acp never passes --approve and RPC mode has no trust prompt, so only the trust store and
// `defaultProjectTrust` decide. Extension `project_trust` handlers cannot be mirrored here.
function isProjectTrusted(cwd: string, agentDir: string): boolean {
  const stored = storedTrustDecision(cwd, agentDir)
  if (stored !== undefined) return stored
  return readJsonObject(join(agentDir, 'settings.json'))?.defaultProjectTrust === 'always'
}

function storedTrustDecision(cwd: string, agentDir: string): boolean | undefined {
  const data = readJsonObject(join(agentDir, 'trust.json'))
  if (!data) return undefined
  let dir = canonicalPath(resolve(cwd))
  while (true) {
    const value = data[dir]
    if (typeof value === 'boolean') return value
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function piAgentDir(cwd: string, env: NodeJS.ProcessEnv): string {
  const dir = env.PI_CODING_AGENT_DIR
  if (!dir) return join(homedir(), '.pi', 'agent')
  if (dir === '~') return homedir()
  return resolve(cwd, dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir)
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
