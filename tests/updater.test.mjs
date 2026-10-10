import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createPluginUpdater, REPOSITORY_URL } from '../lib/updater.js'

const exec = promisify(execFile)
async function command(root, args) {
  const result = await exec('git', ['-c', 'user.name=Update test', '-c', 'user.email=update-test@example.invalid', ...args], { cwd: root, windowsHide: true })
  return result.stdout.trim()
}
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-comfy-update-test-'))
  const root = join(base, options.rootName || 'plugin'), remote = join(base, 'remote')
  await mkdir(root)
  await command(root, ['init', '-b', 'master'])
  await command(root, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(root, '.gitignore'), 'config.json\ndefinitions.json\nworldbook.json\nworkflows/*.json\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-tavern-comfy', version: '1.2.0' }))
  await writeFile(join(root, 'client.js'), 'old code\n')
  await command(root, ['add', '.']); await command(root, ['commit', '-m', 'initial'])
  await command(base, ['clone', root, remote])
  await command(remote, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(remote, 'package.json'), JSON.stringify({ name: options.remotePackageName || 'dsh-tavern-comfy', version: options.remoteVersion || '1.2.1' }))
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

test('renamed GitHub repository keeps existing installs on the legacy origin updateable', async t => {
  const f = await fixture(t)
  await command(f.root, ['remote', 'set-url', 'origin', 'https://github.com/weixinlll/dsh-tavern-comfy.git'])
  const status = await f.updater.status()
  assert.equal(REPOSITORY_URL, 'https://github.com/weixinlll/dsh-tavern-image')
  assert.equal(status.repositoryUrl, REPOSITORY_URL)
  assert.equal(status.supported, true)
})

test('updater accepts the new package id while preserving the legacy package id for this transition', async t => {
  const f = await fixture(t, { remotePackageName: 'dsh-tavern-image' })
  const checked = await f.updater.check()
  assert.equal(checked.available, true)
  assert.equal(checked.latestVersion, '1.2.1')
})

test('updating the old install leaves the active directory in place and asks for a safe manual migration', async t => {
  const f = await fixture(t, { rootName: 'dsh-tavern-comfy', remoteVersion: '2.1.0' })
  const config = JSON.stringify({ token: 'keep' })
  await writeFile(join(f.root, 'config.json'), config)
  await mkdir(join(f.root, 'workflows'))
  await writeFile(join(f.root, 'workflows', 'user.json'), '{"workflow":"keep"}')
  const checked = await f.updater.check()
  assert.equal(checked.canUpdate, true)
  const result = await f.updater.apply(checked.target)
  const renamedRoot = join(f.base, 'dsh-tavern-image')
  assert.equal(result.directoryMigrationRequired, true)
  assert.match(result.message, /完整退出 DSH 后.*改名为 dsh-tavern-image/)
  assert.equal(await readFile(join(f.root, 'config.json'), 'utf8'), config)
  assert.equal(await readFile(join(f.root, 'workflows', 'user.json'), 'utf8'), '{"workflow":"keep"}')
  await assert.rejects(readFile(join(renamedRoot, 'config.json')), { code: 'ENOENT' })
  assert.equal(await command(f.root, ['remote', 'get-url', 'origin']), REPOSITORY_URL + '.git')
})

test('a fast-forward performed by the legacy updater is reported as requiring a one-time directory rename', async t => {
  const f = await fixture(t, { rootName: 'dsh-tavern-comfy', remoteVersion: '2.1.0' })
  // The v2.0.0 updater only fast-forwards; it cannot run the new updater code during the same request.
  await command(f.root, ['fetch', '--no-tags', f.remote, 'master'])
  const target = await command(f.root, ['rev-parse', 'FETCH_HEAD'])
  await command(f.root, ['merge', '--ff-only', '--no-edit', target])

  const restartedUpdater = createPluginUpdater({ root: f.root, git: f.git })
  const status = await restartedUpdater.status()
  assert.equal(status.currentVersion, '2.1.0')
  assert.equal(status.directoryMigrationRequired, true)
  assert.match(status.directoryMigrationMessage, /完全退出 DSH.*改名为 dsh-tavern-image/)

  const renamedRoot = join(f.base, 'dsh-tavern-image')
  await rename(f.root, renamedRoot)
  const migratedUpdater = createPluginUpdater({ root: renamedRoot, git: args => command(renamedRoot, args) })
  const migratedStatus = await migratedUpdater.status()
  assert.equal(migratedStatus.supported, true)
  assert.equal(migratedStatus.directoryMigrationRequired, false)
})

test('updater stops before install when the new folder already exists', async t => {
  const f = await fixture(t, { rootName: 'dsh-tavern-comfy' })
  await mkdir(join(f.base, 'dsh-tavern-image'))
  const status = await f.updater.status()
  assert.equal(status.supported, false)
  assert.match(status.reason, /新插件目录已存在/)
  assert.equal((await f.updater.check()).canUpdate, false)
  assert.equal(f.calls.some(args => args[0] === 'fetch'), false)
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
