#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const directory = process.env.PI_CODING_AGENT_DIR
const sessionId = `session-${process.pid}`
writeFileSync(join(directory, `${process.pid}.started`), '')
process.on('SIGTERM', () => {
  writeFileSync(join(directory, `${process.pid}.stopped`), '')
  process.exit(0)
})
// Must outlive closed pipes: only an explicit signal may stop it.
setInterval(() => {}, 1000)
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line)
  const data =
    command.type === 'get_state'
      ? {
          sessionId,
          sessionFile: join(directory, 'sessions', `${sessionId}.jsonl`),
          thinkingLevel: 'medium',
          model: { provider: 'test', id: 'model' },
          isStreaming: false,
          isCompacting: false
        }
      : command.type === 'get_available_models'
        ? { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
        : command.type === 'get_available_thinking_levels'
          ? { levels: ['off', 'medium', 'high'] }
          : command.type === 'get_messages'
            ? { messages: [{ role: 'user', content: 'hello from before' }] }
            : {}
  process.stdout.write(
    `${JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data })}\n`
  )
})
