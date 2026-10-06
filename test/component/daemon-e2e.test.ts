import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const repo = fileURLToPath(new URL('../../', import.meta.url))

type Message = { id?: number; method?: string; params?: any; result?: any; error?: unknown }

function attach(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', 'attach'], {
    cwd: repo,
    env,
    stdio: 'pipe'
  }) as ChildProcessWithoutNullStreams
  let stderr = ''
  child.stderr.on('data', chunk => (stderr += String(chunk)))
  const notifications: Message[] = []
  const responses = new Map<number, (message: Message) => void>()
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line) as Message
    if (message.id !== undefined && responses.has(message.id)) responses.get(message.id)!(message)
    else if (message.method) notifications.push(message)
  })
  let id = 0
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  async function request(method: string, params: unknown): Promise<any> {
    const requestId = ++id
    const response = new Promise<Message>(resolve => responses.set(requestId, resolve))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const message = await Promise.race([
        response,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`attach timed out on ${method}: ${stderr}`)), 15000)
        })
      ])
      assert.equal(message.error, undefined, JSON.stringify(message.error))
      return message.result
    } finally {
      clearTimeout(timer)
    }
  }
  return { child, request, notifications, exited }
}

test(
  'daemon: pi sessions survive the attach relay disconnecting',
  { skip: process.platform === 'win32', timeout: 60000 },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-daemon-'))
    const home = join(root, 'home')
    const agentDir = join(root, 'agent')
    mkdirSync(home)
    mkdirSync(join(agentDir, 'sessions'), { recursive: true })
    const executable = join(root, 'fake-pi.mjs')
    copyFileSync(fileURLToPath(new URL('../fixtures/daemon-pi.mjs', import.meta.url)), executable)
    chmodSync(executable, 0o755)
    const env = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_ACP_PI_COMMAND: executable,
      PI_ACP_DAEMON_DIR: join(root, 'd')
    }
    const control = (action: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'daemon', action], {
        cwd: repo,
        env,
        encoding: 'utf8'
      })
    const piPids = () =>
      readdirSync(agentDir)
        .filter(name => name.endsWith('.started'))
        .map(name => name.split('.')[0]!)
    t.after(() => {
      control('stop')
      for (const pid of piPids()) {
        try {
          process.kill(Number(pid), 'SIGKILL')
        } catch {
          /* already exited */
        }
      }
      rmSync(root, { recursive: true, force: true })
    })

    const first = attach(env)
    await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const created = await first.request('session/new', { cwd: root, mcpServers: [] })
    const sessionId = created.sessionId as string
    assert.ok(sessionId)
    assert.equal(piPids().length, 1)

    // Simulate the ssh connection dropping.
    first.child.stdin.end()
    first.child.kill('SIGHUP')
    await first.exited
    await delay(300)
    const [pid] = piPids()
    assert.ok(!existsSync(join(agentDir, `${pid}.stopped`)), 'pi must keep running after the client disconnects')

    const status = control('status')
    assert.equal(status.status, 0, status.stderr)
    const parsed = JSON.parse(status.stdout) as { sessions: Array<{ sessionId: string; attached: boolean }> }
    assert.deepEqual(
      parsed.sessions.map(s => [s.sessionId, s.attached]),
      [[sessionId, false]]
    )

    const second = attach(env)
    await second.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const loaded = await second.request('session/load', { sessionId, cwd: root, mcpServers: [] })
    assert.equal(loaded._meta?.piAcp?.reattached, true)
    assert.equal(piPids().length, 1, 'reattach must reuse the running pi process')
    assert.ok(
      second.notifications.some(
        n =>
          n.params?.update?.sessionUpdate === 'user_message_chunk' &&
          n.params.update.content?.text === 'hello from before'
      )
    )

    second.child.stdin.end()
    await second.exited
    const stopped = control('stop')
    assert.equal(stopped.status, 0, stopped.stderr)
    const deadline = Date.now() + 5000
    while (!existsSync(join(agentDir, `${pid}.stopped`)) && Date.now() < deadline) await delay(20)
    assert.ok(existsSync(join(agentDir, `${pid}.stopped`)), 'daemon stop must terminate pi')
  }
)
