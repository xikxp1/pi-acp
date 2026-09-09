import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { FsBridge, fsBridgeEnv } from '../../src/acp/fs-bridge.js'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('fs bridge routes concurrent requests, correlates responses and reports errors', async t => {
  const calls: unknown[] = []
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  const bridge = await FsBridge.create(
    {
      async readTextFile(params) {
        calls.push(params)
        if (params.path.endsWith('missing')) throw new Error('not found')
        await waiting
        return { content: 'unsaved\ntext' }
      },
      async writeTextFile(params) {
        calls.push(params)
        return {}
      }
    },
    () => 's1',
    { read: true, write: true }
  )
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

test('fs bridge is absent without capabilities and rejects unadvertised operations', async t => {
  const conn = {
    async readTextFile() {
      return { content: 'ok' }
    },
    async writeTextFile() {
      assert.fail('write must not be delegated')
    }
  }
  assert.equal(await FsBridge.create(conn, () => 's1'), undefined)
  assert.equal(fsBridgeEnv(undefined).PI_ACP_FS_SOCKET, undefined)
  const bridge = await FsBridge.create(conn, () => 's1', { read: true })
  assert.ok(bridge)
  t.after(() => bridge.close())
  assert.equal(bridge.env.PI_ACP_FS_CAPS, 'read')
  const socket = createConnection(bridge.path)
  t.after(() => socket.destroy())
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]()
  socket.write('{"id":"w","op":"writeTextFile","path":"/file","content":"no"}\n')
  const response = JSON.parse((await lines.next()).value!) as { id: string; error: string }
  assert.equal(response.id, 'w')
  assert.match(response.error, /capability/)
})

test('session spawn receives a filesystem socket only with advertised caps', async t => {
  for (const caps of [{}, { read: true }, { write: true }, { read: true, write: true }]) {
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
        fsCapabilities: caps
      })
      assert.ok(spawnParams)
      assert.equal(Boolean(spawnParams.env?.PI_ACP_FS_SOCKET), Boolean(caps.read || caps.write))
      assert.equal(
        spawnParams.env?.PI_ACP_FS_CAPS,
        [caps.read && 'read', caps.write && 'write'].filter(Boolean).join(',') || undefined
      )
    } finally {
      manager.disposeAll()
      mock.mock.restore()
    }
  }
})
