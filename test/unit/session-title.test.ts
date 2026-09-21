import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { listPiSessions, readPiSessionTitle } from '../../src/acp/pi-sessions.js'
import { titleFromContent } from '../../src/acp/session-title.js'

const header = JSON.stringify({ type: 'session', version: 3, id: 'title-test', cwd: '/tmp/project' })
const userMessage = (content: unknown) => JSON.stringify({ type: 'message', message: { role: 'user', content } })
const sessionInfo = (name: unknown) => JSON.stringify({ type: 'session_info', name })

function fixture(t: TestContext, lines: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-title-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'sessions', '--project--', 'session.jsonl')
  mkdirSync(dirname(file), { recursive: true })
  const raw = [header, ...lines].join('\n')
  writeFileSync(file, raw)
  return { root, file, raw }
}

test('titleFromContent normalizes all whitespace across lines', () => {
  assert.equal(titleFromContent(' \n Fix\t the\r\nlogin\u00a0bug\u2003 now  '), 'Fix the login bug now')
  assert.equal(titleFromContent(' /compact\nplease '), '/compact please')
})

test('titleFromContent joins all valid text blocks and ignores non-text or malformed blocks', () => {
  assert.equal(
    titleFromContent([
      { type: 'text', text: '  Fix\nlogin ' },
      { type: 'image', text: 'ignore me' },
      null,
      12,
      'not a block',
      { type: 'text', text: 123 },
      { text: 'missing type' },
      { type: 'text', text: '\tand logout  ' }
    ]),
    'Fix login and logout'
  )
})

test('titleFromContent returns null for missing, blank, textless, and malformed content', () => {
  for (const content of [
    undefined,
    null,
    false,
    42,
    {},
    { type: 'text', text: 'not an array' },
    '',
    ' \n\t\r ',
    [],
    [{ type: 'image', data: 'image' }],
    [{ type: 'text', text: '  ' }],
    [{ type: 'text', text: null }, null, false]
  ]) {
    assert.equal(titleFromContent(content), null)
  }
})

test('titleFromContent truncates at 80 Unicode code points without an ellipsis', () => {
  assert.equal(titleFromContent('a'.repeat(81)), 'a'.repeat(80))
  assert.equal(titleFromContent('😀'.repeat(81)), '😀'.repeat(80))
  assert.equal(titleFromContent('a'.repeat(79) + '😀tail'), 'a'.repeat(79) + '😀')
  assert.equal(titleFromContent('x'.repeat(80)), 'x'.repeat(80))
})

test('readPiSessionTitle uses the latest valid explicit name unchanged except outer whitespace', t => {
  const name = 'Explicit  title\n' + '😀'.repeat(85)
  const { file } = fixture(t, [
    userMessage('Fallback title'),
    sessionInfo('Old name'),
    sessionInfo(`  ${name}  `),
    sessionInfo(' \t '),
    sessionInfo(123),
    '{invalid json',
    'null',
    '[]'
  ])
  assert.equal(readPiSessionTitle(file), name)
  assert.equal(readPiSessionTitle(file, ''), name)
})

test('readPiSessionTitle finds the latest explicit name outside the tail window', t => {
  const { file } = fixture(t, [
    userMessage('Fallback title'),
    sessionInfo('Old name'),
    sessionInfo('Named early'),
    JSON.stringify({ type: 'custom', data: 'x'.repeat(300 * 1024) }),
    sessionInfo(null),
    sessionInfo('  ')
  ])
  assert.equal(readPiSessionTitle(file), 'Named early')
})

test('readPiSessionTitle skips malformed and unusable messages before the first usable user text', t => {
  const content = [{ type: 'text', text: ' First\nusable ' }, { type: 'image' }, { type: 'text', text: '\tmessage ' }]
  const { file } = fixture(t, [
    '{broken',
    'null',
    '42',
    '[]',
    JSON.stringify({ type: 'message', message: null }),
    JSON.stringify({ type: 'message', message: 'malformed' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'Not the user' } }),
    userMessage(' \n '),
    userMessage([{ type: 'image' }]),
    userMessage({ type: 'text', text: 'malformed content' }),
    userMessage(content),
    userMessage('Later user text')
  ])
  assert.equal(readPiSessionTitle(file), titleFromContent(content))
})

test('readPiSessionTitle scans all of the first 2000 lines in longer sessions', t => {
  const { file } = fixture(t, [
    ...Array.from({ length: 1998 }, () => '{}'),
    userMessage('Title on line 2000'),
    ...Array.from({ length: 100 }, () => '{}')
  ])
  assert.equal(readPiSessionTitle(file), 'Title on line 2000')
})

test('readPiSessionTitle does not use fallback messages after line 2000', t => {
  const { file } = fixture(t, [...Array.from({ length: 1999 }, () => '{}'), userMessage('Too late')])
  assert.equal(readPiSessionTitle(file), null)
})

test('readPiSessionTitle preserves Unicode names split across scanner chunk boundaries', t => {
  const name = '😀 Unicode name'
  const info = sessionInfo(name)
  const infoPrefix = info.slice(0, info.indexOf('😀'))
  const emptyPadding = JSON.stringify({ type: 'custom', data: '' })
  const paddingLength = 256 * 1024 - 1 - Buffer.byteLength([header, emptyPadding, infoPrefix].join('\n'))
  const { file, raw } = fixture(t, [
    JSON.stringify({ type: 'custom', data: 'x'.repeat(paddingLength) }),
    info,
    JSON.stringify({ type: 'custom', data: 'x'.repeat(300 * 1024) })
  ])
  assert.equal(Buffer.from(raw).indexOf(Buffer.from('😀')), 256 * 1024 - 1)
  assert.equal(readPiSessionTitle(file), name)
})

test('readPiSessionTitle handles a final explicit name without a trailing newline during a full scan', t => {
  const { file } = fixture(t, [userMessage('Fallback'), sessionInfo('Final name 😀')])
  assert.equal(readPiSessionTitle(file, ''), 'Final name 😀')
})

test('readPiSessionTitle returns null for a missing file or a file without a usable title', t => {
  const { root, file } = fixture(t, ['{broken', sessionInfo(false), userMessage([])])
  assert.equal(readPiSessionTitle(file), null)
  assert.equal(readPiSessionTitle(join(root, 'missing.jsonl')), null)
})

test('listPiSessions shares display-only fallback extraction without changing files or message updatedAt', t => {
  const content = [
    { type: 'text', text: '  First\nmessage ' },
    { type: 'text', text: '😀'.repeat(90) }
  ]
  const timestamp = '2026-01-01T00:00:01.000Z'
  const { root, file, raw } = fixture(t, [
    JSON.stringify({ type: 'message', timestamp, message: { role: 'user', content } }),
    ...Array.from({ length: 2100 }, () => '{}'),
    JSON.stringify({ type: 'custom', timestamp: '2026-01-02T00:00:00.000Z' })
  ])
  const beforeStat = statSync(file)
  const beforeFiles = readdirSync(root, { recursive: true })
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  t.after(() => {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  })

  const sessions = listPiSessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].title, titleFromContent(content))
  assert.equal(sessions[0].title, readPiSessionTitle(file))
  assert.equal(sessions[0].updatedAt, timestamp)
  assert.equal(readFileSync(file, 'utf8'), raw)
  assert.equal(statSync(file).mtimeMs, beforeStat.mtimeMs)
  assert.deepEqual(readdirSync(root, { recursive: true }), beforeFiles)
})
