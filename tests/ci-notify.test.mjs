import { test } from 'vitest'
import assert from 'node:assert/strict'
import { notification, sendNotification } from '../scripts/ci/notify.mjs'

const env = { ARKME_BUILD_PLATFORM: 'macos', ARKME_CI_ENV: 'test', GITHUB_REF_NAME: 'pre-release', GITHUB_REPOSITORY: 'arkme-senx/arkme-dsh-client', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', ARKME_BUILD_RESULT: 'success', ARKME_RELEASE_RESULT: 'success' }
const make = (overrides = {}, phase = 'release') => notification({ env: { ...env, ...overrides }, phase, started: 1000, now: 158000, version: { version: '3.0.49', version_code: 327 } })

test('release success requires publication success; failures never claim uploaded artifacts', () => {
  const payload = make()
  for (const text of ['macOS', '发布成功', '2 分 37 秒', 'vc327', 'PKG', '已上传 OSS']) assert.ok(payload.message.includes(text))
  assert.ok(make({ ARKME_BUILD_PLATFORM: 'windows' }).message.includes('EXE'))
  assert.throws(() => make({ ARKME_RELEASE_RESULT: 'failure' }))
  assert.throws(() => make({}, 'finish'))
  for (const [result, label] of [['failure', '发布失败'], ['cancelled', '发布已取消']]) {
    const message = make({ ARKME_BUILD_RESULT: result }).message
    assert.ok(message.includes(label))
    assert.ok(!message.includes('已上传 OSS'))
  }
})

test('every notification shows the original creator immediately after the branch', () => {
  const source = { GITHUB_REF_NAME: 'master', ARKME_BUILD_CREATOR: 'imanai666', GITHUB_ACTOR: 'push-account', GITHUB_TRIGGERING_ACTOR: 'rerun-account' }
  for (const [phase, result] of [['start', 'start'], ['finish', 'failure'], ['finish', 'cancelled'], ['release', 'success']]) {
    const { message } = make({ ...source, ARKME_BUILD_RESULT: result }, phase)
    assert.ok(message.includes('分支：master\n构建创建人：imanai666\n'))
  }
  assert.ok(make({ ...source, ARKME_BUILD_CREATOR: '' }).message.includes('构建创建人：push-account\n'))
})

test('deduplication isolates platforms, phases and run attempts', () => {
  const ids = [make(), make({ ARKME_BUILD_PLATFORM: 'windows' }), make({}, 'start'), make({ GITHUB_RUN_ATTEMPT: '2' })].map(p => p.external_message_id)
  assert.equal(new Set(ids).size, 4)
  assert.equal(make().external_message_id, ids[0])
  assert.ok(ids.every(id => id.length <= 128))
})

test('transient failure retries identical payload; token follows actual bot contract', async () => {
  const bodies = []
  const status = await sendNotification({ env: { ...env, ARKME_BUILD_WEBHOOK_TOKEN: 'test-secret' }, payload: make(), wait: async () => {}, fetchImpl: async (url, options) => {
    assert.equal(url.hostname, 'bot.jotmo.cc')
    assert.equal(options.redirect, 'error')
    bodies.push(options.body)
    if (bodies.length === 1) throw new Error('sensitive transport details')
    return { ok: true, json: async () => ({ data: { accepted: true, deduplicated: true } }) }
  } })
  assert.equal(status, 'accepted')
  assert.equal(bodies[0], bodies[1])
  assert.equal(JSON.parse(bodies[0]).token, 'test-secret')
})

test('missing credential makes no request; rejection is not success or retried', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ data: { accepted: false } }) } }
  assert.equal(await sendNotification({ env, payload: make(), fetchImpl }), 'unconfigured')
  assert.equal(calls, 0)
  assert.equal(await sendNotification({ env: { ...env, ARKME_BUILD_WEBHOOK_TOKEN: 'test' }, payload: make(), fetchImpl }), 'rejected')
  assert.equal(calls, 1)
})

test('transport failures are bounded and never return sensitive errors', async () => {
  let calls = 0
  const status = await sendNotification({ env: { ...env, ARKME_BUILD_WEBHOOK_TOKEN: 'test' }, payload: make(), wait: async () => {}, fetchImpl: async () => { calls++; throw new Error('secret') } })
  assert.equal(status, 'unavailable')
  assert.equal(calls, 3)
})
