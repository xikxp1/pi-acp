import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { ClientBridge } from '../../src/acp/client-bridge.js'

type Params = { path: string; content?: string; offset?: number; limit?: number }
type Operations = {
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, content: string): Promise<void>
  access(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  detectImageMimeType(path: string): Promise<unknown>
}
type Tool = {
  name: string
  operations: Operations
  execute(id: string, params: Params, signal: undefined, update: undefined, ctx: { cwd: string }): Promise<Params>
}
type Extension = {
  default(pi: { registerTool(tool: Tool): void; on(event: string, fn: () => Promise<void>): void }): void
  parseAdditionalDirectories(value: string | undefined): string[]
  resolveWorkspacePath(
    path: string,
    cwd: string,
    roots: readonly string[],
    exists: (path: string) => Promise<boolean>
  ): Promise<string>
}

// Keep the companion extension standalone, without requiring pi as an adapter dependency.
const sdk = `
const create = name => (_cwd, options) => ({
  name, operations: options.operations,
  async execute(_id, params) { return params }
});
export const createReadToolDefinition = create('read');
export const createWriteToolDefinition = create('write');
export const createEditToolDefinition = create('edit');
export const detectSupportedImageMimeTypeFromFile = async path => path;
`
const dataUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const source = await readFile(new URL('../../extensions/pi-acp-fs.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const extension = (await import(
  dataUrl(compiled.replace('@earendil-works/pi-coding-agent', dataUrl(sdk)))
)) as Extension

