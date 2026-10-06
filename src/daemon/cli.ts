import { appendFileSync } from 'node:fs'
import { PI_ACP_VERSION } from '../version.js'
import { controlDaemon, runAttach } from './attach.js'
import { getDaemonPaths, type DaemonPaths } from './protocol.js'
import { DEFAULT_EXIT_IDLE_MS, DEFAULT_SESSION_IDLE_MS, DaemonAlreadyRunningError, PiAcpDaemon } from './server.js'

const USAGE = `Usage:
  pi-acp attach          Relay ACP stdio to the background daemon (starts it if needed)
  pi-acp daemon          Run the daemon in the foreground
  pi-acp daemon status   Show daemon sessions
  pi-acp daemon stop     Stop the daemon and all of its sessions
`

function durationEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value * 1000 : fallback
}

function logger(paths: DaemonPaths): (message: string) => void {
  return message => {
    const line = `${new Date().toISOString()} [${process.pid}] ${message}\n`
    // Detached daemons write stdout/stderr to the log file already; foreground runs show it.
    if (process.stderr.isTTY) process.stderr.write(line)
    else {
      try {
        appendFileSync(paths.log, line, { mode: 0o600 })
      } catch {
        process.stderr.write(line)
      }
    }
  }
}

async function runDaemon(paths: DaemonPaths): Promise<number> {
  const daemon = new PiAcpDaemon({
    paths,
    version: PI_ACP_VERSION,
    sessionIdleMs: durationEnv('PI_ACP_DAEMON_SESSION_IDLE_SECONDS', DEFAULT_SESSION_IDLE_MS),
    exitIdleMs: durationEnv('PI_ACP_DAEMON_EXIT_IDLE_SECONDS', DEFAULT_EXIT_IDLE_MS),
    detachedInputTimeoutMs: durationEnv('PI_ACP_DAEMON_INPUT_TIMEOUT_SECONDS', 24 * 60 * 60 * 1000),
    log: logger(paths)
  })
  try {
    await daemon.start()
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      process.stderr.write(`pi-acp: ${error.message}\n`)
      return 0
    }
    throw error
  }
  // The daemon must survive the terminal or ssh session that started it.
  process.on('SIGHUP', () => {})
  process.on('SIGINT', () => void daemon.stop('SIGINT'))
  process.on('SIGTERM', () => void daemon.stop('SIGTERM'))
  process.on('uncaughtException', error => logger(paths)(`uncaught exception: ${error?.stack ?? error}`))
  process.on('unhandledRejection', error => logger(paths)(`unhandled rejection: ${String(error)}`))
  await daemon.stopped
  return 0
}

export async function runCli(args: string[]): Promise<number> {
  const paths = getDaemonPaths()
  const [command, action] = args
  if (command === 'attach') {
    try {
      return await runAttach({ paths, version: PI_ACP_VERSION })
    } catch (error) {
      process.stderr.write(`pi-acp: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  if (command === 'daemon' && !action) return runDaemon(paths)
  if (command === 'daemon' && (action === 'status' || action === 'stop')) {
    const hello = await controlDaemon({ paths, version: PI_ACP_VERSION }, action)
    if (!hello) {
      process.stdout.write('pi-acp daemon is not running\n')
      return action === 'status' ? 1 : 0
    }
    if (action === 'stop') process.stdout.write(`stopping pi-acp daemon (pid ${hello.pid})\n`)
    else process.stdout.write(`${JSON.stringify(hello.status ?? hello, null, 2)}\n`)
    return 0
  }
  process.stderr.write(USAGE)
  return 2
}
