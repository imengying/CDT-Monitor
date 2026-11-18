import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Miniflare } from 'miniflare'

// 全部凭据均为测试夹具；所有出站请求在此拦截，绝不访问云账号。
const state = { instanceId: 'i-review', stoppedIds: [], trafficCalls: 0, traffic: 190, trafficFailed: false, balanceFailed: false, instancesFailed: false, stopFailed: true, startFailed: false, notifyFailed: true, notifications: 0, stallTraffic: false, stallBody: false, status: 'Running', stops: 0, starts: 0, requests: 0 }
state.trafficResponses = []
state.trafficAttempts = null
state.spot = true
state.ipv6 = null
state.hideInstanceIpv6 = false
state.networkCalls = 0
state.networkFailed = false
state.stallNetwork = false
state.networkPages = null
state.balanceCalls = 0
state.instanceCalls = 0
state.publicIp = null
state.dnsRecords = []
state.dnsCalls = 0
state.dnsDeletes = 0
state.dnsDeleteFailed = false
state.dnsWriteUnknown = false
state.dnsToken = 'fixture-dns-token'
state.dnsDeniedZone = null
state.controlEvents = []
let trafficGate = null
let instanceGate = null
let notificationGate = null
const testDirectory = await mkdtemp(resolve(tmpdir(), 'cdt-worker-test-'))
const monitor = { name: 'monitor',
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
    if (url.hostname === 'api.cloudflare.com') {
      state.dnsCalls++
      assert.equal(request.headers.get('authorization'), `Bearer ${state.dnsToken}`)
      assert.match(url.pathname, /^\/client\/v4\/zones\/(?:a{32}|b{32})\/dns_records/)
      const zoneId = url.pathname.split('/')[4]
      const recordId = url.pathname.split('/')[6]
      const ok = result => Response.json({ success: true, result })
      if (zoneId === state.dnsDeniedZone) return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 })
      if (request.method === 'GET') {
        assert.equal(url.searchParams.get('type'), 'A')
        assert.ok(['dns-test.example.com', 'dns-next.example.com', 'dns-new.example.net'].includes(url.searchParams.get('name')))
        assert.ok(url.searchParams.get('content'), 'never scan a zone or all records for the hostname')
        return ok(state.dnsRecords.filter(record => record.zoneId === zoneId && record.name === url.searchParams.get('name') && record.content === url.searchParams.get('content')))
      }
      if (request.method === 'DELETE') {
        state.dnsDeletes++
        state.controlEvents.push('dns-delete')
        if (state.dnsDeleteDelay) await new Promise(resolve => setTimeout(resolve, state.dnsDeleteDelay))
        if (state.dnsDeleteFailed) return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 })
        const found = state.dnsRecords.findIndex(record => record.zoneId === zoneId && record.id === recordId)
        if (found < 0) return Response.json({ success: false }, { status: 404 })
        state.dnsRecords.splice(found, 1)
        return ok({ id: recordId })
      }
      const body = await request.json()
      assert.equal(body.type, 'A')
      assert.equal(body.ttl, 300)
      assert.equal(body.proxied, false)
      assert.ok(['dns-test.example.com', 'dns-next.example.com', 'dns-new.example.net'].includes(body.name))
      let record
      if (request.method === 'PATCH') {
        record = state.dnsRecords.find(record => record.zoneId === zoneId && record.id === recordId)
        if (!record) return Response.json({ success: false }, { status: 404 })
        Object.assign(record, body)
      } else {
        assert.equal(request.method, 'POST')
        record = { id: `record-${state.dnsCalls}`, zoneId, ...body }
        state.dnsRecords.push(record)
      }
      if (state.dnsWriteUnknown) {
        state.dnsWriteUnknown = false
        return Response.json({ success: false, errors: [{ code: 10001 }] }, { status: 500 })
      }
      return ok(record)
    }
    const action = url.searchParams.get('Action')
    if (['DescribeInstances', 'DescribeNetworkInterfaces', 'StartInstance', 'StopInstance'].includes(action)) {
      assert.equal(url.searchParams.get('RegionId'), 'cn-hongkong')
      assert.equal(url.hostname, 'ecs.cn-hongkong.aliyuncs.com', `${action} must use the Hong Kong ECS endpoint for the international account`)
    }
    const fail = () => Response.json({ Code: 'Forbidden', Message: 'fixture failure' }, { status: 403 })
    if (url.origin === 'https://api.telegram.org') {
      state.notifications++
      const notifyBody = await request.text()
      if (notifyBody.includes('DNS')) state.controlEvents.push('dns-alert')
      if (notificationGate) await notificationGate
      if (state.notifyDelay) await new Promise(resolve => setTimeout(resolve, state.notifyDelay))
      state.lastTelegram = { path: url.pathname, body: notifyBody }
      return state.notifyFailed ? fail() : Response.json({ ok: true })
    }
    if (url.hostname === 'bark-preview.test') {
      state.lastBark = { url: request.url, body: await request.json() }
      return state.barkFailed ? fail() : Response.json({ code: 200, message: 'success' })
    }
    switch (action) {
      case 'GetCallerIdentity': return url.searchParams.get('AccessKeyId') === 'invalid-key' ? fail() : Response.json({ AccountId: url.searchParams.get('AccessKeyId') === 'replacement-key' ? '2002' : '1001' })
      case 'ListCdtInternetTraffic':
        assert.equal(url.hostname, 'cdt.aliyuncs.com', 'international CDT traffic must use the global endpoint, independent of ECS region')
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
        if (state.slowDescribeAttempts > 0) {
          state.slowDescribeAttempts--
          await new Promise(resolve => setTimeout(resolve, 3800))
          if (state.slowDescribeAttempts > 0) return Response.json({ Code: 'ServiceUnavailable' }, { status: 503 })
        }
        if (instanceGate) await instanceGate
        if (state.instancesFailed) return fail()
        // 官方接口仅在请求扩展属性时返回主网卡 IPv6，避免只测解析器而漏测请求。
        const ipv6Sets = !state.hideInstanceIpv6 && url.searchParams.get('AdditionalAttributes.1') === 'NETWORK_PRIMARY_ENI_IP' && state.ipv6
          ? [{ Ipv6Address: state.ipv6, Primary: true }] : []
        return Response.json({ Instances: { Instance: [{ InstanceId: state.instanceId, RegionId: 'cn-hongkong', Status: state.status, PublicIpAddress: { IpAddress: state.publicIp ? [state.publicIp] : [] }, SpotStrategy: state.spot ? 'SpotAsPriceGo' : 'NoSpot',
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
        state.controlEvents.push('stop')
        state.stops++
        state.stoppedIds.push(url.searchParams.get('InstanceId'))
        if (state.slowStopAttempts > 0) {
          state.slowStopAttempts--
          await new Promise(resolve => setTimeout(resolve, 3800))
          if (state.slowStopAttempts > 0) return Response.json({ Code: 'ServiceUnavailable' }, { status: 503 })
        }
        if (state.stopFailed) return fail()
        state.status = 'Stopped'
        return Response.json({ RequestId: 'fixture' })
      case 'StartInstance': state.starts++; if (state.startFailed) return fail(); state.status = 'Running'; return Response.json({ RequestId: 'fixture' })
      default: throw new Error(`Unexpected outbound request: ${url.origin}${url.pathname}`)
    }
  },
}
const mf = new Miniflare({ d1Persist: testDirectory, workers: [monitor] })
let cookie = ''
async function request(path, method = 'GET', body, ip = '192.0.2.1', sessionCookie = cookie) {
  return mf.dispatchFetch(`https://monitor.test/api/v1/${path}`, {
    method, headers: { 'content-type': 'application/json', cookie: sessionCookie, 'cf-connecting-ip': ip },
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
  const deadline = Date.now() + 65_000
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
  {
    const credentials = { username: 'review', password: 'test-password-only' }
    const login = async (previous = '') => {
      const res = await request('auth/login', 'POST', credentials, undefined, previous)
      assert.equal(res.status, 200)
      return res.headers.get('set-cookie').split(';')[0]
    }
    const devices = async (sessionCookie) => {
      const res = await request('sessions', 'GET', undefined, undefined, sessionCookie)
      assert.equal(res.status, 200)
      return (await res.json()).sessions
    }
    const active = async (sessionCookie) => (await (await request('auth/session', 'GET', undefined, undefined, sessionCookie)).json()).authenticated
    const second = await login()
    const third = await login()
    const listed = await devices(cookie)
    assert.equal(listed.length, 3, 'independent browsers can share the same UA and IP')
    const current = listed.find(item => item.current)
    assert.ok(current)
    assert.equal((await request('sessions/' + current.sid, 'DELETE')).status, 400)
    const thirdSid = (await devices(third)).find(item => item.current).sid
    await api('sessions/' + thirdSid, 'DELETE')
    assert.equal(await active(third), false)
    assert.equal(await active(second), true)

    await db.prepare("CREATE TRIGGER fixture_session_insert BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'fixture session insert failure'); END").run()
    assert.equal((await request('auth/login', 'POST', credentials, undefined, second)).status, 500)
    assert.equal(await active(second), true, 'failed rotation preserves the original session')
    await db.prepare('DROP TRIGGER fixture_session_insert').run()
    const rotated = await login(second)
    assert.equal(await active(second), false)
    assert.equal((await devices(rotated)).length, 2)
    const fourth = await login()
    const fourthSid = (await devices(fourth)).find(item => item.current).sid
    assert.match(fourthSid, /^[0-9a-f]{32}$/)
    await db.prepare(`CREATE TRIGGER fixture_session_delete BEFORE DELETE ON sessions WHEN OLD.sid = '${fourthSid}'
      BEGIN SELECT RAISE(ABORT, 'fixture session deletion failure'); END`).run()
    assert.equal((await request('sessions', 'DELETE')).status, 500)
    assert.equal(await active(rotated), true, 'a failed bulk revocation does not partially sign out devices')
    assert.equal((await request('auth/logout', 'POST', undefined, undefined, fourth)).status, 500)
    assert.equal(await active(fourth), true)
    await db.prepare('DROP TRIGGER fixture_session_delete').run()
    assert.deepEqual((await api('sessions', 'DELETE')).sessions.map(item => item.sid), [current.sid])
    assert.equal(await active(rotated), false)
    assert.equal(await active(fourth), false)
  }
  console.log('✓ 同网络同浏览器的独立会话可分别管理，重新登录和批量下线支持原子回滚')
  const storedReport = async () => JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'daily_report'").first()).value)
  await api('settings/daily-report', 'PUT', { enabled: false, time: '09:00' })
  assert.equal((await storedReport()).timezone, '', 'omitting report timezone keeps global inheritance')
  let settings = await api('settings/timezone', 'PUT', { timezone: 'UTC+9' })
  assert.equal(settings.daily_report.timezone, 'UTC+9')
  await api('settings/daily-report', 'PUT', { enabled: false, time: '09:00', timezone: 'UTC+9' })
  settings = await api('settings/timezone', 'PUT', { timezone: 'UTC+8' })
  assert.equal(settings.daily_report.timezone, 'UTC+8', 'legacy copied timezone follows the global setting')
  assert.equal((await storedReport()).timezone, '')
  await api('settings/daily-report', 'PUT', { enabled: false, time: '09:00', timezone: 'UTC+9' })
  settings = await api('settings/timezone', 'PUT', { timezone: 'UTC+7' })
  assert.equal(settings.daily_report.timezone, 'UTC+9', 'explicit different report timezone is preserved')
  response = await request('settings/daily-report', 'PUT', { enabled: true, time: '09:00', timezone: 'bad/timezone' })
  assert.equal(response.status, 400)
  assert.equal((await storedReport()).timezone, 'UTC+9', 'invalid report settings leave saved configuration intact')
  await api('settings/timezone', 'PUT', { timezone: 'UTC+8' })
  await api('settings/daily-report', 'PUT', { enabled: false, time: '09:00' })
  console.log('✓ 日报默认继承系统时区，兼容旧配置，保留独立时区并拒绝非法时区')
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
  assert.match(emptyJob.error_msg, /连续 3 次未取得有效流量明细/)
  assert.equal(state.trafficCalls - emptyCalls, 3)
  const afterEmpty = await snapshot()
  for (const field of ['billing_month', 'cdt_domestic_bytes', 'cdt_overseas_bytes', 'traffic_updated_at', 'threshold_triggered_month', 'threshold_limit_gb']) {
    assert.equal(afterEmpty[field], beforeEmpty[field], `empty traffic must preserve ${field}`)
  }
  assert.deepEqual(await history(), beforeEmptyHistory, 'empty traffic must not overwrite history with zero')
  console.log('✓ 连续空流量响应重试耗尽后失败，保留用量、账期、成功时间、历史与熔断')
  const malformedCalls = state.trafficCalls
  state.trafficResponses = [[{ Traffic: null }], [{ Traffic: 100 }, {}], [{ Traffic: -1 }]]
    .map(rows => ({ status: 200, body: JSON.stringify({ TrafficDetails: rows }) }))
  assert.match((await refresh('failed')).error_msg, /有效流量明细/)
  assert.equal(state.trafficCalls - malformedCalls, 3)
  const afterMalformed = await snapshot()
  for (const field of ['billing_month', 'cdt_domestic_bytes', 'cdt_overseas_bytes', 'traffic_updated_at', 'threshold_triggered_month', 'threshold_limit_gb']) {
    assert.equal(afterMalformed[field], beforeEmpty[field])
  }
  assert.deepEqual(await history(), beforeEmptyHistory)
  console.log('✓ 流量缺字段、含部分无效条目或负数均不能覆盖已有样本或解除熔断')
  state.traffic = 0
  state.trafficResponses = [{ status: 200, body: '{"TrafficDetails":[]}' }]
  const recoveredCalls = state.trafficCalls
  await refresh()
  assert.equal(state.trafficCalls - recoveredCalls, 2)
  assert.equal((await snapshot()).cdt_overseas_bytes, 0, 'explicit zero traffic remains valid')
  assert.doesNotMatch((await snapshot()).sync_errors_json, /单位|有效流量明细/)
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

  state.trafficAttempts = []
  state.trafficResponses = [{ status: 530, body: 'error code: 1016' }]
  const dnsErrorJob = await refresh('failed')
  assert.equal(state.trafficAttempts.length, 1, '1016 must not be retried immediately')
  for (const value of ['1016', 'cdt.aliyuncs.com', 'ListCdtInternetTraffic', 'cn-hongkong', '尝试 1 次']) assert.ok(dnsErrorJob.error_msg.includes(value))
  assert.match(dnsErrorJob.error_msg, /耗时 \d+ms/)
  state.trafficResponses = [{ status: 403, body: JSON.stringify({ Code: 'Forbidden', Message: 'https://cdt.aliyuncs.com/?AccessKeyId=fixture-access-key&Signature=fixture-secret', RequestId: 'fixture-request-context' }) }]
  const safeErrorJob = await refresh('failed')
  assert.ok(safeErrorJob.error_msg.includes('fixture-request-context'))
  for (const value of ['fixture-access-key', 'fixture-secret', 'Signature=', 'https://']) assert.equal(safeErrorJob.error_msg.includes(value), false)
  state.trafficResponses = [{ status: 429, body: 'limit' }, { status: 200, body: '{"TrafficDetails":[]}' }, { status: 503, body: 'unavailable' }]
  state.trafficAttempts = []
  await refresh('failed')
  assert.equal(state.trafficAttempts.length, 3, 'empty responses and transient errors share one total retry budget')
  const instancesBeforeFailure = state.instanceCalls
  state.trafficAttempts = []
  state.trafficResponses = Array.from({ length: 3 }, () => ({ status: 503, body: 'unavailable' }))
  await cronAccount(worker, id)
  assert.equal(state.trafficAttempts.length, 3)
  assert.equal(state.instanceCalls, instancesBeforeFailure + 1, 'exhausted cloud retries must not replay successful ECS collection')
  state.trafficFailed = true
  state.trafficAttempts = []
  await cronAccount(worker, id)
  assert.equal(state.trafficAttempts.length, 1, 'permission errors wait for the next Cron without queue replay')
  state.trafficFailed = false
  state.trafficAttempts = null
  console.log('✓ 解析错误与权限失败不快速重试，云端失败不重投整轮采集，错误上下文保留定位信息且隐藏凭据')


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
  const unsentReport = await runJob('reports/daily', 'failed')
  assert.match(unsentReport.error_msg, /未配置任何通知渠道，日报未发送/)
  await api('settings/telegram', 'PUT', { enabled: true })
  state.notifyFailed = true
  const failedReport = await runJob('reports/daily', 'failed')
  assert.match(failedReport.error_msg, /telegram.*❌/i)
  state.notifyFailed = false
  const staleReport = await runJob('reports/daily')
  assert.match(staleReport.result_msg, /telegram.*✅/i)
  // 原账号快照停留在旧账期。插入本例的计量快照，无需发出云请求。
  const samples = [
    ['1001', 'cn-hongkong', 25, 100],
    ['1001', 'ap-southeast-1', 12, 200],
    ['1001', 'cn-hangzhou', 3, 100],
    ['2002', 'cn-hongkong', 7, 100],
    ['1001', 'cn-hongkong', 90, null],
  ]
  const meterIds = []
  for (const [owner, region, gb, at] of samples) {
    const row = await db.prepare("INSERT INTO accounts (name, cloud_account_id, access_key_id, encrypted_access_key_secret, region_id, instance_id, created_at, updated_at) VALUES ('Meter fixture', ?, ?, 'fixture', ?, 'i-meter', 1, 1) RETURNING id")
      .bind(owner, 'meter-key-' + owner, region).first()
    meterIds.push(row.id)
    await db.prepare('INSERT INTO account_snapshots (account_id, billing_month, cdt_domestic_bytes, cdt_overseas_bytes, traffic_updated_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(row.id, overview.billing_month, gb * 1024 ** 3, gb * 1024 ** 3, at, 1000 - (at ?? 0)).run()
  }
  const metered = await api('overview')
  assert.equal(metered.total_traffic_gb, 22)
  assert.deepEqual(metered.accounts.filter(a => meterIds.includes(a.id)).map(a => a.traffic_used_gb), [25, 12, 3, 7, 90])
  assert.match((await runJob('reports/daily')).result_msg, /本月合计流量 22\.00 GB/)
  await db.batch(meterIds.map(key => db.prepare('DELETE FROM accounts WHERE id = ?').bind(key)))
  console.log('✓ 概览和日报按主账号、当月和额度池取最新成功用量，保留各实例卡片')
  await api('settings/telegram', 'PUT', { enabled: false })
  console.log('✓ 手动日报无通知渠道或发送失败时任务失败，成功送达后才提示成功')
  const beforePreviewSettings = (await db.prepare('SELECT * FROM settings ORDER BY key').all()).results
  const beforePreviewJobs = (await db.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n
  const telegramDraft = { enabled: false, token: '123456:preview-only-token', chat_id: 'preview-only-chat' }
  await api('settings/notify-test', 'POST', { channel: 'telegram', preview: telegramDraft })
  assert.match(state.lastTelegram.path, /preview-only-token/)
  assert.equal(new URLSearchParams(state.lastTelegram.body).get('chat_id'), 'preview-only-chat')
  await api('settings/notify-test', 'POST', { channel: 'telegram', preview: { enabled: false, token: '', chat_id: '' } })
  assert.match(state.lastTelegram.path, /fixture-token-for-tests/)
  assert.equal(new URLSearchParams(state.lastTelegram.body).get('chat_id'), 'fixture-chat')
  const barkDraft = { enabled: false, server_url: 'https://bark-preview.test/custom', device_key: 'preview-only-key', normal_level: 'timeSensitive', alert_level: 'critical' }
  await api('settings/notify-test', 'POST', { channel: 'bark', preview: barkDraft })
  assert.equal(state.lastBark.url, 'https://bark-preview.test/custom/push')
  assert.equal(state.lastBark.body.device_key, 'preview-only-key')
  assert.equal(state.lastBark.body.level, 'timeSensitive')
  state.notifyFailed = true
  response = await request('settings/notify-test', 'POST', { channel: 'telegram', preview: telegramDraft })
  assert.equal(response.status, 502, 'preview reports delivery failures directly')
  state.notifyFailed = false
  response = await request('settings/notify-test', 'POST', { channel: 'telegram', preview: { ...telegramDraft, token: 'bad' } })
  assert.equal(response.status, 400)
  assert.deepEqual((await db.prepare('SELECT * FROM settings ORDER BY key').all()).results, beforePreviewSettings)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n, beforePreviewJobs, 'preview must not persist draft credentials in jobs')
  assert.equal((await api('logs?q=preview-only')).length, 0, 'preview credentials must not appear in logs')
  await api('settings/bark', 'PUT', { ...barkDraft, enabled: false, device_key: 'stored-bark-key' })
  await api('settings/notify-test', 'POST', { channel: 'bark', preview: { ...barkDraft, device_key: '' } })
  assert.equal(state.lastBark.body.device_key, 'stored-bark-key')
  await api('settings/bark', 'PUT', { ...barkDraft, enabled: true, device_key: '' })
  await api('settings/telegram', 'PUT', { enabled: true })
  state.barkFailed = true
  const partiallySent = await runJob('reports/daily')
  assert.match(partiallySent.result_msg, /telegram ✅.*bark ❌/)
  state.barkFailed = false
  await api('settings/bark', 'PUT', { ...barkDraft, enabled: false, device_key: '' })
  await api('settings/telegram', 'PUT', { enabled: false })
  console.log('✓ 通知测试使用未保存表单、空密钥复用已存配置，草稿不落库，日报部分送达保留失败详情')
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
  for (const [field, query] of [['account_id', 'fixture'], ['instance_id', 'i-search-only'], ['action_type', 'search_fields']]) {
    await db.prepare('INSERT INTO action_logs (account_id, action_type, instance_id, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(field === 'account_id' ? id : null, 'search_fields', field === 'instance_id' ? query : null, 'old matching entry', 1).run()
    const path = `logs?limit=1&action=search_fields&q=${encodeURIComponent(query)}`
    assert.equal((await api(path)).length, 1, `search covers ${field} before applying the limit`)
    const removed = await api(path, 'DELETE')
    assert.equal(removed.removed, 1, `deletion uses the same ${field} predicate`)
    assert.equal((await api('logs?action=search_fixture')).length, 1)
  }
  console.log('✓ 日志查询与删除共用关键词、类型和账号条件，支持名称/实例/类型/详情与字面通配符')

  await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: false })
  const beforeDuplicate = state.starts
  const manual = await api(`accounts/${id}/instances/i-review/stop`, 'POST')
  await eventually(async () => (await db.prepare('SELECT status FROM jobs WHERE id = ?').bind(manual.job_id).first()).status === 'success', 'manual stop')
  const afterManualStop = state.stops
  await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { Job: { id: manual.job_id } } }])
  assert.equal(state.stops, afterManualStop, 'redelivered completed job cannot replay the command')
  assert.equal(state.starts, beforeDuplicate)
  console.log('✓ 队列重复投递不重放已完成的开关机任务')

  // 同一消息失败 → 重投成功 → 再次重复投递，不依赖下一轮 Cron。
  const sameCycle = Date.now()
  const message = { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
    body: { Cron: { account_id: id, scheduled_at: sameCycle } } }
  await db.prepare(`CREATE TRIGGER fail_snapshot BEFORE UPDATE ON account_snapshots WHEN NEW.account_id = ${id} BEGIN SELECT RAISE(ABORT, 'fixture database failure'); END`).run()
  let delivery = await worker.queue('cdt-monitor-tasks', [message])
  assert.equal(delivery.retryMessages.length, 1)
  assert.equal(await db.prepare('SELECT * FROM locks WHERE name = ?').bind(`cron-account:${id}:${sameCycle}`).first(), null)
  await db.prepare('DROP TRIGGER fail_snapshot').run()
  const beforeRetry = state.requests
  delivery = await worker.queue('cdt-monitor-tasks', [{ ...message, attempts: 2 }])
  assert.equal(delivery.retryMessages.length, 0)
  assert.ok(state.requests > beforeRetry)
  const completedRequests = state.requests
  await worker.queue('cdt-monitor-tasks', [{ ...message, attempts: 3 }])
  assert.equal(state.requests, completedRequests)
  console.log('✓ 数据库故障允许同一 Cron 消息重投，成功后才去重')

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
      assert.equal((await api('overview')).accounts.find(a => a.id === id).instances[0].keep_alive, true)
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

  const overlapTime = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 16)
  await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: true,
    schedule_mode: 'simple', schedule_start_time: overlapTime, schedule_stop_time: overlapTime })
  const overlapStarts = state.starts
  const overlapStops = state.stops
  state.status = 'Running'
  await cronAccount(worker, id)
  assert.equal(state.stops, overlapStops + 1)
  await cronAccount(worker, id)
  assert.equal(state.status, 'Stopped')
  assert.equal(state.starts, overlapStarts, 'overlapping simple schedules must not restart after the stop has been deduplicated')
  state.status = 'Running'
  console.log('✓ 简单模式开关机窗口重叠时关机优先，后续巡检不会补发冲突的开机指令')

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

  await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: true })
  const keepAliveInstances = (await snapshot()).instances_json
  for (const instances of [keepAliveInstances, '[]']) {
    await db.prepare('UPDATE account_snapshots SET instances_json = ? WHERE account_id = ?').bind(instances, id).run()
    const beforeBlockedStop = state.requests
    const blocked = await runJob(`accounts/${id}/instances/i-review/stop`, 'failed')
    assert.match(blocked.error_msg, /保活已启用，不能手动关机/)
    assert.equal(state.requests, beforeBlockedStop, 'keep alive rejects manual stop before contacting cloud APIs, including without a snapshot')
  }
  state.status = 'Stopped'
  const keepAliveStarts = state.starts
  await runJob(`accounts/${id}/instances/i-review/start`)
  assert.equal(state.starts, keepAliveStarts + 1, 'keep alive still permits manual start')
  await api(`accounts/${id}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: false })
  const stopsAfterDisabling = state.stops
  await runJob(`accounts/${id}/instances/i-review/stop`)
  assert.equal(state.stops, stopsAfterDisabling + 1, 'disabling keep alive restores manual stop')
  state.status = 'Running'
  console.log('✓ 保活开启时直接调用关机接口也被拒绝，缺少快照不能绕过，开机与关闭保活后关机正常')

  const freshKeepAlive = await api('accounts', 'POST', { ...config, name: 'Fresh keep alive', traffic_threshold_gb: 0, spot_keep_alive: true })
  const freshId = freshKeepAlive.id
  const freshView = async () => (await api('overview')).accounts.find(a => a.id === freshId)
  assert.equal((await freshView()).instances[0].keep_alive, true, 'visible configuration applies before the first snapshot')
  state.status = 'Stopped'
  state.spot = false
  const freshStarts = state.starts
  await cronAccount(worker, freshId)
  assert.equal(state.starts, freshStarts, 'keep alive must not start non-spot instances')
  state.spot = true
  await db.prepare('DELETE FROM account_snapshots WHERE account_id = ?').bind(freshId).run()
  await cronAccount(worker, freshId)
  assert.equal(state.starts, freshStarts + 1, 'first collection must honor the visible keep-alive switch without a hidden per-instance switch')
  const freshVersion = (await db.prepare('SELECT config_version FROM accounts WHERE id = ?').bind(freshId).first()).config_version
  await api(`accounts/${freshId}/instances/i-review/keep-alive`, 'PUT', { enabled: false })
  const afterToggle = await freshView()
  assert.equal(afterToggle.spot_keep_alive, false)
  assert.equal(afterToggle.instances[0].keep_alive, false)
  assert.equal((await db.prepare('SELECT config_version FROM accounts WHERE id = ?').bind(freshId).first()).config_version, freshVersion + 1)
  state.status = 'Stopped'
  await cronAccount(worker, freshId)
  assert.equal(state.starts, freshStarts + 1, 'legacy endpoint disables the same setting used by the scheduler')
  await api(`accounts/${freshId}`, 'PUT', { ...config, traffic_threshold_gb: 0, spot_keep_alive: true })
  await db.prepare('DELETE FROM locks WHERE name = ?').bind(`keepalive:${freshId}:i-review`).run()
  await cronAccount(worker, freshId)
  assert.equal(state.starts, freshStarts + 2, 'enabling through account settings overrides the old false snapshot flag')
  await api(`accounts/${freshId}`, 'DELETE')
  state.status = 'Running'
  console.log('✓ 首次采集即按页面开关保活，普通实例不启动，旧接口与账号设置保持一致且可重新启用')

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

  async function maintenance(retry = false, target = worker) {
    const result = await target.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: 'Maintenance' }])
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
  assert.equal((await reportConfig()).last_sent_date ?? null, null)
  state.notifyFailed = false
  let releaseNotification
  notificationGate = new Promise(resolve => { releaseNotification = resolve })
  const sendingReport = maintenance()
  try {
    await eventually(() => state.notifications === reportNotifications + 2, 'report reaches notification channel')
    await api('settings/daily-report', 'PUT', { enabled: false, time: '13:25', timezone: 'UTC+5:30' })
  } finally {
    releaseNotification()
    notificationGate = null
    await sendingReport
  }
  assert.equal(state.notifications, reportNotifications + 2)
  const deliveredReport = await reportConfig()
  assert.ok(deliveredReport.last_sent_date)
  assert.deepEqual(deliveredReport, { enabled: false, time: '13:25', timezone: 'UTC+5:30', last_sent_date: deliveredReport.last_sent_date })
  await api('settings/daily-report', 'PUT', { enabled: true, time: reportTime, timezone: 'UTC+8' })
  assert.equal((await reportConfig()).last_sent_date, deliveredReport.last_sent_date)
  await maintenance()
  assert.equal(state.notifications, reportNotifications + 2, 'delivered daily report must not repeat')
  await api('settings/daily-report', 'PUT', { enabled: false, time: reportTime, timezone: 'UTC+8' })
  await api('settings/telegram', 'PUT', { enabled: false })
  console.log('✓ 日报生成或推送失败均释放租约，恢复后重试发送，送达后去重')
  console.log('✓ 推送期间保存的新日报时间、时区和开关生效，之后保存设置也保留送达日期')

  state.stallTraffic = true
  let began = Date.now()
  const stalled = await refresh('failed')
  assert.match(stalled.error_msg, /流量查询失败，网络连接超时，稍后重试.*cdt\.aliyuncs\.com/)
  assert.ok(Date.now() - began < 25_000, 'stalled headers must respect request budget')
  state.stallTraffic = false
  state.stallBody = true
  began = Date.now()
  const stalledBody = await refresh('failed')
  assert.match(stalledBody.error_msg, /流量查询失败，网络连接超时，稍后重试.*cdt\.aliyuncs\.com/)
  assert.ok(Date.now() - began < 25_000, 'stalled response body must respect request budget')
  state.stallBody = false
  console.log('✓ 请求头和响应体卡住时均能超时收尾')

  // DDNS：共享配置、真实 Worker/D1/队列，全部 Cloudflare API 由夹具拦截。
  state.status = 'Running'
  state.publicIp = '192.0.2.10'
  state.traffic = 1
  state.stopFailed = false
  state.startFailed = false
  state.notifyFailed = false
  await api('settings/telegram', 'PUT', { enabled: true, token: '123456:fixture-token-for-tests', chat_id: 'fixture-chat' })
  const ddnsInput = { zone_id: 'a'.repeat(32), name: 'dns-test.example.com', api_token: 'fixture-dns-token' }
  const dnsAccountInput = { ...config, name: 'DDNS fixture', instance_id: state.instanceId, traffic_threshold_gb: 0, spot_keep_alive: false, dns: { enabled: true } }
  assert.equal((await request('accounts', 'POST', dnsAccountInput)).status, 400, 'enable only after configuring DDNS')
  for (const invalid of [{ ...ddnsInput, zone_id: 'invalid' }, { ...ddnsInput, name: 'https://example.com' }, { ...ddnsInput, api_token: 'bad\ntoken' }, { ...ddnsInput, api_token: '' }]) {
    assert.equal((await request('settings/ddns', 'PUT', invalid)).status, 400)
  }
  const savedDdns = await api('settings/ddns', 'PUT', ddnsInput)
  assert.equal(savedDdns.ddns.token_configured, true)
  assert.equal(JSON.stringify(savedDdns).includes('fixture-dns-token'), false)
  const sharedConfig = JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'ddns'").first()).value)
  assert.equal(JSON.stringify(sharedConfig).includes('fixture-dns-token'), false, 'shared token is encrypted')
  const dnsAccount = await api('accounts', 'POST', dnsAccountInput)
  const dnsId = dnsAccount.id
  const dnsRefresh = (expected) => runJob(`accounts/${dnsId}/refresh`, expected)
  const dnsStored = async () => JSON.parse((await db.prepare('SELECT dns_json FROM accounts WHERE id = ?').bind(dnsId).first()).dns_json)
  const lightRefresh = async () => {
    const result = await worker.queue('cdt-monitor-tasks', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
      body: { Refresh: { account_id: dnsId, requested_at: ++cronSequence } },
    }])
    assert.equal(result.retryMessages.length, 0, JSON.stringify(result))
  }
  assert.deepEqual(dnsAccount.dns, { enabled: true, last_error: null })
  assert.equal((await dnsStored()).token_enc, undefined, 'new accounts never duplicate shared credentials')

  await dnsRefresh()
  assert.equal(state.dnsRecords.length, 1)
  await api('settings/ddns', 'PUT', { ...ddnsInput, api_token: '' })
  const retainedConfig = JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'ddns'").first()).value)
  assert.equal(retainedConfig.token_enc, sharedConfig.token_enc, 'blank token preserves the shared credential')
  console.log('✓ DDNS 共享配置验证、凭据加密与留空保留；实例仅保存开关和同步状态')

  // 升级前 D1 在实例行存凭据，状态里的 IP 没有 Zone 和域名归属。
  const peerRecords = ['192.0.2.51', '192.0.2.52'].map((content, i) => ({ ...state.dnsRecords[0], id: `peer-${i}`, content }))
  state.dnsRecords.push(...peerRecords)
  const legacyDns = {
    enabled: true, zone_id: 'c'.repeat(32), name: 'old.example.org', token_enc: sharedConfig.token_enc, lead_minutes: 30,
    state: { record_id: 'old-record', published_ip: peerRecords[0].content, pending_ip: peerRecords[1].content, paused: true },
  }
  await db.batch([
    db.prepare("DELETE FROM settings WHERE key = 'ddns'"),
    db.prepare('UPDATE accounts SET dns_json = ? WHERE id = ?').bind(JSON.stringify(legacyDns), dnsId),
  ])
  assert.deepEqual((await api('settings')).ddns, { zone_id: '', name: '', token_configured: false })
  const dnsCallsWithoutConfig = state.dnsCalls
  const renamed = await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, name: 'DDNS renamed' })
  assert.equal(renamed.name, 'DDNS renamed')
  assert.equal(renamed.dns.enabled, true, 'the browser always submits the unchanged switch')
  const edited = await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, stop_mode: 'KeepCharging', dns: undefined })
  assert.equal(edited.stop_mode, 'KeepCharging')
  assert.equal(edited.dns.enabled, true, 'omitting the switch preserves its value')
  assert.equal((await dnsStored()).token_enc, undefined, 'saving the account drops its old private configuration')
  await dnsRefresh()
  assert.match((await dnsStored()).state.last_error, /请先在控制台设置的 DDNS 中配置/)
  assert.equal(state.dnsCalls, dnsCallsWithoutConfig, 'missing shared configuration never calls Cloudflare')
  const dnsOff = await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, dns: { enabled: false } })
  assert.equal(dnsOff.dns.enabled, false)
  const invalidEnable = await request(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, name: 'must not save' })
  assert.equal(invalidEnable.status, 400, 'enabling still requires shared configuration')
  assert.equal((await dnsStored()).enabled, false)
  assert.equal((await db.prepare('SELECT name FROM accounts WHERE id = ?').bind(dnsId).first()).name, dnsAccountInput.name)
  await api('settings/ddns', 'PUT', ddnsInput)
  await api(`accounts/${dnsId}`, 'PUT', dnsAccountInput)
  await dnsRefresh()
  const recovered = (await dnsStored()).state
  assert.equal(recovered.last_error, null)
  assert.equal(recovered.zone_id, ddnsInput.zone_id)
  assert.equal(recovered.published_ip, state.publicIp)
  assert.equal(recovered.pending_ip, null)
  assert.equal(state.dnsRecords.filter(record => record.content === state.publicIp).length, 1)
  assert.deepEqual(state.dnsRecords.filter(record => record.content !== state.publicIp), peerRecords, 'unscoped cached IPs must never remove other nodes in the new target')
  state.dnsRecords = state.dnsRecords.filter(record => record.content === state.publicIp)
  console.log('✓ 旧格式实例可编辑和关闭开关，重新启用需全局配置，首次同步保留其他节点的记录')

  state.dnsRecords[0].ttl = 1
  state.dnsRecords[0].proxied = true
  await dnsRefresh()
  assert.equal(state.dnsRecords[0].ttl, 300)
  assert.equal(state.dnsRecords[0].proxied, false, 'adopted records use the configured DNS-only behavior')
  const stableState = await dnsStored()
  const stableCalls = state.dnsCalls
  await dnsRefresh()
  await cronAccount(worker, dnsId)
  assert.ok(state.dnsCalls > stableCalls, 'stable state still verifies actual DNS records')
  assert.deepEqual(await dnsStored(), stableState, 'healthy verification does not rewrite state')
  state.dnsRecords = []
  await dnsRefresh()
  assert.equal(state.dnsRecords.length, 1, 'external deletion is repaired even when IP is unchanged')
  state.publicIp = '192.0.2.11'
  await dnsRefresh()
  assert.deepEqual(state.dnsRecords.map(r => r.content), ['192.0.2.11'])
  console.log('✓ 稳定状态核查真实记录，外部删除自动补回，IP 变化清理旧地址且不重复创建')

  const nodeAInstanceId = state.instanceId
  state.instanceId = 'i-ddns-second'
  state.publicIp = '192.0.2.20'
  const secondInput = { ...dnsAccountInput, name: 'DDNS second', instance_id: state.instanceId, access_key_id: 'replacement-key' }
  const second = await api('accounts', 'POST', secondInput)
  await runJob(`accounts/${second.id}/refresh`)
  assert.deepEqual(state.dnsRecords.map(r => r.content).sort(), ['192.0.2.11', '192.0.2.20'])
  state.instanceId = nodeAInstanceId
  state.publicIp = '192.0.2.11'
  const ownRecord = () => state.dnsRecords.find(r => r.content === state.publicIp)
  const assertSecond = () => assert.equal(state.dnsRecords.filter(r => r.content === '192.0.2.20').length, 1)
  state.dnsDeleteFailed = true
  state.controlEvents = []
  const manualAlerts = state.notifications
  state.notifyFailed = true
  await runJob(`accounts/${dnsId}/instances/${state.instanceId}/stop`)
  assert.equal(state.status, 'Stopped')
  assert.deepEqual(state.controlEvents, ['stop', 'dns-delete', 'dns-alert'], 'DNS follows verified shutdown and never delays the stop command')
  assert.equal(state.notifications, manualAlerts + 1)
  const manualDeletes = state.dnsDeletes
  await dnsRefresh()
  assert.equal(state.notifications, manualAlerts + 2, 'an undelivered alert is retried on the same DNS fault')
  state.notifyFailed = false
  await cronAccount(worker, dnsId)
  await dnsRefresh()
  assert.equal(state.dnsDeletes, manualDeletes + 3, 'failed cleanup retries even while stopped')
  assert.equal(state.notifications, manualAlerts + 3, 'delivery is confirmed before suppressing further alerts')
  console.log('✓ DDNS 告警发送失败会再试，持续故障在确认送达后去重')
  state.dnsDeleteFailed = false
  state.publicIp = null // 节省停机可能释放公网 IP，仍必须清理最后一次登记的地址。
  await cronAccount(worker, dnsId)
  assert.deepEqual(state.dnsRecords.map(r => r.content), ['192.0.2.20'])
  assert.equal((await dnsStored()).state.published_ip, null)
  state.instanceId = 'i-ddns-second'
  state.status = 'Running'
  state.publicIp = '192.0.2.11'
  await runJob(`accounts/${second.id}/refresh`)
  const successor = structuredClone(ownRecord())
  state.instanceId = nodeAInstanceId
  state.status = 'Stopped'
  state.publicIp = null
  const callsAfterRelease = state.dnsCalls
  await cronAccount(worker, dnsId)
  assert.equal(state.dnsCalls, callsAfterRelease)
  assert.deepEqual(state.dnsRecords, [successor], 'the old owner must leave the new node’s recycled IP alone')
  state.instanceId = 'i-ddns-second'
  state.status = 'Running'
  state.publicIp = '192.0.2.20'
  await runJob(`accounts/${second.id}/refresh`)
  state.instanceId = nodeAInstanceId
  state.status = 'Stopped'
  state.publicIp = '192.0.2.11'
  await runJob(`accounts/${dnsId}/instances/${state.instanceId}/start`)
  assert.ok(ownRecord(), 'manual start publishes immediately after verifying Running')
  assertSecond()
  console.log('✓ 两实例共享域名互不误删；停机删除失败后持续重试、告警去重，IP 释放仍能清理，开机立即补回')
  console.log('✓ 地址回收后分配给另一节点，旧节点重复巡检保留新节点解析')

  const adopted = structuredClone(ownRecord())
  state.instanceId = 'i-ddns-second'
  await runJob(`accounts/${second.id}/refresh`)
  assert.deepEqual(ownRecord(), adopted, 'the new owner adopts the existing record ID')
  state.instanceId = nodeAInstanceId
  state.status = 'Stopped'
  state.publicIp = null
  await dnsRefresh()
  assert.deepEqual(state.dnsRecords, [adopted], 'a delayed stop cannot delete a record already adopted by the running peer')
  assert.equal((await dnsStored()).state.published_ip, null)
  state.instanceId = 'i-ddns-second'
  state.status = 'Running'
  state.publicIp = '192.0.2.20'
  await runJob(`accounts/${second.id}/refresh`)
  state.instanceId = nodeAInstanceId
  state.publicIp = '192.0.2.11'
  await dnsRefresh()
  assertSecond()
  console.log('✓ 新节点先接管原 A 记录时，旧节点的延迟停机清理保留同一条记录')

  state.dnsDeleteFailed = true
  state.status = 'Stopped'
  const attemptsBeforeRecovery = state.notifications
  let releaseDnsNotification
  notificationGate = new Promise(resolve => { releaseDnsNotification = resolve })
  const alertInFlight = dnsRefresh()
  try {
    await eventually(() => state.notifications > attemptsBeforeRecovery, 'DNS alert reached the channel')
    const enabled = await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, dns: { enabled: false } })
    assert.equal(enabled.dns.enabled, false, 'a slow notification does not lock the account')
    await api(`accounts/${dnsId}`, 'PUT', dnsAccountInput)
  } finally {
    releaseDnsNotification()
    notificationGate = null
    await alertInFlight
  }
  await api('settings/bark', 'PUT', { ...barkDraft, enabled: true })
  state.lastBark = null
  state.notifyDelay = 9000
  await lightRefresh()
  assert.ok(state.lastBark, 'Bark receives the new alert while Telegram times out')
  assert.equal(state.notifications, attemptsBeforeRecovery + 2, 'a late receipt cannot silence the next incident')
  state.notifyDelay = 0
  await lightRefresh()
  assert.equal(state.notifications, attemptsBeforeRecovery + 2, 'one confirmed channel is sufficient')
  await api('settings/bark', 'PUT', { enabled: false })
  state.dnsDeleteFailed = false
  state.status = 'Running'
  await dnsRefresh()
  console.log('✓ 告警发送期间可以编辑负载均衡，新故障单独确认送达')

  // 阿里云控制台、抢占回收等外部状态变化，由相同同步逻辑处理。
  for (const status of ['Starting', 'Stopping', 'Unknown']) {
    state.status = status
    const calls = state.dnsCalls
    await dnsRefresh()
    assert.equal(state.dnsCalls, calls, 'unknown/transitional states must not mutate DNS')
  }
  state.status = 'Stopped'
  const balancesBefore = state.balanceCalls
  const trafficBefore = state.trafficCalls
  await lightRefresh()
  assert.equal(ownRecord(), undefined)
  state.status = 'Running'
  await lightRefresh()
  assert.ok(ownRecord())
  assert.equal(state.balanceCalls, balancesBefore)
  assert.equal(state.trafficCalls, trafficBefore)
  state.instancesFailed = true
  const staleCalls = state.dnsCalls
  await dnsRefresh('failed')
  assert.equal(state.dnsCalls, staleCalls, 'failed ECS lookup must not reconcile from stale snapshot')
  state.instancesFailed = false
  console.log('✓ 外部启停通过状态补采同步 DDNS；过渡态、未知状态及查询失败不使用旧快照操作解析')

  await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, dns: { enabled: false } })
  state.status = 'Stopped'
  const disabledCalls = state.dnsCalls
  await dnsRefresh()
  assert.equal(state.dnsCalls, disabledCalls)
  assert.ok(ownRecord(), 'switch off stops managing existing records')
  await api(`accounts/${dnsId}`, 'PUT', dnsAccountInput)
  await dnsRefresh()
  assert.equal(ownRecord(), undefined, 'enabling for a stopped instance removes its existing record')
  state.status = 'Running'
  state.dnsWriteUnknown = true
  await dnsRefresh()
  assert.ok(ownRecord())
  assert.ok((await dnsStored()).state.pending_ip)
  await dnsRefresh()
  assert.equal(state.dnsRecords.filter(r => r.content === state.publicIp).length, 1)
  assert.equal((await dnsStored()).state.pending_ip, null)
  console.log('✓ DDNS 关闭后停止管理，重新开启按真实状态同步；创建结果未知先核实，不重复 POST')

  // 记录 ID 被人工改成另一台机器的 IP，不能依赖缓存 ID 误删。
  ownRecord().content = '192.0.2.99'
  await dnsRefresh()
  assert.ok(ownRecord())
  await runJob(`accounts/${dnsId}/instances/${state.instanceId}/stop`)
  assert.ok(state.dnsRecords.some(r => r.content === '192.0.2.99'))
  assertSecond()
  await runJob(`accounts/${dnsId}/instances/${state.instanceId}/start`)
  console.log('✓ 缓存记录被人工改为其他 IP 后不会误删，始终精确匹配域名和本机 IP')

  const scheduled = new Date(Date.now() + 20 * 60_000 + 8 * 3600_000)
  await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, schedule_mode: 'advanced', schedule_stop_cron: `${scheduled.getUTCMinutes()} ${scheduled.getUTCHours()} * * *` })
  await cronAccount(worker, dnsId)
  assert.ok(ownRecord(), 'running nodes stay published until stopped; no early drain')
  for (const mode of ['simple', 'advanced']) {
    const stopAt = new Date(Date.now() - 60_000 + 8 * 3600_000)
    await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, schedule_mode: mode,
      ...(mode === 'simple'
        ? { schedule_stop_time: `${String(stopAt.getUTCHours()).padStart(2, '0')}:${String(stopAt.getUTCMinutes()).padStart(2, '0')}` }
        : { schedule_stop_cron: `${stopAt.getUTCMinutes()} ${stopAt.getUTCHours()} * * *` }),
    })
    await cronAccount(worker, dnsId)
    assert.equal(state.status, 'Stopped')
    await lightRefresh()
    assert.equal(ownRecord(), undefined)
    await runJob(`accounts/${dnsId}/instances/${state.instanceId}/start`)
    assert.ok(ownRecord(), `${mode}: immediate restart publishes despite unchanged schedule`)
    await cronAccount(worker, dnsId)
    assert.ok(ownRecord())
  }
  await api(`accounts/${dnsId}`, 'PUT', dnsAccountInput)
  console.log('✓ 定时关机不再提前摘除，确认停机后删除；简单/Cron 计划关机后立即重启均恢复解析')

  // 流量熔断只控制实例，DDNS 根据查询到的终态收敛；删除失败不能影响停机。
  state.dnsDeleteFailed = true
  await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, traffic_threshold_gb: 0.5 })
  await dnsRefresh()
  assert.equal(state.status, 'Stopped')
  await dnsRefresh()
  assert.ok(ownRecord(), 'failed DNS cleanup remains pending')
  const thresholdDeletes = state.dnsDeletes
  await cronAccount(worker, dnsId)
  assert.equal(state.dnsDeletes, thresholdDeletes + 1)
  state.dnsDeleteFailed = false
  await dnsRefresh()
  assert.equal(ownRecord(), undefined)
  assertSecond()
  await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, traffic_threshold_gb: 0.5, over_limit_action: 'notify_only' })
  await runJob(`accounts/${dnsId}/instances/${state.instanceId}/start`)
  assert.ok(ownRecord())
  await api(`accounts/${dnsId}`, 'PUT', { ...dnsAccountInput, traffic_threshold_gb: 0.5 })
  await cronAccount(worker, dnsId)
  await cronAccount(worker, dnsId)
  assert.equal(ownRecord(), undefined, 'a later threshold stop must remove the newly published record again')
  await api(`accounts/${dnsId}`, 'PUT', dnsAccountInput)
  await dnsRefresh()
  await runJob(`accounts/${dnsId}/instances/${state.instanceId}/start`)
  console.log('✓ 熔断停机退出共享域名，失败自动补偿；恢复再熔断不会继承旧的一次性标记')

  // DNS 请求和通知均卡住时，控制命令已先执行；恢复后正常巡检清理。
  state.slowDescribeAttempts = 3
  state.slowStopAttempts = 3
  state.dnsDeleteDelay = 2500
  state.notifyDelay = 6000
  state.controlEvents = []
  const slowStopBegan = Date.now()
  await runJob(`accounts/${dnsId}/instances/${state.instanceId}/stop`)
  assert.equal(state.status, 'Stopped')
  assert.deepEqual(state.controlEvents, ['stop', 'stop', 'stop', 'dns-delete', 'dns-alert'])
  assert.ok(Date.now() - slowStopBegan < 55_000)
  state.dnsDeleteDelay = 0
  state.notifyDelay = 0
  await dnsRefresh()
  await runJob(`accounts/${dnsId}/instances/${state.instanceId}/start`)
  console.log('✓ 慢查询、慢停机、DNS 超时和通知卡住不挤占关机预算，同步失败可恢复')

  // 更换共享域名后，先清理本实例旧记录，再登记新域名；其他节点下轮各自迁移。
  await api('settings/ddns', 'PUT', { ...ddnsInput, name: 'dns-next.example.com', api_token: '' })
  await dnsRefresh()
  assert.equal(state.dnsRecords.filter(r => r.content === state.publicIp).length, 1)
  assert.equal(ownRecord().name, 'dns-next.example.com')
  assert.equal(state.dnsRecords.find(r => r.content === '192.0.2.20').name, ddnsInput.name)
  state.instanceId = 'i-ddns-second'
  state.publicIp = '192.0.2.20'
  await runJob(`accounts/${second.id}/refresh`)
  assert.equal(ownRecord().name, 'dns-next.example.com')
  assert.equal(state.dnsRecords.filter(r => r.content === state.publicIp).length, 1)
  state.instanceId = nodeAInstanceId
  state.publicIp = '192.0.2.11'
  console.log('✓ 共享域名修改后逐实例迁移解析，清理自己的旧记录并保留其他节点')

  // 更换 Zone 和 Token：权限不足时保留归属并说明原因，恢复权限后重试迁移。
  const nextZone = 'b'.repeat(32)
  const previousIp = state.publicIp
  const reassignedIp = '192.0.2.31'
  state.dnsRecords.push({ ...ownRecord(), id: 'independent-old-record', content: reassignedIp })
  state.publicIp = reassignedIp
  state.dnsToken = 'fixture-new-zone-token'
  state.dnsDeniedZone = ddnsInput.zone_id
  await api('settings/ddns', 'PUT', { zone_id: nextZone, name: 'dns-new.example.net', api_token: state.dnsToken })
  const beforeZoneSwitch = structuredClone(state.dnsRecords)
  const zoneAlerts = state.notifications
  await dnsRefresh()
  assert.deepEqual(state.dnsRecords, beforeZoneSwitch)
  assert.equal((await dnsStored()).state.zone_id, ddnsInput.zone_id)
  const cleanupError = (await dnsStored()).state.last_error
  assert.match(cleanupError, /旧解析 dns-next\.example\.com 清理失败.*HTTP 403.*新旧 Zone/)
  assert.equal(cleanupError.includes(state.dnsToken), false)
  assert.equal(state.notifications, zoneAlerts + 1)
  await dnsRefresh()
  assert.equal(state.notifications, zoneAlerts + 1, 'missing old Zone access is reported once')
  state.dnsDeniedZone = null
  await dnsRefresh()
  const published = state.dnsRecords.filter(r => r.content === reassignedIp && r.zoneId === nextZone)
  assert.deepEqual(published.map(r => r.name), ['dns-new.example.net'])
  assert.ok(!state.dnsRecords.some(r => r.content === previousIp && r.zoneId === ddnsInput.zone_id), 'only the previously published IP is removed from the old Zone')
  assert.ok(state.dnsRecords.some(r => r.id === 'independent-old-record' && r.content === reassignedIp), 'a newly assigned IP confers no ownership in the old Zone')
  assert.equal((await dnsStored()).state.zone_id, nextZone)
  assert.equal((await dnsStored()).state.last_error, null)
  assert.equal(state.dnsRecords.find(r => r.content === '192.0.2.20').zoneId, ddnsInput.zone_id)
  assert.ok(state.dnsRecords.some(r => r.content === '192.0.2.99' && r.zoneId === ddnsInput.zone_id), 'unrelated old Zone record is preserved')
  state.instanceId = 'i-ddns-second'
  state.publicIp = '192.0.2.20'
  state.status = 'Stopped'
  await runJob(`accounts/${second.id}/refresh`)
  assert.equal(ownRecord(), undefined, 'stopped node cleans its old Zone without publishing in the new one')
  assert.ok(state.dnsRecords.some(r => r.content === reassignedIp && r.zoneId === nextZone))
  state.status = 'Running'
  await runJob(`accounts/${second.id}/refresh`)
  assert.equal(ownRecord().zoneId, nextZone)
  state.instanceId = nodeAInstanceId
  state.publicIp = reassignedIp
  console.log('✓ 更换 Zone 和 Token 后明确提示旧 Zone 权限不足，恢复授权可重试，运行及停止节点分别同步且不误删其他记录')
  await api(`accounts/${dnsId}`, 'DELETE')
  await api(`accounts/${second.id}`, 'DELETE')
  state.publicIp = null

  const attempts = await Promise.all(Array.from({ length: 12 }, () => request('auth/login', 'POST', { username: 'review', password: 'wrong' }, '192.0.2.2')))
  assert.equal(attempts.filter(r => r.status === 401).length, 10)
  assert.equal(attempts.filter(r => r.status === 429).length, 2)
  console.log('✓ 并发登录尝试也受原子限流约束')

  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('turnstile', '{broken', 0)").run()
  response = await request('auth/login', 'POST', { username: 'review', password: 'test-password-only' }, '192.0.2.3')
  assert.equal(response.status, 500)
  assert.equal((await response.json()).code, 'turnstile_broken')
  console.log('✓ 人机校验配置损坏时拒绝登录')

  // 在独立时钟的 Worker 中复用本地 D1，实际投递巡检和维护队列。
  const year = new Date().getUTCFullYear() + 1
  const previousDay = `${year - 1}-12-31`
  const nextDay = `${year}-01-01`
  async function atLocalTime(time) {
    const now = Date.parse(time + '+08:00')
    await mf.setOptions({ d1Persist: testDirectory, workers: [{
      ...monitor, bindings: { ...monitor.bindings, FIXED_TIME_MS: now },
    }] })
    cronSequence = now - 1000
    return { db: await mf.getD1Database('DB'), worker: await mf.getWorker('monitor') }
  }
  await db.batch([
    db.prepare("UPDATE accounts SET enabled = 1, traffic_threshold_gb = 0, spot_keep_alive = 0, schedule_mode = 'simple', schedule_start_time = '23:59', schedule_stop_time = NULL, last_schedule_start_date = NULL WHERE id = ?").bind(id),
    db.prepare('UPDATE account_snapshots SET billing_month = ?, cdt_overseas_bytes = ?, traffic_updated_at = ? WHERE account_id = ?').bind(previousDay.slice(0, 7), 12 * 1024 ** 3, Date.parse(previousDay + 'T23:58:00+08:00'), id),
    db.prepare("UPDATE settings SET value = ? WHERE key = 'daily_report'").bind(JSON.stringify({ enabled: true, time: '23:59', timezone: 'UTC+8' })),
  ])
  const midnight = await atLocalTime(nextDay + 'T00:00:03')
  const reminders = state.notifications
  await maintenance(false, midnight.worker)
  await maintenance(false, midnight.worker)
  assert.equal(state.notifications, reminders + 1)
  const reportText = new URLSearchParams(state.lastTelegram.body).get('text')
  assert.ok(reportText.includes(previousDay))
  assert.match(reportText, /本月合计流量 12\.00 GB/)
  const sentDate = database => database.prepare("SELECT json_extract(value, '$.last_sent_date') AS day FROM settings WHERE key = 'daily_report'").first('day')
  assert.equal(await sentDate(midnight.db), previousDay)
  state.status = 'Stopped'
  const startsAtMidnight = state.starts
  await cronAccount(midnight.worker, id)
  assert.equal(state.starts, startsAtMidnight + 1)
  assert.equal(await midnight.db.prepare('SELECT last_schedule_start_date FROM accounts WHERE id = ?').bind(id).first('last_schedule_start_date'), previousDay)
  state.status = 'Stopped'
  await cronAccount(midnight.worker, id)
  assert.equal(state.starts, startsAtMidnight + 1)
  await midnight.db.prepare("UPDATE accounts SET schedule_stop_time = '23:59', schedule_start_time = '00:00', last_schedule_stop_date = NULL WHERE id = ?").bind(id).run()
  state.status = 'Running'
  const stopsAtMidnight = state.stops
  await cronAccount(midnight.worker, id)
  await cronAccount(midnight.worker, id)
  assert.equal(state.stops, stopsAtMidnight + 1)
  assert.equal(state.starts, startsAtMidnight + 1, 'midnight start yields to the preceding stop window')
  assert.equal(await midnight.db.prepare('SELECT last_schedule_stop_date FROM accounts WHERE id = ?').bind(id).first('last_schedule_stop_date'), previousDay)
  await midnight.db.prepare("UPDATE accounts SET schedule_start_time = '23:59', schedule_stop_time = NULL WHERE id = ?").bind(id).run()
  const evening = await atLocalTime(nextDay + 'T23:59:03')
  await cronAccount(evening.worker, id)
  assert.equal(state.starts, startsAtMidnight + 2)
  await maintenance(false, evening.worker)
  assert.equal(state.notifications, reminders + 2)
  assert.equal(await sentDate(evening.db), nextDay)
  console.log('✓ 跨年补跑 23:59 开机、关机与日报，按计划日去重和汇总，次日晚照常执行')
} finally {
  await mf.dispose()
  await rm(testDirectory, { recursive: true, force: true })
}
