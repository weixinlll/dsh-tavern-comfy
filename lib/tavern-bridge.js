/**
 * Tavern 官方插件接口适配层（接口版本 1）
 * ============================================================
 *
 * 为什么有这一层：
 *   以前"把图插进正文"是靠给 Tavern 打 5~8 处客户端补丁（造一个
 *   tavernAssistantTextRenderer 服务）+ 自建 /jobs?image=1 图片服务。
 *   Tavern 一更新、补丁被冲掉，插件就瞎了（正文不显示图、按钮消失）。
 *
 *   现在 Tavern 开放了官方接口，这条链路整个可以走正门：
 *     tavern.promptSection     自动生图规则进入**游玩时**的正文提示词
 *                              （DSH 自带的 systemPrompt.section 游玩时不生效，
 *                                以前那套注入其实一直是空的）
 *     tavern.onTurnSettled     每轮正文写完通知一次 —— 自动配图从"前端渲染时猜"改成"服务端事件"
 *     tavern.getTurn           手动按钮配图时，用来取这一轮的 textVersion 与正文
 *     tavern.attach / update   图片按 anchor 挂进正文；与 textVersion 绑定，
 *                              回退或切版本时 Tavern 自己隐藏，切回来又出现
 *     attachments.saveImage    图片交给 DSH 附件服务，不再自建取图路由
 *
 * 这一层只做"和 Tavern 交互"；规划与 ComfyUI 出图仍用插件自己的实现。
 */

/** 自动生图规则：让前台模型在正文里写 image###...### 标记（手动机不用它） */
function markerRule(count) {
  const n = Math.max(1, Math.min(8, Number(count) || 3))
  return [
    '【插图标记】',
    '在正文里选出 ' + n + ' 个最值得配图的瞬间，在**那个句子所在段落之后**另起一行写上：',
    '',
    'image###<英文提示词>###',
    '',
    '- 提示词用英文逗号分隔的 Danbooru 风格 tag：人物外观、表情、服装状态、动作、镜头、光线、场景。',
    '- 一行一个标记，标记独占一行，前后各留一个空行。',
    '- 不要解释这些标记，也不要把它写进括号或代码块。',
  ].join('\n')
}

/**
 * 安装官方桥。
 * @returns {{ dispose: Function, attachTurn: Function, available: boolean }}
 */
export function installTavernBridge({ tavern, attachments, engine, getConfig, logger, readFileAsBytes }) {
  const disposes = []
  const log = msg => { try { logger?.info?.(`dsh-tavern-comfy[官方桥]: ${msg}`) } catch {} }
  const warn = msg => { try { logger?.warn?.(`dsh-tavern-comfy[官方桥]: ${msg}`) } catch {} }
  const running = new Map()   // `${gameId}:${turn}` → Promise

  async function waitJob(jobId, timeoutMs = 8 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const job = engine.getJob(jobId)
      if (!job) return null
      if (job.state === 'done' && job.file) return job
      if (job.state === 'failed' || job.state === 'cancelled') return job
      await new Promise(r => setTimeout(r, 1500))
    }
    return null
  }

  /**
   * 给某一轮配图：规划 → 每张挂 pending 占位 → 出图 → update 成真图。
   * 自动（onTurnSettled）和手动（/attach-turn 路由）共用这一份实现。
   */
  async function attachTurn({ gameId, turn, textVersion, text, messageId }) {
    const config = getConfig() ?? {}
    const body = String(text ?? '').trim()
    if (!body) throw new Error('这一轮没有正文')
    if (!textVersion) throw new Error('拿不到这一轮的版本号（textVersion）')

    const plan = await engine.planMessage({
      text: body,
      messageId: messageId || ('turn-' + gameId + '-' + turn),
      turn,
      sessionId: gameId,
      manual: true,
    })
    const plans = Array.isArray(plan?.plans) ? plan.plans : []
    if (!plans.length) return { attached: 0, error: plan?.error || '规划没有产出画面' }

    let ok = 0
    for (const item of plans) {
      const jobId = String(item?.jobId ?? '')
      const anchor = String(item?.mount ?? '').slice(0, 500)
      const caption = String(item?.title ?? '').slice(0, 500)

      let attached = null
      try {
        attached = await tavern.attach({
          gameId, turn, textVersion,
          item: { kind: 'dsh-tavern-comfy/image', status: 'pending', anchor, caption, data: { jobId } },
        })
      } catch (error) {
        warn('挂占位失败：' + (error?.message ?? error))
        continue
      }
      if (!attached?.id) continue

      if (!jobId) { await tavern.update(attached.id, { status: 'failed', error: '没有拿到作业号' }).catch(() => {}); continue }

      try {
        const job = await waitJob(jobId)
        if (!job) { await tavern.update(attached.id, { status: 'failed', error: '等待出图超时' }); continue }
        if (job.state !== 'done' || !job.file) {
          await tavern.update(attached.id, { status: 'failed', error: String(job.error || '出图失败').slice(0, 200) })
          continue
        }
        const bytes = await readFileAsBytes(job.file)
        const attachment = await attachments.saveImage({
          data: bytes,
          mediaType: job.mediaType || 'image/png',
          name: 'tavern-comfy-' + jobId.slice(0, 8),
        })
        await tavern.update(attached.id, { status: 'ready', attachment, progress: 1 })
        ok += 1
        log(`第 ${turn} 轮挂上一张图（${jobId.slice(0, 8)}）`)
      } catch (error) {
        await tavern.update(attached.id, { status: 'failed', error: String(error?.message ?? error).slice(0, 200) }).catch(() => {})
      }
    }
    if (!config) warn('读不到配置，按默认继续')
    return { attached: ok, total: plans.length }
  }

  // ── ① 自动生图规则：进游玩正文提示词 ────────────────────────────
  try {
    const off = tavern.promptSection({
      name: 'auto-image-gen',
      text: () => (getConfig()?.autoImageGen ? markerRule(getConfig()?.imageGenCount) : ''),
    })
    if (typeof off === 'function') disposes.push(off)
    log('已注册提示词段落 auto-image-gen')
  } catch (error) {
    warn('注册提示词段落失败：' + (error?.message ?? error))
  }

  // ── ② 每轮结算 → 自动配图 ───────────────────────────────────────
  try {
    const off = tavern.onTurnSettled(turn => {
      if (!getConfig()?.plannerEnabled) return          // 自动那条仍受开关控制
      if (String(turn.text ?? '').trim().length < 200) return   // 短消息不配图
      const key = `${turn.gameId}:${turn.turn}`
      if (running.has(key)) return
      const task = attachTurn({
        gameId: turn.gameId, turn: turn.turn, textVersion: turn.textVersion, text: turn.text,
      })
        .catch(error => warn('自动配图出错：' + (error?.message ?? error)))
        .finally(() => running.delete(key))
      running.set(key, task)
    })
    if (typeof off === 'function') disposes.push(off)
    log('已注册 onTurnSettled')
  } catch (error) {
    warn('注册轮次监听失败：' + (error?.message ?? error))
  }

  return {
    available: true,
    attachTurn,
    dispose: () => { for (const dispose of disposes) { try { dispose() } catch {} } },
  }
}
