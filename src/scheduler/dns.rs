//! DDNS 只跟随本轮核实的实例终态；失败留待后续巡检，不阻断启停。
use super::*;
use crate::dns::{CloudflareDns, DdnsConfig, DnsAlert, DnsSettings, DnsState};

pub(super) struct PendingAlert {
    account_id: i64,
    incident_id: String,
    message: Message,
}

impl Scheduler {
    pub(super) async fn dns_reconcile(&self, account: &AccountRow, instance: &InstanceInfo) {
        if !account.is_enabled()
            || !DnsSettings::from_account(account).enabled
            || !(instance.is_running() || instance.is_stopped())
        {
            return;
        }
        if let Err(err) = self.dns_reconcile_inner(account.id, instance).await {
            log_error!("账号 {} DDNS 同步未完成，后续巡检重试：{}", account.id, err);
        }
    }

    /// 自动化已更新快照的过渡态不能拿来添加或删除解析。
    pub(super) async fn dns_reconcile_snapshot(&self, account: &AccountRow) {
        if !account.is_enabled() || !DnsSettings::from_account(account).enabled {
            return;
        }
        if let Ok(instances) = self.db.snapshot_instances(account.id).await
            && let Some(instance) = instances.first()
        {
            self.dns_reconcile(account, instance).await;
        }
    }

    async fn dns_reconcile_inner(&self, id: i64, instance: &InstanceInfo) -> worker::Result<()> {
        let Some(account) = self.db.get_account(id).await? else {
            return Ok(());
        };
        let mut config = DnsSettings::from_account(&account);
        if !config.enabled {
            return Ok(());
        }
        let target = self.db.get_ddns_config().await?;
        let before = config.state.clone();
        let result =
            crate::runtime::timeout(7_000, self.dns_sync(id, &mut config, &target, instance))
                .await
                .unwrap_or_else(|_| Err("Cloudflare DNS 同步超时，稍后重试".into()));
        self.dns_result(
            &account,
            &target,
            &mut config,
            before,
            result,
            instance.is_running(),
        )
        .await
    }

    async fn dns_sync(
        &self,
        id: i64,
        config: &mut DnsSettings,
        target: &DdnsConfig,
        instance: &InstanceInfo,
    ) -> Result<(), String> {
        if !target.configured() {
            return Err("请先在控制台设置的 DDNS 中配置域名和凭据".into());
        }
        let token = self.dns_token(target)?;
        if config.state.zone_id != target.zone_id || config.state.name != target.name {
            // 只清理有明确 Zone 和域名归属的已发布或待核实地址。
            // 实例当前的 IP 可能是刚分配的，不能用它推断旧域名下的记录归属。
            if !config.state.zone_id.is_empty() && !config.state.name.is_empty() {
                let previous = DdnsConfig {
                    zone_id: config.state.zone_id.clone(),
                    name: config.state.name.clone(),
                    token_enc: None,
                };
                self.dns_delete_ips(id, &previous, &token, &mut config.state, None, None)
                    .await
                    .map_err(|err| {
                        let hint = if previous.zone_id != target.zone_id {
                            "。切换期间，API Token 需同时拥有新旧 Zone 的 DNS 编辑权限"
                        } else {
                            ""
                        };
                        format!(
                            "旧解析 {} 清理失败（{err}），新解析将在清理后同步{hint}",
                            previous.name
                        )
                    })?;
            }
            config.state = DnsState {
                zone_id: target.zone_id.clone(),
                name: target.name.clone(),
                ..Default::default()
            };
        }
        let ip = instance
            .public_ip
            .as_deref()
            .filter(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok());
        // 先清理历史归属；运行中的当前地址由下面的发布步骤核实。
        let keep_ip = ip.filter(|_| instance.is_running());
        self.dns_delete_ips(id, target, &token, &mut config.state, ip, keep_ip)
            .await?;
        if instance.is_stopped() {
            return Ok(());
        }
        let Some(ip) = ip else {
            // IP 已释放时不能让旧地址继续接流量；等公网 IPv4 可用后再登记。
            return Err("实例尚无公网 IPv4，待分配后自动同步".into());
        };
        let client = CloudflareDns {
            settings: target,
            token: &token,
        };
        // 每轮核实真实记录，缓存 ID 只记录归属，不能证明记录仍然存在。
        let record_id = match client.find(ip).await? {
            Some(record) if record.needs_update => client.publish(Some(&record.id), ip).await?,
            Some(record) => record.id,
            None => {
                config.state.pending_ip = Some(ip.into());
                self.db
                    .save_dns(id, config)
                    .await
                    .map_err(|_| "DDNS 同步状态保存失败")?;
                client.publish(None, ip).await?
            }
        };
        config.state.record_id = Some(record_id);
        config.state.published_ip = Some(ip.into());
        config.state.pending_ip = None;
        Ok(())
    }

