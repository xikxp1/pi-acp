import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

for (const disconnect of ['stdin end', 'SIGTERM'] as const) {
  test(
    `stdio: ${disconnect} terminates all retained pi subprocesses`,
    { skip: process.platform === 'win32', timeout: 20000 },
    async t => {
      const root = mkdtempSync(join(tmpdir(), 'pi-acp-shutdown-'))
      const executable = join(root, 'fake-pi.mjs')
      copyFileSync(fileURLToPath(new URL('../fixtures/shutdown-pi.mjs', import.meta.url)), executable)
      chmodSync(executable, 0o755)
      const adapter = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root, PI_ACP_PI_COMMAND: executable },
        stdio: 'pipe'
      })
      let stderr = ''
      adapter.stderr.on('data', chunk => {
        stderr += String(chunk)
      })
      const exited = new Promise<void>((resolve, reject) => {
        adapter.once('exit', () => resolve())
        adapter.once('error', reject)
      })
      t.after(() => {
        adapter.kill('SIGKILL')
        for (const file of readdirSync(root).filter(name => name.endsWith('.started'))) {
          try {
            process.kill(Number(file.split('.')[0]), 'SIGKILL')
          } catch {
            /* already exited */
          }
        }
        rmSync(root, { recursive: true, force: true })
      })
      const responses = new Map<number, (message: { result?: { sessionId?: string }; error?: unknown }) => void>()
      const lines = createInterface({ input: adapter.stdout })
      lines.on('line', line => {
        const message = JSON.parse(line)
        responses.get(message.id)?.(message)
      })
      let id = 0
      async function request(method: string, params: unknown) {
        const requestId = ++id
        const response = new Promise<{ result?: { sessionId?: string }; error?: unknown }>(resolve =>
          responses.set(requestId, resolve)
        )
        adapter.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
        const result = await wait(response)
        assert.equal(result.error, undefined, JSON.stringify(result.error))
        return result.result
      }
      async function wait<T>(promise: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`adapter timed out: ${stderr}`)), 10000)
            })
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const first = await request('session/new', { cwd: root, mcpServers: [] })
      const second = await request('session/new', { cwd: root, mcpServers: [] })
      assert.notEqual(first?.sessionId, second?.sessionId)
      const children = readdirSync(root)
        .filter(name => name.endsWith('.started'))
        .map(name => name.split('.')[0])
      assert.equal(children.length, 2)
      assert.ok(
        children.every(pid => !existsSync(join(root, `${pid}.stopped`))),
        'both sessions must remain live until disconnect'
      )
      if (disconnect === 'stdin end') adapter.stdin.end()
      else adapter.kill('SIGTERM')
      await wait(exited)
      const deadline = Date.now() + 2000
      while (children.some(pid => !existsSync(join(root, `${pid}.stopped`))) && Date.now() < deadline) await delay(10)
      assert.ok(
        children.every(pid => existsSync(join(root, `${pid}.stopped`))),
        'disconnect must signal every retained pi subprocess'
      )
    }
  )
}
