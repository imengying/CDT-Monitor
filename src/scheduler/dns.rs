//! DNS 联动复用账号操作租约和现有巡检；DNS 失败不能阻断实例控制。
use super::*;
use crate::dns::{CloudflareDns, DnsSettings, TICK_MS, drain_due, next_stop, schedule_key};

impl Scheduler {
    /// 复用正常巡检。仅处理本轮已核实的实例，不能依据旧快照恢复。
    pub(super) async fn dns_reconcile(
        &self,
        account: &AccountRow,
        instance: &InstanceInfo,
        blocked: bool,
    ) {
        let config = DnsSettings::from_account(account);
        if !account.is_enabled() || !config.enabled {
            return;
        }
        // 正常稳定状态直接使用本轮已有账号数据，不额外读取或写入 D1。
        if instance.is_running()
            && !blocked
            && !config.state.paused
            && !config.state.seen_stopped
            && config.state.drain_at.is_none()
            && config.state.schedule_key == schedule_key(account, &self.timezone)
            && config.state.record_id.is_some()
            && config.state.published_ip == instance.public_ip
            && config.state.last_error.is_none()
            && next_stop(account, &self.timezone, self.now)
                .is_none_or(|stop| !drain_due(stop, config.lead_minutes, self.now))
        {
            return;
        }
        if instance.is_stopped()
            && config.state.seen_stopped
            && config.state.drain_at.is_none()
            && !config.state.paused
            && config.state.attempt_slot.is_none()
        {
            return;
        }
        let result = crate::runtime::timeout(
            7_000,
            self.dns_reconcile_inner(account.id, instance, blocked),
        )
        .await;
        if !matches!(result, Ok(Ok(()))) {
            log_error!("账号 {} DNS 同步未完成，后续巡检处理", account.id);
        }
    }
    async fn dns_reconcile_inner(
        &self,
        id: i64,
        instance: &InstanceInfo,
        blocked: bool,
    ) -> worker::Result<()> {
        // 同一轮熔断可能已经改变 DNS 状态，必须读取最新值。
        let Some(account) = self.db.get_account(id).await? else {
            return Ok(());
        };
        let mut config = DnsSettings::from_account(&account);
        if !config.enabled {
            return Ok(());
        }
        let before = config.state.clone();
        if instance.is_stopped() {
            config.state.seen_stopped = true;
            config.state.drain_at = None;
            config.state.paused = false;
            config.state.attempt_slot = None;
        } else if instance.is_running() {
            let key = schedule_key(&account, &self.timezone);
            if config.state.schedule_key != key
                || config.state.seen_stopped
                || config.state.drain_at.is_some_and(|stop| {
                    account
                        .last_schedule_start_at
                        .is_some_and(|start| start > stop)
                })
            {
                config.state.drain_at = None;
                config.state.attempt_slot = None;
                config.state.alerted_event = None;
            }
            config.state.schedule_key = key;
            if config.state.seen_stopped {
                config.state.paused = false;
                config.state.seen_stopped = false;
            }
            if config.state.drain_at.is_none()
                && let Some(stop) = next_stop(&account, &self.timezone, self.now)
                && drain_due(stop, config.lead_minutes, self.now)
            {
                config.state.drain_at = Some(stop);
                config.state.attempt_slot = None;
            }
            if config.state != before {
                self.db.save_dns(id, &config).await?;
            }
            if let Some(stop) = config.state.drain_at {
                if !blocked && !config.state.paused {
                    self.dns_withdraw_inner(&account, instance, &format!("schedule:{stop}"), true)
                        .await?;
                }
                return Ok(());
            }
            if blocked || config.state.paused {
                return Ok(());
            }
            let Some(ip) = instance
                .public_ip
                .as_deref()
                .filter(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok())
            else {
                return Ok(());
            };
            if config.state.record_id.is_some()
                && config.state.published_ip.as_deref() == Some(ip)
                && config.state.last_error.is_none()
            {
                return Ok(());
            }
            let result = self.dns_publish(id, &mut config, ip).await;
            self.dns_result(&account, &mut config, result, "publish", "登记 A 记录")
                .await?;
            return Ok(());
        }
        if config.state != before {
            self.db.save_dns(id, &config).await?;
        }
        Ok(())
    }

