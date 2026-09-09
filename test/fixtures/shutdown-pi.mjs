#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const directory = process.env.PI_CODING_AGENT_DIR
writeFileSync(join(directory, `${process.pid}.started`), '')
process.on('SIGTERM', () => {
  writeFileSync(join(directory, `${process.pid}.stopped`), '')
  process.exit(0)
})
// Keep the fake subprocess alive after its parent closes the pipes: shutdown must
// explicitly signal it, not rely on EOF accidentally ending this test fixture.
setInterval(() => {}, 1000)
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line)
  const data =
    command.type === 'get_state'
      ? { sessionId: `session-${process.pid}`, thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
      : command.type === 'get_available_models'
        ? { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
        : {}
  process.stdout.write(
    `${JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data })}\n`
  )
})
