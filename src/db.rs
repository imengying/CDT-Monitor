//! # D1 数据访问层
//!
//! 集中所有 SQL，上层（路由 / 调度器）不直接拼 SQL。设计要点：
//!
//! * **每个语句显式绑定参数**。这里不用 `serde_wasm_bindgen` 序列化参数，
//!   而是手写 `JsValue`：`NULL` / `REAL` / `TEXT` 的映射关系一目了然，
//!   避免 `Option`、大整数在跨语言边界上出现意外。
//! * **时间戳统一 millis(i64)**，`D1Type` 只支持 `i32` 整数，因此一律走
//!   `JsValue::from_f64`；秒级/毫秒级时间戳都远小于 `2^53`，不会丢精度。
//! * **布尔存 0/1**，读取时用 `i64` 承载（见 `models::AccountRow`）。
//! * **首页只读快照表**，`account_snapshots` 是唯一的读热点；采集侧通过
//!   `upsert_snapshot` 覆盖写入，并在账期切换时自动清理熔断标记。
//! * **幂等**：`locks` 表实现带 TTL 的抢占式锁；`jobs` 表记录每一次异步任务，
//!   前端凭 `job_id` 轮询。
//!
//! 所有方法都返回 `worker::Result<T>`，调用方用 `?` 直接向上传播。

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, Env, Result};

use crate::models::{
    AccountRow, ActionLog, HistoryBucket, InstanceInfo, JobRow, JobStatus, JobType, LogFilter,
    SessionRow, SnapshotRow, SnapshotUpdate, TrafficPoint, setting_key,
};

// ===========================================================================
// 参数绑定辅助
// ===========================================================================

fn j_text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn j_opt_text(value: Option<&str>) -> JsValue {
    match value {
        Some(v) => JsValue::from_str(v),
        None => JsValue::NULL,
    }
}

fn j_i64(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

fn j_f64(value: f64) -> JsValue {
    JsValue::from_f64(value)
}

fn j_opt_f64(value: Option<f64>) -> JsValue {
    match value {
        Some(v) if v.is_finite() => JsValue::from_f64(v),
        _ => JsValue::NULL,
    }
}

fn j_bool(value: bool) -> JsValue {
    JsValue::from_f64(if value { 1.0 } else { 0.0 })
}

/// 错误信息入库前截断，避免把整段阿里云响应塞进 D1。
fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let head: String = value.chars().take(max_chars).collect();
    format!("{head}…（已截断）")
}

// ===========================================================================
// Db
// ===========================================================================

/// D1 访问封装。
///
/// `D1Database` 本身不实现 `Clone`，因此这里只持有 `Env`，每次操作时按需
/// 取出绑定——`Env::d1` 只是一次反射查表，开销可以忽略。
#[derive(Clone, Debug)]
pub struct Db {
    env: Env,
}

impl Db {
    pub fn new(env: &Env) -> Self {
        Self { env: env.clone() }
    }

    /// 取出 D1 绑定（`wrangler.toml` 中 `binding = "DB"`）。
    fn conn(&self) -> Result<D1Database> {
        self.env.d1("DB")
    }

    /// 准备一条语句。
    fn stmt(&self, sql: &str) -> Result<D1PreparedStatement> {
        Ok(self.conn()?.prepare(sql))
    }

