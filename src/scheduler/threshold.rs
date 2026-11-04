//! 熔断状态、停机核实与通知重试。
use super::*;

impl Scheduler {
    /// 处理首次超限：标记账期 → 停机（按策略）→ 告警。
    ///
    /// 返回是否真的完成了标记（幂等锁保护，并发 Cron 只有一个能进来）。
    pub(super) async fn handle_threshold(
        &self,
        account: &AccountRow,
        used_gb: f64,
        pool: QuotaPool,
    ) -> worker::Result<bool> {
        let billing_month = crate::models::billing_month(self.now, &self.timezone);
        let lock_name = format!("threshold:{}:{}", account.id, billing_month);
        let owner = random_hex(8).map_err(|e| worker::Error::RustError(e.to_string()))?;
        let acquired = self
            .db
            .acquire_lock(&lock_name, &owner, now_ms(), 60_000)
            .await?;
        if !acquired {
            return Ok(false);
        }

        let result = self
            .reconcile_threshold(account, used_gb, pool, &billing_month)
            .await;
        let _ = self.db.release_lock(&lock_name, &owner).await;
        result
    }

    async fn reconcile_threshold(
        &self,
        account: &AccountRow,
        used_gb: f64,
        pool: QuotaPool,
        month: &str,
    ) -> worker::Result<bool> {
        let snapshot = self.db.get_snapshot(account.id).await?;
        let first = !snapshot
            .as_ref()
            .is_some_and(|s| s.threshold_triggered(month));
        if first {
            self.db
                .mark_threshold_triggered(account.id, month, account.traffic_threshold_gb, now_ms())
                .await?;
            self.db
                .add_log(
                    Some(account.id),
                    "threshold_triggered",
                    None,
                    &format!(
                        "{}池用量 {:.2} GB 达到阈值 {} GB",
                        pool.label(),
                        used_gb,
                        account.traffic_threshold_gb
                    ),
                    now_ms(),
                )
                .await?;
        }
        let mut details = vec![format!(
            "账期 {month}，{}池已用 {used_gb:.2} GB",
            pool.label()
        )];
        let mut status = "notify_only";
        if account.action() == OverLimitAction::StopAndNotify {
            status = "pending";
            self.db
                .set_threshold_stop_status(account.id, status)
                .await?;
            // 每轮核实真实状态，Starting/查询失败都留在 pending，下一轮继续处理。
            if let Some(id) = account.instance_id_opt() {
                let client = AliyunClient::from_account(account, self.account_secret(account)?);
                match client.describe_instance(&account.region_id, id).await {
                    Ok(Some(instance)) if instance.is_stopped() => {
                        status = "confirmed";
                        details.push("已确认实例停止".into());
                    }
                    Ok(Some(instance)) if instance.is_running() => {
                        match client
                            .stop_instance(id, &account.region_id, account.stop_mode())
                            .await
                        {
                            Ok(()) => {
                                details.push("停机指令已提交，等待确认；后续巡检将继续核实".into());
                                self.db
                                    .add_log(
                                        Some(account.id),
                                        "threshold_stop",
                                        Some(id),
                                        "熔断停机指令已提交，等待确认",
                                        now_ms(),
                                    )
                                    .await?;
                            }
                            Err(err) => {
                                details.push(format!("停机失败，将重试：{}", err.short()));
                                self.db
                                    .add_log(
                                        Some(account.id),
                                        "threshold_stop_failed",
                                        Some(id),
                                        &err.short(),
                                        now_ms(),
                                    )
                                    .await?;
                            }
                        }
                    }
                    Ok(_) => details.push("实例状态尚未确认，后续巡检将重试".into()),
                    Err(err) => details.push(format!("实例查询失败，将重试：{}", err.short())),
                }
            }
            self.db
                .set_threshold_stop_status(account.id, status)
                .await?;
        } else {
            details.push("仅通知策略，未执行停机".into());
        }
        if !snapshot
            .as_ref()
            .is_some_and(|s| s.threshold_notified_month.as_deref() == Some(month))
        {
            let body = match status {
                "confirmed" => "流量已超限，已确认实例停止",
                "pending" => "流量已超限，停机尚未确认，系统将继续重试",
                _ => "流量已超限，当前策略为仅通知",
            };
            let outcome = self
                .notify(
                    Message::alert(format!("{} 流量达到阈值", account.name), body)
                        .with_details(details)
                        .with_group(format!("CDT-{}", account.id)),
                )
                .await;
            if outcome.any_success() {
                self.db.mark_threshold_notified(account.id, month).await?;
            }
        }
        Ok(first)
    }

    /// 当月是否处于「熔断闸门」关闭状态（禁止任何自动/手动开机）。
    pub async fn threshold_blocked(&self, account: &AccountRow) -> worker::Result<bool> {
        if account.action() != OverLimitAction::StopAndNotify {
            return Ok(false);
        }
        let billing_month = crate::models::billing_month(self.now, &self.timezone);
        Ok(self
            .db
            .get_snapshot(account.id)
            .await?
            .map(|snapshot| snapshot.threshold_triggered(&billing_month))
            .unwrap_or(false))
    }
}
