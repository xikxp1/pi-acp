import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import extension, {
  ASK_USER_ACP_GUIDELINES,
  addAskUserGuidelines,
  type AskUserPi,
  type PromptOptions
} from '../../extensions/pi-acp-ask-user.js'

const previousEnv = process.env.PI_ACP_ASK_USER
afterEach(() => {
  if (previousEnv === undefined) delete process.env.PI_ACP_ASK_USER
  else process.env.PI_ACP_ASK_USER = previousEnv
})

function setup() {
  let handler: ((event: { systemPromptOptions: PromptOptions }, ctx: { mode?: string }) => void) | undefined
  const pi: AskUserPi = {
    on(event, fn) {
      assert.equal(event, 'before_agent_start')
      handler = fn
    }
  }
  extension(pi)
  return (mode: string, toolGuidelines: Record<string, string[]> = {}) => {
    const options: PromptOptions = { toolGuidelines }
    handler?.({ systemPromptOptions: options }, { mode })
    return options.toolGuidelines
  }
}

test('ask_user extension appends ACP guidelines after existing ask_user guidelines in pi-acp RPC sessions', () => {
  process.env.PI_ACP_ASK_USER = '1'
  const run = setup()
  const guidelines = run('rpc', { ask_user: ['Ask one question.'], read: ['Read first.'] })
  assert.deepEqual(guidelines.ask_user, ['Ask one question.', ...ASK_USER_ACP_GUIDELINES])
  assert.deepEqual(guidelines.read, ['Read first.'])
})

test('ask_user extension is inert outside pi-acp RPC sessions', () => {
  delete process.env.PI_ACP_ASK_USER
  assert.deepEqual(setup()('rpc'), {})

  process.env.PI_ACP_ASK_USER = '1'
  assert.deepEqual(setup()('tui'), {})
})

test('addAskUserGuidelines does not duplicate rules', () => {
  const options: PromptOptions = { toolGuidelines: {} }
  addAskUserGuidelines(options)
  const first = options.toolGuidelines.ask_user
  addAskUserGuidelines(options)
  assert.deepEqual(options.toolGuidelines.ask_user, [...ASK_USER_ACP_GUIDELINES])
  assert.equal(options.toolGuidelines.ask_user, first)
})
