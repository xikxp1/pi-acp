import test from 'node:test'
import assert from 'node:assert/strict'
import { toToolResultTitle } from '../../src/acp/translate/tool-presentation.js'

function textResult(...texts: string[]) {
  return { content: texts.map(text => ({ type: 'text', text })) }
}

test('toToolResultTitle: generic tools retain their identity and trim result text', () => {
  assert.equal(
    toToolResultTitle('CustomTool', textResult(' \tCompleted successfully\t ')),
    'CustomTool: Completed successfully'
  )
  assert.equal(toToolResultTitle('custom_tool', ' \tCompleted successfully\t '), 'custom_tool: Completed successfully')
})

test('toToolResultTitle: text-only blocks concatenate without inserted separators', () => {
  assert.equal(
    toToolResultTitle('custom', textResult('  Com', '', 'pleted ', 'successfully  ')),
    'custom: Completed successfully'
  )
})

test('toToolResultTitle: an exactly 80-codepoint summary is not truncated', () => {
  const summary = 'a'.repeat(80)
  assert.equal(toToolResultTitle('custom', textResult(`  ${summary}  `)), `custom: ${summary}`)
})

test('toToolResultTitle: an 81-codepoint summary truncates to 80 including ellipsis', () => {
  assert.equal(toToolResultTitle('custom', textResult('a'.repeat(81))), `custom: ${'a'.repeat(79)}…`)
})

test('toToolResultTitle: summary truncation never truncates the tool identity', () => {
  const name = `CustomTool_${'identity'.repeat(20)}`
  assert.equal(toToolResultTitle(name, 'x'.repeat(200)), `${name}: ${'x'.repeat(79)}…`)
})

test('toToolResultTitle: truncation counts Unicode codepoints without splitting emoji', () => {
  const exact = '😀'.repeat(80)
  assert.equal(toToolResultTitle('custom', exact), `custom: ${exact}`)
  const truncated = `${'😀'.repeat(79)}…`
  assert.equal(toToolResultTitle('custom', textResult('😀'.repeat(81))), `custom: ${truncated}`)
  assert.equal(Array.from(truncated).length, 80)
  assert.equal(toToolResultTitle('custom', `${'a'.repeat(78)}😀bc`), `custom: ${'a'.repeat(78)}😀…`)
})

test('toToolResultTitle: empty and whitespace-only results preserve the existing title', () => {
  for (const text of ['', ' ', '\t', ' \t\u00a0 ']) {
    assert.equal(toToolResultTitle('custom', text), undefined)
    assert.equal(toToolResultTitle('custom', textResult(text)), undefined)
  }
  assert.equal(toToolResultTitle('custom', textResult('', ' ', '\t')), undefined)
  assert.equal(toToolResultTitle('', 'Completed'), undefined)
  assert.equal(toToolResultTitle(' \t ', 'Completed'), undefined)
})

test('toToolResultTitle: every line separator is rejected even at text boundaries', () => {
  for (const separator of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
    for (const text of [`first${separator}second`, `${separator}Completed`, `Completed${separator}`, separator]) {
      assert.equal(toToolResultTitle('custom', text), undefined, JSON.stringify(text))
      assert.equal(toToolResultTitle('custom', textResult(text)), undefined, JSON.stringify(text))
    }
    assert.equal(toToolResultTitle('custom', textResult('Completed', separator, 'successfully')), undefined)
  }
})

test('toToolResultTitle: non-text and mixed content preserve the existing title', () => {
  for (const block of [
    { type: 'image', data: 'encoded', mimeType: 'image/png' },
    { type: 'resource', resource: { uri: 'file:///result', text: 'Completed' } },
    { type: 'audio', data: 'encoded', mimeType: 'audio/wav' },
    { type: 'unknown', text: 'Completed' }
  ]) {
    assert.equal(toToolResultTitle('custom', { content: [block] }), undefined)
    assert.equal(toToolResultTitle('custom', { content: [{ type: 'text', text: 'Completed' }, block] }), undefined)
    assert.equal(toToolResultTitle('custom', { content: [block, { type: 'text', text: 'Completed' }] }), undefined)
  }
})

