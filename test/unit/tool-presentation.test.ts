import test from 'node:test'
import assert from 'node:assert/strict'
import { toToolKind, toToolTitle } from '../../src/acp/translate/tool-presentation.js'

const cwd = '/repo'

test('toToolKind maps pi and companion tools to ACP kinds', () => {
  assert.equal(toToolKind('read'), 'read')
  assert.equal(toToolKind('write'), 'edit')
  assert.equal(toToolKind('edit'), 'edit')
  assert.equal(toToolKind('bash'), 'execute')
  assert.equal(toToolKind('grep'), 'search')
  assert.equal(toToolKind('find'), 'search')
  assert.equal(toToolKind('ls'), 'search')
  assert.equal(toToolKind('web_search'), 'fetch')
  assert.equal(toToolKind('fetch_content'), 'fetch')
  assert.equal(toToolKind('todo'), 'think')
  assert.equal(toToolKind('Agent'), 'other')
  assert.equal(toToolKind('mystery'), 'other')
})

test('toToolTitle: file tools show a cwd-relative path', () => {
  assert.equal(toToolTitle('read', { path: '/repo/src/index.ts' }, cwd), 'read src/index.ts')
  assert.equal(toToolTitle('edit', { path: 'src/a.ts', edits: [] }, cwd), 'edit src/a.ts')
  assert.equal(toToolTitle('write', { file_path: '/elsewhere/x.txt' }, cwd), 'write /elsewhere/x.txt')
  assert.equal(toToolTitle('ls', { path: '/repo/docs' }, cwd), 'ls docs')
})

test('toToolTitle: search tools show pattern and optional path', () => {
  assert.equal(toToolTitle('grep', { pattern: 'toToolKind', path: '/repo/src' }, cwd), 'grep "toToolKind" in src')
  assert.equal(toToolTitle('grep', { pattern: 'x' }, cwd), 'grep "x"')
  assert.equal(toToolTitle('find', { pattern: '**/*.ts' }, cwd), 'find **/*.ts')
})

test('toToolTitle: fetch tools show query or url', () => {
  assert.equal(toToolTitle('web_search', { query: 'pi rpc mode' }, cwd), 'web_search "pi rpc mode"')
  assert.equal(toToolTitle('web_search', { queries: ['a', 'b'] }, cwd), 'web_search "a"')
  assert.equal(toToolTitle('fetch_content', { url: 'https://x.dev/p' }, cwd), 'fetch_content https://x.dev/p')
})

test('toToolTitle: falls back to bare name and truncates long args', () => {
  assert.equal(toToolTitle('read', {}, cwd), 'read')
  assert.equal(toToolTitle('read', null, cwd), 'read')
  assert.equal(toToolTitle('mystery', { foo: 1 }, cwd), 'mystery')
  const long = 'a'.repeat(200)
  const title = toToolTitle('grep', { pattern: long }, cwd)
  assert.ok(title.length < 100)
  assert.ok(title.endsWith('…"'))
})

test('toToolTitle: subagent tools keep their dedicated title', () => {
  assert.equal(
    toToolTitle('Agent', { subagent_type: 'Explore', description: 'Find X' }, cwd),
    'Agent (Explore): Find X'
  )
})