async function setup(t: TestContext, roots: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-acp-fs-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cwd = join(dir, 'main')
  await mkdir(cwd)
  const extraRoots = roots.map(root => join(dir, root))
  for (const root of extraRoots) await mkdir(root, { recursive: true })
  const previous = { ...process.env }
  delete process.env.PI_ACP_FS_SOCKET
  delete process.env.PI_ACP_FS_CAPS
  process.env.PI_ACP_ADDITIONAL_DIRECTORIES = JSON.stringify(extraRoots)
  t.after(() => {
    for (const key of ['PI_ACP_FS_SOCKET', 'PI_ACP_FS_CAPS', 'PI_ACP_ADDITIONAL_DIRECTORIES']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  const tools = new Map<string, Tool>()
  const start = () => {
    extension.default({
      registerTool: tool => {
        tools.set(tool.name, tool)
      },
      on: (event, fn) => {
        if (event === 'session_shutdown') t.after(fn)
      }
    })
  }
  const target = async (name: string, path: string) => {
    const params = await tools.get(name)!.execute('call', { path, offset: 2, limit: 3 }, undefined, undefined, { cwd })
    assert.equal(params.offset, 2)
    assert.equal(params.limit, 3)
    return resolve(cwd, params.path)
  }
  return { cwd, roots: extraRoots, tools, start, target }
}

test('roots env validates absolute paths and deduplicates normalized roots', () => {
  assert.deepEqual(extension.parseAdditionalDirectories(undefined), [])
  assert.deepEqual(extension.parseAdditionalDirectories('[]'), [])
  const root = resolve('extra')
  assert.deepEqual(extension.parseAdditionalDirectories(JSON.stringify([root, root + '/'])), [root])
  for (const value of ['broken', '{}', '[1]', '["relative"]']) {
    assert.throws(() => extension.parseAdditionalDirectories(value))
  }
})

test('extension is inert without a bridge or roots', async t => {
  const f = await setup(t)
  f.start()
  assert.equal(f.tools.size, 0)
})

test('without roots, tool registration still follows client capabilities', async t => {
  for (const [caps, names] of [
    ['read', ['read']],
    ['write', ['write']],
    ['read,write', ['read', 'write', 'edit']]
  ] as const) {
    await t.test(caps, async t => {
      const f = await setup(t)
      process.env.PI_ACP_FS_SOCKET = join(f.cwd, 'unused.sock')
      process.env.PI_ACP_FS_CAPS = caps
      f.start()
      assert.deepEqual([...f.tools.keys()], names)
    })
  }
})

test('read/edit/write select cwd first, then a unique extra-root match locally', async t => {
  const f = await setup(t, ['lib', 'other'])
  await writeFile(join(f.roots[0], 'unique.txt'), 'extra')
  await writeFile(join(f.roots[0], 'shared.txt'), 'extra shared')
  await writeFile(join(f.cwd, 'shared.txt'), 'local shared')
  f.start()
  assert.deepEqual([...f.tools.keys()], ['read', 'write', 'edit'])
  for (const name of f.tools.keys()) {
    assert.equal(await f.target(name, 'unique.txt'), join(f.roots[0], 'unique.txt'))
    assert.equal(await f.target(name, 'shared.txt'), join(f.cwd, 'shared.txt'))
    assert.equal(await f.target(name, '@unique.txt'), join(f.roots[0], 'unique.txt'))
    assert.equal(await f.target(name, 'lib/new/nested.txt'), join(f.roots[0], 'new/nested.txt'))
    assert.equal(await f.target(name, './lib/new.txt'), join(f.roots[0], 'new.txt'))
    assert.equal(await f.target(name, 'new.txt'), join(f.cwd, 'new.txt'))
    assert.equal(await f.target(name, join(f.cwd, 'unique.txt')), join(f.cwd, 'unique.txt'))
    assert.equal(await f.target(name, '../unique.txt'), resolve(f.cwd, '../unique.txt'))
  }
  const read = f.tools.get('read')!
  assert.equal((await read.operations.readFile(await f.target('read', 'unique.txt'))).toString(), 'extra')
  assert.equal(
    await read.operations.detectImageMimeType(await f.target('read', 'unique.txt')),
    join(f.roots[0], 'unique.txt')
  )
  const path = await f.target('edit', 'unique.txt')
  await f.tools.get('edit')!.operations.writeFile(path, 'edited')
  assert.equal(await readFile(path, 'utf8'), 'edited')
  const newPath = await f.target('write', 'lib/new/nested.txt')
  await f.tools.get('write')!.operations.mkdir(resolve(newPath, '..'))
  await f.tools.get('write')!.operations.writeFile(newPath, 'created')
  assert.equal(await readFile(newPath, 'utf8'), 'created')
})

test('ambiguous fallback paths and duplicate root names fail before tools execute', async t => {
  const f = await setup(t, ['one/lib', 'two/lib'])
  for (const root of f.roots) await writeFile(join(root, 'shared.txt'), 'shared')
  f.start()
  for (const name of f.tools.keys()) {
    await assert.rejects(f.target(name, 'shared.txt'), /Ambiguous workspace path/)
    await assert.rejects(f.target(name, 'lib/new.txt'), /Ambiguous workspace root/)
    assert.equal(await f.target(name, join(f.roots[1], 'shared.txt')), join(f.roots[1], 'shared.txt'))
  }
  await writeFile(join(f.cwd, 'shared.txt'), 'local')
  assert.equal(await f.target('read', 'shared.txt'), join(f.cwd, 'shared.txt'))
})

test('absolute, home and parent-relative paths are never searched in extra roots', async () => {
  const cwd = resolve('main')
  const root = resolve('extra')
  const lookedUp: string[] = []
  for (const path of [join(cwd, 'missing'), '~/missing', '@~/missing', '~']) {
    assert.equal(
      await extension.resolveWorkspacePath(path, cwd, [root], async path => {
        lookedUp.push(path)
        return false
      }),
      path
    )
  }
  assert.deepEqual(lookedUp, [])
  const calls: string[] = []
  assert.equal(
    await extension.resolveWorkspacePath('../missing', cwd, [root], async path => {
      calls.push(path)
      return false
    }),
    resolve(cwd, '../missing')
  )
  assert.deepEqual(calls, [resolve(cwd, '../missing')])
})

test('path probe failures are not treated as missing files', async () => {
  await assert.rejects(
    extension.resolveWorkspacePath('file', resolve('cwd'), [resolve('lib')], async () => {
      throw new Error('Permission denied')
    }),
    /Permission denied/
  )
})

test('client-only buffers resolve across roots; writes and edits use the same absolute target', async t => {
  const f = await setup(t, ['lib', 'other'])
  const bufferPath = join(f.roots[0], 'buffer.txt')
  const files = new Map([[bufferPath, 'unsaved']])
  const writes: string[] = []
  const bridge = await ClientBridge.create(
    {
      async readTextFile({ path }) {
        const content = files.get(path)
        if (content === undefined) throw new Error('Not found')
        return { content }
      },
      async writeTextFile({ path, content }) {
        files.set(path, content)
        writes.push(path)
        return {}
      },
      async createTerminal() {
        throw new Error('unused')
      }
    },
    () => 'session',
    { read: true, write: true }
  )
  assert.ok(bridge)
  t.after(() => bridge.close())
  Object.assign(process.env, bridge.env)
  f.start()
  for (const name of f.tools.keys()) {
    assert.equal(await f.target(name, 'buffer.txt'), bufferPath)
  }
  const read = f.tools.get('read')!.operations
  await read.access(bufferPath)
  assert.equal((await read.readFile(bufferPath)).toString(), 'unsaved')
  await f.tools.get('edit')!.operations.writeFile(await f.target('edit', 'buffer.txt'), 'edited buffer')
  await f.tools.get('write')!.operations.writeFile(await f.target('write', 'lib/new.txt'), 'new buffer')
  assert.deepEqual(writes, [bufferPath, join(f.roots[0], 'new.txt')])
  files.set(join(f.roots[1], 'buffer.txt'), 'duplicate')
  await assert.rejects(f.target('write', 'buffer.txt'), /Ambiguous workspace path/)
  files.set(join(f.cwd, 'buffer.txt'), 'cwd buffer')
  assert.equal(await f.target('read', 'buffer.txt'), join(f.cwd, 'buffer.txt'))
})

test('unavailable client falls back to local files under the selected extra root', async t => {
  const f = await setup(t, ['lib'])
  await writeFile(join(f.roots[0], 'file.txt'), 'local')
  process.env.PI_ACP_FS_SOCKET = join(f.cwd, 'nonexistent.sock')
  process.env.PI_ACP_FS_CAPS = 'read,write'
  f.start()
  const path = await f.target('read', 'file.txt')
  assert.equal(path, join(f.roots[0], 'file.txt'))
  assert.equal((await f.tools.get('read')!.operations.readFile(path)).toString(), 'local')
  await f.tools.get('write')!.operations.writeFile(await f.target('write', 'file.txt'), 'fallback')
  assert.equal(await readFile(path, 'utf8'), 'fallback')
})
