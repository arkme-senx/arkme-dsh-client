import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const defaultURL = 'https://bot.jotmo.cc/api/public/v1/bot/webhook/db58fd3e-bde1-52aa-8f5f-8a4d4836329a'
const clean = value => String(value ?? '').replace(/[\r\n\[\]`]/g, ' ').replaceAll('@', '＠')

export function notification({ env, phase, version, started, now = Date.now() }) {
  const platform = { macos: 'macOS', windows: 'Windows' }[env.ARKME_BUILD_PLATFORM]
  if (!platform || !['start', 'finish', 'release'].includes(phase)) throw new Error('Invalid notification phase/platform')
  const result = phase === 'start' ? 'start' : env.ARKME_BUILD_RESULT
  if (result === 'success' && (phase !== 'release' || env.ARKME_RELEASE_RESULT !== 'success')) throw new Error('Publication has not succeeded')
  const label = { start: '🚀 开始构建', success: '✅ 发布成功', failure: '❌ 构建失败', cancelled: '⏹ 构建已取消' }[result] ?? 'ℹ️ 构建已结束（状态未知）'
  const statusLabel = phase === 'release' ? label.replaceAll('构建', '发布') : label
  const lines = [`arkme-dsh-client ${platform} ${statusLabel}`, `环境：${clean(env.ARKME_CI_ENV)}`, `分支：${clean(env.GITHUB_REF_NAME)}`]
  lines.push(`构建创建人：${clean(env.ARKME_BUILD_CREATOR || env.GITHUB_ACTOR || '未知')}`)
  if (version?.version && version?.version_code) lines.push(`版本：${clean(version.version)} / vc${clean(version.version_code)}`)
  if (phase !== 'start' && Number.isFinite(started) && now >= started) {
    const seconds = Math.floor((now - started) / 1000)
    lines.push(`耗时：约 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`)
  }
  if (result === 'success') {
    lines.push(`产物：${platform === 'macOS' ? 'PKG、ZIP 与更新文件' : 'EXE、ZIP 与更新文件'}已上传 OSS`)
    lines.push('发布状态：产物及兼容配置校验通过，版本已正式生效')
  }
  lines.push(`🔗 查看构建详情：https://github.com/${clean(env.GITHUB_REPOSITORY)}/actions/runs/${clean(env.GITHUB_RUN_ID)}/attempts/${clean(env.GITHUB_RUN_ATTEMPT)}`)
  const identity = [env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.ARKME_BUILD_PLATFORM, phase]
  if (identity.some(value => !value)) throw new Error('Missing notification identity')
  return { message: lines.join('\n'), external_message_id: `arkme-build-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}` }
}

// Never log request bodies, URLs, credentials or raw fetch/server errors.
export async function sendNotification({ env, payload, fetchImpl = fetch, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const token = env.ARKME_BUILD_WEBHOOK_TOKEN?.trim()
  if (!token) return 'unconfigured'
  let url
  try { url = new URL(env.ARKME_BUILD_WEBHOOK_URL || defaultURL) } catch { return 'invalid_config' }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return 'invalid_config'
  const body = JSON.stringify({ ...payload, token })
  for (let attempt = 0; attempt < 3; attempt++) {
    let retry = false
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) })
      if (response.ok) {
        const envelope = await response.json()
        if ((envelope.data ?? envelope).accepted === true) return 'accepted'
        return 'rejected'
      }
      retry = [408, 429].includes(response.status) || response.status >= 500
      if (!retry) return 'rejected'
    } catch { retry = true }
    if (retry && attempt < 2) await wait(1000 * 2 ** attempt)
  }
  return 'unavailable'
}

async function main() {
  const env = process.env
  const phase = process.argv[2]
  const marker = join(env.RUNNER_TEMP || '.', `arkme-build-start-${env.ARKME_BUILD_PLATFORM}.json`)
  let started, version
  if (phase === 'start') await writeFile(marker, JSON.stringify(Date.now()))
  else { try { started = JSON.parse(await readFile(marker, 'utf8')) } catch {} }
  try { version = JSON.parse(await readFile('reservation.json', 'utf8')) } catch {}
  if (phase === 'release' && version?.created_at) started = Number(version.created_at) * 1000
  const status = await sendNotification({ env, payload: notification({ env, phase, version, started }) })
  if (status === 'accepted') console.log('Build notification accepted')
  else console.log(`::warning::Build notification: ${status}. Check ARKME_BUILD_WEBHOOK_TOKEN and bot configuration.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.log('::warning::Build notification failed; details suppressed to protect credentials.') })
}
