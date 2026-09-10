import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import type { TerminalHandle } from '@agentclientprotocol/sdk'
import {
  ClientBridge,
  clientBridgeEnv,
  truncatedOutputDelta,
  type BridgeConnection
} from '../../src/acp/client-bridge.js'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const noTerminal = async (): Promise<TerminalHandle> => {
  throw new Error('terminal must not be created')
}

test('fs bridge routes concurrent requests, correlates responses and reports errors', async t => {
  const calls: unknown[] = []
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  const conn: BridgeConnection = {
    async readTextFile(params) {
      calls.push(params)
      if (params.path.endsWith('missing')) throw new Error('not found')
      await waiting
      return { content: 'unsaved\ntext' }
    },
    async writeTextFile(params) {
      calls.push(params)
      return {}
    },
    createTerminal: noTerminal
  }
  const bridge = await ClientBridge.create(conn, () => 's1', { read: true, write: true })
  assert.ok(bridge)
  t.after(() => bridge.close())
  const socket = createConnection(bridge.path)
  t.after(() => socket.destroy())
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]()
  socket.write(
    '{"id":"r","op":"readTextFile","path":"/file"}\n' +
      '{"id":"w","op":"writeTextFile","path":"/file","content":"new"}\n'
  )
  assert.deepEqual(JSON.parse((await lines.next()).value!), { id: 'w' })
  release()
  assert.deepEqual(JSON.parse((await lines.next()).value!), { id: 'r', content: 'unsaved\ntext' })
  assert.deepEqual(calls, [
    { sessionId: 's1', path: '/file' },
    { sessionId: 's1', path: '/file', content: 'new' }
  ])
  socket.write('{"id":"e","op":"readTextFile","path":"/missing"}\n')
  assert.deepEqual(JSON.parse((await lines.next()).value!), { id: 'e', error: 'not found' })
  bridge.close()
  bridge.close()
  if (process.platform !== 'win32') assert.equal(existsSync(bridge.path), false)
})

test('bridge is absent without capabilities and rejects unadvertised operations', async t => {
  const conn: BridgeConnection = {
    async readTextFile() {
      return { content: 'ok' }
    },
    async writeTextFile() {
      assert.fail('write must not be delegated')
    },
    createTerminal: noTerminal
  }
  assert.equal(await ClientBridge.create(conn, () => 's1'), undefined)
  assert.equal(clientBridgeEnv(undefined).PI_ACP_FS_SOCKET, undefined)
  assert.equal(clientBridgeEnv(undefined).PI_ACP_TERMINAL, undefined)
  assert.equal(clientBridgeEnv(undefined).PI_ACP_ADDITIONAL_DIRECTORIES, '[]')
  assert.equal(clientBridgeEnv(undefined, ['/lib']).PI_ACP_ADDITIONAL_DIRECTORIES, '["/lib"]')
  const bridge = await ClientBridge.create(conn, () => 's1', { read: true })
  assert.ok(bridge)
  t.after(() => bridge.close())
  assert.equal(bridge.env.PI_ACP_FS_CAPS, 'read')
  assert.equal(clientBridgeEnv(bridge, ['/lib']).PI_ACP_ADDITIONAL_DIRECTORIES, '["/lib"]')
  assert.equal(bridge.env.PI_ACP_TERMINAL, undefined)
  const socket = createConnection(bridge.path)
  t.after(() => socket.destroy())
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]()
  socket.write('{"id":"w","op":"writeTextFile","path":"/file","content":"no"}\n')
  const response = JSON.parse((await lines.next()).value!) as { id: string; error: string }
  assert.equal(response.id, 'w')
  assert.match(response.error, /capability/)
  socket.write('{"id":"t","op":"terminalRun","command":"ls"}\n')
  const terminal = JSON.parse((await lines.next()).value!) as { id: string; error: string }
  assert.equal(terminal.id, 't')
  assert.match(terminal.error, /capability/)
})

