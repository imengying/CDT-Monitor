import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Miniflare } from 'miniflare'

// 全部凭据均为测试夹具；所有出站请求在此拦截，绝不访问云账号。
const state = { instanceId: 'i-review', stoppedIds: [], trafficCalls: 0, traffic: 190, trafficFailed: false, balanceFailed: false, instancesFailed: false, stopFailed: true, startFailed: false, notifyFailed: true, notifications: 0, stallTraffic: false, stallBody: false, status: 'Running', stops: 0, starts: 0, requests: 0 }
state.trafficResponses = []
state.trafficAttempts = null
state.ipv6 = null
state.hideInstanceIpv6 = false
state.networkCalls = 0
state.networkFailed = false
state.stallNetwork = false
state.networkPages = null
state.balanceCalls = 0
state.instanceCalls = 0
let trafficGate = null
let instanceGate = null
const testDirectory = await mkdtemp(resolve(tmpdir(), 'cdt-worker-test-'))
const mf = new Miniflare({ d1Persist: testDirectory, workers: [{ name: 'monitor',
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
      case 'GetCallerIdentity': return url.searchParams.get('AccessKeyId') === 'invalid-key' ? fail() : Response.json({ AccountId: url.searchParams.get('AccessKeyId') === 'replacement-key' ? '2002' : '1001' })
      case 'ListCdtInternetTraffic':
        state.trafficCalls++
        state.trafficAttempts?.push({ nonce: url.searchParams.get('SignatureNonce'), timestamp: url.searchParams.get('Timestamp'), signature: url.searchParams.get('Signature') })
        if (state.trafficResponses.length) {
          const { status, body } = state.trafficResponses.shift()
          return new Response(body, { status })
        }
        if (trafficGate) await trafficGate
        if (state.stallTraffic) return new Promise(() => {})
        if (state.stallBody) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'content-type': 'application/json' } })
        return state.trafficFailed ? fail() : Response.json({ TrafficDetails: [{ BusinessRegionId: 'cn-hongkong', Traffic: state.traffic * 1024 ** 3 }] })
      case 'QueryAccountBalance':
        state.balanceCalls++
        return state.balanceFailed ? fail() : Response.json({ Data: { AvailableAmount: '42.00', Currency: 'USD' } })
      case 'DescribeInstances': {
        state.instanceCalls++
        if (instanceGate) await instanceGate
        if (state.instancesFailed) return fail()
        // 官方接口仅在请求扩展属性时返回主网卡 IPv6，避免只测解析器而漏测请求。
        const ipv6Sets = !state.hideInstanceIpv6 && url.searchParams.get('AdditionalAttributes.1') === 'NETWORK_PRIMARY_ENI_IP' && state.ipv6
          ? [{ Ipv6Address: state.ipv6, Primary: true }] : []
        return Response.json({ Instances: { Instance: [{ InstanceId: state.instanceId, RegionId: 'cn-hongkong', Status: state.status, SpotStrategy: 'SpotAsPriceGo',
          NetworkInterfaces: { NetworkInterface: [{ Type: 'Primary', Ipv6Sets: { Ipv6Set: ipv6Sets } }] },
        }] } })
      }
      case 'DescribeNetworkInterfaces': {
        state.networkCalls++
        assert.equal(url.searchParams.get('RegionId'), 'cn-hongkong')
        assert.equal(url.searchParams.get('InstanceId'), state.instanceId)
        assert.equal(url.searchParams.has('Type'), false, 'include secondary ENIs')
        if (state.networkFailed) return fail()
        if (state.stallNetwork) return new Promise(() => {})
        if (state.networkPages) {
          const token = url.searchParams.get('NextToken') ?? ''
          assert.ok(Object.hasOwn(state.networkPages, token), 'unexpected ENI pagination token')
          return Response.json(state.networkPages[token])
        }
        const ipv6Sets = state.ipv6 ? [{ Ipv6Address: state.ipv6, Primary: true }] : []
        // DescribeNetworkInterfaces 官方结构使用 NetworkInterfaceSet，区别于实例详情。
        return Response.json({ NetworkInterfaceSets: { NetworkInterfaceSet: [{ Type: 'Primary', InstanceId: state.instanceId, Ipv6Sets: { Ipv6Set: ipv6Sets } }] } })
      }
      case 'StopInstance':
        state.stops++
        state.stoppedIds.push(url.searchParams.get('InstanceId'))
        if (state.stopFailed) return fail()
        state.status = 'Stopped'
        return Response.json({ RequestId: 'fixture' })
      case 'StartInstance': state.starts++; if (state.startFailed) return fail(); state.status = 'Running'; return Response.json({ RequestId: 'fixture' })
      default: throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`)
    }
  },
}] })
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
async function cronAccount(worker, accountId, retry = false) {
  const result = await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
    body: { Cron: { account_id: accountId, scheduled_at: ++cronSequence } },
  }])
  assert.equal(result.outcome, 'ok', JSON.stringify(result))
  assert.equal(result.retryMessages.length, retry ? 1 : 0, JSON.stringify(result))
}

try {
  const db = await mf.getD1Database('DB')
  const worker = await mf.getWorker('monitor')
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
  // 存量配置可能设置过 30 天，新登录必须忽略旧字段并固定为 7 天。
  await db.prepare("UPDATE settings SET value = ? WHERE key = 'advanced'")
    .bind(JSON.stringify({ log_level: 'error', job_lock_ttl_ms: 600_000, session_ttl_ms: 30 * 86400_000 })).run()
  let response = await request('auth/login', 'POST', { username: 'review', password: 'test-password-only' })
  assert.equal(response.status, 200, await response.clone().text())
  assert.match(response.headers.get('set-cookie'), /Max-Age=604800(?:;|$)/i)
  cookie = response.headers.get('set-cookie').split(';')[0]
  const session = await db.prepare('SELECT created_at, expires_at FROM sessions').first()
  assert.equal(session.expires_at - session.created_at, 7 * 86400_000)
  assert.equal('session_ttl_ms' in (await api('settings')).advanced, false)
  for (const extra of [{}, { session_ttl_ms: 60_000 }]) {
    const settings = await api('settings/advanced', 'PUT', { log_level: 'error', job_lock_ttl_ms: 600_000, ...extra })
    assert.equal('session_ttl_ms' in settings.advanced, false)
    const stored = JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'advanced'").first()).value)
    assert.equal('session_ttl_ms' in stored, false)
  }
  console.log('✓ 新登录固定 7 天，旧会话有效期配置和旧客户端字段不再生效')
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
  assert.equal(JSON.parse((await snapshot()).instances_json)[0].status, 'Stopping')
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
  const beforeEmpty = await snapshot()
  const history = async () => (await db.prepare('SELECT * FROM traffic_hourly WHERE account_id = ? ORDER BY recorded_at').bind(id).all()).results
  const beforeEmptyHistory = await history()
  const emptyCalls = state.trafficCalls
  state.trafficResponses = [
    { status: 200, body: '{"TrafficDetails":[]}' },
    { status: 200, body: '{"Data":{"TrafficDetails":[]}}' },
    { status: 200, body: '{}' },
  ]
  const emptyJob = await refresh('failed')
  assert.match(emptyJob.error_msg, /连续 3 次返回空流量明细/)
  assert.equal(state.trafficCalls - emptyCalls, 3)
  const afterEmpty = await snapshot()
  for (const field of ['billing_month', 'cdt_domestic_bytes', 'cdt_overseas_bytes', 'traffic_updated_at', 'threshold_triggered_month', 'threshold_limit_gb']) {
    assert.equal(afterEmpty[field], beforeEmpty[field], `empty traffic must preserve ${field}`)
  }
  assert.deepEqual(await history(), beforeEmptyHistory, 'empty traffic must not overwrite history with zero')
  console.log('✓ 连续空流量响应重试耗尽后失败，保留用量、账期、成功时间、历史与熔断')
  state.traffic = 0
  state.trafficResponses = [{ status: 200, body: '{"TrafficDetails":[]}' }]
  const recoveredCalls = state.trafficCalls
  await refresh()
  assert.equal(state.trafficCalls - recoveredCalls, 2)
  assert.equal((await snapshot()).cdt_overseas_bytes, 0, 'explicit zero traffic remains valid')
  assert.equal((await snapshot()).threshold_triggered_month, null)
  state.traffic = 190
  console.log('✓ 提升阈值必须经成功采集才解除熔断')

  for (const response of [
    { status: 429, body: 'Too Many Requests' },
    { status: 400, body: '{"Code":"InvalidTimeStamp.Expired","Message":"Request expired"}' },
    { status: 200, body: '{"Code":"MissingParameter","Message":"The input parameter Timestamp is not supplied."}' },
  ]) {
    state.trafficResponses = [response]
    state.trafficAttempts = []
    await refresh()
    assert.equal(state.trafficAttempts.length, 2)
    assert.equal(new Set(state.trafficAttempts.map(a => a.nonce)).size, 2)
    assert.equal(new Set(state.trafficAttempts.map(a => a.signature)).size, 2)
    assert.ok(state.trafficAttempts.every(a => a.timestamp && Number.isFinite(Date.parse(a.timestamp))))
  }
  state.trafficResponses = Array.from({ length: 3 }, () => ({ status: 429, body: 'Too Many Requests' }))
  state.trafficAttempts = []
  await refresh('failed')
  assert.equal(state.trafficAttempts.length, 3, 'persistent throttling must stop after three attempts')
  state.trafficFailed = true
  state.trafficAttempts = []
  await refresh('failed')
  assert.equal(state.trafficAttempts.length, 1, 'permission failures must not be retried')
  state.trafficFailed = false
  state.trafficAttempts = null
  console.log('✓ HTTP 429 与瞬态时间戳错误重新签名后重试，持续失败有上限，权限错误不重试')

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
  const staleReport = await runJob('reports/daily')
  assert.match(staleReport.result_msg, /本月合计流量 0\.00 GB/)
  assert.match(staleReport.result_msg, /1 个账号本月流量待采集/)
  assert.match(staleReport.result_msg, /本月流量待采集（未计入合计）/)
  assert.match(staleReport.result_msg, /采集异常/)
  assert.doesNotMatch(staleReport.result_msg, /190\.00/)
  console.log('✓ 日报排除旧账期流量，并说明未采集账号与异常')
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

  const disabled = await api('accounts', 'POST', { ...config, enabled: false })
  const beforeDisabled = state.requests
  await api('overview?refresh=transitional')
  await cronAccount(worker, disabled.id)
  await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
    body: { Refresh: { account_id: disabled.id, requested_at: Date.now() } },
  }])
  assert.equal(state.requests, beforeDisabled, 'disabled accounts must not reach cloud APIs through automatic refresh')
  assert.equal(await db.prepare('SELECT * FROM account_snapshots WHERE account_id = ?').bind(disabled.id).first(), null)
  const disabledStops = state.stops
  state.traffic = 190
  state.status = 'Running'
  await runJob(`accounts/${disabled.id}/refresh`)
  assert.equal(state.stops, disabledStops, 'explicit sampling of a disabled account must not execute threshold actions')
  assert.equal((await db.prepare('SELECT threshold_triggered_month FROM account_snapshots WHERE account_id = ?').bind(disabled.id).first()).threshold_triggered_month, null)
  await api(`accounts/${disabled.id}`, 'DELETE')
  state.traffic = 1
  state.status = 'Stopped'
  console.log('✓ 停用账号不自动补采，已排队消息也跳过，手动采集不触发熔断停机')

  await refresh()
  const balanceCalls = state.balanceCalls
  const balanceAt = (await snapshot()).balance_updated_at
  await cronAccount(worker, id)
  await cronAccount(worker, id)
  assert.equal(state.balanceCalls, balanceCalls)
  assert.equal((await snapshot()).balance_updated_at, balanceAt)
  await db.prepare('UPDATE account_snapshots SET balance_updated_at = ? WHERE account_id = ?').bind(Date.now() - 31 * 60_000, id).run()
  state.balanceFailed = true
  await cronAccount(worker, id)
  assert.equal(state.balanceCalls, balanceCalls + 1)
  assert.ok((await snapshot()).balance_updated_at < balanceAt)
  state.balanceFailed = false
  await cronAccount(worker, id)
  assert.equal(state.balanceCalls, balanceCalls + 2, 'failed balance query must remain due')
  assert.ok((await snapshot()).balance_updated_at > balanceAt)
  await refresh()
  assert.equal(state.balanceCalls, balanceCalls + 3, 'manual refresh always queries balance')
  console.log('✓ 巡检余额每 30 分钟更新，失败保持待重试，手动刷新立即查询')

  for (const ipv6 of ['2001:db8:1234:5678::1', '2001:db8:1234:5678::2', null]) {
    state.ipv6 = ipv6
    const callsBefore = state.networkCalls
    await refresh()
    assert.equal(state.networkCalls - callsBefore, ipv6 ? 0 : 1, 'only query ENIs when instance IPv6 is absent')
    assert.equal(JSON.parse((await snapshot()).instances_json)[0].public_ipv6, ipv6)
    assert.equal((await api('overview')).accounts.find(a => a.id === id).instances[0].public_ipv6, ipv6)
  }
  console.log('✓ 请求主网卡扩展字段，IPv6 首次分配、地址变化及移除均同步到概览')
  state.hideInstanceIpv6 = true
  for (const ipv6 of ['2001:db8:1234:5678::3', '2001:db8:1234:5678::4', null]) {
    state.ipv6 = ipv6
    await refresh()
    assert.equal(JSON.parse((await snapshot()).instances_json)[0].public_ipv6, ipv6)
    assert.equal((await api('overview')).accounts.find(a => a.id === id).instances[0].public_ipv6, ipv6)
  }
  const eni = (type, ip, instanceId = state.instanceId) => ({ Type: type, InstanceId: instanceId, Ipv6Sets: { Ipv6Set: [{ Ipv6Address: ip, Primary: true }] } })
  state.networkPages = { '': { NetworkInterfaceSets: { NetworkInterfaceSet: [
    eni('Primary', '2001:db8::bad', 'i-unrelated'),
    eni('Secondary', '2001:db8::5'), eni('Primary', '2001:db8::6'),
  ] } } }
  await refresh()
  assert.equal(JSON.parse((await snapshot()).instances_json)[0].public_ipv6, '2001:db8::6', 'prefer primary ENI and ignore unrelated instance')
  state.networkPages = {
    '': { NetworkInterfaceSets: { NetworkInterfaceSet: [] }, NextToken: 'page2' },
    page2: { NetworkInterfaceSets: { NetworkInterfaceSet: [eni('Secondary', '2001:db8::7')] } },
  }
  await refresh()
  assert.equal(JSON.parse((await snapshot()).instances_json)[0].public_ipv6, '2001:db8::7', 'find IPv6 on secondary ENI on next page')
  const statusNetworkCalls = state.networkCalls
  await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
    body: { Refresh: { account_id: id, requested_at: Date.now() } },
  }])
  assert.equal(state.networkCalls, statusNetworkCalls, 'status refresh must not query secondary ENIs again')
  assert.equal(JSON.parse((await snapshot()).instances_json)[0].public_ipv6, '2001:db8::7', 'status refresh preserves known secondary IPv6')
  state.networkPages = { '': {} }
  const malformedNetwork = await refresh()
  assert.match(malformedNetwork.result_msg, /IPv6 补充查询失败.*NetworkInterfaceSets.NetworkInterfaceSet/)
  state.networkPages = null
  state.networkFailed = true
  const deniedCalls = state.networkCalls
  const deniedNetwork = await refresh()
  assert.match(deniedNetwork.result_msg, /IPv6 补充查询失败.*ecs:DescribeNetworkInterfaces/)
  assert.equal(state.networkCalls - deniedCalls, 1)
  assert.equal(JSON.parse((await snapshot()).instances_json)[0].status, state.status)
  assert.ok(JSON.parse((await snapshot()).sync_errors_json).some(e => e.includes('ecs:DescribeNetworkInterfaces')))
  state.networkFailed = false
  state.stallNetwork = true
  const stalledNetwork = await refresh()
  assert.match(stalledNetwork.result_msg, /IPv6 查询失败，网络连接超时，稍后重试/)
  assert.equal(JSON.parse((await snapshot()).instances_json)[0].status, state.status)
  state.stallNetwork = false
  state.hideInstanceIpv6 = false
  await refresh()
  assert.deepEqual(JSON.parse((await snapshot()).sync_errors_json), [])
  console.log('✓ 实例未返回 IPv6 时按官方 ENI 结构补查，覆盖主副网卡、分页、移除和权限/超时告警，不影响实例状态')

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
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() })
  await eventually(async () => (await db.prepare('SELECT last_schedule_stop_at AS at FROM accounts WHERE id = ?').bind(id).first()).at, 'scheduled stop')
  assert.equal(state.status, 'Stopped')
  assert.equal((await api('overview')).accounts.find(a => a.id === id).instances[0].status, 'Stopping')
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
  await cronAccount(worker, id, true)
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
  await cronAccount(worker, id, true)
  assert.equal(state.starts, previousStarts + 1)
  assert.equal(JSON.parse((await snapshot()).instances_json)[0].status, 'Stopped', 'failed keep alive must not display Starting')
  assert.equal(await db.prepare('SELECT * FROM locks WHERE name = ?').bind(`keepalive:${id}:i-review`).first(), null)
  state.startFailed = false
  await cronAccount(worker, id)
  assert.equal(state.starts, previousStarts + 2)
  assert.equal(state.status, 'Running')
  assert.equal(JSON.parse((await snapshot()).instances_json)[0].status, 'Starting')
  console.log('✓ 保活开机失败释放冷却锁，下轮核实状态后重试')

  await api('settings/telegram', 'PUT', { enabled: true })
  state.trafficFailed = true
  state.notifyFailed = true
  const beforeNotice = state.notifications
  await cronAccount(worker, id, true)
  assert.equal(state.notifications, beforeNotice + 1)
  state.notifyFailed = false
  await cronAccount(worker, id, true)
  assert.equal(state.notifications, beforeNotice + 2)
  await cronAccount(worker, id, true)
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

  // 同一消息失败 → 重投成功 → 再次重复投递，不依赖下一轮 Cron。
  await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: false })
  const sameCycle = Date.now()
  const message = { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
    body: { Cron: { account_id: id, scheduled_at: sameCycle } } }
  state.trafficFailed = true
  let delivery = await worker.queue('cdt-monitor-tasks', [message])
  assert.equal(delivery.retryMessages.length, 1)
  assert.equal(await db.prepare('SELECT * FROM locks WHERE name = ?').bind(`cron-account:${id}:${sameCycle}`).first(), null)
  state.trafficFailed = false
  const beforeRetry = state.requests
  delivery = await worker.queue('cdt-monitor-tasks', [{ ...message, attempts: 2 }])
  assert.equal(delivery.retryMessages.length, 0)
  assert.ok(state.requests > beforeRetry)
  const completedRequests = state.requests
  await worker.queue('cdt-monitor-tasks', [{ ...message, attempts: 3 }])
  assert.equal(state.requests, completedRequests)
  console.log('✓ 同一 Cron 消息失败可重投，成功后才去重')

  const leaseCycle = sameCycle + 1
  const leaseKey = `cron-account:${id}:${leaseCycle}`
  const leaseMessage = { ...message, id: crypto.randomUUID(), body: { Cron: { account_id: id, scheduled_at: leaseCycle } } }
  await db.prepare('INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?)').bind(leaseKey, 'interrupted-consumer', Date.now() + 120_000).run()
  delivery = await worker.queue('cdt-monitor-tasks', [leaseMessage])
  assert.equal(delivery.retryMessages.length, 1, 'busy lease must retry instead of acknowledging')
  assert.equal(state.requests, completedRequests)
  await db.prepare('UPDATE locks SET expires_at = 1 WHERE name = ?').bind(leaseKey).run()
  delivery = await worker.queue('cdt-monitor-tasks', [{ ...leaseMessage, attempts: 2 }])
  assert.equal(delivery.retryMessages.length, 0)
  assert.equal((await db.prepare('SELECT owner FROM locks WHERE name = ?').bind(leaseKey).first()).owner, 'completed')
  console.log('✓ 执行租约未到期时重试，中断租约过期后可以接管')

  for (const start of [false, true]) {
    const hhmm = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 16)
    await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: start,
      schedule_mode: 'simple', ...(start ? { schedule_start_time: hhmm } : { schedule_stop_time: hhmm }) })
    const dateColumn = start ? 'last_schedule_start_date' : 'last_schedule_stop_date'
    await db.prepare(`UPDATE accounts SET ${dateColumn} = NULL WHERE id = ?`).bind(id).run()
    const scheduled = Date.now()
    const scheduleMessage = { ...message, id: crypto.randomUUID(), body: { Cron: { account_id: id, scheduled_at: scheduled } } }
    const beforeAction = start ? state.starts : state.stops
    for (const status of [start ? 'Stopping' : 'Starting', 'Unknown']) {
      state.status = status
      delivery = await worker.queue('cdt-monitor-tasks', [scheduleMessage])
      assert.equal(delivery.retryMessages.length, 1)
      assert.equal((await db.prepare(`SELECT ${dateColumn} AS date FROM accounts WHERE id = ?`).bind(id).first()).date, null)
      assert.equal(start ? state.starts : state.stops, beforeAction)
    }
    state.status = start ? 'Stopped' : 'Running'
    const failureFlag = start ? 'startFailed' : 'stopFailed'
    // 先验证指令失败不会写入过渡态；暂时关闭保活，以隔离定时失败路径。
    await db.prepare('UPDATE accounts SET spot_keep_alive = 0 WHERE id = ?').bind(id).run()
    state[failureFlag] = true
    delivery = await worker.queue('cdt-monitor-tasks', [scheduleMessage])
    assert.equal(delivery.retryMessages.length, 1)
    assert.equal(JSON.parse((await snapshot()).instances_json)[0].status, start ? 'Stopped' : 'Running')
    state[failureFlag] = false
    await db.prepare('UPDATE accounts SET spot_keep_alive = ?, last_schedule_stop_at = NULL WHERE id = ?').bind(start ? 1 : 0, id).run()
    if (start) {
      assert.equal(JSON.parse((await snapshot()).instances_json)[0].keep_alive, true)
      await db.prepare('DELETE FROM locks WHERE name = ?').bind(`keepalive:${id}:i-review`).run()
    }
    delivery = await worker.queue('cdt-monitor-tasks', [{ ...scheduleMessage, attempts: 2 }])
    assert.equal(delivery.retryMessages.length, 0)
    assert.equal(start ? state.starts : state.stops, beforeAction + 2, 'schedule and keep alive must issue only one successful command')
    assert.equal((await api('overview')).accounts.find(a => a.id === id).instances[0].status, start ? 'Starting' : 'Stopping')
    assert.ok((await db.prepare(`SELECT ${dateColumn} AS date FROM accounts WHERE id = ?`).bind(id).first()).date)
    await worker.queue('cdt-monitor-tasks', [{ ...scheduleMessage, attempts: 3 }])
    assert.equal(start ? state.starts : state.stops, beforeAction + 2, 'completed scheduled action cannot repeat')
    // 页面下一次概览轮询按后端快照补采，最终收敛到真实云端状态。
    await db.prepare("DELETE FROM locks WHERE name = 'overview-refresh'").run()
    await api('overview?refresh=transitional')
    await eventually(async () => JSON.parse((await snapshot()).instances_json)[0].status === (start ? 'Running' : 'Stopped'), 'transition reaches cloud state')
    await eventually(async () => !(await db.prepare('SELECT * FROM locks WHERE name = ?').bind(`account-operation:${id}`).first()), 'transition refresh releases account')
  }
  console.log('✓ 定时启停遇到过渡态或未知状态保留重试，终态恢复后同消息补偿执行')
  console.log('✓ 定时启停成功立即显示过渡态、失败不误报、轮询收敛终态，开机与保活同轮不重复下发')


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

  await eventually(async () => !(await db.prepare("SELECT name FROM locks WHERE name LIKE 'account-operation:%'").first()), 'cron releases account operations')
  // 阻塞实例查询，概览仍应立即返回；只补采启用账号的实例状态。
  await db.prepare("DELETE FROM locks WHERE name = 'overview-refresh'").run()
  await db.prepare("UPDATE account_snapshots SET instances_json = '[]'").run()
  let releaseTraffic
  let releaseInstance
  instanceGate = new Promise(resolve => { releaseInstance = resolve })
  const beforeStatus = await snapshot()
  const statusHistory = await history()
  const statusTrafficCalls = state.trafficCalls
  const statusBalanceCalls = state.balanceCalls
  const statusInstanceCalls = state.instanceCalls
  const statusStops = state.stops
  const beforeOverview = Date.now()
  try {
    const pendingOverview = await api('overview?refresh=transitional')
    assert.equal(pendingOverview.accounts.length, 12)
    assert.ok(Date.now() - beforeOverview < 3000, 'overview must not await cloud sampling')
    await api('overview?refresh=transitional') // 多标签页重复请求由全局防抖合并。
    await eventually(() => state.instanceCalls > statusInstanceCalls, 'queued refresh reaches instance API')
  } finally {
    releaseInstance()
    instanceGate = null
  }
  await eventually(async () => (await snapshot()).instances_updated_at >= beforeOverview, 'queued instance refresh finishes')
  await eventually(async () => !(await db.prepare('SELECT * FROM locks WHERE name = ?').bind(`account-operation:${id}`).first()), 'instance refresh releases account')
  assert.equal(state.instanceCalls, statusInstanceCalls + 1)
  assert.equal(state.trafficCalls, statusTrafficCalls)
  assert.equal(state.balanceCalls, statusBalanceCalls)
  assert.equal(state.stops, statusStops)
  assert.deepEqual(await history(), statusHistory)
  assert.equal((await snapshot()).traffic_updated_at, beforeStatus.traffic_updated_at)
  assert.equal((await snapshot()).balance_updated_at, beforeStatus.balance_updated_at)
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM account_snapshots WHERE account_id != ? AND instances_json != '[]'").bind(id).first()).count, 0)
  assert.equal((await api('overview')).accounts.find(account => account.id === id).instances[0].status, 'Running')
  console.log('✓ 页面补采只查询启用账号的实例，慢查询不阻塞概览，不重复查流量、余额或写历史')

  await db.prepare('CREATE TABLE history_updates (bucket TEXT)').run()
  for (const bucket of ['hourly', 'daily']) {
    await db.prepare(`CREATE TRIGGER track_${bucket}_update AFTER UPDATE ON traffic_${bucket} BEGIN INSERT INTO history_updates VALUES ('${bucket}'); END`).run()
  }
  await refresh()
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM history_updates').first()).count, 0)
  state.traffic = 2
  await refresh()
  assert.deepEqual((await db.prepare('SELECT bucket FROM history_updates ORDER BY bucket').all()).results, [{ bucket: 'daily' }, { bucket: 'hourly' }])
  for (const bucket of ['hourly', 'daily']) {
    await db.prepare(`DROP TRIGGER track_${bucket}_update`).run()
    await db.prepare(`UPDATE traffic_${bucket} SET recorded_at = recorded_at - 86400000 WHERE account_id = ?`).bind(id).run()
  }
  await db.prepare('DROP TABLE history_updates').run()
  await refresh()
  assert.equal((await history()).at(-1).traffic, 2, 'a new bucket must be inserted even if traffic is unchanged')
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM traffic_daily WHERE account_id = ?').bind(id).first()).count, 2)
  console.log('✓ 相同采样值不重复更新历史，新小时和新日期仍建立采样点')


  const beforeAtomic = await snapshot()
  await db.prepare("CREATE TRIGGER fail_daily BEFORE INSERT ON traffic_daily BEGIN SELECT RAISE(ABORT, 'fixture history write failure'); END").run()
  state.traffic = 42
  await refresh('failed')
  assert.equal((await snapshot()).cdt_overseas_bytes, beforeAtomic.cdt_overseas_bytes, 'history failure must roll back the snapshot')
  await db.prepare('DROP TRIGGER fail_daily').run()
  state.traffic = 1
  console.log('✓ 历史写入失败会回滚同批快照，避免部分写入')

  // 云控制台改变真实状态，缓存恰好与手动意图一致，仍必须执行所需动作。
  state.status = 'Running'
  await refresh()
  state.status = 'Stopped'
  const manualStarts = state.starts
  await runJob(`accounts/${id}/instances/i-review/start`)
  assert.equal(state.starts, manualStarts + 1)
  assert.equal(state.status, 'Running')
  state.status = 'Stopped'
  await refresh()
  state.status = 'Running'
  const manualStops = state.stops
  await runJob(`accounts/${id}/instances/i-review/stop`)
  assert.equal(state.stops, manualStops + 1)
  state.status = 'Running'
  const noOp = await runJob(`accounts/${id}/instances/i-review/start`)
  assert.match(noOp.result_msg, /已核实/)
  assert.equal(state.starts, manualStarts + 1)
  assert.equal(JSON.parse((await snapshot()).instances_json)[0].status, 'Running')
  state.instancesFailed = true
  await runJob(`accounts/${id}/instances/i-review/stop`, 'failed')
  assert.equal(state.stops, manualStops + 1)
  state.instancesFailed = false
  state.status = 'Starting'
  await runJob(`accounts/${id}/instances/i-review/start`, 'failed')
  assert.equal(state.starts, manualStarts + 1)
  state.status = 'Running'
  console.log('✓ 手动启停核实云端状态；已达目标刷新快照，查询失败或过渡态不发指令')

  const replacement = await api('accounts', 'POST', { ...config, name: 'Identity test' })
  const replacementId = replacement.id
  const replacementSnapshot = () => db.prepare('SELECT * FROM account_snapshots WHERE account_id = ?').bind(replacementId).first()
  const replacementRow = () => db.prepare('SELECT * FROM accounts WHERE id = ?').bind(replacementId).first()
  state.traffic = 190
  await runJob(`accounts/${replacementId}/refresh`)
  const breaker = (await replacementSnapshot()).threshold_triggered_month
  assert.ok(breaker)
  // 同主账号轮换 AccessKey、升级前尚无身份记录，都必须保留熔断。
  await db.prepare('UPDATE accounts SET cloud_account_id = NULL WHERE id = ?').bind(replacementId).run()
  await api(`accounts/${replacementId}`, 'PUT', { ...config, access_key_id: 'rotated-key', access_key_secret: 'rotated-secret' })
  assert.equal((await replacementSnapshot()).threshold_triggered_month, breaker)
  assert.equal((await replacementRow()).cloud_account_id, '1001')
  await db.prepare("UPDATE accounts SET cloud_account_id = NULL, access_key_id = 'invalid-key' WHERE id = ?").bind(replacementId).run()
  const beforeOfflineEdit = state.requests
  await api(`accounts/${replacementId}`, 'PUT', { ...config, access_key_id: '', access_key_secret: undefined, enabled: false })
  assert.equal(state.requests, beforeOfflineEdit, 'editing legacy configuration must not require working cloud credentials')
  assert.equal((await replacementSnapshot()).threshold_triggered_month, breaker)
  await db.prepare("UPDATE accounts SET cloud_account_id = '1001', access_key_id = 'rotated-key' WHERE id = ?").bind(replacementId).run()
  const preservedVersion = (await replacementRow()).config_version
  response = await request(`accounts/${replacementId}`, 'PUT', { ...config, access_key_id: 'invalid-key' })
  assert.equal(response.status, 502)
  assert.equal((await replacementRow()).config_version, preservedVersion)
  assert.equal((await replacementSnapshot()).threshold_triggered_month, breaker)
  console.log('✓ 同账号密钥轮换与存量身份补齐保留熔断，验证失败不改变配置')

  // 在清理关联状态时注入数据库错误，整个配置更新必须回滚。
  await db.prepare("CREATE TRIGGER fail_identity_reset BEFORE DELETE ON account_snapshots BEGIN SELECT RAISE(ABORT, 'fixture reset failure'); END").run()
  response = await request(`accounts/${replacementId}`, 'PUT', { ...config, access_key_id: 'replacement-key', instance_id: 'i-new-account' })
  assert.equal(response.status, 500)
  assert.equal((await replacementRow()).config_version, preservedVersion)
  assert.equal((await replacementRow()).access_key_id, 'rotated-key')
  assert.equal((await replacementSnapshot()).threshold_triggered_month, breaker)
  await db.prepare('DROP TRIGGER fail_identity_reset').run()
  await api(`accounts/${replacementId}`, 'PUT', { ...config, access_key_id: 'replacement-key', instance_id: 'i-new-account' })
  assert.equal(await replacementSnapshot(), null)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM traffic_hourly WHERE account_id = ?').bind(replacementId).first()).n, 0)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM traffic_daily WHERE account_id = ?').bind(replacementId).first()).n, 0)
  const replacementView = (await api('overview')).accounts.find(a => a.id === replacementId)
  assert.ok(replacementView.instances.every(i => i.instance_id === 'i-new-account'))
  state.instanceId = 'i-new-account'
  state.status = 'Running'
  state.traffic = 1
  const afterReplacementStops = state.stops
  await runJob(`accounts/${replacementId}/refresh`)
  assert.equal(state.stops, afterReplacementStops)
  assert.equal((await replacementSnapshot()).threshold_triggered_month, null)
  console.log('✓ 更换云账号原子清理旧快照和历史；新账号低用量不会继承熔断误停机')

  const oldVersion = (await replacementRow()).config_version
  await api(`accounts/${replacementId}`, 'PUT', { ...config, access_key_id: 'replacement-key', instance_id: 'i-new-account', name: 'Updated' })
  const obsoleteTask = JSON.stringify({ StopInstance: { account_id: replacementId, instance_id: 'i-new-account', config_version: oldVersion } })
  await db.prepare("INSERT INTO jobs (id, account_id, job_type, status, created_at, payload_json) VALUES ('obsolete-action', ?, 'stop_instance', 'pending', ?, ?)").bind(replacementId, Date.now(), obsoleteTask).run()
  await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { Job: { id: 'obsolete-action' } } }])
  assert.equal((await api('jobs/obsolete-action')).status, 'failed')
  assert.match((await api('jobs/obsolete-action')).error_msg, /配置已变更/)
  assert.equal(state.stops, afterReplacementStops)
  console.log('✓ 旧配置排队的启停任务被拒绝，不操作新配置的资源')

  // 采集正在访问旧资源时不允许修改或删除配置，也不允许手动动作交错执行。
  const beforeConcurrentTraffic = state.trafficCalls
  trafficGate = new Promise(resolve => { releaseTraffic = resolve })
  let activeRefresh
  try {
    activeRefresh = await api(`accounts/${replacementId}/refresh`, 'POST')
    await eventually(() => state.trafficCalls > beforeConcurrentTraffic, 'refresh reaches cloud')
    response = await request(`accounts/${replacementId}`, 'PUT', { ...config, access_key_id: 'replacement-key', instance_id: 'i-new-account' })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'account_busy')
    response = await request(`accounts/${replacementId}`, 'DELETE')
    assert.equal(response.status, 409)
    const concurrentStop = await api(`accounts/${replacementId}/instances/i-new-account/stop`, 'POST')
    // 显式投递第二个消费调用，避免本地自动消费者串行排队掩盖并发场景。
    await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { Job: { id: concurrentStop.job_id } } }])
    assert.equal((await api(`jobs/${concurrentStop.job_id}`)).status, 'failed')
    assert.equal(state.stops, afterReplacementStops)
  } finally {
    releaseTraffic()
    trafficGate = null
  }
  await eventually(async () => (await api(`jobs/${activeRefresh.job_id}`)).status === 'success', 'blocked refresh finishes')
  await api(`accounts/${replacementId}`, 'DELETE')
  state.instanceId = 'i-review'
  state.status = 'Running'
  console.log('✓ 刷新、账号编辑/删除、手动控制共用互斥，旧采集不能越过配置变更写回')

  await db.prepare('UPDATE sessions SET last_seen_at = 1').run()
  await api('jobs/obsolete-action')
  const touched = (await db.prepare('SELECT last_seen_at FROM sessions').first()).last_seen_at
  await db.prepare("INSERT INTO jobs (id, job_type, status, created_at, started_at) VALUES ('unrelated-stale', 'refresh_all', 'running', 1, 1)").run()
  for (let i = 0; i < 5; i++) await api('jobs/obsolete-action')
  assert.equal((await db.prepare('SELECT last_seen_at FROM sessions').first()).last_seen_at, touched)
  assert.equal((await db.prepare("SELECT status FROM jobs WHERE id = 'unrelated-stale'").first()).status, 'running')
  assert.equal((await api('jobs/unrelated-stale')).status, 'failed')
  console.log('✓ 高频轮询每分钟最多更新一次会话，只回收所查询任务')

  // 刚替换的存量账号仅补采了实例，也应有完整的首次流量采集窗口。
  await db.prepare('DELETE FROM account_snapshots WHERE account_id = ?').bind(id).run()
  await db.prepare('UPDATE accounts SET created_at = ?, updated_at = ? WHERE id = ?').bind(Date.now() - 60 * 60_000, Date.now(), id).run()
  await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
    body: { Refresh: { account_id: id, requested_at: Date.now() } },
  }])
  assert.equal((await snapshot()).traffic_updated_at, null)
  assert.ok((await snapshot()).instances_updated_at)
  trafficGate = new Promise(resolve => { releaseTraffic = resolve })
  try {
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() })
    assert.equal((await api('logs?action=collection_stalled')).length, 0)
  } finally {
    releaseTraffic()
    trafficGate = null
  }
  await eventually(async () => (await snapshot())?.traffic_updated_at, 'replacement initial collection completes')
  await eventually(async () => !(await db.prepare('SELECT * FROM locks WHERE name = ?').bind(`account-operation:${id}`).first()), 'initial collection releases operation')
  // 模拟积压：本轮队列仍在等待云接口，派发端独立发现旧采样并告警。
  await api('settings/telegram', 'PUT', { enabled: true })
  await db.prepare('UPDATE account_snapshots SET traffic_updated_at = ?, instances_updated_at = ? WHERE account_id = ?').bind(Date.now() - 20 * 60_000, Date.now() - 20 * 60_000, id).run()
  const beforeHealth = state.notifications
  trafficGate = new Promise(resolve => { releaseTraffic = resolve })
  try {
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() })
    assert.equal(state.notifications, beforeHealth + 1)
    assert.equal((await api('logs?action=collection_stalled')).length, 1)
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() + 1 })
    assert.equal(state.notifications, beforeHealth + 1, 'stalled health alert must be deduplicated')
  } finally {
    releaseTraffic()
    trafficGate = null
  }
  await eventually(async () => (await snapshot()).traffic_updated_at > Date.now() - 60_000, 'health test refresh completes')
  await eventually(async () => !(await db.prepare('SELECT * FROM locks WHERE name = ?').bind(`account-operation:${id}`).first()), 'account operation finishes')
  await api('settings/telegram', 'PUT', { enabled: false })
  console.log('✓ 采集停滞告警在派发端执行，队列未完成仍可告警，并在送达后去重')

  async function maintenance(retry = false) {
    const result = await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: 'Maintenance' }])
    assert.equal(result.outcome, 'ok', JSON.stringify(result))
    assert.equal(result.retryMessages.length, retry ? 1 : 0, JSON.stringify(result))
  }
  await db.prepare("DELETE FROM locks WHERE name = 'housekeeping'").run()
  await db.prepare("INSERT INTO action_logs (action_type, detail, created_at) VALUES ('fixture_expired', 'expired', 1)").run()
  await db.prepare("CREATE TRIGGER fail_cleanup BEFORE DELETE ON action_logs WHEN OLD.action_type = 'fixture_expired' BEGIN SELECT RAISE(ABORT, 'fixture cleanup failure'); END").run()
  await maintenance(true)
  assert.equal(await db.prepare("SELECT * FROM locks WHERE name = 'housekeeping'").first(), null, 'failed cleanup must release its lease')
  assert.ok(await db.prepare("SELECT id FROM action_logs WHERE action_type = 'fixture_expired'").first())
  await db.prepare('DROP TRIGGER fail_cleanup').run()
  await maintenance()
  assert.equal(await db.prepare("SELECT id FROM action_logs WHERE action_type = 'fixture_expired'").first(), null)
  const cleanupLock = await db.prepare("SELECT * FROM locks WHERE name = 'housekeeping'").first()
  assert.equal(cleanupLock.owner, 'completed')
  assert.ok(cleanupLock.expires_at > Date.now() + 23 * 3600_000)
  await db.prepare("INSERT INTO action_logs (action_type, detail, created_at) VALUES ('fixture_cooldown', 'expired', 1)").run()
  await maintenance()
  assert.ok(await db.prepare("SELECT id FROM action_logs WHERE action_type = 'fixture_cooldown'").first(), 'successful cleanup must enter cooldown')
  console.log('✓ 清理失败释放租约并重试，成功后才进入一天冷却期')

  const reportTime = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 16)
  await api('settings/daily-report', 'PUT', { enabled: true, time: reportTime, timezone: 'UTC+8' })
  await api('settings/telegram', 'PUT', { enabled: true })
  const reportNotifications = state.notifications
  const reportBalance = (await snapshot()).balance_amount
  await db.prepare("UPDATE account_snapshots SET balance_amount = 'fixture invalid balance' WHERE account_id = ?").bind(id).run()
  await maintenance(true)
  assert.equal(state.notifications, reportNotifications)
  assert.equal(await db.prepare("SELECT * FROM locks WHERE name LIKE 'daily-report:%'").first(), null, 'report generation failure must release its lease')
  await db.prepare('UPDATE account_snapshots SET balance_amount = ? WHERE account_id = ?').bind(reportBalance, id).run()
  state.notifyFailed = true
  await maintenance(true)
  assert.equal(state.notifications, reportNotifications + 1)
  assert.equal(await db.prepare("SELECT * FROM locks WHERE name LIKE 'daily-report:%'").first(), null, 'notification failure must release its lease')
  const reportConfig = async () => JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'daily_report'").first()).value)
  assert.equal((await reportConfig()).last_sent_date, null)
  state.notifyFailed = false
  await maintenance()
  assert.equal(state.notifications, reportNotifications + 2)
  assert.ok((await reportConfig()).last_sent_date)
  await maintenance()
  assert.equal(state.notifications, reportNotifications + 2, 'delivered daily report must not repeat')
  await api('settings/daily-report', 'PUT', { enabled: false, time: reportTime, timezone: 'UTC+8' })
  await api('settings/telegram', 'PUT', { enabled: false })
  console.log('✓ 日报生成或推送失败均释放租约，恢复后重试发送，送达后去重')

  state.stallTraffic = true
  let began = Date.now()
  const stalled = await refresh('failed')
  assert.equal(stalled.error_msg, '流量查询失败，网络连接超时，稍后重试')
  assert.ok(Date.now() - began < 25_000, 'stalled headers must respect request budget')
  state.stallTraffic = false
  state.stallBody = true
  began = Date.now()
  const stalledBody = await refresh('failed')
  assert.equal(stalledBody.error_msg, '流量查询失败，网络连接超时，稍后重试')
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
