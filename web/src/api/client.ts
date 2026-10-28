/**
 * API 客户端
 * ============================================================================
 * 统一处理三件事：
 *
 * 1. **Cookie 凭证**：会话是 `HttpOnly; Secure; SameSite=Strict` Cookie，
 *    JS 读不到也不需要读；只要每个请求带 `credentials: 'same-origin'`。
 * 2. **202 Job 轮询**：所有写接口都返回 `{ job_id, status, job_type }`，
 *    这里把它包装成「提交 → 轮询 → 拿到终态」的一次 Promise。
 * 3. **错误归一化**：后端错误体是 `{ error, code? }`，401 时额外带
 *    `X-Auth-Required: 1` 响应头。这里统一抛 `ApiError`，并把 401 广播给
 *    上层（`onUnauthorized`）以便立刻切回登录页。
 * ============================================================================
 */

/** 后端错误码（与 src/lib.rs 保持一致）。 */
export type ApiErrorCode =
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'turnstile_failed'
  | 'turnstile_unavailable'
  | 'turnstile_broken'
  | 'cross_origin'
  | 'job_locked'
  | 'cannot_kick_self'
  | 'job_conflict'
  | 'credentials_not_configured'
  | 'internal_error'
  | 'init_failed'
  | (string & {})

/** 统一的 API 错误。 */
export class ApiError extends Error {
  readonly status: number
  readonly code?: ApiErrorCode

  constructor(message: string, status: number, code?: ApiErrorCode) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  /** 会话失效。 */
  get isUnauthorized(): boolean {
    return this.status === 401
  }

  /** 需要一次性人机校验（Turnstile token 已被消费）。 */
  get isTurnstileIssue(): boolean {
    return (
      this.code === 'turnstile_failed' ||
      this.code === 'turnstile_unavailable' ||
      this.code === 'turnstile_broken'
    )
  }
}

// ---------------------------------------------------------------------------
// 类型定义（与 src/models.rs 的 DTO 对齐）
// ---------------------------------------------------------------------------

export type SiteType = 'china' | 'intl'
export type OverLimitAction = 'stop_and_notify' | 'notify_only'
export type StopMode = 'StopCharging' | 'KeepCharging'
export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'unknown'
export type JobType =
  | 'refresh_all'
  | 'refresh_account'
  | 'start_instance'
  | 'stop_instance'
  | 'notify_test'
  | 'daily_report'
  | 'unknown'
export type PushLevel = 'active' | 'timeSensitive' | 'critical'
export type NotifyChannel = 'telegram' | 'bark'
export type HistoryBucket = 'hour' | 'day'

export interface SessionResponse {
  authenticated: boolean
  turnstile_site_key: string
  expires_at?: number
}

export interface InstanceInfo {
  instance_id: string
  instance_name: string
  instance_type: string
  region_id: string
  zone_id: string
  status: string
  public_ip: string | null
  private_ip: string | null
  instance_charge_type: string | null
  spot_strategy: string | null
  stopped_mode: string | null
  os_name: string | null
  creation_time: string | null
  expired_time: string | null
  spot: boolean
  keep_alive: boolean
}

export interface AccountOverview {
  id: number
  name: string
  site_type: SiteType
  site_label: string
  region_id: string
  region_name: string
  instance_id: string
  traffic_threshold_gb: number
  quota_gb: number
  quota_label: string
  balance_cash: number | null
  balance_credit: number | null
  over_limit_action: OverLimitAction
  stop_mode: StopMode
  schedule_start_time: string | null
  schedule_stop_time: string | null
  spot_keep_alive: boolean
  enabled: boolean
  balance_amount: number | null
  balance_currency: string | null
  traffic_used_gb: number
  percentage: number
  billing_month: string
  threshold_triggered: boolean
  snapshot_updated_at: number | null
  instances: InstanceInfo[]
}

export interface OverviewResponse {
  accounts: AccountOverview[]
  timezone: string
  billing_month: string
}

export interface TrafficSample {
  /** 桶起始时间（Unix 毫秒） */
  recorded_at: number
  /** 当月累计流量（GB） */
  traffic_gb: number
}