    /// 执行写语句，返回受影响行数。
    async fn exec(&self, sql: &str, params: &[JsValue]) -> Result<usize> {
        let stmt = self.stmt(sql)?.bind(params)?;
        let result = stmt.run().await?;
        if !result.success() {
            return Err(worker::Error::RustError(
                result
                    .error()
                    .unwrap_or_else(|| format!("D1 语句失败：{sql}")),
            ));
        }
        Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0))
    }

    /// 执行写语句并返回 `last_row_id`。
    async fn insert(&self, sql: &str, params: &[JsValue]) -> Result<i64> {
        let stmt = self.stmt(sql)?.bind(params)?;
        let result = stmt.run().await?;
        if !result.success() {
            return Err(worker::Error::RustError(
                result
                    .error()
                    .unwrap_or_else(|| format!("D1 语句失败：{sql}")),
            ));
        }
        Ok(result.meta()?.and_then(|m| m.last_row_id).unwrap_or(0))
    }

    /// 查询多行。
    async fn query<T: DeserializeOwned>(&self, sql: &str, params: &[JsValue]) -> Result<Vec<T>> {
        let stmt = self.stmt(sql)?.bind(params)?;
        let result = stmt.all().await?;
        if !result.success() {
            return Err(worker::Error::RustError(
                result
                    .error()
                    .unwrap_or_else(|| format!("D1 查询失败：{sql}")),
            ));
        }
        result.results::<T>()
    }

    /// 查询单行。
    async fn query_first<T: DeserializeOwned>(
        &self,
        sql: &str,
        params: &[JsValue],
    ) -> Result<Option<T>> {
        let stmt = self.stmt(sql)?.bind(params)?;
        stmt.first::<T>(None).await
    }

    /// 查询单个标量（例如 `COUNT(*)` 或 `MAX(recorded_at)`）。
    async fn scalar_i64(&self, sql: &str, params: &[JsValue]) -> Result<i64> {
        let stmt = self.stmt(sql)?.bind(params)?;
        let value: Option<i64> = stmt.first(Some("value")).await?;
        Ok(value.unwrap_or(0))
    }

    // =======================================================================
    // settings
    // =======================================================================

    /// 读取一个配置项。
    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            value: String,
        }
        let row: Option<Row> = self
            .query_first("SELECT value FROM settings WHERE key = ?", &[j_text(key)])
            .await?;
        Ok(row.map(|r| r.value))
    }

    /// 写入一个配置项（不存在则插入）。
    pub async fn set_setting(&self, key: &str, value: &str, now_ms: i64) -> Result<()> {
        self.exec(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            &[j_text(key), j_text(value), j_i64(now_ms)],
        )
        .await?;
        Ok(())
    }

    /// 删除一个配置项。
    pub async fn delete_setting(&self, key: &str) -> Result<()> {
        self.exec("DELETE FROM settings WHERE key = ?", &[j_text(key)])
            .await?;
        Ok(())
    }

    /// 读取 JSON 配置；缺失或解析失败时返回 `default()`。
    pub async fn get_json_setting<T>(&self, key: &str) -> Result<T>
    where
        T: DeserializeOwned + Default,
    {
        match self.get_setting(key).await? {
            Some(raw) if !raw.trim().is_empty() => {
                Ok(serde_json::from_str(&raw).unwrap_or_default())
            }
            _ => Ok(T::default()),
        }
    }

    /// 写入 JSON 配置。
    pub async fn set_json_setting<T: Serialize>(
        &self,
        key: &str,
        value: &T,
        now_ms: i64,
    ) -> Result<()> {
        let raw = serde_json::to_string(value)
            .map_err(|e| worker::Error::RustError(format!("配置序列化失败：{e}")))?;
        self.set_setting(key, &raw, now_ms).await
    }

    /// 读取全局时区（`UTC+8` 形式）。
    pub async fn get_timezone(&self) -> Result<String> {
        Ok(self
            .get_setting(setting_key::TIMEZONE)
            .await?
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "UTC+8".to_string()))
    }

    // =======================================================================
    // accounts
    // =======================================================================

    /// 列出账号；`only_enabled = true` 时只返回启用的。
    pub async fn list_accounts(&self, only_enabled: bool) -> Result<Vec<AccountRow>> {
        let sql = if only_enabled {
            "SELECT * FROM accounts WHERE enabled = 1 ORDER BY id ASC"
        } else {
            "SELECT * FROM accounts ORDER BY id ASC"
        };
        self.query(sql, &[]).await
    }

    /// 按 ID 取账号。
    pub async fn get_account(&self, id: i64) -> Result<Option<AccountRow>> {
        self.query_first("SELECT * FROM accounts WHERE id = ?", &[j_i64(id)])
            .await
    }

    /// 插入账号，返回新 ID。
    #[allow(clippy::too_many_arguments)]
    pub async fn create_account(
        &self,
        name: &str,
        site_type: &str,
        access_key_id: &str,
        encrypted_secret: &str,
        regions_json: &str,
        traffic_limit_gb: f64,
        spike_threshold_gb: Option<f64>,
        over_limit_action: &str,
        stop_mode: &str,
        schedule_start_time: Option<&str>,
        schedule_stop_time: Option<&str>,
        spot_keep_alive: bool,
        enabled: bool,
        now_ms: i64,
    ) -> Result<i64> {
        self.insert(
            "INSERT INTO accounts (
                name, site_type, access_key_id, encrypted_access_key_secret, regions_json,
                traffic_limit_gb, spike_threshold_gb, over_limit_action, stop_mode,
                schedule_start_time, schedule_stop_time, spot_keep_alive, enabled,
                last_schedule_start_date, last_schedule_stop_date, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
            &[
                j_text(name),
                j_text(site_type),
                j_text(access_key_id),
                j_text(encrypted_secret),
                j_text(regions_json),
                j_f64(traffic_limit_gb),
                j_opt_f64(spike_threshold_gb),
                j_text(over_limit_action),
                j_text(stop_mode),
                j_opt_text(schedule_start_time),
                j_opt_text(schedule_stop_time),
                j_bool(spot_keep_alive),
                j_bool(enabled),
                j_i64(now_ms),
                j_i64(now_ms),
            ],
        )
        .await
    }

    /// 更新账号（`encrypted_secret = None` 表示保留原密钥）。
    #[allow(clippy::too_many_arguments)]
    pub async fn update_account(
        &self,
        id: i64,
        name: &str,
        site_type: &str,
        access_key_id: &str,
        encrypted_secret: Option<&str>,
        regions_json: &str,
        traffic_limit_gb: f64,
        spike_threshold_gb: Option<f64>,
        over_limit_action: &str,
        stop_mode: &str,
        schedule_start_time: Option<&str>,
        schedule_stop_time: Option<&str>,
        spot_keep_alive: bool,
        enabled: bool,
        now_ms: i64,
    ) -> Result<()> {
        let sql = match encrypted_secret {
            Some(_) => {
                "UPDATE accounts SET
                    name = ?, site_type = ?, access_key_id = ?, encrypted_access_key_secret = ?,
                    regions_json = ?, traffic_limit_gb = ?, spike_threshold_gb = ?,
                    over_limit_action = ?, stop_mode = ?,
                    schedule_start_time = ?, schedule_stop_time = ?, spot_keep_alive = ?,
                    enabled = ?, updated_at = ?
                 WHERE id = ?"
            }
            None => {
                "UPDATE accounts SET
                    name = ?, site_type = ?, access_key_id = ?,
                    regions_json = ?, traffic_limit_gb = ?, spike_threshold_gb = ?,
                    over_limit_action = ?, stop_mode = ?,
                    schedule_start_time = ?, schedule_stop_time = ?, spot_keep_alive = ?,
                    enabled = ?, updated_at = ?
                 WHERE id = ?"
            }
        };

        let mut params = vec![j_text(name), j_text(site_type), j_text(access_key_id)];
        if let Some(secret) = encrypted_secret {
            params.push(j_text(secret));
        }
        params.extend_from_slice(&[
            j_text(regions_json),
            j_f64(traffic_limit_gb),
            j_opt_f64(spike_threshold_gb),
            j_text(over_limit_action),
            j_text(stop_mode),
            j_opt_text(schedule_start_time),
            j_opt_text(schedule_stop_time),
            j_bool(spot_keep_alive),
            j_bool(enabled),
            j_i64(now_ms),
            j_i64(id),
        ]);

        let changed = self.exec(sql, &params).await?;
        // SQLite 会把「值相同的 UPDATE」也算作 1 行变更；这里只在 0 行时
        // 额外确认一次账号是否真的不存在，避免把正常的无改动更新误报成错误。
        if changed == 0 && self.get_account(id).await?.is_none() {
            return Err(worker::Error::RustError("账号不存在".to_string()));
        }
        Ok(())
    }

    /// 删除账号及其快照 / 历史（`jobs`、`action_logs` 保留账号名为 NULL 的审计记录）。
    pub async fn delete_account(&self, id: i64) -> Result<()> {
        let db = self.conn()?;
        let statements = vec![
            db.prepare("DELETE FROM traffic_history WHERE account_id = ?")
                .bind(&[j_i64(id)])?,
            db.prepare("DELETE FROM account_snapshots WHERE account_id = ?")
                .bind(&[j_i64(id)])?,
            db.prepare("DELETE FROM accounts WHERE id = ?")
                .bind(&[j_i64(id)])?,
        ];
        let results = db.batch(statements).await?;
        for result in &results {
            if !result.success() {
                return Err(worker::Error::RustError(
                    result.error().unwrap_or_else(|| "删除账号失败".to_string()),
                ));
            }
        }
        Ok(())
    }

    /// 记录某个账号「今日已执行过定时开机 / 关机」，避免同一天重复触发。
    pub async fn mark_schedule_done(
        &self,
        account_id: i64,
        is_start: bool,
        date: &str,
        now_ms: i64,
    ) -> Result<()> {
        let sql = if is_start {
            "UPDATE accounts SET last_schedule_start_date = ?, updated_at = ? WHERE id = ?"
        } else {
            "UPDATE accounts SET last_schedule_stop_date = ?, updated_at = ? WHERE id = ?"
        };
        self.exec(sql, &[j_text(date), j_i64(now_ms), j_i64(account_id)])
            .await?;
        Ok(())
    }

    // =======================================================================
    // account_snapshots
    // =======================================================================

    /// 首页读路径：一次取全部快照。
    pub async fn list_snapshots(&self) -> Result<Vec<SnapshotRow>> {
        self.query("SELECT * FROM account_snapshots", &[]).await
    }

    /// 取单个账号快照。
    pub async fn get_snapshot(&self, account_id: i64) -> Result<Option<SnapshotRow>> {
        self.query_first(
            "SELECT * FROM account_snapshots WHERE account_id = ?",
            &[j_i64(account_id)],
        )
        .await
    }

    /// 覆盖写入快照。
    ///
    /// `threshold_triggered_month` 不参与普通写入：
    /// * 账期内保留原值（已触发则继续禁止开机）；
    /// * 账期切换（`excluded.billing_month` 与新账期不一致）时自动清空。
    pub async fn upsert_snapshot(&self, update: &SnapshotUpdate) -> Result<()> {
        let instances_json = serde_json::to_string(&update.instances)
            .map_err(|e| worker::Error::RustError(format!("实例列表序列化失败：{e}")))?;
        self.exec(
            "INSERT INTO account_snapshots (
                account_id, balance_amount, balance_currency,
                cdt_domestic_bytes, cdt_overseas_bytes, billing_month,
                instances_json, threshold_triggered_month, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
             ON CONFLICT(account_id) DO UPDATE SET
                balance_amount = excluded.balance_amount,
                balance_currency = excluded.balance_currency,
                cdt_domestic_bytes = excluded.cdt_domestic_bytes,
                cdt_overseas_bytes = excluded.cdt_overseas_bytes,
                billing_month = excluded.billing_month,
                instances_json = excluded.instances_json,
                updated_at = excluded.updated_at,
                threshold_triggered_month = CASE
                    WHEN account_snapshots.threshold_triggered_month = excluded.billing_month
                        THEN account_snapshots.threshold_triggered_month
                    ELSE NULL
                END",
            &[
                j_i64(update.account_id),
                j_opt_f64(update.balance_amount),
                j_opt_text(update.balance_currency.as_deref()),
                j_i64(update.cdt_domestic_bytes.max(0)),
                j_i64(update.cdt_overseas_bytes.max(0)),
                j_text(&update.billing_month),
                j_text(&instances_json),
                j_i64(update.updated_at),
            ],
        )
        .await?;
        Ok(())
    }

    /// 标记本月已触发流量熔断。
    pub async fn mark_threshold_triggered(
        &self,
        account_id: i64,
        month: &str,
        now_ms: i64,
    ) -> Result<()> {
        self.exec(
            "INSERT INTO account_snapshots (
                account_id, balance_amount, balance_currency,
                cdt_domestic_bytes, cdt_overseas_bytes, billing_month,
                instances_json, threshold_triggered_month, updated_at
             ) VALUES (?, NULL, NULL, 0, 0, ?, '[]', ?, ?)
             ON CONFLICT(account_id) DO UPDATE SET
                threshold_triggered_month = excluded.threshold_triggered_month,
                billing_month = excluded.billing_month,
                updated_at = excluded.updated_at",
            &[
                j_i64(account_id),
                j_text(month),
                j_text(month),
                j_i64(now_ms),
            ],
        )
        .await?;
        Ok(())
    }

    /// 只更新实例列表（逐实例保活开关等轻量操作，避免打阿里云）。
    pub async fn update_snapshot_instances(
        &self,
        account_id: i64,
        instances: &[InstanceInfo],
        now_ms: i64,
    ) -> Result<()> {
        let instances_json = serde_json::to_string(instances)
            .map_err(|e| worker::Error::RustError(format!("实例列表序列化失败：{e}")))?;
        let changed = self
            .exec(
                "UPDATE account_snapshots SET instances_json = ?, updated_at = ? WHERE account_id = ?",
                &[j_text(&instances_json), j_i64(now_ms), j_i64(account_id)],
            )
            .await?;
        if changed == 0 {
            return Err(worker::Error::RustError(
                "账号快照尚未生成，请先手动刷新一次".to_string(),
            ));
        }
        Ok(())
    }

    /// 读取快照中的实例列表。
    pub async fn snapshot_instances(&self, account_id: i64) -> Result<Vec<InstanceInfo>> {
        Ok(self
            .get_snapshot(account_id)
            .await?
            .map(|snapshot| snapshot.instances())
            .unwrap_or_default())
    }

    // =======================================================================
    // traffic_history
    // =======================================================================

    /// 最近一条采样（用于「值没变就不写」的去重）。
    pub async fn latest_history(&self, account_id: i64) -> Result<Option<TrafficPoint>> {
        #[derive(Deserialize)]
        struct Row {
            recorded_at: i64,
            domestic_bytes: i64,
            overseas_bytes: i64,
            total_bytes: i64,
        }
        let row: Option<Row> = self
            .query_first(
                "SELECT recorded_at, domestic_bytes, overseas_bytes, total_bytes
                 FROM traffic_history WHERE account_id = ?
                 ORDER BY recorded_at DESC LIMIT 1",
                &[j_i64(account_id)],
            )
            .await?;
        Ok(row.map(|r| TrafficPoint {
            recorded_at: r.recorded_at,
            domestic_bytes: r.domestic_bytes,
            overseas_bytes: r.overseas_bytes,
            total_bytes: r.total_bytes,
        }))
    }

    /// 插入一条采样。
    pub async fn insert_history(
        &self,
        account_id: i64,
        recorded_at: i64,
        domestic_bytes: i64,
        overseas_bytes: i64,
    ) -> Result<()> {
        let total = domestic_bytes.max(0) + overseas_bytes.max(0);
        self.exec(
            "INSERT INTO traffic_history
                (account_id, recorded_at, domestic_bytes, overseas_bytes, total_bytes)
             VALUES (?, ?, ?, ?, ?)",
            &[
                j_i64(account_id),
                j_i64(recorded_at),
                j_i64(domestic_bytes.max(0)),
                j_i64(overseas_bytes.max(0)),
                j_i64(total),
            ],
        )
        .await?;
        Ok(())
    }

    /// 有变化才写；`heartbeat_ms` 内数值完全相同的采样会被跳过。
    ///
    /// 返回 `true` 表示确实写入了一行。
    pub async fn sample_history(
        &self,
        account_id: i64,
        recorded_at: i64,
        domestic_bytes: i64,
        overseas_bytes: i64,
        heartbeat_ms: i64,
    ) -> Result<bool> {
        let domestic = domestic_bytes.max(0);
        let overseas = overseas_bytes.max(0);
        if let Some(last) = self.latest_history(account_id).await? {
            let unchanged = last.domestic_bytes == domestic && last.overseas_bytes == overseas;
            let fresh = recorded_at.saturating_sub(last.recorded_at) < heartbeat_ms.max(0);
            if unchanged && fresh {
                return Ok(false);
            }
        }
        self.insert_history(account_id, recorded_at, domestic, overseas)
            .await?;
        Ok(true)
    }

    /// 按时间粒度聚合历史流量。
    ///
    /// `offset_ms` 为本地时区偏移，用于把「天」桶对齐到本地 00:00
    /// （否则 UTC+8 的一天会被切成 08:00 → 次日 08:00）。
    /// 每个桶取 `MAX`——CDT 上报的是账期累计值，单调递增，最大值即桶末值。
    ///
    /// 桶宽是编译期常量（来自 `HistoryBucket`），直接内联进 SQL；
    /// 其余参数用 `CAST(? AS INTEGER)` 强制整数语义，避免 D1 把绑定值
    /// 当 REAL 参与运算后产生浮点分桶。
    #[allow(clippy::too_many_arguments)]
    pub async fn aggregate_history(
        &self,
        account_id: i64,
        bucket: HistoryBucket,
        offset_ms: i64,
        since_ms: i64,
        until_ms: i64,
        limit: u32,
    ) -> Result<Vec<TrafficPoint>> {
        #[derive(Deserialize)]
        struct Row {
            bucket_start: i64,
            domestic_bytes: i64,
            overseas_bytes: i64,
            total_bytes: i64,
        }

        let width = bucket.width_ms();
        let sql = format!(
            "SELECT CAST((recorded_at + CAST(? AS INTEGER)) / {width} AS INTEGER) * {width}
                    - CAST(? AS INTEGER) AS bucket_start,
                    MAX(domestic_bytes) AS domestic_bytes,
                    MAX(overseas_bytes) AS overseas_bytes,
                    MAX(total_bytes) AS total_bytes
             FROM traffic_history
             WHERE account_id = CAST(? AS INTEGER)
               AND recorded_at >= CAST(? AS INTEGER)
               AND recorded_at <= CAST(? AS INTEGER)
             GROUP BY bucket_start
             ORDER BY bucket_start DESC
             LIMIT CAST(? AS INTEGER)"
        );

        let rows: Vec<Row> = self
            .query(
                &sql,
                &[
                    j_i64(offset_ms),
                    j_i64(offset_ms),
                    j_i64(account_id),
                    j_i64(since_ms),
                    j_i64(until_ms),
                    j_i64(limit.clamp(1, 720) as i64),
                ],
            )
            .await?;

        let mut points: Vec<TrafficPoint> = rows
            .into_iter()
            .map(|r| TrafficPoint {
                recorded_at: r.bucket_start,
                domestic_bytes: r.domestic_bytes.max(0),
                overseas_bytes: r.overseas_bytes.max(0),
                total_bytes: r.total_bytes.max(0),
            })
            .collect();
        points.sort_by_key(|p| p.recorded_at);
        Ok(points)
    }

    /// 采样条数（诊断用）。
    pub async fn history_count(&self, account_id: i64) -> Result<i64> {
        self.scalar_i64(
            "SELECT COUNT(*) AS value FROM traffic_history WHERE account_id = ?",
            &[j_i64(account_id)],
        )
        .await
    }

    // =======================================================================
    // jobs
    // =======================================================================

    /// 创建任务（状态 `pending`）。
    pub async fn create_job(
        &self,
        id: &str,
        account_id: Option<i64>,
        job_type: JobType,
        now_ms: i64,
    ) -> Result<()> {
        self.exec(
            "INSERT INTO jobs (id, account_id, job_type, status, error_msg, created_at, finished_at)
             VALUES (?, ?, ?, 'pending', NULL, ?, NULL)",
            &[
                j_text(id),
                match account_id {
                    Some(id) => j_i64(id),
                    None => JsValue::NULL,
                },
                j_text(job_type.as_str()),
                j_i64(now_ms),
            ],
        )
        .await?;
        Ok(())
    }

    /// 置为 `running`。
    pub async fn start_job(&self, id: &str) -> Result<()> {
        self.exec(
            "UPDATE jobs SET status = 'running' WHERE id = ?",
            &[j_text(id)],
        )
        .await?;
        Ok(())
    }

    /// 置为 `success`。
    pub async fn finish_job_success(&self, id: &str, now_ms: i64) -> Result<()> {
        self.exec(
            "UPDATE jobs SET status = 'success', error_msg = NULL, finished_at = ? WHERE id = ?",
            &[j_i64(now_ms), j_text(id)],
        )
        .await?;
        Ok(())
    }

    /// 置为 `failed` 并记录错误。
    pub async fn finish_job_failed(&self, id: &str, error: &str, now_ms: i64) -> Result<()> {
        self.exec(
            "UPDATE jobs SET status = 'failed', error_msg = ?, finished_at = ? WHERE id = ?",
            &[j_text(&truncate(error, 900)), j_i64(now_ms), j_text(id)],
        )
        .await?;
        Ok(())
    }

    /// 查询任务。
    pub async fn get_job(&self, id: &str) -> Result<Option<JobRow>> {
        self.query_first("SELECT * FROM jobs WHERE id = ?", &[j_text(id)])
            .await
    }

    /// 最近任务列表（可按账号过滤）。
    pub async fn list_jobs(&self, account_id: Option<i64>, limit: u32) -> Result<Vec<JobRow>> {
        let limit = limit.clamp(1, 100) as i64;
        match account_id {
            Some(id) => {
                self.query(
                    "SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?",
                    &[j_i64(id), j_i64(limit)],
                )
                .await
            }
            None => {
                self.query(
                    "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?",
                    &[j_i64(limit)],
                )
                .await
            }
        }
    }

    /// 判断某账号是否已有同类任务在跑（避免前端连点导致重复开机/关机）。
    pub async fn has_active_job(&self, account_id: i64, job_type: JobType) -> Result<bool> {
        let count = self
            .scalar_i64(
                "SELECT COUNT(*) AS value FROM jobs
                 WHERE account_id = ? AND job_type = ? AND status IN ('pending', 'running')",
                &[j_i64(account_id), j_text(job_type.as_str())],
            )
            .await?;
        Ok(count > 0)
    }

    /// 清理过期任务记录。
    pub async fn purge_jobs(&self, before_ms: i64) -> Result<usize> {
        self.exec("DELETE FROM jobs WHERE created_at < ?", &[j_i64(before_ms)])
            .await
    }

    // =======================================================================
    // action_logs
    // =======================================================================

    /// 写入一条操作 / 告警日志。
    pub async fn add_log(
        &self,
        account_id: Option<i64>,
        action_type: &str,
        instance_id: Option<&str>,
        detail: &str,
        now_ms: i64,
    ) -> Result<()> {
        self.exec(
            "INSERT INTO action_logs (account_id, action_type, instance_id, detail, created_at)
             VALUES (?, ?, ?, ?, ?)",
            &[
                match account_id {
                    Some(id) => j_i64(id),
                    None => JsValue::NULL,
                },
                j_text(action_type),
                j_opt_text(instance_id),
                j_text(&truncate(detail, 900)),
                j_i64(now_ms),
            ],
        )
        .await?;
        Ok(())
    }

    /// 读取日志（带账号名）。
    pub async fn list_logs(&self, filter: &LogFilter) -> Result<Vec<ActionLog>> {
        let limit = filter.limit.clamp(1, 500) as i64;

        // 条件按需拼接，参数顺序与 SQL 占位符保持一致
        let mut clauses: Vec<&str> = Vec::new();
        let mut params: Vec<JsValue> = Vec::new();

        if let Some(id) = filter.account_id {
            clauses.push("l.account_id = ?");
            params.push(j_i64(id));
        }
        if let Some(prefix) = filter.action_prefix.as_deref().filter(|v| !v.is_empty()) {
            clauses.push("l.action_type LIKE ?");
            params.push(j_text(&format!("{prefix}%")));
        }
        if let Some(keyword) = filter.keyword.as_deref().filter(|v| !v.is_empty()) {
            clauses.push("l.detail LIKE ?");
            params.push(j_text(&format!("%{keyword}%")));
        }

        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        params.push(j_i64(limit));

        let sql = format!(
            "SELECT l.id, l.account_id, a.name AS account_name, l.action_type,
                    l.instance_id, l.detail, l.created_at
             FROM action_logs l LEFT JOIN accounts a ON a.id = l.account_id
             {where_sql}
             ORDER BY l.created_at DESC LIMIT ?"
        );
        self.query(&sql, &params).await
    }

    /// 清理过期日志。
    pub async fn purge_logs(&self, before_ms: i64) -> Result<usize> {
        self.exec(
            "DELETE FROM action_logs WHERE created_at < ?",
            &[j_i64(before_ms)],
        )
        .await
    }

    // =======================================================================
    // locks（幂等）
    // =======================================================================

    /// 尝试获取锁；已存在且未过期时返回 `false`。
    ///
    /// 用「插入或抢占过期锁」的单条语句实现，天然并发安全。
    pub async fn acquire_lock(
        &self,
        name: &str,
        owner: &str,
        now_ms: i64,
        ttl_ms: i64,
    ) -> Result<bool> {
        let expires_at = now_ms.saturating_add(ttl_ms.max(1_000));
        let changed = self
            .exec(
                "INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?)
                 ON CONFLICT(name) DO UPDATE SET
                    owner = excluded.owner, expires_at = excluded.expires_at
                 WHERE locks.expires_at <= ?",
                &[
                    j_text(name),
                    j_text(owner),
                    j_i64(expires_at),
                    j_i64(now_ms),
                ],
            )
            .await?;
        Ok(changed > 0)
    }

    /// 释放自己持有的锁（owner 不匹配时不会误删）。
    pub async fn release_lock(&self, name: &str, owner: &str) -> Result<bool> {
        let changed = self
            .exec(
                "DELETE FROM locks WHERE name = ? AND owner = ?",
                &[j_text(name), j_text(owner)],
            )
            .await?;
        Ok(changed > 0)
    }

    /// 清理已过期的锁。
    pub async fn purge_locks(&self, now_ms: i64) -> Result<usize> {
        self.exec("DELETE FROM locks WHERE expires_at <= ?", &[j_i64(now_ms)])
            .await
    }

    // =======================================================================
    // 登录设备（sessions）
    // =======================================================================

    /// 新建会话。
    pub async fn create_session(&self, row: &SessionRow) -> Result<()> {
        self.exec(
            "INSERT INTO sessions (sid, ua, ip, created_at, last_seen_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            &[
                j_text(&row.sid),
                j_text(&row.ua),
                j_text(&row.ip),
                j_i64(row.created_at),
                j_i64(row.last_seen_at),
                j_i64(row.expires_at),
            ],
        )
        .await?;
        Ok(())
    }

    /// 会话是否仍然有效（存在、未过期）。
    pub async fn session_is_active(&self, sid: &str, now_ms: i64) -> Result<bool> {
        let hit: Option<SessionRow> = self
            .query_first(
                "SELECT * FROM sessions WHERE sid = ? AND expires_at > ?",
                &[j_text(sid), j_i64(now_ms)],
            )
            .await?;
        Ok(hit.is_some())
    }

    /// 刷新活跃时间（供「最近活跃」展示）。
    pub async fn touch_session(&self, sid: &str, now_ms: i64) -> Result<()> {
        self.exec(
            "UPDATE sessions SET last_seen_at = ? WHERE sid = ?",
            &[j_i64(now_ms), j_text(sid)],
        )
        .await?;
        Ok(())
    }

    /// 列出未过期的会话，最近活跃在前。
    pub async fn list_sessions(&self, now_ms: i64) -> Result<Vec<SessionRow>> {
        self.query(
            "SELECT * FROM sessions WHERE expires_at > ? ORDER BY last_seen_at DESC",
            &[j_i64(now_ms)],
        )
        .await
    }

    /// 吊销指定会话，返回是否真的删掉了。
    pub async fn delete_session(&self, sid: &str) -> Result<bool> {
        let changed = self
            .exec("DELETE FROM sessions WHERE sid = ?", &[j_text(sid)])
            .await?;
        Ok(changed > 0)
    }

    /// 清理过期会话。
    pub async fn purge_sessions(&self, now_ms: i64) -> Result<usize> {
        self.exec(
            "DELETE FROM sessions WHERE expires_at <= ?",
            &[j_i64(now_ms)],
        )
        .await
    }

    // =======================================================================
    // 维护
    // =======================================================================

    /// 清理过期流量采样。
    pub async fn purge_history(&self, before_ms: i64) -> Result<usize> {
        self.exec(
            "DELETE FROM traffic_history WHERE recorded_at < ?",
            &[j_i64(before_ms)],
        )
        .await
    }

    /// 统计各表行数，供设置页「存储」信息展示。
    pub async fn stats(&self) -> Result<DbStats> {
        let accounts = self
            .scalar_i64("SELECT COUNT(*) AS value FROM accounts", &[])
            .await?;
        let samples = self
            .scalar_i64("SELECT COUNT(*) AS value FROM traffic_history", &[])
            .await?;
        let logs = self
            .scalar_i64("SELECT COUNT(*) AS value FROM action_logs", &[])
            .await?;
        let jobs = self
            .scalar_i64("SELECT COUNT(*) AS value FROM jobs", &[])
            .await?;
        Ok(DbStats {
            accounts,
            samples,
            logs,
            jobs,
        })
    }
}

/// 存储统计。
#[derive(Debug, Clone, Serialize)]
pub struct DbStats {
    pub accounts: i64,
    pub samples: i64,
    pub logs: i64,
    pub jobs: i64,
}

/// 任务状态的中文描述，日志里用。
pub fn describe_job_status(status: JobStatus) -> &'static str {
    match status {
        JobStatus::Pending => "排队中",
        JobStatus::Running => "执行中",
        JobStatus::Success => "成功",
        JobStatus::Failed => "失败",
        JobStatus::Unknown => "未知",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_text() {
        assert_eq!(truncate("abc", 10), "abc");
    }

    #[test]
    fn truncate_marks_long_text() {
        let out = truncate("0123456789", 3);
        assert!(out.starts_with("012"));
        assert!(out.ends_with("（已截断）"));
    }

    #[test]
    fn truncate_is_utf8_safe() {
        let out = truncate("中文日志内容", 2);
        assert!(out.starts_with("中文"));
    }

    #[test]
    fn job_status_labels() {
        assert_eq!(describe_job_status(JobStatus::Running), "执行中");
    }
}
