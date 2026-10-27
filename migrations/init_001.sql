-- ============================================================================
-- CDT-Monitor Worker · D1 初始化脚本
-- 所有时间戳均为「Unix 毫秒」INTEGER；布尔值以 INTEGER(0/1) 存储
-- （D1 返回值经 serde-wasm-bindgen 反序列化，0/1 无法直接映射为 bool，
--   因此 Rust 侧一律用 i64 读取后转换，见 src/models.rs）
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 系统级配置：key/value 文本存储
-- 约定的 key：
--   schema_version        数据库版本
--   timezone              全局时区（UTC+8 形式）
--   daily_report          日报配置 JSON：{enabled,time,timezone}
--   telegram              Telegram 配置 JSON：{enabled,token_enc,chat_id}
--   bark                  Bark 配置 JSON：{enabled,server_url,device_key_enc,normal_level,alert_level}
--   turnstile             Turnstile 配置 JSON：{enabled,site_key,secret_enc}
--   advanced              高级配置 JSON：{log_level,job_lock_ttl_ms,session_ttl_ms}
--
-- 注意：管理员账号与密码**不在**本表，它们只来自 Worker 环境变量
-- （ADMIN_USERNAME / ADMIN_PASSWORD），数据库里没有任何密码材料。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 阿里云账号
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  name                        TEXT    NOT NULL,
  site_type                   TEXT    NOT NULL DEFAULT 'china'
                              CHECK (site_type IN ('china', 'intl')),
  access_key_id               TEXT    NOT NULL,
  -- Base64(24 字节 Nonce + XChaCha20Poly1305 密文)
  encrypted_access_key_secret TEXT    NOT NULL,
  -- 一个账号对应一个地域、一台实例。实例 ID 必填：
  -- 留空会让熔断停机 / 定时开关机 / 保活作用到该地域内所有实例。
  region_id                   TEXT    NOT NULL DEFAULT 'cn-hongkong',
  instance_id                 TEXT    NOT NULL,
  -- 告警阈值（GB）。0 表示不限制也不告警；大于 0 时累计流量到线即告警。
  -- 实际比较的额度按 region_id 决定：中国内地地域 20 GB，其余 200 GB。
  traffic_threshold_gb        REAL    NOT NULL DEFAULT 0,
  over_limit_action           TEXT    NOT NULL DEFAULT 'stop_and_notify'
                              CHECK (over_limit_action IN ('stop_and_notify', 'notify_only')),
  stop_mode                   TEXT    NOT NULL DEFAULT 'StopCharging'
                              CHECK (stop_mode IN ('StopCharging', 'KeepCharging')),
  schedule_start_time         TEXT,
  schedule_stop_time          TEXT,
  spot_keep_alive             INTEGER NOT NULL DEFAULT 0,
  enabled                     INTEGER NOT NULL DEFAULT 1,
  last_schedule_start_date    TEXT,
  last_schedule_stop_date     TEXT,
  -- 最近一次定时关机的毫秒时间戳。保活只在这之后的短时间内避让，
  -- 与「当天已关机」无关：当天稍后被抢占回收仍应重新拉起。
  last_schedule_stop_at       INTEGER,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_enabled ON accounts (enabled);
CREATE INDEX IF NOT EXISTS idx_accounts_site ON accounts (site_type);

-- ---------------------------------------------------------------------------
-- 账号 / 实例最新状态快照（首页只读此表，避免每次请求都打阿里云）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_snapshots (
  account_id               INTEGER PRIMARY KEY
                           REFERENCES accounts (id) ON DELETE CASCADE,
  balance_amount           REAL,
  balance_currency         TEXT,
  -- 余额分项（BSS 返回的细分字段，用于 hover 展示）
  balance_cash             REAL,
  balance_credit           REAL,
  cdt_domestic_bytes       INTEGER NOT NULL DEFAULT 0,
  cdt_overseas_bytes       INTEGER NOT NULL DEFAULT 0,
  billing_month            TEXT    NOT NULL DEFAULT '',
  instances_json           TEXT    NOT NULL DEFAULT '[]',
  -- 已触发熔断的账期（YYYY-MM）；与当前账期相同表示本月已触发过，禁止再次拉起实例
  threshold_triggered_month TEXT,
  updated_at               INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 流量历史采样（CDT 为账期累计值，图表按小时/天取桶内最大值）
-- ---------------------------------------------------------------------------
-- 流量采样：每个小时一个点、每天一个点，存的是「当月累计用量」。
-- 分两张表是因为小时表只需保留最近 25 条、日表 31 条，
-- 混在一起要靠时间窗过滤，查询更复杂。
CREATE TABLE IF NOT EXISTS traffic_hourly (
  account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  recorded_at INTEGER NOT NULL,
  -- 当月累计流量（GB）
  traffic     REAL    NOT NULL,
  PRIMARY KEY (account_id, recorded_at)
);

CREATE TABLE IF NOT EXISTS traffic_daily (
  account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  recorded_at INTEGER NOT NULL,
  traffic     REAL    NOT NULL,
  PRIMARY KEY (account_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_traffic_hourly_time ON traffic_hourly (recorded_at);
CREATE INDEX IF NOT EXISTS idx_traffic_daily_time ON traffic_daily (recorded_at);

-- ---------------------------------------------------------------------------
-- 异步任务（手动刷新 / 开关机 / 通知测试 / 日报）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  account_id  INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  job_type    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'success', 'failed')),
  error_msg   TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_account_created ON jobs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at DESC);

-- ---------------------------------------------------------------------------
-- 自动化操作 / 告警日志
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
  action_type TEXT    NOT NULL,
  instance_id TEXT,
  detail      TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_logs_account_created
  ON action_logs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_logs_created
  ON action_logs (created_at DESC);

-- ---------------------------------------------------------------------------
-- 登录设备（会话）
--
-- 无状态 Token 可离线验签，但「踢下线」需要服务端状态：Token 载荷携带 sid，
-- 每次请求校验 sid 仍在本表且未被吊销。
--
-- ua / ip 仅用于展示，不参与鉴权。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  sid          TEXT PRIMARY KEY,
  ua           TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- 幂等锁：保证同一账号的同类自动化动作在 TTL 内只执行一次
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locks (
  name       TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks (expires_at);

-- ---------------------------------------------------------------------------
-- 预置配置
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('schema_version', '1', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('timezone', 'UTC+8', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('daily_report', '{"enabled":false,"time":"09:00","timezone":"UTC+8"}', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('advanced', '{"log_level":"error","job_lock_ttl_ms":600000,"session_ttl_ms":604800000}', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('telegram', '{"enabled":false,"token_enc":null,"chat_id":null}', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('bark', '{"enabled":false,"server_url":"https://api.day.app","device_key_enc":null,"normal_level":"active","alert_level":"critical"}', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