export interface TrafficHistoryResponse {
  history: {
    hourly: TrafficSample[]
    daily: TrafficSample[]
  }
  traffic_threshold_gb: number
  quota_gb: number
  billing_month: string
  threshold_triggered: boolean
}

export interface ActionLog {
  id: number
  account_id: number | null
  account_name: string | null
  action_type: string
  instance_id: string | null
  detail: string
  created_at: number
}

export interface JobDto {
  id: string
  account_id: number | null
  job_type: JobType
  status: JobStatus
  error_msg: string | null
  created_at: number
  finished_at: number | null
}

export interface AcceptedJob {
  job_id: string
  status: JobStatus
  job_type: JobType
}

export interface AccountDto {
  id: number
  name: string
  site_type: SiteType
  site_label: string
  /** AccessKey ID 是否已配置（后端不回传明文） */
  access_key_id_configured: boolean
  region_id: string
  region_name: string
  instance_id: string
  traffic_threshold_gb: number
  quota_gb: number
  quota_label: string
  over_limit_action: OverLimitAction
  over_limit_action_label: string
  stop_mode: StopMode
  stop_mode_label: string
  schedule_start_time: string | null
  schedule_stop_time: string | null
  spot_keep_alive: boolean
  enabled: boolean
  created_at: number
  updated_at: number
}

export interface AccountInput {
  name: string
  site_type: SiteType
  /** 编辑时留空表示沿用原值 */
  access_key_id: string
  /** 编辑时留空表示沿用原密钥 */
  access_key_secret?: string
  region_id: string
  instance_id: string
  traffic_threshold_gb: number
  over_limit_action: OverLimitAction
  stop_mode: StopMode
  schedule_start_time: string | null
  schedule_stop_time: string | null
  spot_keep_alive: boolean
  enabled: boolean
}

export interface TelegramSettings {
  enabled: boolean
  /** 会话 ID 是否已配置（后端不回传明文） */
  chat_id_configured: boolean
  token_configured: boolean
}

export interface BarkSettings {
  enabled: boolean
  server_url: string
  device_key_configured: boolean
  normal_level: PushLevel
  alert_level: PushLevel
}

export interface DailyReportSettings {
  enabled: boolean
  time: string
  timezone: string
}

export interface SessionDevice {
  sid: string
  ua: string
  ip: string
  created_at: number
  last_seen_at: number
  expires_at: number
  current: boolean
}

export interface SessionsResponse {
  sessions: SessionDevice[]
}

export interface TurnstileSettings {
  enabled: boolean
  /** 站点公钥是否已配置（后端不回传明文） */
  site_key_configured: boolean
  secret_configured: boolean
}

export interface TurnstileUpdate {
  enabled: boolean
  site_key?: string
  secret_key?: string
}

export interface TimeZoneOption {
  value: string
  label: string
}

export interface AdvancedSettings {
  log_level: string
  job_lock_ttl_ms: number
  session_ttl_ms: number
}

export interface SettingsResponse {
  timezone: string
  timezone_options: TimeZoneOption[]
  advanced: AdvancedSettings
  turnstile: TurnstileSettings
  telegram: TelegramSettings
  bark: BarkSettings
  daily_report: DailyReportSettings
  accounts: AccountDto[]
}

export interface TelegramUpdate {
  enabled: boolean
  /** 留空表示保持原值 */
  chat_id: string
  token?: string
}

export interface BarkUpdate {
  enabled: boolean
  server_url: string
  device_key?: string
  normal_level: PushLevel
  alert_level: PushLevel
}

