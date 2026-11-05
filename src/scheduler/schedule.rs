//! 定时开关机与抢占式保活。
use super::*;

impl Scheduler {
    // -----------------------------------------------------------------------
    // 定时开关机
    // -----------------------------------------------------------------------

    /// 判断「定时关机」这次该不该执行。
    ///
    /// 返回 `(去重键, 时间描述)`；`None` 表示本轮不执行。
    fn stop_due(&self, account: &AccountRow) -> Option<(String, String)> {
        if account.schedule_is_advanced() {
            let expr = account.stop_cron()?;
            let window_ms = SCHEDULE_WINDOW_MINUTES as i64 * 60 * 1000;
            let occurred =
                crate::cron::last_occurrence_within(expr, &self.timezone, self.now, window_ms)?;
            // 这次触发已经执行过（或执行时间更晚）就跳过
            if account
                .last_schedule_stop_at
                .is_some_and(|prev| prev >= occurred)
            {
                return None;
            }
            Some((format!("cron:{occurred}"), crate::cron::describe(expr)))
        } else {
            let target = account.schedule_stop_minutes()?;
            let now_minutes = local_minutes_of_day(self.now, &self.timezone);
            if !within_window(now_minutes, target, SCHEDULE_WINDOW_MINUTES) {
                return None;
            }
            let today = local_date(self.now, &self.timezone);
            if account.last_schedule_stop_date.as_deref() == Some(today.as_str()) {
                return None;
            }
            Some((format!("daily:{today}"), today))
        }
    }

    /// 判断「定时开机」这次该不该执行，语义同 [`Self::stop_due`]。
    fn start_due(&self, account: &AccountRow) -> Option<(String, String)> {
        if account.schedule_is_advanced() {
            let expr = account.start_cron()?;
            let window_ms = SCHEDULE_WINDOW_MINUTES as i64 * 60 * 1000;
            let occurred =
                crate::cron::last_occurrence_within(expr, &self.timezone, self.now, window_ms)?;
            if account
                .last_schedule_start_at
                .is_some_and(|prev| prev >= occurred)
            {
                return None;
            }
            Some((format!("cron:{occurred}"), crate::cron::describe(expr)))
        } else {
            let target = account.schedule_start_minutes()?;
            let now_minutes = local_minutes_of_day(self.now, &self.timezone);
            if !within_window(now_minutes, target, SCHEDULE_WINDOW_MINUTES) {
                return None;
            }
            let today = local_date(self.now, &self.timezone);
            if account.last_schedule_start_date.as_deref() == Some(today.as_str()) {
                return None;
            }
            Some((format!("daily:{today}"), today))
        }
    }

    /// 定时关机：命中窗口且这次触发尚未执行过。
    ///
    /// 两种模式共用「命中 → 加锁 → 执行 → 记录」流程，只是判定不同：
    /// * `simple`：每日 HH:MM，按本地日期去重；
    /// * `advanced`：五字段 Cron，按「上次执行的触发时刻」去重，
    ///   所以 `*/5` 这类高频表达式也能逐次生效。
    pub(super) async fn maybe_scheduled_stop(
        &self,
        account: &AccountRow,
        report: &mut CronReport,
    ) -> worker::Result<()> {
        let Some((dedupe_key, label)) = self.stop_due(account) else {
            return Ok(());
        };
        let today = local_date(self.now, &self.timezone);

        let lock_name = format!("schedule-stop:{}:{dedupe_key}", account.id);
        let owner = random_hex(8).map_err(|e| worker::Error::RustError(e.to_string()))?;
        if !self
            .db
            .acquire_lock(&lock_name, &owner, now_ms(), 60_000)
            .await?
        {
            report.retry_needed = true;
            return Ok(());
        }

        let instances = self.db.snapshot_instances(account.id).await?;
        let unresolved = instances.is_empty()
            || instances
                .iter()
                .any(|instance| !instance.is_running() && !instance.is_stopped());
        let running: Vec<InstanceInfo> = instances
            .into_iter()
            .filter(|instance| instance.is_running())
            .collect();

        let mut ok_count = 0usize;
        if !running.is_empty() {
            let secret = self.account_secret(account)?;
            let client = AliyunClient::from_account(account, secret);
            for instance in &running {
                match client
                    .stop_instance(
                        &instance.instance_id,
                        &instance.region_id,
                        account.stop_mode(),
                    )
                    .await
                {
                    Ok(()) => {
                        ok_count += 1;
                        report.instances_stopped += 1;
                        self.db
                            .add_log(
                                Some(account.id),
                                "schedule_stop",
                                Some(&instance.instance_id),
                                &format!("定时关机 {label}"),
                                now_ms(),
                            )
                            .await?;
                    }
                    Err(err) => {
                        report.notes.push(format!(
                            "{} 定时关机失败（{}）：{}",
                            account.name,
                            instance.instance_id,
                            err.short()
                        ));
                        self.db
                            .add_log(
                                Some(account.id),
                                "schedule_stop_failed",
                                Some(&instance.instance_id),
                                &err.short(),
                                now_ms(),
                            )
                            .await?;
                    }
                }
            }
        }

        // 过渡态、未知或缺少实例都不能证明关机目标已完成。
        if !unresolved && ok_count == running.len() {
            self.db
                .mark_schedule_done(account.id, false, &today, now_ms())
                .await?;
        } else {
            report.retry_needed = true;
        }
        let _ = self.db.release_lock(&lock_name, &owner).await;

        report.notes.push(format!(
            "{} 定时关机：成功 {} / 待处理 {}（{}）",
            account.name,
            ok_count,
            running.len().saturating_sub(ok_count),
            today
        ));
        Ok(())
    }