    async fn dns_publish(
        &self,
        account_id: i64,
        config: &mut DnsSettings,
        ip: &str,
    ) -> Result<(), String> {
        let token = self.dns_token(config)?;
        // 已知 ID 直接更新；创建结果未知时只按上次待登记 IP 查找，不扫描其他节点。
        if config.state.record_id.is_none() {
            let client = CloudflareDns {
                settings: config,
                token: &token,
            };
            if let Some(previous) = config
                .state
                .pending_ip
                .as_deref()
                .or(config.state.published_ip.as_deref())
            {
                config.state.record_id = client.find(previous).await?;
            }
            if config.state.record_id.is_none()
                && config
                    .state
                    .pending_ip
                    .as_deref()
                    .or(config.state.published_ip.as_deref())
                    != Some(ip)
            {
                config.state.record_id = CloudflareDns {
                    settings: config,
                    token: &token,
                }
                .find(ip)
                .await?;
            }
        }
        if config.state.record_id.is_none() {
            config.state.pending_ip = Some(ip.into());
            self.db
                .save_dns(account_id, config)
                .await
                .map_err(|_| "DNS 创建前保存状态失败")?;
        }
        let id = config.state.record_id.clone();
        let result = CloudflareDns {
            settings: config,
            token: &token,
        }
        .publish(id.as_deref(), ip)
        .await;
        match result {
            Ok(id) => {
                config.state.record_id = Some(id);
                config.state.published_ip = Some(ip.into());
                config.state.pending_ip = None;
                Ok(())
            }
            Err(error) => {
                if error.contains("HTTP 404") || error.contains("错误码 81044") {
                    config.state.record_id = None;
                }
                Err(error)
            }
        }
    }
    fn dns_token(&self, config: &DnsSettings) -> Result<String, String> {
        self.crypto
            .decrypt(
                config
                    .token_enc
                    .as_deref()
                    .ok_or("未配置 Cloudflare API Token")?,
            )
            .map_err(|_| "Cloudflare API Token 解密失败，请重新保存凭据".into())
    }

