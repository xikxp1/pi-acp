import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { appendSystemPromptArgs, discoverAppendSystemPromptFile } from '../../src/pi-rpc/append-system-prompt.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { bounded, createRpcChild } from '../helpers/rpc-child.js'

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-append-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const project = join(root, 'work', 'project')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(join(project, '.pi'), { recursive: true })
  const env = { PI_CODING_AGENT_DIR: agentDir }
  const globalFile = join(agentDir, 'APPEND_SYSTEM.md')
  const projectFile = join(project, '.pi', 'APPEND_SYSTEM.md')
  return {
    root,
    agentDir,
    project,
    env,
    globalFile,
    projectFile,
    writeGlobal: () => writeFileSync(globalFile, 'global rules'),
    writeProject: () => writeFileSync(projectFile, 'project rules'),
    trust: (entries: Record<string, boolean | null>) =>
      writeFileSync(join(agentDir, 'trust.json'), JSON.stringify(entries)),
    settings: (value: Record<string, unknown>) =>
      writeFileSync(join(agentDir, 'settings.json'), `\uFEFF${JSON.stringify(value)}`)
  }
}

test('discoverAppendSystemPromptFile returns undefined when no file exists', t => {
  const f = fixture(t)
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), undefined)
  assert.deepEqual(appendSystemPromptArgs('roots', f.project, f.env), ['--append-system-prompt', 'roots'])
})

test('discoverAppendSystemPromptFile uses the agent-dir file when the project has none', t => {
  const f = fixture(t)
  f.writeGlobal()
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), f.globalFile)
  assert.deepEqual(appendSystemPromptArgs('roots', f.project, f.env), [
    '--append-system-prompt',
    f.globalFile,
    '--append-system-prompt',
    'roots'
  ])
})

test('discoverAppendSystemPromptFile ignores an untrusted project file', t => {
  const f = fixture(t)
  f.writeProject()
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), undefined)
  f.writeGlobal()
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), f.globalFile)
})

test('discoverAppendSystemPromptFile prefers a project file trusted via the nearest canonical trust entry', t => {
  const f = fixture(t)
  f.writeGlobal()
  f.writeProject()
  f.trust({ [realpathSync(join(f.root, 'work'))]: true })
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), f.projectFile)

  f.trust({ [realpathSync(join(f.root, 'work'))]: true, [realpathSync(f.project)]: false })
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), f.globalFile)
})

test('discoverAppendSystemPromptFile honors defaultProjectTrust unless a stored decision exists', t => {
  const f = fixture(t)
  f.writeGlobal()
  f.writeProject()
  f.settings({ defaultProjectTrust: 'always' })
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), f.projectFile)

  f.trust({ [realpathSync(f.project)]: false })
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), f.globalFile)

  f.trust({})
  f.settings({ defaultProjectTrust: 'ask' })
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), f.globalFile)
})

test('discoverAppendSystemPromptFile tolerates malformed trust and settings files', t => {
  const f = fixture(t)
  f.writeGlobal()
  f.writeProject()
  writeFileSync(join(f.agentDir, 'trust.json'), '{not json')
  writeFileSync(join(f.agentDir, 'settings.json'), '[]')
  assert.equal(discoverAppendSystemPromptFile(f.project, f.env), f.globalFile)
})

test('PiRpcProcess.spawn keeps the discovered APPEND_SYSTEM.md ahead of adapter text', async t => {
  const f = fixture(t)
  f.writeGlobal()
  const rpc = createRpcChild()
  t.after(rpc.cleanup)
  const stderr = new PassThrough()
  Object.assign(rpc.child, { stderr })
  t.after(() => stderr.destroy())
  const calls: Array<{ args: string[]; options: SpawnOptions }> = []
  t.mock.method(childProcess, 'spawn', (_command: string, args: string[], options: SpawnOptions) => {
    calls.push({ args, options })
    setImmediate(() => rpc.child.emit('spawn'))
    return rpc.child as unknown as ChildProcessWithoutNullStreams
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  const withText = await bounded(PiRpcProcess.spawn({ cwd: f.project, env: f.env, appendSystemPrompt: 'roots' }))
  t.after(() => withText.dispose())
  assert.deepEqual(calls[0].args, [
    '--mode',
    'rpc',
    '--no-themes',
    '--append-system-prompt',
    f.globalFile,
    '--append-system-prompt',
    'roots'
  ])

  const withoutText = await bounded(PiRpcProcess.spawn({ cwd: f.project, env: f.env }))
  t.after(() => withoutText.dispose())
  assert.deepEqual(calls[1].args, ['--mode', 'rpc', '--no-themes'])
})