    /// 定时开机：命中窗口、当天未执行过、且未被熔断闸门拦住。
    pub(super) async fn maybe_scheduled_start(
        &self,
        account: &AccountRow,
        report: &mut CronReport,
    ) -> worker::Result<()> {
        let Some((dedupe_key, label)) = self.start_due(account) else {
            return Ok(());
        };
        let today = local_date(self.now, &self.timezone);
        if account.schedule_is_advanced() && !automation_allowed(account, self.now, &self.timezone)
        {
            return Ok(());
        }

        // 优先级：熔断闸门高于定时开机
        if self.threshold_blocked(account).await? {
            // 标记当日已完成：本月不会再尝试拉起，无需在窗口内反复判定。
            self.db
                .mark_schedule_done(account.id, true, &today, now_ms())
                .await?;
            report.notes.push(format!(
                "{} 定时开机被跳过：本月已触发流量熔断",
                account.name
            ));
            self.db
                .add_log(
                    Some(account.id),
                    "schedule_start_blocked",
                    None,
                    "本月已触发流量熔断，定时开机被禁止",
                    now_ms(),
                )
                .await?;
            return Ok(());
        }

        let lock_name = format!("schedule-start:{}:{dedupe_key}", account.id);
        let owner = random_hex(8).map_err(|e| worker::Error::RustError(e.to_string()))?;
        if !self
            .db
            .acquire_lock(&lock_name, &owner, now_ms(), 60_000)
            .await?
        {
            report.retry_needed = true;
            return Ok(());
        }

        let instances = self.db.snapshot_instances(account.id).await?;
        let unresolved = instances.is_empty()
            || instances
                .iter()
                .any(|instance| !instance.is_running() && !instance.is_stopped());
        let stopped: Vec<InstanceInfo> = instances
            .into_iter()
            .filter(|instance| instance.is_stopped())
            .collect();

        let mut ok_count = 0usize;
        if !stopped.is_empty() {
            let secret = self.account_secret(account)?;
            let client = AliyunClient::from_account(account, secret);
            for instance in &stopped {
                match client
                    .start_instance(&instance.instance_id, &instance.region_id)
                    .await
                {
                    Ok(()) => {
                        ok_count += 1;
                        report.instances_started += 1;
                        self.db
                            .add_log(
                                Some(account.id),
                                "schedule_start",
                                Some(&instance.instance_id),
                                &format!("定时开机 {label}"),
                                now_ms(),
                            )
                            .await?;
                    }
                    Err(err) => {
                        report.notes.push(format!(
                            "{} 定时开机失败（{}）：{}",
                            account.name,
                            instance.instance_id,
                            err.short()
                        ));
                        self.db
                            .add_log(
                                Some(account.id),
                                "schedule_start_failed",
                                Some(&instance.instance_id),
                                &err.short(),
                                now_ms(),
                            )
                            .await?;
                    }
                }
            }
        }

        if !unresolved && ok_count == stopped.len() {
            self.db
                .mark_schedule_done(account.id, true, &today, now_ms())
                .await?;
        } else {
            report.retry_needed = true;
        }
        let _ = self.db.release_lock(&lock_name, &owner).await;

        report.notes.push(format!(
            "{} 定时开机：成功 {} / 待处理 {}（{}）",
            account.name,
            ok_count,
            stopped.len().saturating_sub(ok_count),
            today
        ));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 抢占式保活
    // -----------------------------------------------------------------------

    /// 今天是否已经执行过定时关机。
    ///
    /// 必须重新读库：`run_account_cron` 手里那份 `AccountRow` 是本轮开始时的快照，
    /// 而定时关机就在同一轮里把它写进了 `last_schedule_stop_date`。
    ///
    /// 注意这里用「刚刚」而不是「今天」：定时关机后只在
    /// [`KEEP_ALIVE_STOP_GRACE_MINUTES`] 内让路，之后照常保活。
    async fn scheduled_stop_just_happened(&self, account: &AccountRow) -> worker::Result<bool> {
        if account.schedule_stop_minutes().is_none() && account.stop_cron().is_none() {
            return Ok(false);
        }
        let fresh = self.db.get_account(account.id).await?;
        let Some(stop_at) = fresh.and_then(|row| row.last_schedule_stop_at) else {
            return Ok(false);
        };
        // 时间戳来自未来（时钟回拨 / 时区变动）时不能当成「刚关机」，
        // 否则保活会被永久卡住。
        let elapsed = now_ms().saturating_sub(stop_at).max(0);
        Ok(elapsed < KEEP_ALIVE_STOP_GRACE_MINUTES * 60 * 1000)
    }

    /// 抢占式实例保活：拉起处于 Stopped 的可保活抢占式实例。
    ///
    /// 阿里云不提供区分「系统回收」与「用户手动停机」的字段（两者都是
    /// `Status == Stopped`），`OperationLocks` 只在回收前 5 分钟标记，
    /// 比巡检间隔还短、抓不住。因此只能靠**前置条件**收窄误判，
    /// 与上游保持一致的四个闸门（任一不满足就跳过）：
    ///
    /// 1. 账号级与实例级保活开关都开启；
    /// 2. 当前处于「允许运行时段」（见 [`in_allowed_window`]）；
    /// 3. 未触发流量熔断；
    /// 4. 今天还没执行过定时关机（定时关机优先于保活）。
    ///
    /// 剩下的情形（暂停窗口外手动停机）仍会被拉起，这是接口能力的边界：
    /// 手动停机前请先关掉该实例或账号的保活开关。
    pub(super) async fn maybe_keep_alive(
        &self,
        account: &AccountRow,
        snapshot: Option<&SnapshotRow>,
        report: &mut CronReport,
    ) -> worker::Result<()> {
        if !account.is_spot_keep_alive() {
            return Ok(());
        }
        let Some(snapshot) = snapshot else {
            return Ok(());
        };

        let candidates: Vec<InstanceInfo> = snapshot
            .instances()
            .into_iter()
            .filter(|instance| instance.keep_alive_active(true) && instance.is_stopped())
            .collect();
        if candidates.is_empty() {
            return Ok(());
        }

        // 只在「允许运行时段」内保活。注意不能只判断「是否处于停机窗口」：
        // 只配了关机时刻时那种判断会返回 false，保活会在停机后立刻
        // 把实例拉回来，定时关机形同虚设。
        if !automation_allowed(account, self.now, &self.timezone) {
            report.notes.push(format!(
                "{} 当前不在允许运行时段，跳过抢占式保活",
                account.name
            ));
            return Ok(());
        }

        // 本轮刚被定时关机的不保活。快照里的状态是刷新时抓的，
        // 定时关机发生在其后，若不拦住会在同一轮里把自己刚停的机器拉起来
        // （上游用 statusChangedBySchedule 表达同一件事）。
        if self.scheduled_stop_just_happened(account).await? {
            report.notes.push(format!(
                "{} 刚执行过定时关机，本轮跳过抢占式保活",
                account.name
            ));
            return Ok(());
        }

        // 熔断闸门
        if self.threshold_blocked(account).await? {
            report
                .notes
                .push(format!("{} 已触发流量熔断，跳过抢占式保活", account.name));
            return Ok(());
        }

        let secret = self.account_secret(account)?;
        let client = AliyunClient::from_account(account, secret);

        for instance in &candidates {
            let lock_name = format!("keepalive:{}:{}", account.id, instance.instance_id);
            let owner = random_hex(8).map_err(|e| worker::Error::RustError(e.to_string()))?;
            if !self
                .db
                .acquire_lock(
                    &lock_name,
                    &owner,
                    now_ms(),
                    INSTANCE_LOCK_TTL_MINUTES * 60 * 1000,
                )
                .await?
            {
                continue;
            }

            match client
                .start_instance(&instance.instance_id, &instance.region_id)
                .await
            {
                Ok(()) => {
                    report.keep_alive_started += 1;
                    report.notes.push(format!(
                        "{} 抢占式保活拉起 {}",
                        account.name, instance.instance_id
                    ));
                    self.db
                        .add_log(
                            Some(account.id),
                            "spot_keep_alive",
                            Some(&instance.instance_id),
                            "抢占式实例已被释放，自动重新拉起",
                            now_ms(),
                        )
                        .await?;
                }
                Err(err) => {
                    report.retry_needed = true;
                    report.notes.push(format!(
                        "{} 保活失败（{}）：{}",
                        account.name,
                        instance.instance_id,
                        err.short()
                    ));
                    // 下一轮先重新查询真实状态，再决定是否重试；失败不占用成功冷却窗口。
                    let _ = self.db.release_lock(&lock_name, &owner).await;
                    self.db
                        .add_log(
                            Some(account.id),
                            "spot_keep_alive_failed",
                            Some(&instance.instance_id),
                            &err.short(),
                            now_ms(),
                        )
                        .await?;
                }
            }
        }

        Ok(())
    }
}