test('terminal bridge streams output deltas, exit status and supports kill', async t => {
  let output = ''
  let exitStatus: { exitCode: number | null; signal: string | null } | undefined
  let resolveExit!: () => void
  const exited = new Promise<void>(resolve => {
    resolveExit = resolve
  })
  const created: unknown[] = []
  const released: string[] = []
  let killed = 0
  const handle = {
    id: 'term-1',
    async currentOutput() {
      return { output, truncated: false, exitStatus: exitStatus ?? null }
    },
    async waitForExit() {
      await exited
      return exitStatus!
    },
    async kill() {
      killed += 1
      exitStatus = { exitCode: null, signal: 'SIGTERM' }
      resolveExit()
    },
    async release() {
      released.push('term-1')
    }
  } as unknown as TerminalHandle
  const attached: unknown[] = []
  const conn: BridgeConnection = {
    async readTextFile() {
      return { content: '' }
    },
    async writeTextFile() {
      return {}
    },
    async createTerminal(params) {
      created.push(params)
      return handle
    }
  }
  const bridge = await ClientBridge.create(
    conn,
    () => 's1',
    { terminal: true },
    { onTerminalCreated: (toolCallId, terminalId) => attached.push([toolCallId, terminalId]) }
  )
  assert.ok(bridge)
  t.after(() => bridge.close())
  assert.equal(bridge.env.PI_ACP_TERMINAL, '1')
  assert.equal(bridge.env.PI_ACP_FS_CAPS, undefined)

  const socket = createConnection(bridge.path)
  t.after(() => socket.destroy())
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]()
  socket.write(
    JSON.stringify({
      id: 'run',
      op: 'terminalRun',
      toolCallId: 'tc-1',
      command: 'echo hi',
      cwd: '/tmp',
      env: { PI_SESSION_ID: 'abc', BAD: 1 }
    }) + '\n'
  )
  assert.deepEqual(JSON.parse((await lines.next()).value!), { id: 'run', event: 'created', terminalId: 'term-1' })
  assert.deepEqual(attached, [['tc-1', 'term-1']])
  const request = created[0] as { command: string; args: string[]; cwd: string; env: unknown; sessionId: string }
  assert.equal(request.sessionId, 's1')
  assert.equal(request.command, 'echo hi')
  assert.deepEqual(request.args, [])
  assert.equal(request.cwd, '/tmp')
  assert.deepEqual(request.env, [{ name: 'PI_SESSION_ID', value: 'abc' }])

  output = 'hello '
  assert.deepEqual(JSON.parse((await lines.next()).value!), { id: 'run', event: 'output', data: 'hello ' })
  output = 'hello world\n'
  assert.deepEqual(JSON.parse((await lines.next()).value!), { id: 'run', event: 'output', data: 'world\n' })

  socket.write('{"id":"k","op":"terminalKill","run":"run"}\n')
  const remaining = [JSON.parse((await lines.next()).value!), JSON.parse((await lines.next()).value!)]
  assert.deepEqual(
    remaining.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    [{ id: 'k' }, { id: 'run', event: 'exit', exitCode: null, signal: 'SIGTERM' }]
  )
  assert.equal(killed, 1)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(released, ['term-1'])
})

test('terminal create failure is reported as a plain error before any event', async t => {
  const conn: BridgeConnection = {
    async readTextFile() {
      return { content: '' }
    },
    async writeTextFile() {
      return {}
    },
    async createTerminal() {
      throw new Error('client refused')
    }
  }
  const bridge = await ClientBridge.create(conn, () => 's1', { terminal: true })
  assert.ok(bridge)
  t.after(() => bridge.close())
  const socket = createConnection(bridge.path)
  t.after(() => socket.destroy())
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]()
  socket.write('{"id":"run","op":"terminalRun","command":"true"}\n')
  assert.deepEqual(JSON.parse((await lines.next()).value!), { id: 'run', error: 'client refused' })
})

test('truncated output delta re-anchors on the already sent tail', () => {
  assert.equal(truncatedOutputDelta('', 'abc'), 'abc')
  assert.equal(truncatedOutputDelta('ab', 'abc'), 'c')
  assert.equal(truncatedOutputDelta('0123456789', '56789abc'), 'abc')
  assert.equal(truncatedOutputDelta('xyz', 'unrelated'), 'unrelated')
})

test('session spawn receives bridge env only with advertised caps', async t => {
  for (const caps of [{}, { read: true }, { write: true }, { read: true, write: true }, { terminal: true }]) {
    let spawnParams: Parameters<typeof PiRpcProcess.spawn>[0] | undefined
    const mock = t.mock.method(PiRpcProcess, 'spawn', async (params: Parameters<typeof PiRpcProcess.spawn>[0]) => {
      spawnParams = params
      return {
        getState: async () => ({ sessionId: 'test-fs' }),
        onEvent: () => () => {},
        dispose: () => params.onDispose?.()
      } as unknown as PiRpcProcess
    })
    const manager = new SessionManager()
    try {
      await manager.create({
        cwd: process.cwd(),
        mcpServers: [],
        conn: asAgentConn(new FakeAgentSideConnection()),
        clientCapabilities: caps
      })
      assert.ok(spawnParams)
      assert.equal(Boolean(spawnParams.env?.PI_ACP_FS_SOCKET), Boolean(caps.read || caps.write || caps.terminal))
      assert.equal(
        spawnParams.env?.PI_ACP_FS_CAPS,
        [caps.read && 'read', caps.write && 'write'].filter(Boolean).join(',') || undefined
      )
      assert.equal(spawnParams.env?.PI_ACP_TERMINAL, caps.terminal ? '1' : undefined)
    } finally {
      manager.disposeAll()
      mock.mock.restore()
    }
  }
})