test('toToolResultTitle: JSON objects and arrays are rejected as strings or text blocks', () => {
  for (const text of ['{}', '[]', ' {"status":"done"} ', '[1,"done",null]', '{"nested":{"ok":true}}']) {
    assert.equal(toToolResultTitle('custom', text), undefined, text)
    assert.equal(toToolResultTitle('custom', textResult(text)), undefined, text)
    assert.equal(toToolResultTitle('custom', textResult('Result: ', text)), undefined, text)
    assert.equal(toToolResultTitle('custom', textResult(text, ' complete')), undefined, text)
  }
})

test('toToolResultTitle: JSON objects and arrays assembled from text blocks are rejected', () => {
  assert.equal(toToolResultTitle('custom', textResult('{"status":', '"done"}')), undefined)
  assert.equal(toToolResultTitle('custom', textResult('[', '1,2', ']')), undefined)
})

test('toToolResultTitle: primitive JSON and non-JSON prose remain valid summaries', () => {
  for (const text of ['true', 'false', 'null', '42', '"done"', '{not JSON}', '[done]', 'Result: {"status":"done"}']) {
    assert.equal(toToolResultTitle('custom', text), `custom: ${text}`)
    assert.equal(toToolResultTitle('custom', textResult(text)), `custom: ${text}`)
  }
})

test('toToolResultTitle: missing and malformed content preserve the existing title', () => {
  const malformed: unknown[] = [
    undefined,
    null,
    true,
    42,
    {},
    [],
    { text: 'Completed' },
    { content: undefined },
    { content: null },
    { content: 'Completed' },
    { content: {} },
    { content: [] },
    { content: [null] },
    { content: [undefined] },
    { content: ['Completed'] },
    { content: [42] },
    { content: [{}] },
    { content: [{ text: 'Completed' }] },
    { content: [{ type: 'text' }] },
    { content: [{ type: 'text', text: null }] },
    { content: [{ type: 'text', text: 42 }] },
    { content: [{ type: 'text', text: ['Completed'] }] },
    { content: [{ type: 'text', text: 'Completed' }, null] }
  ]
  for (const result of malformed) {
    assert.equal(toToolResultTitle('custom', result), undefined, JSON.stringify(result))
  }
})

test('toToolResultTitle: specialized tools preserve titles regardless of name casing', () => {
  for (const name of [
    'bash',
    'powershell',
    'read',
    'write',
    'edit',
    'grep',
    'find',
    'ls',
    'glob',
    'ffgrep',
    'fffind',
    'web_search',
    'fetch_content',
    'source_check',
    'get_search_content',
    'webfetch',
    'websearch',
    'todo',
    'think',
    'Agent',
    'subagent'
  ]) {
    for (const variant of [name, name.toLowerCase(), name.toUpperCase(), name[0]!.toUpperCase() + name.slice(1)]) {
      assert.equal(toToolResultTitle(variant, 'Completed successfully'), undefined, variant)
      assert.equal(toToolResultTitle(variant, textResult('Completed successfully')), undefined, variant)
    }
  }
})

test('toToolResultTitle: deriving a title leaves the full result payload untouched', () => {
  const text = `  ${'😀'.repeat(100)}  `
  const result = Object.freeze({
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    details: Object.freeze({ status: 'done', raw: 'Keep full tool output' })
  })
  const before = structuredClone(result)
  assert.equal(toToolResultTitle('custom', result), `custom: ${'😀'.repeat(79)}…`)
  assert.deepEqual(result, before)

  const rejected = Object.freeze({
    content: Object.freeze([
      Object.freeze({ type: 'text', text: 'Completed' }),
      Object.freeze({ type: 'image', data: 'encoded', mimeType: 'image/png' })
    ])
  })
  const rejectedBefore = structuredClone(rejected)
  assert.equal(toToolResultTitle('custom', rejected), undefined)
  assert.deepEqual(rejected, rejectedBefore)
})
