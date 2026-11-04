import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import * as miniflare from 'miniflare'
const { Miniflare } = miniflare
const compatibleOptions = miniflare.convertV4MiniflareOptions ?? (options => options)

// 全部凭据均为测试夹具；所有出站请求在此拦截，绝不访问云账号。
const state = { traffic: 190, trafficFailed: false, balanceFailed: false, instancesFailed: false, stopFailed: true, startFailed: false, notifyFailed: true, notifications: 0, stallTraffic: false, stallBody: false, status: 'Running', stops: 0, starts: 0, requests: 0 }
const testDirectory = await mkdtemp(resolve(tmpdir(), 'cdt-worker-test-'))
const mf = new Miniflare(compatibleOptions({ resourcePersistencePath: testDirectory, workers: [{ name: 'monitor',
  modules: [
    { type: 'ESModule', path: resolve('tests/budget-worker.mjs') },
    { type: 'ESModule', path: resolve('build/index.js') },
    { type: 'CompiledWasm', path: resolve('build/index_bg.wasm') },
  ],
  compatibilityDate: '2026-10-01',
  compatibilityFlags: ['no_nodejs_global_timers'],
  d1Databases: ['DB'],
  queueProducers: { TASKS: 'cdt-monitor-tasks' },
  queueConsumers: { 'cdt-monitor-tasks': { maxBatchSize: 1, maxBatchTimeout: 0, retryDelay: 1 } },
  bindings: { MASTER_KEY: 'ab'.repeat(32), ADMIN_USERNAME: 'review', ADMIN_PASSWORD: 'test-password-only' },
  outboundService: async request => {
    state.requests++
    const url = new URL(request.url)
    const action = url.searchParams.get('Action')
    const fail = () => Response.json({ Code: 'Forbidden', Message: 'fixture failure' }, { status: 403 })
    if (url.origin === 'https://api.telegram.org') {
      state.notifications++
      return state.notifyFailed ? fail() : Response.json({ ok: true })
    }
    switch (action) {
      case 'ListCdtInternetTraffic':
        if (state.stallTraffic) return new Promise(() => {})
        if (state.stallBody) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'content-type': 'application/json' } })
        return state.trafficFailed ? fail() : Response.json({ TrafficDetails: [{ BusinessRegionId: 'cn-hongkong', Traffic: state.traffic * 1024 ** 3 }] })
      case 'QueryAccountBalance': return state.balanceFailed ? fail() : Response.json({ Data: { AvailableAmount: '42.00', Currency: 'USD' } })
      case 'DescribeInstances': return state.instancesFailed ? fail() : Response.json({ Instances: { Instance: [{ InstanceId: 'i-review', RegionId: 'cn-hongkong', Status: state.status, SpotStrategy: 'SpotAsPriceGo' }] } })
      case 'StopInstance':
        state.stops++
        if (state.stopFailed) return fail()
        state.status = 'Stopped'
        return Response.json({ RequestId: 'fixture' })
      case 'StartInstance': state.starts++; if (state.startFailed) return fail(); state.status = 'Running'; return Response.json({ RequestId: 'fixture' })
      default: throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`)
    }
  },
}] }))
let cookie = ''
async function request(path, method = 'GET', body, ip = '192.0.2.1') {
  return mf.dispatchFetch(`https://monitor.test/api/v1/${path}`, {
    method, headers: { 'content-type': 'application/json', cookie, 'cf-connecting-ip': ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
async function api(path, method = 'GET', body) {
  const response = await request(path, method, body)
  const value = await response.json()
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`)
  return value
}
async function runJob(path, expected = 'success') {
  const accepted = await api(path, 'POST')
  const deadline = Date.now() + 35_000
  while (Date.now() < deadline) {
    const job = await api(`jobs/${accepted.job_id}`)
    if (['success', 'failed'].includes(job.status)) {
      assert.equal(job.status, expected, JSON.stringify(job))
      return job
    }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Job timed out: ${accepted.job_id}`)
}
async function eventually(check, label, timeout = 35_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await check()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}`)
}
let cronSequence = Date.now() - 60_000
async function cronAccount(worker, accountId) {
  const result = await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
    body: { Cron: { account_id: accountId, scheduled_at: ++cronSequence } },
  }])
  assert.equal(result.outcome, 'ok', JSON.stringify(result))
  assert.equal(result.retryMessages.length, 0, JSON.stringify(result))
}

try {
  const db = await mf.getD1Database('DB')
  for (const filename of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
    if (filename === 'init_003_reliability.sql') {
      await db.batch([
        db.prepare("INSERT INTO accounts (id, name, access_key_id, encrypted_access_key_secret, instance_id, traffic_threshold_gb, enabled, created_at, updated_at) VALUES (999, 'Legacy', 'legacy-key', 'preserved-ciphertext', 'i-legacy', 180, 0, 1, 1)"),
        db.prepare("INSERT INTO account_snapshots (account_id, billing_month, cdt_overseas_bytes, threshold_triggered_month, updated_at) VALUES (999, '2000-01', 123456, '2000-01', 1)"),
        db.prepare("INSERT INTO jobs (id, job_type, status, created_at) VALUES ('legacy-pending', 'refresh_all', 'pending', 1), ('legacy-running', 'start_instance', 'running', 1), ('legacy-success', 'refresh_all', 'success', 1)"),
        db.prepare("INSERT INTO locks (name, owner, expires_at) VALUES ('legacy-lock', 'legacy-running', 1)"),
      ])
    }
    const sql = (await readFile(`migrations/${filename}`, 'utf8')).replace(/^--.*$/gm, '')
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
    await db.batch(statements.map(s => db.prepare(s)))
  }
  const legacy = await db.prepare('SELECT * FROM account_snapshots WHERE account_id = 999').first()
  assert.equal(legacy.cdt_overseas_bytes, 123456)
  assert.equal(legacy.threshold_limit_gb, 180)
  assert.equal(legacy.traffic_updated_at, null)
  assert.equal((await db.prepare('SELECT encrypted_access_key_secret AS secret FROM accounts WHERE id = 999').first()).secret, 'preserved-ciphertext')
  assert.equal((await db.prepare("SELECT status FROM jobs WHERE id = 'legacy-pending'").first()).status, 'failed')
  assert.equal((await db.prepare("SELECT status FROM jobs WHERE id = 'legacy-running'").first()).status, 'failed')
  assert.equal((await db.prepare("SELECT status FROM jobs WHERE id = 'legacy-success'").first()).status, 'success')
  assert.equal(await db.prepare("SELECT * FROM locks WHERE name = 'legacy-lock'").first(), null)
  await db.batch([
    db.prepare('DELETE FROM accounts WHERE id = 999'),
    db.prepare("DELETE FROM jobs WHERE id IN ('legacy-pending', 'legacy-running', 'legacy-success')"),
  ])
  console.log('✓ 存量库升级保留账号密文和快照，清理旧执行器未完成任务')
  let response = await request('auth/login', 'POST', { username: 'review', password: 'test-password-only' })
  assert.equal(response.status, 200, await response.clone().text())
  cookie = response.headers.get('set-cookie').split(';')[0]
  const config = { name: 'Fixture', site_type: 'intl', access_key_id: 'fixture-access-key', access_key_secret: 'fixture-secret', region_id: 'cn-hongkong', instance_id: 'i-review', traffic_threshold_gb: 180, over_limit_action: 'stop_and_notify', stop_mode: 'StopCharging', enabled: true, spot_keep_alive: false }
  const account = await api('accounts', 'POST', config)
  const id = account.id
  const snapshot = () => db.prepare('SELECT * FROM account_snapshots WHERE account_id = ?').bind(id).first()
  const refresh = (expected) => runJob(`accounts/${id}/refresh`, expected)
  await api('settings/telegram', 'PUT', { enabled: true, token: '123456:fixture-token-for-tests', chat_id: 'fixture-chat' })

  await refresh()
  assert.equal(state.stops, 1)
  assert.equal((await snapshot()).threshold_stop_status, 'pending')
  assert.equal((await snapshot()).threshold_notified_month, null)
  assert.equal(state.notifications, 1)
  state.stopFailed = false
  state.notifyFailed = false
  await refresh()
  assert.equal(state.stops, 2, 'previous failed stop must be retried')
  assert.ok((await snapshot()).threshold_notified_month)
  assert.equal(state.notifications, 2)
  await refresh()
  assert.equal((await snapshot()).threshold_stop_status, 'confirmed')
  assert.equal(state.stops, 2, 'confirmed stop must not be reissued')
  assert.equal(state.notifications, 2, 'delivered alert must not be resent')
  console.log('✓ 熔断停机失败后重试，核实终态')
  console.log('✓ 熔断告警发送失败后重试，成功送达后去重')
  await api('settings/telegram', 'PUT', { enabled: false })

  await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 250 })
  state.trafficFailed = true
  await refresh('failed')
  assert.ok((await snapshot()).threshold_triggered_month, 'failed sampling cannot release breaker')
  state.trafficFailed = false
  await refresh()
  assert.equal((await snapshot()).threshold_triggered_month, null)
  console.log('✓ 提升阈值必须经成功采集才解除熔断')

  await api(`accounts/${id}`, 'PUT', config)
  await db.prepare("UPDATE account_snapshots SET billing_month = '2000-01', threshold_triggered_month = '2000-01', cdt_overseas_bytes = ?, traffic_updated_at = 1234 WHERE account_id = ?").bind(190 * 1024 ** 3, id).run()
  state.trafficFailed = true
  const stops = state.stops
  await refresh('failed')
  const stale = await snapshot()
  assert.equal(stale.billing_month, '2000-01')
  assert.equal(stale.traffic_updated_at, 1234)
  assert.equal(state.stops, stops)
  const overview = await api('overview')
  assert.equal(overview.accounts[0].traffic_current, false)
  assert.ok(overview.accounts[0].sync_errors.length)
  state.trafficFailed = false
  state.traffic = 1
  await refresh()
  assert.equal((await snapshot()).threshold_triggered_month, null)
  console.log('✓ 跨月失败保留原账期，成功低用量不会继承错误熔断')

  state.balanceFailed = true
  const oldBalanceAt = (await snapshot()).balance_updated_at
  const partial = await refresh()
  assert.match(partial.result_msg, /余额查询失败/)
  assert.equal((await snapshot()).balance_updated_at, oldBalanceAt)
  state.balanceFailed = false
  console.log('✓ 部分失败返回详情，保留各来源成功时间')

  await api('accounts', 'POST', { ...config, name: 'Second', traffic_threshold_gb: 0 })
  await db.prepare("INSERT INTO jobs (id, job_type, status, created_at, payload_json) VALUES ('queued-batch', 'refresh_all', 'pending', ?, '{}')").bind(Date.now()).run()
  await db.prepare("INSERT INTO locks (name, owner, expires_at) VALUES ('job:refresh_all', 'queued-batch', 1)").run()
  response = await request('refresh', 'POST')
  assert.equal(response.status, 409, 'unfinished batch must retain mutual exclusion beyond lock TTL')
  await db.prepare("UPDATE jobs SET created_at = 1 WHERE id = 'queued-batch'").run()
  const batchJob = await api('refresh', 'POST')
  const all = await eventually(async () => {
    const row = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(batchJob.job_id).first()
    return row?.status === 'success' && row
  }, 'batch should finish without HTTP polling')
  assert.match(all.result_msg, /2 个账号刷新成功/)
  assert.equal((await api('jobs/queued-batch')).status, 'failed')
  console.log('✓ 批量任务无需浏览器轮询即可完成，并持久化进度')
  console.log('✓ 未完成批量任务过锁期仍防重复提交，超期任务可回收')

  await db.prepare("INSERT INTO jobs (id, job_type, status, created_at, started_at, payload_json) VALUES ('interrupted', 'stop_instance', 'running', ?, ?, '{}')").bind(Date.now() - 120_000, Date.now() - 120_000).run()
  await db.prepare("INSERT INTO locks (name, owner, expires_at) VALUES ('job:fixture', 'interrupted', ?)").bind(Date.now() + 100000).run()
  const interrupted = await api('jobs/interrupted')
  assert.equal(interrupted.status, 'failed')
  assert.equal(await db.prepare("SELECT * FROM locks WHERE owner = 'interrupted'").first(), null)
  assert.equal(state.stops, stops, 'ambiguous stop must not be replayed')
  console.log('✓ 中断任务收敛为失败并释放锁，不重放启停指令')

  await db.prepare('UPDATE accounts SET enabled = 0 WHERE id != ?').bind(id).run()
  await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: true, schedule_mode: 'advanced', schedule_stop_cron: '* * * * *' })
  await api(`accounts/${id}/instances/i-review/keep-alive`, 'PUT', { enabled: true })
  state.status = 'Running'
  const worker = await mf.getWorker('monitor')
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() })
  await eventually(async () => (await db.prepare('SELECT last_schedule_stop_at AS at FROM accounts WHERE id = ?').bind(id).first()).at, 'scheduled stop')
  assert.equal(state.status, 'Stopped')
  const starts = state.starts
  await cronAccount(worker, id)
  assert.equal(state.starts, starts, 'Cron stop must not be undone by keep alive')
  console.log('✓ 真实 Cron 入口：进阶关机后下轮保活不会重新开机')

  // 旧快照显示已停止，云端实际运行；本轮查询失败不能把定时关机标记完成。
  await db.prepare('UPDATE accounts SET last_schedule_stop_at = NULL, last_schedule_stop_date = NULL WHERE id = ?').bind(id).run()
  state.status = 'Stopped'
  await refresh()
  state.status = 'Running'
  state.instancesFailed = true
  const previousStops = state.stops
  await cronAccount(worker, id)
  assert.equal((await db.prepare('SELECT last_schedule_stop_at AS at FROM accounts WHERE id = ?').bind(id).first()).at, null)
  assert.equal(state.stops, previousStops)
  state.instancesFailed = false
  await cronAccount(worker, id)
  assert.equal(state.stops, previousStops + 1)
  console.log('✓ 实例查询失败不会用旧快照标记定时关机完成，恢复后补偿执行')

  await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: true })
  await db.prepare('UPDATE accounts SET last_schedule_stop_at = NULL, last_schedule_stop_date = NULL WHERE id = ?').bind(id).run()
  state.status = 'Stopped'
  state.startFailed = true
  const previousStarts = state.starts
  await cronAccount(worker, id)
  assert.equal(state.starts, previousStarts + 1)
  assert.equal(await db.prepare('SELECT * FROM locks WHERE name = ?').bind(`keepalive:${id}:i-review`).first(), null)
  state.startFailed = false
  await cronAccount(worker, id)
  assert.equal(state.starts, previousStarts + 2)
  assert.equal(state.status, 'Running')
  console.log('✓ 保活开机失败释放冷却锁，下轮核实状态后重试')

  await api('settings/telegram', 'PUT', { enabled: true })
  state.trafficFailed = true
  state.notifyFailed = true
  const beforeNotice = state.notifications
  await cronAccount(worker, id)
  assert.equal(state.notifications, beforeNotice + 1)
  state.notifyFailed = false
  await cronAccount(worker, id)
  assert.equal(state.notifications, beforeNotice + 2)
  await cronAccount(worker, id)
  assert.equal(state.notifications, beforeNotice + 2, 'successful alert is deduplicated')
  state.trafficFailed = false
  await api('settings/telegram', 'PUT', { enabled: false })
  console.log('✓ 巡检通知失败后重试，送达后才保留去重锁')

  const keyword = '长中文关键词测试'.repeat(10) + '%_Test'
  await db.prepare("INSERT INTO action_logs (action_type, detail, created_at) VALUES ('search_fixture', ?, ?)").bind(keyword, Date.now()).run()
  await db.prepare("INSERT INTO action_logs (action_type, detail, created_at) VALUES ('search_fixture', 'unrelated', ?)").bind(Date.now()).run()
  assert.equal((await api(`logs?q=${encodeURIComponent(keyword.toLowerCase())}`)).length, 1)
  assert.equal((await api('logs?q=%25_')).length, 1, 'wildcards must be literal')
  await api(`logs?q=${encodeURIComponent(keyword)}`, 'DELETE')
  assert.equal((await api('logs?action=search_fixture')).length, 1, 'filtered deletion preserves unrelated logs')
  console.log('✓ 长中文日志关键词与通配符按字面匹配，查询和删除条件一致')

  const beforeDuplicate = state.starts
  const manual = await api(`accounts/${id}/instances/i-review/stop`, 'POST')
  await eventually(async () => (await db.prepare('SELECT status FROM jobs WHERE id = ?').bind(manual.job_id).first()).status === 'success', 'manual stop')
  const afterManualStop = state.stops
  await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { Job: { id: manual.job_id } } }])
  assert.equal(state.stops, afterManualStop, 'redelivered completed job cannot replay the command')
  assert.equal(state.starts, beforeDuplicate)
  console.log('✓ 队列重复投递不重放已完成的开关机任务')

  // 账号规模超过原单次 Cron 的免费额度；每个消费调用受 50 次 D1 上限检查。
  await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: false })
  for (let index = 0; index < 10; index++) {
    await api('accounts', 'POST', { ...config, name: `Scale ${index}`, traffic_threshold_gb: 0 })
  }
  const cycleAt = Date.now()
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: cycleAt })
  await eventually(async () => {
    const { count } = await db.prepare('SELECT COUNT(*) AS count FROM accounts a JOIN account_snapshots s ON s.account_id = a.id WHERE a.enabled = 1 AND s.traffic_updated_at >= ?').bind(cycleAt).first()
    return count === 11
  }, 'all 11 accounts must be sampled within separate D1 budgets')
  await db.prepare('UPDATE accounts SET enabled = 0 WHERE id != ?').bind(id).run()
  console.log('✓ 11 个账号通过真实 Cron 分发完成采样，每次执行不超过 50 次 D1 调用')

  const beforeAtomic = await snapshot()
  await db.prepare("CREATE TRIGGER fail_daily BEFORE INSERT ON traffic_daily BEGIN SELECT RAISE(ABORT, 'fixture history write failure'); END").run()
  state.traffic = 42
  await refresh('failed')
  assert.equal((await snapshot()).cdt_overseas_bytes, beforeAtomic.cdt_overseas_bytes, 'history failure must roll back the snapshot')
  await db.prepare('DROP TRIGGER fail_daily').run()
  state.traffic = 1
  console.log('✓ 历史写入失败会回滚同批快照，避免部分写入')

  state.stallTraffic = true
  let began = Date.now()
  const stalled = await refresh('failed')
  assert.match(stalled.error_msg, /超时/)
  assert.ok(Date.now() - began < 25_000, 'stalled headers must respect request budget')
  state.stallTraffic = false
  state.stallBody = true
  began = Date.now()
  const stalledBody = await refresh('failed')
  assert.match(stalledBody.error_msg, /超时/)
  assert.ok(Date.now() - began < 25_000, 'stalled response body must respect request budget')
  state.stallBody = false
  console.log('✓ 请求头和响应体卡住时均能超时收尾')

  const attempts = await Promise.all(Array.from({ length: 12 }, () => request('auth/login', 'POST', { username: 'review', password: 'wrong' }, '192.0.2.2')))
  assert.equal(attempts.filter(r => r.status === 401).length, 10)
  assert.equal(attempts.filter(r => r.status === 429).length, 2)
  console.log('✓ 并发登录尝试也受原子限流约束')

  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('turnstile', '{broken', 0)").run()
  response = await request('auth/login', 'POST', { username: 'review', password: 'test-password-only' }, '192.0.2.3')
  assert.equal(response.status, 500)
  assert.equal((await response.json()).code, 'turnstile_broken')
  console.log('✓ 人机校验配置损坏时拒绝登录')
} finally {
  await mf.dispose()
  await rm(testDirectory, { recursive: true, force: true })
}
