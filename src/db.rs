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
    AccountRow, ActionLog, AdvancedConfig, HistoryBucket, InstanceInfo, JobRow, JobStatus, JobType,
    LogFilter, SessionRow, SnapshotRow, SnapshotUpdate, TrafficSample, setting_key,
};

pub const ACCOUNT_BUSY: &str = "账号正在执行操作，请稍后重试";

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

fn j_opt_i64(value: Option<i64>) -> JsValue {
    value.map(j_i64).unwrap_or(JsValue::NULL)
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

    /// 配置编辑、采集与所有实例控制共用租约；预算短于租约，超时后释放。
    pub async fn with_account_lock<T>(
        &self,
        id: i64,
        budget_ms: u64,
        work: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        let key = format!("account-operation:{id}");
        let owner = crate::crypto::random_hex(8)?;
        if !self
            .acquire_lock(&key, &owner, crate::models::now_ms(), 120_000)
            .await?
        {
            return Err(worker::Error::RustError(ACCOUNT_BUSY.into()));
        }
        let result = crate::runtime::timeout(budget_ms.min(85_000), work)
            .await
            .unwrap_or_else(|e| Err(worker::Error::RustError(e.into())));
        self.release_lock(&key, &owner).await?;
        result
    }

    pub async fn account_at_version(&self, id: i64, version: i64) -> Result<AccountRow> {
        let account = self
            .get_account(id)
            .await?
            .ok_or_else(|| worker::Error::RustError("账号不存在".into()))?;
        if account.config_version != version {
            return Err(worker::Error::RustError(
                "账号配置已变更，请刷新后重新提交".into(),
            ));
        }
        Ok(account)
    }

    pub async fn set_cloud_account_id(&self, id: i64, cloud_id: &str) -> Result<()> {
        self.exec(
            "UPDATE accounts SET cloud_account_id = ? WHERE id = ?",
            &[j_text(cloud_id), j_i64(id)],
        )
        .await?;
        Ok(())
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

    /// 读取 JSON 配置；缺失或解析失败时返回 `default()`。
    pub async fn get_json_setting<T>(&self, key: &str) -> Result<T>
    where
        T: DeserializeOwned + Default,
    {
        match self.get_setting(key).await? {
            Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw)
                .map_err(|e| worker::Error::RustError(format!("配置 {key} 格式错误：{e}"))),
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

    /// 读取高级配置；缺失或解析失败时返回默认值。
    pub async fn get_advanced_config(&self) -> Result<AdvancedConfig> {
        let config: AdvancedConfig = self
            .get_json_setting(setting_key::ADVANCED)
            .await
            .unwrap_or_default();
        Ok(config.normalized())
    }

    /// 写入高级配置。
    pub async fn set_advanced_config(&self, config: &AdvancedConfig, now_ms: i64) -> Result<()> {
        self.set_json_setting(setting_key::ADVANCED, config, now_ms)
            .await
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
        cloud_account_id: &str,
        encrypted_secret: &str,
        region_id: &str,
        instance_id: &str,
        traffic_threshold_gb: f64,
        over_limit_action: &str,
        stop_mode: &str,
        schedule_start_time: Option<&str>,
        schedule_stop_time: Option<&str>,
        schedule_mode: &str,
        schedule_start_cron: Option<&str>,
        schedule_stop_cron: Option<&str>,
        spot_keep_alive: bool,
        enabled: bool,
        now_ms: i64,
    ) -> Result<i64> {
        self.insert(
            "INSERT INTO accounts (
                name, site_type, access_key_id, cloud_account_id, encrypted_access_key_secret,
                region_id, instance_id, traffic_threshold_gb,
                over_limit_action, stop_mode,
                schedule_start_time, schedule_stop_time, spot_keep_alive, enabled,
                schedule_mode, schedule_start_cron, schedule_stop_cron,
                last_schedule_start_date, last_schedule_stop_date,
                last_schedule_start_at, last_schedule_stop_at,
                created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)",
            &[
                j_text(name),
                j_text(site_type),
                j_text(access_key_id),
                j_text(cloud_account_id),
                j_text(encrypted_secret),
                j_text(region_id),
                j_text(instance_id),
                j_f64(traffic_threshold_gb),
                j_text(over_limit_action),
                j_text(stop_mode),
                j_opt_text(schedule_start_time),
                j_opt_text(schedule_stop_time),
                j_bool(spot_keep_alive),
                j_bool(enabled),
                j_text(schedule_mode),
                j_opt_text(schedule_start_cron),
                j_opt_text(schedule_stop_cron),
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
        previous: &AccountRow,
        cloud_account_id: Option<&str>,
        name: &str,
        site_type: &str,
        access_key_id: &str,
        encrypted_secret: Option<&str>,
        region_id: &str,
        instance_id: &str,
        traffic_threshold_gb: f64,
        over_limit_action: &str,
        stop_mode: &str,
        schedule_start_time: Option<&str>,
        schedule_stop_time: Option<&str>,
        schedule_mode: &str,
        schedule_start_cron: Option<&str>,
        schedule_stop_cron: Option<&str>,
        spot_keep_alive: bool,
        enabled: bool,
        now_ms: i64,
    ) -> Result<()> {
        let sql = match encrypted_secret {
            Some(_) => {
                "UPDATE accounts SET
                    name = ?, site_type = ?, access_key_id = ?, encrypted_access_key_secret = ?,
                    region_id = ?, instance_id = ?, traffic_threshold_gb = ?,
                    over_limit_action = ?, stop_mode = ?,
                    schedule_start_time = ?, schedule_stop_time = ?, spot_keep_alive = ?,
                    schedule_mode = ?, schedule_start_cron = ?, schedule_stop_cron = ?,
                    enabled = ?, updated_at = ?, cloud_account_id = ?, config_version = config_version + 1
                 WHERE id = ?"
            }
            None => {
                "UPDATE accounts SET
                    name = ?, site_type = ?, access_key_id = ?,
                    region_id = ?, instance_id = ?, traffic_threshold_gb = ?,
                    over_limit_action = ?, stop_mode = ?,
                    schedule_start_time = ?, schedule_stop_time = ?, spot_keep_alive = ?,
                    schedule_mode = ?, schedule_start_cron = ?, schedule_stop_cron = ?,
                    enabled = ?, updated_at = ?, cloud_account_id = ?, config_version = config_version + 1
                 WHERE id = ?"
            }
        };

        let mut params = vec![j_text(name), j_text(site_type), j_text(access_key_id)];
        if let Some(secret) = encrypted_secret {
            params.push(j_text(secret));
        }
        params.extend_from_slice(&[
            j_text(region_id),
            j_text(instance_id),
            j_f64(traffic_threshold_gb),
            j_text(over_limit_action),
            j_text(stop_mode),
            j_opt_text(schedule_start_time),
            j_opt_text(schedule_stop_time),
            j_bool(spot_keep_alive),
            j_text(schedule_mode),
            j_opt_text(schedule_start_cron),
            j_opt_text(schedule_stop_cron),
            j_bool(enabled),
            j_i64(now_ms),
            j_opt_text(cloud_account_id),
            j_i64(id),
        ]);

        let db = self.conn()?;
        let mut statements = vec![db.prepare(sql).bind(&params)?];
        let identity_changed = previous.cloud_account_id.as_deref() != cloud_account_id;
        let pool_changed = previous.quota_pool() != crate::models::QuotaPool::of_region(region_id);
        let reset_traffic = identity_changed || previous.site_type != site_type || pool_changed;
        let resource_changed = reset_traffic
            || previous.region_id != region_id
            || previous.instance_id_opt() != Some(instance_id);
        if reset_traffic {
            for table in ["account_snapshots", "traffic_hourly", "traffic_daily"] {
                statements.push(
                    db.prepare(format!("DELETE FROM {table} WHERE account_id = ?"))
                        .bind(&[j_i64(id)])?,
                );
            }
        } else if resource_changed {
            statements.push(db.prepare("UPDATE account_snapshots SET instances_json = '[]', instances_updated_at = NULL, threshold_stop_status = NULL, threshold_notified_month = NULL WHERE account_id = ?").bind(&[j_i64(id)])?);
        }
        if resource_changed
            || previous.schedule_start_time.as_deref() != schedule_start_time
            || previous.schedule_stop_time.as_deref() != schedule_stop_time
            || previous.schedule_mode.as_deref().unwrap_or("simple") != schedule_mode
            || previous.schedule_start_cron.as_deref() != schedule_start_cron
            || previous.schedule_stop_cron.as_deref() != schedule_stop_cron
        {
            statements.push(db.prepare("UPDATE accounts SET last_schedule_start_date = NULL, last_schedule_stop_date = NULL, last_schedule_start_at = NULL, last_schedule_stop_at = NULL WHERE id = ?").bind(&[j_i64(id)])?);
        }
        // 配置和关联状态一起提交，失败时全部回滚。
        db.batch(statements).await?;
        Ok(())
    }

    /// 删除账号及其快照 / 历史（`jobs`、`action_logs` 保留账号名为 NULL 的审计记录）。
    pub async fn delete_account(&self, id: i64) -> Result<()> {
        let db = self.conn()?;
        let statements = vec![
            db.prepare("DELETE FROM traffic_hourly WHERE account_id = ?")
                .bind(&[j_i64(id)])?,
            db.prepare("DELETE FROM traffic_daily WHERE account_id = ?")
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
            // 同时记录精确时刻：Cron 模式按「上次执行的触发」去重，
            // 不能只看日期，否则 `*/5` 这类高频表达式一天只能跑一次。
            "UPDATE accounts SET last_schedule_start_date = ?, last_schedule_start_at = ?, updated_at = ? WHERE id = ?"
        } else {
            // 同时记录精确时刻：保活只需避让「刚关机的那一轮」，
            // 不能用日期判断，否则当天此后被抢占回收也不会再拉起。
            "UPDATE accounts SET last_schedule_stop_date = ?, last_schedule_stop_at = ?, updated_at = ? WHERE id = ?"
        };
        let params = vec![
            j_text(date),
            j_i64(now_ms),
            j_i64(now_ms),
            j_i64(account_id),
        ];
        self.exec(sql, &params).await?;
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

    /// 手动动作前的实时实例查询只更新实例来源，保留流量、余额与熔断。
    pub async fn save_live_instance(
        &self,
        account_id: i64,
        instance: &InstanceInfo,
        now: i64,
    ) -> Result<()> {
        let json = serde_json::to_string(&[instance])
            .map_err(|e| worker::Error::RustError(e.to_string()))?;
        self.exec("INSERT INTO account_snapshots (account_id, instances_json, instances_updated_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET instances_json = excluded.instances_json, instances_updated_at = excluded.instances_updated_at, updated_at = excluded.updated_at",
            &[j_i64(account_id), j_text(&json), j_i64(now), j_i64(now)]).await?;
        Ok(())
    }

    /// 覆盖写入快照。
    ///
    /// `threshold_triggered_month` 不参与普通写入：
    /// * 账期内保留原值（已触发则继续禁止开机）；
    /// * 账期切换（`excluded.billing_month` 与新账期不一致）时自动清空。
    pub async fn upsert_snapshot(
        &self,
        update: &SnapshotUpdate,
        sample: Option<(f64, i64, i64)>,
    ) -> Result<()> {
        let instances_json = serde_json::to_string(&update.instances)
            .map_err(|e| worker::Error::RustError(format!("实例列表序列化失败：{e}")))?;
        let snapshot = self
            .stmt(
                "INSERT INTO account_snapshots (
                account_id, balance_amount, balance_currency, balance_cash, balance_credit,
                cdt_domestic_bytes, cdt_overseas_bytes, billing_month,
                instances_json, threshold_triggered_month, updated_at,
                traffic_updated_at, balance_updated_at, instances_updated_at, sync_errors_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id) DO UPDATE SET
                balance_amount = excluded.balance_amount,
                balance_currency = excluded.balance_currency,
                balance_cash = excluded.balance_cash,
                balance_credit = excluded.balance_credit,
                cdt_domestic_bytes = excluded.cdt_domestic_bytes,
                cdt_overseas_bytes = excluded.cdt_overseas_bytes,
                billing_month = excluded.billing_month,
                instances_json = excluded.instances_json,
                updated_at = excluded.updated_at,
                traffic_updated_at = excluded.traffic_updated_at,
                balance_updated_at = excluded.balance_updated_at,
                instances_updated_at = excluded.instances_updated_at,
                sync_errors_json = excluded.sync_errors_json,
                threshold_triggered_month = CASE
                    WHEN account_snapshots.threshold_triggered_month = excluded.billing_month
                        THEN account_snapshots.threshold_triggered_month
                    ELSE NULL
                END",
            )?
            .bind(&[
                j_i64(update.account_id),
                j_opt_f64(update.balance_amount),
                j_opt_text(update.balance_currency.as_deref()),
                j_opt_f64(update.balance_cash),
                j_opt_f64(update.balance_credit),
                j_i64(update.cdt_domestic_bytes.max(0)),
                j_i64(update.cdt_overseas_bytes.max(0)),
                j_text(&update.billing_month),
                j_text(&instances_json),
                j_i64(update.updated_at),
                j_opt_i64(update.traffic_updated_at),
                j_opt_i64(update.balance_updated_at),
                j_opt_i64(update.instances_updated_at),
                j_text(&serde_json::to_string(&update.sync_errors).unwrap_or_default()),
            ])?;
        let mut statements = vec![snapshot];
        if let Some((traffic, at, day)) = sample {
            statements.extend(self.traffic_statements(update.account_id, traffic, at, day)?);
        }
        self.conn()?.batch(statements).await?;
        Ok(())
    }

    /// 标记本月已触发流量熔断。
    pub async fn mark_threshold_triggered(
        &self,
        account_id: i64,
        month: &str,
        limit_gb: f64,
        now_ms: i64,
    ) -> Result<()> {
        self.exec(
            "INSERT INTO account_snapshots (
                account_id, balance_amount, balance_currency,
                cdt_domestic_bytes, cdt_overseas_bytes, billing_month,
                instances_json, threshold_triggered_month, updated_at, threshold_limit_gb
             ) VALUES (?, NULL, NULL, 0, 0, ?, '[]', ?, ?, ?)
             ON CONFLICT(account_id) DO UPDATE SET
                threshold_triggered_month = excluded.threshold_triggered_month,
                threshold_limit_gb = excluded.threshold_limit_gb,
                billing_month = excluded.billing_month,
                updated_at = excluded.updated_at",
            &[
                j_i64(account_id),
                j_text(month),
                j_text(month),
                j_i64(now_ms),
                j_f64(limit_gb),
            ],
        )
        .await?;
        Ok(())
    }

    pub async fn clear_threshold(&self, account_id: i64) -> Result<()> {
        self.exec("UPDATE account_snapshots SET threshold_triggered_month = NULL, threshold_limit_gb = NULL, threshold_notified_month = NULL, threshold_stop_status = NULL WHERE account_id = ?", &[j_i64(account_id)]).await?;
        Ok(())
    }

    pub async fn set_threshold_stop_status(&self, account_id: i64, status: &str) -> Result<()> {
        self.exec(
            "UPDATE account_snapshots SET threshold_stop_status = ? WHERE account_id = ?",
            &[j_text(status), j_i64(account_id)],
        )
        .await?;
        Ok(())
    }

    pub async fn mark_threshold_notified(&self, account_id: i64, month: &str) -> Result<()> {
        self.exec(
            "UPDATE account_snapshots SET threshold_notified_month = ? WHERE account_id = ?",
            &[j_text(month), j_i64(account_id)],
        )
        .await?;
        Ok(())
    }

    /// 只更新实例列表（逐实例保活开关等轻量操作，避免打阿里云）。
    pub async fn update_snapshot_instances(
        &self,
        account_id: i64,
        instances: &[InstanceInfo],
        _now_ms: i64,
    ) -> Result<()> {
        let instances_json = serde_json::to_string(instances)
            .map_err(|e| worker::Error::RustError(format!("实例列表序列化失败：{e}")))?;
        let changed = self
            .exec(
                "UPDATE account_snapshots SET instances_json = ? WHERE account_id = ?",
                &[j_text(&instances_json), j_i64(account_id)],
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
    // traffic_hourly / traffic_daily
    // =======================================================================

    /// 记录一次采样：同一小时内覆盖、同一天内覆盖，存当月累计用量（GB）。
    ///
    /// 小时表与日表各写一行，读的时候分开查 —— 小时表只要最近 25 条、
    /// 日表 31 条，混在一张表里反而要靠时间窗过滤。
    fn traffic_statements(
        &self,
        account_id: i64,
        traffic_gb: f64,
        now_ms: i64,
        day_start_ms: i64,
    ) -> Result<Vec<D1PreparedStatement>> {
        let hour = now_ms / 3_600_000 * 3_600_000;
        let value = traffic_gb.max(0.0);
        Ok(vec![
            self.stmt("INSERT INTO traffic_hourly (account_id, recorded_at, traffic) VALUES (?, ?, ?) ON CONFLICT(account_id, recorded_at) DO UPDATE SET traffic = excluded.traffic")?
                .bind(&[j_i64(account_id), j_i64(hour), j_f64(value)])?,
            self.stmt("INSERT INTO traffic_daily (account_id, recorded_at, traffic) VALUES (?, ?, ?) ON CONFLICT(account_id, recorded_at) DO UPDATE SET traffic = excluded.traffic")?
                .bind(&[j_i64(account_id), j_i64(day_start_ms), j_f64(value)])?,
        ])
    }

    /// 取最近 N 个小时点 / 天点，按时间升序返回。
    pub async fn traffic_history(
        &self,
        account_id: i64,
        bucket: HistoryBucket,
    ) -> Result<Vec<TrafficSample>> {
        let (table, limit) = match bucket {
            HistoryBucket::Hour => ("traffic_hourly", 25i64),
            HistoryBucket::Day => ("traffic_daily", 31i64),
        };
        #[derive(Deserialize)]
        struct Row {
            traffic: f64,
            recorded_at: i64,
        }
        let sql = format!(
            "SELECT traffic, recorded_at FROM {table}
             WHERE account_id = ?
             ORDER BY recorded_at DESC
             LIMIT {limit}"
        );
        let rows: Vec<Row> = self.query(&sql, &[j_i64(account_id)]).await?;
        let mut out: Vec<TrafficSample> = rows
            .into_iter()
            .map(|r| TrafficSample {
                recorded_at: r.recorded_at,
                traffic_gb: r.traffic.max(0.0),
            })
            .collect();
        out.sort_by_key(|p| p.recorded_at);
        Ok(out)
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
        payload: &str,
        now_ms: i64,
    ) -> Result<()> {
        self.exec(
            "INSERT INTO jobs (id, account_id, job_type, status, error_msg, created_at, finished_at, payload_json)
             VALUES (?, ?, ?, 'pending', NULL, ?, NULL, ?)",
            &[
                j_text(id),
                match account_id {
                    Some(id) => j_i64(id),
                    None => JsValue::NULL,
                },
                j_text(job_type.as_str()),
                j_i64(now_ms),
                j_text(payload),
            ],
        )
        .await?;
        Ok(())
    }

    /// 原子领取一段任务，轮询、Cron 和初始请求只能有一个执行者。
    pub async fn claim_job(&self, id: &str, now: i64) -> Result<bool> {
        Ok(self.exec("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'",
            &[j_i64(now), j_text(id)]).await? > 0)
    }

    pub async fn continue_job(&self, id: &str, payload: &str) -> Result<()> {
        self.exec("UPDATE jobs SET status = 'pending', payload_json = ?, started_at = NULL WHERE id = ? AND status = 'running'", &[j_text(payload), j_text(id)]).await?;
        Ok(())
    }

    pub async fn recover_jobs(&self, now: i64) -> Result<()> {
        self.exec("UPDATE jobs SET status = 'failed', error_msg = '执行中断或超时，请刷新实例状态后重新提交', finished_at = ? WHERE (status = 'running' AND COALESCE(started_at, created_at) <= ?) OR (status = 'pending' AND created_at <= ?)",
            &[j_i64(now), j_i64(now - 60_000), j_i64(now - 24 * 60 * 60 * 1000)]).await?;
        self.exec("DELETE FROM locks WHERE owner IN (SELECT id FROM jobs WHERE status IN ('failed', 'success'))", &[]).await?;
        Ok(())
    }

    /// 轮询和单任务投递只回收目标任务；owner 索引避免扫描全部历史锁。
    pub async fn recover_job(&self, id: &str, now: i64) -> Result<()> {
        self.conn()?.batch(vec![
            self.stmt("UPDATE jobs SET status = 'failed', error_msg = '执行中断或超时，请刷新实例状态后重新提交', finished_at = ? WHERE id = ? AND ((status = 'running' AND COALESCE(started_at, created_at) <= ?) OR (status = 'pending' AND created_at <= ?))")?
                .bind(&[j_i64(now), j_text(id), j_i64(now - 60_000), j_i64(now - 24 * 60 * 60_000)])?,
            self.stmt("DELETE FROM locks WHERE owner = ? AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status IN ('failed', 'success'))")?
                .bind(&[j_text(id), j_text(id)])?,
        ]).await?;
        Ok(())
    }

    pub async fn pending_jobs(&self) -> Result<Vec<JobRow>> {
        self.query(
            "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 10",
            &[],
        )
        .await
    }

    /// 置为 `success`。
    pub async fn finish_job_success(&self, id: &str, detail: &str, now_ms: i64) -> Result<()> {
        self.exec(
            "UPDATE jobs SET status = 'success', error_msg = NULL, finished_at = ?, result_msg = ? WHERE id = ? AND status = 'running'",
            &[j_i64(now_ms), j_text(&truncate(detail, 900)), j_text(id)],
        )
        .await?;
        Ok(())
    }

    /// 置为 `failed` 并记录错误。
    pub async fn finish_job_failed(&self, id: &str, error: &str, now_ms: i64) -> Result<()> {
        self.exec(
            "UPDATE jobs SET status = 'failed', error_msg = ?, finished_at = ? WHERE id = ? AND status IN ('pending', 'running')",
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
            clauses.push("instr(l.action_type, ?) = 1");
            params.push(j_text(prefix));
        }
        if let Some(keyword) = filter.keyword.as_deref().filter(|v| !v.is_empty()) {
            clauses.push("instr(lower(l.detail), lower(?)) > 0");
            params.push(j_text(keyword));
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

    /// 清空日志，可按同一套过滤条件收窄（不传则全清）。
    ///
    /// 条件与 [`Self::list_logs`] 保持一致：界面上看到什么，就能只清掉什么。
    pub async fn clear_logs(&self, filter: &LogFilter) -> Result<usize> {
        let mut clauses: Vec<&str> = Vec::new();
        let mut params: Vec<JsValue> = Vec::new();

        if let Some(account_id) = filter.account_id {
            clauses.push("account_id = ?");
            params.push(j_i64(account_id));
        }
        if let Some(prefix) = filter.action_prefix.as_deref().filter(|v| !v.is_empty()) {
            clauses.push("instr(action_type, ?) = 1");
            params.push(j_text(prefix));
        }
        if let Some(keyword) = filter.keyword.as_deref().filter(|v| !v.is_empty()) {
            clauses.push("instr(lower(detail), lower(?)) > 0");
            params.push(j_text(keyword));
        }

        let sql = if clauses.is_empty() {
            "DELETE FROM action_logs".to_string()
        } else {
            format!("DELETE FROM action_logs WHERE {}", clauses.join(" AND "))
        };
        self.exec(&sql, &params).await
    }

    // =======================================================================
    // locks（幂等）
    // =======================================================================

    /// 尝试获取锁；已存在且未过期时返回 `false`。
    ///
    /// 用「插入或抢占过期锁」的单条语句实现，天然并发安全。
    /// 未完成任务的锁保留到任务收尾或 recover_jobs 回收，避免分段期间重复提交。
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
                 WHERE locks.expires_at <= ? AND NOT EXISTS (
                    SELECT 1 FROM jobs WHERE jobs.id = locks.owner AND jobs.status IN ('pending', 'running')
                 )",
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

    /// 此消息是否已成功执行；完成标记与短期执行租约共用 locks 表。
    pub async fn task_completed(&self, name: &str) -> Result<bool> {
        Ok(self
            .query_first::<serde_json::Value>(
                "SELECT name FROM locks WHERE name = ? AND owner = 'completed'",
                &[j_text(name)],
            )
            .await?
            .is_some())
    }

    /// 将执行租约转为完成标记；旧执行者不能覆盖后继执行者的租约。
    pub async fn complete_task(&self, name: &str, owner: &str, expires_at: i64) -> Result<()> {
        let changed = self
            .exec(
                "UPDATE locks SET owner = 'completed', expires_at = ? WHERE name = ? AND owner = ?",
                &[j_i64(expires_at), j_text(name), j_text(owner)],
            )
            .await?;
        if changed == 0 {
            return Err(worker::Error::RustError(
                "任务租约已失效，请重试核实".into(),
            ));
        }
        Ok(())
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
        self.exec(
            "DELETE FROM locks WHERE expires_at <= ? AND NOT EXISTS (
                SELECT 1 FROM jobs WHERE jobs.id = locks.owner AND jobs.status IN ('pending', 'running')
             )",
            &[j_i64(now_ms)],
        ).await
    }

    /// 固定窗口原子计数：并发请求不能绕过额度，超额请求不继续写库。
    pub async fn allow_login(
        &self,
        bucket: &str,
        now: i64,
        limit: i64,
        window_ms: i64,
    ) -> Result<bool> {
        Ok(self.exec("INSERT INTO login_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = CASE WHEN login_attempts.expires_at <= ? THEN 1 ELSE login_attempts.attempts + 1 END, expires_at = CASE WHEN login_attempts.expires_at <= ? THEN excluded.expires_at ELSE login_attempts.expires_at END WHERE login_attempts.expires_at <= ? OR login_attempts.attempts < ?",
            &[j_text(bucket), j_i64(now + window_ms), j_i64(now), j_i64(now), j_i64(now), j_i64(limit)]).await? > 0)
    }

    pub async fn purge_login_attempts(&self, now: i64) -> Result<()> {
        self.exec(
            "DELETE FROM login_attempts WHERE expires_at <= ?",
            &[j_i64(now)],
        )
        .await?;
        Ok(())
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
            "UPDATE sessions SET last_seen_at = ? WHERE sid = ? AND last_seen_at <= ?",
            &[j_i64(now_ms), j_text(sid), j_i64(now_ms - 60_000)],
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

    /// 删除同一设备的旧会话（同 UA + 同 IP），返回删除条数。
    ///
    /// 同一个浏览器反复登录会不断新建 `sid`，旧记录要等过期才被清理，
    /// 「登录设备」里就会堆出一串一模一样的条目。登录前先清掉同设备旧会话，
    /// 让列表始终「一台设备一条」。
    pub async fn delete_sessions_of_device(&self, ua: &str, ip: &str) -> Result<usize> {
        self.exec(
            "DELETE FROM sessions WHERE ua = ? AND ip = ?",
            &[j_text(ua), j_text(ip)],
        )
        .await
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
        let hourly = self
            .exec(
                "DELETE FROM traffic_hourly WHERE recorded_at < ?",
                &[j_i64(before_ms)],
            )
            .await?;
        let daily = self
            .exec(
                "DELETE FROM traffic_daily WHERE recorded_at < ?",
                &[j_i64(before_ms)],
            )
            .await?;
        Ok(hourly + daily)
    }
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