// ---------------------------------------------------------------------------
// 底层请求
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body } = options

  const init: RequestInit = {
    method,
    // SameSite=Strict Cookie 需要同源凭证
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
    },
    // 禁用缓存，确保拿到最新快照
    cache: 'no-store',
  }

  if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError('网络异常，请检查连接后重试', 0)
  }

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json')
  const text = await response.text()

  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`
    let code: ApiErrorCode | undefined
    if (isJson && text) {
      try {
        const parsed = JSON.parse(text) as { error?: string; code?: string }
        if (parsed.error) message = parsed.error
        code = parsed.code
      } catch {
        message = text.slice(0, 300) || message
      }
    }

    throw new ApiError(message, response.status, code)
  }

  if (!text) {
    return undefined as T
  }
  if (!isJson) {
    return text as unknown as T
  }
  return JSON.parse(text) as T
}

// ---------------------------------------------------------------------------
// Job 轮询
// ---------------------------------------------------------------------------

export interface PollOptions {
  /** 轮询间隔（毫秒），默认 1200 */
  intervalMs?: number
  /** 超时（毫秒），默认 180 秒（Worker 的 wait_until 上限远大于此） */
  timeoutMs?: number
  /** 每次拿到新状态时回调 */
  onUpdate?: (job: JobDto) => void
  /** 轮询被取消时使用的信号 */
  signal?: AbortSignal
}

/** 轮询直到任务终态；失败时抛 `ApiError`。 */
export async function waitForJob(jobId: string, options: PollOptions = {}): Promise<JobDto> {
  const { intervalMs = 1200, timeoutMs = 180_000, onUpdate, signal } = options
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new ApiError('操作已取消', 0, 'aborted')
    }

    const job = await request<JobDto>(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
    onUpdate?.(job)

    if (job.status === 'success') {
      return job
    }
    if (job.status === 'failed') {
      throw new ApiError(job.error_msg ?? '任务执行失败', 200, 'job_failed')
    }

    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, intervalMs)
      signal?.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }

  throw new ApiError('任务执行超时，请稍后在日志中查看结果', 0, 'job_timeout')
}

/** 提交异步任务并等到终态。 */
async function runJob(
  path: string,
  body: unknown,
  options: PollOptions = {},
): Promise<JobDto> {
  const accepted = await request<AcceptedJob>(path, {
    method: 'POST',
    body,
  })
  return waitForJob(accepted.job_id, options)
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

export const api = {
  // ---------------------------------------------------------------- 认证
  session(): Promise<SessionResponse> {
    return request<SessionResponse>('/api/v1/auth/session')
  },

  async login(
    username: string,
    password: string,
    turnstileToken: string,
  ): Promise<SessionResponse> {
    return request<SessionResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: {
        // 服务端未配置 ADMIN_USERNAME 时会忽略该字段
        username,
        password,
        turnstile_token: turnstileToken,
      },
    })
  },

  async logout(): Promise<void> {
    await request<unknown>('/api/v1/auth/logout', {
      method: 'POST',
    })
  },

  // ---------------------------------------------------------------- 概览
  /**
   * 概览数据。
   *
   * `refreshTransitional` 为真时，后端会对处于 `Starting` / `Stopping` 的实例
   * 补一次采集（带 10 秒防抖），用于过渡态的加速轮询。
   */
  overview(refreshTransitional = false): Promise<OverviewResponse> {
    const query = refreshTransitional ? '?refresh=transitional' : ''
    return request<OverviewResponse>(`/api/v1/overview${query}`)
  },

  /** 一次返回小时点与天点两份，由前端切「24 小时 / 30 天」。 */
  history(accountId: number): Promise<TrafficHistoryResponse> {
    return request<TrafficHistoryResponse>(`/api/v1/history?account_id=${accountId}`)
  },

  logs(limit = 80, options: { accountId?: number; action?: string } = {}): Promise<ActionLog[]> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (options.accountId !== undefined) {
      params.set('account_id', String(options.accountId))
    }
    if (options.action) {
      params.set('action', options.action)
    }
    return request<ActionLog[]>(`/api/v1/logs?${params.toString()}`)
  },

  // ---------------------------------------------------------------- 任务
  job(jobId: string): Promise<JobDto> {
    return request<JobDto>(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
  },

  jobs(limit = 20): Promise<JobDto[]> {
    return request<JobDto[]>(`/api/v1/jobs?limit=${limit}`)
  },

  /** 刷新全部账号（异步）。 */
  refreshAll(options: PollOptions = {}): Promise<JobDto> {
    return runJob('/api/v1/refresh', undefined, options)
  },

  /** 刷新单个账号（异步）。 */
  refreshAccount(accountId: number, options: PollOptions = {}): Promise<JobDto> {
    return runJob(`/api/v1/accounts/${accountId}/refresh`, undefined, options)
  },

  // ---------------------------------------------------------------- 实例
  startInstance(accountId: number, instanceId: string, options: PollOptions = {}): Promise<JobDto> {
    return runJob(
      `/api/v1/accounts/${accountId}/instances/${encodeURIComponent(instanceId)}/start`,
      undefined,
      options,
    )
  },

  stopInstance(accountId: number, instanceId: string, options: PollOptions = {}): Promise<JobDto> {
    return runJob(
      `/api/v1/accounts/${accountId}/instances/${encodeURIComponent(instanceId)}/stop`,
      undefined,
      options,
    )
  },

  setKeepAlive(accountId: number, instanceId: string, enabled: boolean): Promise<unknown> {
    return request<unknown>(
      `/api/v1/accounts/${accountId}/instances/${encodeURIComponent(instanceId)}/keep-alive`,
      { method: 'PUT', body: { enabled } },
    )
  },

  // ---------------------------------------------------------------- 账号
  createAccount(input: AccountInput): Promise<AccountDto> {
    return request<AccountDto>('/api/v1/accounts', { method: 'POST', body: input })
  },

  updateAccount(id: number, input: AccountInput): Promise<AccountDto> {
    return request<AccountDto>(`/api/v1/accounts/${id}`, { method: 'PUT', body: input })
  },

  deleteAccount(id: number): Promise<unknown> {
    return request<unknown>(`/api/v1/accounts/${id}`, { method: 'DELETE' })
  },

  // ---------------------------------------------------------------- 登录设备
  sessions(): Promise<SessionsResponse> {
    return request<SessionsResponse>('/api/v1/sessions')
  },

  revokeSession(sid: string): Promise<SessionsResponse> {
    return request<SessionsResponse>(`/api/v1/sessions/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
    })
  },

  revokeOtherSessions(): Promise<SessionsResponse> {
    return request<SessionsResponse>('/api/v1/sessions', { method: 'DELETE' })
  },

  // ---------------------------------------------------------------- 设置
  settings(): Promise<SettingsResponse> {
    return request<SettingsResponse>('/api/v1/settings')
  },

  updateTurnstile(input: TurnstileUpdate): Promise<SettingsResponse> {
    return request<SettingsResponse>('/api/v1/settings/turnstile', { method: 'PUT', body: input })
  },

  updateTelegram(input: TelegramUpdate): Promise<SettingsResponse> {
    return request<SettingsResponse>('/api/v1/settings/telegram', { method: 'PUT', body: input })
  },

  updateBark(input: BarkUpdate): Promise<SettingsResponse> {
    return request<SettingsResponse>('/api/v1/settings/bark', { method: 'PUT', body: input })
  },

  updateDailyReport(enabled: boolean, time: string): Promise<SettingsResponse> {
    return request<SettingsResponse>('/api/v1/settings/daily-report', {
      method: 'PUT',
      body: { enabled, time, timezone: '' },
    })
  },

  updateAdvanced(input: AdvancedSettings): Promise<SettingsResponse> {
    return request<SettingsResponse>('/api/v1/settings/advanced', { method: 'PUT', body: input })
  },

  updateTimezone(timezone: string): Promise<SettingsResponse> {
    return request<SettingsResponse>('/api/v1/settings/timezone', {
      method: 'PUT',
      body: { timezone },
    })
  },

  /** 测试通知渠道（异步，返回每个渠道的送达结果摘要）。 */
  testNotify(channel?: NotifyChannel, options: PollOptions = {}): Promise<JobDto> {
    return runJob('/api/v1/settings/notify-test', channel ? { channel } : {}, options)
  },

  /** 立即推送日报（异步）。 */
  pushDailyReport(options: PollOptions = {}): Promise<JobDto> {
    return runJob('/api/v1/reports/daily', undefined, options)
  },
}

// ---------------------------------------------------------------------------
// 展示工具
// ---------------------------------------------------------------------------

/** 金额格式化。 */
export function humanAmount(amount: number | null, currency: string | null): string {
  if (amount === null || !Number.isFinite(amount)) return '—'
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : (currency ?? '')
  return `${symbol} ${amount.toFixed(2)}`
}

/** 时间戳 -> 本地时间文本。 */
export function formatTime(ms: number | null, withDate = true): string {
  if (!ms) return '—'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (!withDate) return time
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

/** 相对时间（"3 分钟前"）。 */
export function relativeTime(ms: number | null): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 0) return '刚刚'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
