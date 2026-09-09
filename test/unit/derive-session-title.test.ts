import test from 'node:test'
import assert from 'node:assert/strict'

// Minimal local impl (mirrors extensions/pi-acp-session-title.ts; the extension
// imports pi types that are not resolvable in this repo).
const MAX_TITLE_LENGTH = 80

function deriveSessionTitle(message: string): string | null {
  const firstLine = message
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0)

  if (!firstLine || firstLine.startsWith('/')) return null

  const collapsed = firstLine.replace(/\s+/g, ' ')
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
}

test('deriveSessionTitle: uses first non-empty line', () => {
  assert.equal(deriveSessionTitle('\n\nFix the login bug\nmore details'), 'Fix the login bug')
})

test('deriveSessionTitle: collapses whitespace', () => {
  assert.equal(deriveSessionTitle('Fix   the\t login bug'), 'Fix the login bug')
})

test('deriveSessionTitle: truncates long lines with ellipsis', () => {
  const title = deriveSessionTitle('a'.repeat(200))
  assert.ok(title)
  assert.equal(title.length, 80)
  assert.ok(title.endsWith('…'))
})

test('deriveSessionTitle: returns null for slash commands', () => {
  assert.equal(deriveSessionTitle('/compact'), null)
  assert.equal(deriveSessionTitle('  /name foo'), null)
})

test('deriveSessionTitle: returns null for empty input', () => {
  assert.equal(deriveSessionTitle(''), null)
  assert.equal(deriveSessionTitle('   \n  '), null)
})
