import test from 'node:test'
import assert from 'node:assert/strict'
import { ClientDetachedError, ClientLink, type SessionClient } from '../../src/acp/client-link.js'
import { FakeAgentSideConnection } from '../helpers/fakes.js'
import { deferred, nextTick } from '../helpers/rpc-child.js'

const permission = { sessionId: 's', toolCall: { toolCallId: 't' }, options: [] }

function client(conn = new FakeAgentSideConnection()): SessionClient {
  return conn as unknown as SessionClient
}

test('ClientLink: non-durable link forwards directly to its client', async () => {
  const conn = new FakeAgentSideConnection()
  const link = new ClientLink(client(conn))
  await link.sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'plan', entries: [] } })
  const response = await link.requestPermission(permission as never)
  assert.equal(conn.updates.length, 1)
  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(response.outcome, { outcome: 'selected', optionId: 'allow' })
})

test('ClientLink: detached link drops output and rejects fs/terminal delegation', async () => {
  const conn = new FakeAgentSideConnection()
  const first = client(conn)
  const link = new ClientLink(first, { durable: true })
  assert.equal(link.detach(client()), false, 'only the current client can detach')
  assert.equal(link.detach(first), true)
  assert.ok(link.detachedAt !== undefined)
  await link.sessionUpdate({ sessionId: 's', update: { sessionUpdate: 'plan', entries: [] } })
  assert.equal(conn.updates.length, 0)
  await assert.rejects(link.readTextFile({ sessionId: 's', path: '/x' }), ClientDetachedError)
  await assert.rejects(link.createTerminal({ sessionId: 's', command: 'ls' }), ClientDetachedError)
})

test('ClientLink: durable permission request waits for the next client', async () => {
  const link = new ClientLink(null, { durable: true })
  const pending = link.requestPermission(permission as never)
  await nextTick()
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'later' } }
  link.attach(client(conn))
  assert.deepEqual((await pending).outcome, { outcome: 'selected', optionId: 'later' })
})

test('ClientLink: request is re-issued when the client is replaced before answering', async () => {
  const stalled = new FakeAgentSideConnection()
  const never = deferred<never>()
  stalled.requestPermission = async (params: unknown) => {
    stalled.permissionRequests.push(params)
    return never.promise
  }
  const link = new ClientLink(client(stalled), { durable: true })
  const pending = link.requestPermission(permission as never)
  await nextTick()
  assert.equal(stalled.permissionRequests.length, 1)
  const next = new FakeAgentSideConnection()
  link.attach(client(next))
  await pending
  assert.equal(next.permissionRequests.length, 1)
})

test('ClientLink: request waits until a reattached client finished its replay', async () => {
  const link = new ClientLink(null, { durable: true })
  const conn = new FakeAgentSideConnection()
  const replay = deferred<void>()
  link.attach(client(conn), replay.promise)
  const pending = link.requestPermission(permission as never)
  await nextTick()
  assert.equal(conn.permissionRequests.length, 0)
  replay.resolve()
  await pending
  assert.equal(conn.permissionRequests.length, 1)
})

test('ClientLink: detached requests cancel on timeout and on close', async () => {
  const timed = new ClientLink(null, { durable: true, detachedInputTimeoutMs: 10 })
  assert.deepEqual((await timed.requestPermission(permission as never)).outcome, { outcome: 'cancelled' })

  const closed = new ClientLink(null, { durable: true })
  const pending = closed.unstable_createElicitation({} as never)
  closed.close()
  assert.deepEqual(await pending, { action: 'cancel' })
})

test('ClientLink: delivery to a superseded client stops waiting', async () => {
  const stalled = new FakeAgentSideConnection()
  stalled.sessionUpdate = () => new Promise<void>(() => {})
  const link = new ClientLink(client(stalled), { durable: true })
  const target = link.outputTarget()!
  const delivery = link.deliver(target, { sessionId: 's', update: { sessionUpdate: 'plan', entries: [] } })
  link.attach(client())
  await delivery
})
