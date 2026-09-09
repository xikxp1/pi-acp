import test from 'node:test'
import assert from 'node:assert/strict'
import { todoDetailsToPlan } from '../../src/acp/translate/plan.js'

test('todoDetailsToPlan: translates all statuses and priorities', () => {
  const todos = [
    { content: 'First', status: 'pending', priority: 'high' },
    { content: 'Second', status: 'in_progress', priority: 'medium' },
    { content: 'Third', status: 'completed', priority: 'low' }
  ]
  assert.deepEqual(todoDetailsToPlan({ todos }), todos)
})

test('todoDetailsToPlan: rejects missing or malformed details', () => {
  for (const details of [undefined, null, false, 1, 'todos', [], {}, { todos: null }, { todos: {} }]) {
    assert.equal(todoDetailsToPlan(details), null)
  }
})

test('todoDetailsToPlan: skips malformed entries and strips extra fields', () => {
  const valid = { content: 'Keep', status: 'pending', priority: 'high' }
  assert.deepEqual(
    todoDetailsToPlan({
      todos: [
        null,
        undefined,
        1,
        'bad',
        {},
        { ...valid, content: 1 },
        { ...valid, status: 'unknown' },
        { ...valid, priority: 'urgent' },
        { content: 'Missing fields' },
        { ...valid, extra: true }
      ]
    }),
    [valid]
  )
})

test('todoDetailsToPlan: preserves empty plans and skips all invalid entries', () => {
  assert.deepEqual(todoDetailsToPlan({ todos: [] }), [])
  assert.deepEqual(todoDetailsToPlan({ todos: [null, {}] }), [])
})