    async fn dns_delete_ips(
        &self,
        id: i64,
        target: &DdnsConfig,
        token: &str,
        state: &mut DnsState,
        current_ip: Option<&str>,
        keep_ip: Option<&str>,
    ) -> Result<(), String> {
        let client = CloudflareDns {
            settings: target,
            token,
        };
        let mut ips = [
            state.published_ip.clone(),
            state.pending_ip.clone(),
            current_ip.map(str::to_owned),
        ];
        ips.sort();
        let mut previous = None;
        for ip in ips.iter().flatten().map(String::as_str) {
            if Some(ip) == keep_ip || Some(ip) == previous {
                continue;
            }
            previous = Some(ip);
            let published = state.published_ip.as_deref() == Some(ip);
            // 地址已脱离本机时，新记录 ID 可能属于接手这个 IP 的节点。
            let expected_id = state
                .record_id
                .as_deref()
                .filter(|_| published && current_ip != Some(ip));
            if let Some(record) = client.find(ip).await?
                && expected_id.is_none_or(|id| id == record.id)
                && !self
                    .db
                    .dns_ip_in_use(id, target, ip)
                    .await
                    .map_err(|_| "无法核实其他节点的 IP 归属，稍后重试")?
            {
                client.delete(&record.id).await?;
            }
            if published {
                state.published_ip = None;
                state.record_id = None;
            }
            if state.pending_ip.as_deref() == Some(ip) {
                state.pending_ip = None;
            }
        }
        Ok(())
    }

    fn dns_token(&self, config: &DdnsConfig) -> Result<String, String> {
        self.crypto
            .decrypt(
                config
                    .token_enc
                    .as_deref()
                    .ok_or("未配置 Cloudflare API Token")?,
            )
            .map_err(|_| "Cloudflare API Token 解密失败，请重新保存凭据".into())
    }

    async fn dns_result(
        &self,
        account: &AccountRow,
        target: &DdnsConfig,
        config: &mut DnsSettings,
        before: DnsState,
        result: Result<(), String>,
        running: bool,
    ) -> worker::Result<()> {
        let error = result.err();
        let action = if running {
            "登记 A 记录"
        } else {
            "删除 A 记录"
        };
        config.state.last_error = error.clone();
        if error.is_none() {
            config.state.alert = None;
        } else if config
            .state
            .alert
            .as_ref()
            .is_none_or(|alert| alert.running != running)
        {
            config.state.alert = Some(DnsAlert {
                id: random_hex(16)?,
                running,
            });
        }
        if config.state != before {
            self.db.save_dns(account.id, config).await?;
        }
        if let Some(error) = error {
            if before.last_error.as_ref() != Some(&error) {
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
            if let Some(alert) = &config.state.alert {
                self.dns_alerts.borrow_mut().push(PendingAlert {
                    account_id: account.id,
                    incident_id: alert.id.clone(),
                    message: Message::alert(
                        format!("{} DDNS 同步失败", account.name),
                        format!("{}：{action}失败：{error}。后续巡检将重试。", target.name),
                    )
                    .with_group("CDT-DNS"),
                });
            }
        } else if before != config.state {
            self.db
                .add_log(
                    Some(account.id),
                    "dns_synced",
                    account.instance_id_opt(),
                    &format!("{}：{action}完成", target.name),
                    now_ms(),
                )
                .await?;
        }
        Ok(())
    }

    /// 同步和控制操作结束后发送；持续失败只告警一次，恢复后重新计数。
    pub(super) async fn flush_dns_alerts(&self) {
        let alerts = std::mem::take(&mut *self.dns_alerts.borrow_mut());
        for pending in alerts {
            let id = pending.account_id;
            if let Err(err) = self.send_dns_alert(pending).await {
                log_warn!("账号 {id} DDNS 告警待重试：{err}");
            }
        }
    }

    async fn send_dns_alert(&self, pending: PendingAlert) -> worker::Result<()> {
        let id = pending.account_id;
        let key = format!("dns-alert:{id}");
        let owner = random_hex(8)?;
        if !self
            .db
            .claim_dns_alert(id, &pending.incident_id, &key, &owner, now_ms())
            .await?
        {
            return Ok(());
        }
        // 两个渠道并行，各自先完成或超时，慢渠道不会吞掉另一渠道的成功回执。
        let budget = u64::from(crate::notify::REQUEST_TIMEOUT_MS) + 2_000;
        let outcome = crate::runtime::timeout(budget, self.notify(pending.message)).await;
        let receipt = match outcome {
            Ok(outcome) if outcome.any_success() => {
                self.db
                    .mark_dns_alert_delivered(id, &pending.incident_id, &key, now_ms())
                    .await
            }
            _ => Ok(()),
        };
        self.db.release_lock(&key, &owner).await?;
        receipt
    }
}