    /// 手动/熔断只执行一次；定时关机按五分钟批次重试，不触发整条账号消息重投。
    pub(super) async fn dns_before_stop(
        &self,
        account: &AccountRow,
        instance: &InstanceInfo,
        event: &str,
        scheduled: bool,
    ) {
        let config = DnsSettings::from_account(account);
        if !config.enabled || (!scheduled && config.state.once_event.as_deref() == Some(event)) {
            return;
        }
        let result = crate::runtime::timeout(
            7_000,
            self.dns_withdraw_inner(account, instance, event, scheduled),
        )
        .await;
        if !matches!(result, Ok(Ok(()))) {
            log_error!("账号 {} DNS 摘除未完成，继续执行关机", account.id);
        }
    }
    async fn dns_withdraw_inner(
        &self,
        account: &AccountRow,
        instance: &InstanceInfo,
        event: &str,
        scheduled: bool,
    ) -> worker::Result<()> {
        if instance.is_stopped() {
            return Ok(());
        }
        let Some(current) = self.db.get_account(account.id).await? else {
            return Ok(());
        };
        let mut config = DnsSettings::from_account(&current);
        if !config.enabled {
            return Ok(());
        }
        if scheduled {
            // 先前成功摘除后，published_ip 保留用于下一次启动时核对旧记录。
            if config.state.attempt_slot.is_some()
                && config.state.record_id.is_none()
                && config.state.last_error.is_none()
            {
                return Ok(());
            }
            let slot = self.now.div_euclid(TICK_MS);
            if config.state.attempt_slot == Some(slot) {
                return Ok(());
            }
            config.state.attempt_slot = Some(slot);
            if config.state.drain_at.is_none() {
                config.state.drain_at = Some(self.now);
            }
            config.state.schedule_key = schedule_key(&current, &self.timezone);
        } else {
            if config.state.once_event.as_deref() == Some(event) {
                return Ok(());
            }
            config.state.once_event = Some(event.into());
            config.state.paused = true;
            config.state.seen_stopped = false;
        }
        // 在外部请求之前保存一次性标记，队列中断/熔断重试也不会重复摘除。
        self.db.save_dns(account.id, &config).await?;
        let result = self
            .dns_delete(&mut config, instance.public_ip.as_deref())
            .await;
        let event = if scheduled {
            format!("schedule:{}", config.state.drain_at.unwrap_or(self.now))
        } else {
            event.to_owned()
        };
        self.dns_result(account, &mut config, result, &event, "摘除 A 记录")
            .await
    }
    async fn dns_delete(
        &self,
        config: &mut DnsSettings,
        current_ip: Option<&str>,
    ) -> Result<(), String> {
        let token = self.dns_token(config)?;
        if config.state.record_id.is_none() {
            let ip = config
                .state
                .pending_ip
                .as_deref()
                .or(config.state.published_ip.as_deref())
                .or(current_ip);
            if let Some(ip) = ip {
                config.state.record_id = CloudflareDns {
                    settings: config,
                    token: &token,
                }
                .find(ip)
                .await?;
            } else {
                return Err("尚未取得可用于定位 A 记录的公网 IP".into());
            }
        }
        if let Some(id) = config.state.record_id.as_deref() {
            CloudflareDns {
                settings: config,
                token: &token,
            }
            .delete(id)
            .await?;
        }
        config.state.record_id = None;
        config.state.pending_ip = None;
        Ok(())
    }
    async fn dns_result(
        &self,
        account: &AccountRow,
        config: &mut DnsSettings,
        result: Result<(), String>,
        event: &str,
        action: &str,
    ) -> worker::Result<()> {
        let error = result.err();
        let changed = error != config.state.last_error;
        config.state.last_error = error.clone();
        if error.is_none() && event == "publish" {
            config.state.alerted_event = None;
        }
        let alert = error.is_some() && config.state.alerted_event.as_deref() != Some(event);
        // 每次停机事件最多尝试发送一次失败告警；不新增通知重试任务。
        if alert {
            config.state.alerted_event = Some(event.into());
        }
        self.db.save_dns(account.id, config).await?;
        if let Some(error) = error {
            if changed {
                self.db
                    .add_log(
                        Some(account.id),
                        "dns_failed",
                        account.instance_id_opt(),
                        &format!("{action}失败：{error}"),
                        now_ms(),
                    )
                    .await?;
            }
            if alert {
                self.notify(
                    Message::alert(
                        format!("{} DNS 联动失败", account.name),
                        format!(
                            "{}：{action}失败：{error}。DNS 失败不阻断关机。",
                            config.name
                        ),
                    )
                    .with_group("CDT-DNS"),
                )
                .await;
            }
        } else {
            self.db
                .add_log(
                    Some(account.id),
                    "dns_synced",
                    account.instance_id_opt(),
                    &format!("{}：{action}完成", config.name),
                    now_ms(),
                )
                .await?;
        }
        Ok(())
    }
    /// 显式开机允许撤销失败手动停机留下的暂停状态；实际添加仍等待 Running。
    pub(super) async fn dns_resume(&self, account: &AccountRow) {
        if !DnsSettings::from_account(account).enabled {
            return;
        }
        if let Ok(Some(current)) = self.db.get_account(account.id).await {
            let mut config = DnsSettings::from_account(&current);
            if config.state.paused {
                config.state.paused = false;
                if config
                    .state
                    .once_event
                    .as_deref()
                    .is_some_and(|event| event.starts_with("manual:"))
                {
                    config.state.once_event = None;
                }
                let _ = self.db.save_dns(account.id, &config).await;
            }
        }
    }
    pub(super) async fn dns_release_threshold(&self, account: &AccountRow) {
        if !DnsSettings::from_account(account).enabled {
            return;
        }
        if let Ok(Some(current)) = self.db.get_account(account.id).await {
            let mut config = DnsSettings::from_account(&current);
            if config
                .state
                .once_event
                .as_deref()
                .is_some_and(|event| event.starts_with("threshold:"))
            {
                config.state.once_event = None;
                config.state.paused = false;
                let _ = self.db.save_dns(account.id, &config).await;
            }
        }
    }
}
