import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const REPOSITORY_URL = 'https://github.com/weixinlll/dsh-tavern-comfy'
const BRANCH = 'master'
const HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const PRIVATE_PATH = /^(?:config\.json|definitions\.json|worldbook\.json|jobs-store\.json|plans-store\.json|backups(?:\/|$)|cache(?:\/|$)|workflows\/.*\.json$)/i

async function runGit(root, args) {
  try {
    const result = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    })
    return result.stdout.trim()
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('未找到 Git，请安装 Git 后重试。')
    if (error.killed || error.code === 'ETIMEDOUT') throw new Error('更新请求超时，请检查网络后重试。')
    // 不把命令输出返回浏览器，避免远端地址或本机路径泄露。
    throw new Error('Git 操作失败，请检查网络及插件目录后重试。')
  }
}

function ownRepository(remote) {
  return [REPOSITORY_URL, REPOSITORY_URL + '.git', 'git@github.com:weixinlll/dsh-tavern-comfy.git'].includes(remote)
}

/** 只操作这个插件的 Git checkout；不运行下载的脚本，不管理 Tavern 宿主。 */
export function createPluginUpdater({ root, git = args => runGit(root, args), now = Date.now }) {
  const version = readFile(resolve(root, 'package.json'), 'utf8')
    .then(source => String(JSON.parse(source).version || '未知')).catch(() => '未知')
  let checked = null
  let installed = null
  let busy = false
  let restartRequired = false

  async function inspect() {
    const currentVersion = await version
    const common = { ok: true, currentVersion, repositoryUrl: REPOSITORY_URL, restartRequired }
    try {
      const top = await git(['rev-parse', '--show-toplevel'])
      const [actual, expected] = await Promise.all([realpath(top), realpath(root)])
      const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
      if (normalize(actual) !== normalize(expected)) return { ...common, supported: false, canUpdate: false, reason: '此目录不是独立的 Git 安装，请从项目页面下载更新。' }
      if (!ownRepository(await git(['remote', 'get-url', 'origin']))) return { ...common, supported: false, canUpdate: false, reason: '插件来源与官方项目不一致，请手动核对更新。' }
      if (await git(['branch', '--show-current']) !== BRANCH) return { ...common, supported: false, canUpdate: false, reason: '当前不在 master 分支，请手动更新。' }
      const head = await git(['rev-parse', 'HEAD'])
      if (!HASH.test(head)) throw new Error('无法确认本地代码版本。')
      const dirty = Boolean(await git(['status', '--porcelain', '--untracked-files=no']))
      return { ...common, supported: true, canUpdate: !dirty && !restartRequired, head, reason: restartRequired ? '更新已安装，请完整重启 DSH。' : dirty ? '插件代码有本地改动，请先处理改动再更新。' : '' }
    } catch (error) {
      return { ...common, supported: false, canUpdate: false, reason: error.message }
    }
  }

  async function exclusive(action) {
    if (busy) throw new Error('正在检查或更新，请稍后再试。')
    busy = true
    try { return await action() } finally { busy = false }
  }

  async function check() {
    return exclusive(async () => {
      checked = null
      const local = await inspect()
      if (!local.supported || restartRequired) return { ...local, available: false }
      await git(['fetch', '--no-tags', 'origin', BRANCH])
      const target = await git(['rev-parse', 'FETCH_HEAD'])
      if (!HASH.test(target)) throw new Error('无法确认远端代码版本。')
      const pkg = JSON.parse(await git(['show', target + ':package.json']))
      if (pkg.name !== 'dsh-tavern-comfy' || typeof pkg.version !== 'string') throw new Error('远端不是有效的插件版本。')
      const available = target !== local.head
      const result = { ...local, latestVersion: pkg.version, available, target, checkedAt: now() }
      if (!available) return { ...result, canUpdate: false, reason: local.reason || '当前代码已是最新版本。' }
      const base = await git(['merge-base', 'HEAD', target])
      if (base !== local.head) return { ...result, canUpdate: false, reason: '本地提交与远端不同，请手动合并后更新。' }
      const paths = (await git(['diff', '--name-only', local.head, target])).split(/\r?\n/)
      if (paths.some(path => PRIVATE_PATH.test(path))) return { ...result, canUpdate: false, reason: '远端改动包含用户数据路径，已停止自动更新。' }
      checked = { ...result, base: local.head }
      return result
    })
  }

  async function apply(target) {
    return exclusive(async () => {
      // 安装响应丢失后的同版本重试只返回结果，不再次改动代码。
      if (installed && target === installed.target) return installed
      if (!checked || typeof target !== 'string' || target !== checked.target || !checked.available || !checked.canUpdate) throw new Error('请先检查更新，再安装检查到的版本。')
      const local = await inspect()
      if (!local.supported || !local.canUpdate) throw new Error(local.reason || '当前无法更新。')
      if (local.head !== checked.base) { checked = null; throw new Error('本地代码已变化，请重新检查更新。') }
      // 只允许 fast-forward；不会 reset/clean，也不会覆盖未跟踪的用户文件。
      await git(['merge', '--ff-only', '--no-edit', target])
      if (await git(['rev-parse', 'HEAD']) !== target) throw new Error('更新结果未能确认，请检查插件目录。')
      restartRequired = true
      installed = { ...checked, available: false, canUpdate: false, restartRequired, reason: '更新已安装，请完整关闭并重启 DSH 后使用新版。' }
      return installed
    })
  }

  return { status: inspect, check, apply }
}
