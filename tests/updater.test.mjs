import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createPluginUpdater, REPOSITORY_URL } from '../lib/updater.js'

const exec = promisify(execFile)
async function command(root, args) {
  const result = await exec('git', ['-c', 'user.name=Update test', '-c', 'user.email=update-test@example.invalid', ...args], { cwd: root, windowsHide: true })
  return result.stdout.trim()
}
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-comfy-update-test-'))
  const root = join(base, 'plugin'), remote = join(base, 'remote')
  await mkdir(root)
  await command(root, ['init', '-b', 'master'])
  await command(root, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(root, '.gitignore'), 'config.json\ndefinitions.json\nworldbook.json\nworkflows/*.json\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-tavern-comfy', version: '1.2.0' }))
  await writeFile(join(root, 'client.js'), 'old code\n')
  await command(root, ['add', '.']); await command(root, ['commit', '-m', 'initial'])
  await command(base, ['clone', root, remote])
  await command(remote, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(remote, 'package.json'), JSON.stringify({ name: 'dsh-tavern-comfy', version: '1.2.1' }))
  await writeFile(join(remote, 'client.js'), 'new code\n')
  await command(remote, ['add', '.']); await command(remote, ['commit', '-m', 'update'])
  await command(root, ['remote', 'add', 'origin', REPOSITORY_URL + '.git'])
  const calls = []
  const git = async args => {
    calls.push(args)
    // Real Git fast-forward, but fetch only a disposable local fixture, never GitHub.
    return command(root, args[0] === 'fetch' ? ['fetch', '--no-tags', remote, 'master'] : args)
  }
  t.after(async () => {
    assert.equal(dirname(resolve(base)), resolve(tmpdir()))
    assert.ok(basename(base).startsWith('dsh-comfy-update-test-'))
    await rm(base, { recursive: true, force: true })
  })
  return { root, remote, base, git, calls, updater: createPluginUpdater({ root, git }) }
}

test('check is separate from install; exact checked fast-forward preserves ignored user data and requires restart', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'workflows'))
  const privateFiles = ['config.json', 'definitions.json', 'worldbook.json', 'workflows/user.json']
  for (const file of privateFiles) await writeFile(join(f.root, file), '{"private":"keep exactly"}\n')
  const before = await command(f.root, ['rev-parse', 'HEAD'])
  const local = await f.updater.status()
  assert.equal(local.currentVersion, '1.2.0'); assert.equal(local.supported, true)
  assert.equal(f.calls.some(args => args[0] === 'fetch'), false)
  const checked = await f.updater.check()
  assert.equal(checked.latestVersion, '1.2.1'); assert.equal(checked.available, true); assert.equal(checked.canUpdate, true)
  assert.equal(await command(f.root, ['rev-parse', 'HEAD']), before)
  assert.equal(await readFile(join(f.root, 'client.js'), 'utf8'), 'old code\n')
  await assert.rejects(f.updater.apply('a'.repeat(40)), /先检查更新/)
  const result = await f.updater.apply(checked.target)
  assert.equal(await command(f.root, ['rev-parse', 'HEAD']), checked.target)
  assert.equal(await readFile(join(f.root, 'client.js'), 'utf8'), 'new code\n')
  for (const file of privateFiles) assert.equal(await readFile(join(f.root, file), 'utf8'), '{"private":"keep exactly"}\n')
  assert.equal(result.restartRequired, true); assert.equal(result.canUpdate, false)
  assert.equal(result.currentVersion, '1.2.0') // Running bundle stays old until restart.
  assert.deepEqual(await f.updater.apply(checked.target), result)
  assert.equal(f.calls.filter(args => args[0] === 'merge').length, 1)
})

test('local code edits are rechecked immediately before install', async t => {
  const f = await fixture(t)
  const checked = await f.updater.check()
  await writeFile(join(f.root, 'client.js'), 'local draft\n')
  await assert.rejects(f.updater.apply(checked.target), /本地改动/)
  assert.equal(await readFile(join(f.root, 'client.js'), 'utf8'), 'local draft\n')
  assert.equal(f.calls.some(args => args[0] === 'merge'), false)
})

test('changed local commit invalidates the checked version and divergent history cannot auto-update', async t => {
  const f = await fixture(t)
  const checked = await f.updater.check()
  await writeFile(join(f.root, 'local.txt'), 'local change')
  await command(f.root, ['add', 'local.txt']); await command(f.root, ['commit', '-m', 'local branch'])
  await assert.rejects(f.updater.apply(checked.target), /代码已变化/)
  const next = await f.updater.check()
  assert.equal(next.canUpdate, false); assert.match(next.reason, /本地提交与远端不同/)
  assert.equal(f.calls.some(args => args[0] === 'merge'), false)
})

test('remote changes to private data paths are refused', async t => {
  const f = await fixture(t)
  await writeFile(join(f.remote, 'config.json'), '{"overwrite":"forbidden"}')
  await command(f.remote, ['add', '--force', 'config.json']); await command(f.remote, ['commit', '-m', 'private path'])
  await writeFile(join(f.root, 'config.json'), '{"original":true}')
  const checked = await f.updater.check()
  assert.equal(checked.canUpdate, false); assert.match(checked.reason, /用户数据路径/)
  await assert.rejects(f.updater.apply(checked.target), /先检查更新/)
  assert.equal(await readFile(join(f.root, 'config.json'), 'utf8'), '{"original":true}')
})

test('unrelated origin and nested checkout cannot be updated', async t => {
  const f = await fixture(t)
  await command(f.root, ['remote', 'set-url', 'origin', 'https://example.invalid/other.git'])
  assert.equal((await f.updater.check()).supported, false)
  assert.equal(f.calls.some(args => args[0] === 'fetch'), false)
  const nested = join(f.root, 'nested'); await mkdir(nested)
  await writeFile(join(nested, 'package.json'), '{"version":"1.2.0"}')
  const updater = createPluginUpdater({ root: nested, git: args => command(nested, args) })
  const status = await updater.status()
  assert.equal(status.supported, false); assert.match(status.reason, /独立的 Git/)
})

test('concurrent checks are refused and failed network checks can retry', async t => {
  const f = await fixture(t)
  let release, entered
  const waiting = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  let fail = true
  const updater = createPluginUpdater({ root: f.root, git: async args => {
    if (args[0] === 'fetch' && fail) { entered(); await waiting; throw new Error('test network failure') }
    return f.git(args)
  } })
  const checking = updater.check()
  await started
  await assert.rejects(updater.check(), /正在检查或更新/)
  release(); await assert.rejects(checking, /network failure/)
  fail = false
  assert.equal((await updater.check()).canUpdate, true)
})
