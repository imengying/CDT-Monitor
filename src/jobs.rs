//! 可恢复的 D1 任务执行器。批量刷新每段处理一个账号。
use super::*;

/// 参数和批量进度持久化在 D1；每次请求最多执行一段。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) enum JobTask {
    RefreshAll,
    RefreshBatch {
        remaining: Vec<i64>,
        completed: usize,
        failures: Vec<String>,
    },
    RefreshAccount {
        account_id: i64,
    },
    StartInstance {
        account_id: i64,
        instance_id: String,
        #[serde(default)]
        config_version: i64,
    },
    StopInstance {
        account_id: i64,
        instance_id: String,
        #[serde(default)]
        config_version: i64,
    },
    NotifyTest {
        channel: Option<NotifyChannel>,
    },
    DailyReport,
}

impl JobTask {
    pub(crate) fn job_type(&self) -> JobType {
        match self {
            JobTask::RefreshAll | JobTask::RefreshBatch { .. } => JobType::RefreshAll,
            JobTask::RefreshAccount { .. } => JobType::RefreshAccount,
            JobTask::StartInstance { .. } => JobType::StartInstance,
            JobTask::StopInstance { .. } => JobType::StopInstance,
            JobTask::NotifyTest { .. } => JobType::NotifyTest,
            JobTask::DailyReport => JobType::DailyReport,
        }
    }

    pub(crate) fn account_id(&self) -> Option<i64> {
        match self {
            JobTask::RefreshAll
            | JobTask::RefreshBatch { .. }
            | JobTask::NotifyTest { .. }
            | JobTask::DailyReport => None,
            JobTask::RefreshAccount { account_id }
            | JobTask::StartInstance { account_id, .. }
            | JobTask::StopInstance { account_id, .. } => Some(*account_id),
        }
    }

    /// 需要 D1 级互斥锁的任务名（跨实例防止并发重复执行）。
    ///
    /// 刷新任务按范围互斥；同一实例的手动开关机共用一把锁。
    /// 通知测试与手动日报允许用户再次提交。
    pub(crate) fn lock_name(&self) -> Option<String> {
        match self {
            JobTask::RefreshAll | JobTask::RefreshBatch { .. } => {
                Some("job:refresh_all".to_string())
            }
            JobTask::RefreshAccount { account_id } => Some(format!("job:refresh:{account_id}")),
            JobTask::StartInstance {
                account_id,
                instance_id,
                ..
            }
            | JobTask::StopInstance {
                account_id,
                instance_id,
                ..
            } => Some(format!("job:instance:{account_id}:{instance_id}")),
            _ => None,
        }
    }
}

/// 执行一个 Job：置 running → 跑任务 → 置 success/failed → 释放互斥锁。
pub(crate) async fn execute_job(env: Env, job_id: String) -> worker::Result<()> {
    // 包含领取、初始化、外部调用和数据库收尾的总预算。
    crate::runtime::timeout(28_000, async {
        execute_segment(env.clone(), job_id.clone()).await;
        if let Some(row) = Db::new(&env).get_job(&job_id).await? {
            match row.status.as_str() {
                "pending" => crate::tasks::enqueue_job(&env, &job_id).await?,
                "running" => return Err(worker::Error::RustError("任务仍在执行，稍后核实".into())),
                _ => {}
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| worker::Error::RustError(e.into()))?
}

async fn execute_segment(env: Env, job_id: String) {
    let began = now_ms();
    let db = Db::new(&env);
    if !matches!(db.claim_job(&job_id, now_ms()).await, Ok(true)) {
        return;
    }
    let row = match db.get_job(&job_id).await {
        Ok(Some(row)) => row,
        _ => return, // 60 秒后由 recover_jobs 回收
    };
    let task: JobTask = match row
        .payload_json
        .as_deref()
        .and_then(|v| serde_json::from_str(v).ok())
    {
        Some(task) => task,
        None => {
            let _ = db
                .finish_job_failed(&job_id, "任务参数无效，请重新提交", now_ms())
                .await;
            return;
        }
    };
    let lock_name = task.lock_name();
    let scheduler = match Scheduler::new(&env).await {
        Ok(scheduler) => scheduler,
        Err(err) => {
            let text = err.to_string();
            log_error!("任务 {job_id} 初始化失败：{text}");
            let _ = db.finish_job_failed(&job_id, &text, now_ms()).await;
            release_job_lock(&db, lock_name.as_deref(), &job_id).await;
            return;
        }
    };

    let result = crate::runtime::timeout((24_000 - (now_ms() - began)).max(1) as u64, async {
        match task {
            JobTask::RefreshAll => Err(worker::Error::RustError("批量任务尚未初始化".into())),
            JobTask::RefreshBatch {
                mut remaining,
                mut completed,
                mut failures,
            } => {
                if let Some(id) = remaining.pop() {
                    match db.get_account(id).await? {
                        Some(account) => {
                            let outcome = Box::pin(scheduler.refresh_account(&account)).await;
                            if outcome.success {
                                completed += 1;
                            }
                            if !outcome.warnings.is_empty() || !outcome.success {
                                failures.push(format!(
                                    "{}：{}",
                                    account.name,
                                    outcome.warnings.join("；")
                                ));
                            }
                        }
                        None => failures.push(format!("账号 {id} 已删除")),
                    }
                }
                if remaining.is_empty() {
                    let message = format!(
                        "{completed} 个账号刷新成功{}",
                        if failures.is_empty() {
                            String::new()
                        } else {
                            format!("；注意：{}", failures.join("；"))
                        }
                    );
                    if completed == 0 {
                        Err(worker::Error::RustError(message))
                    } else {
                        Ok(Some(message))
                    }
                } else {
                    let next = JobTask::RefreshBatch {
                        remaining,
                        completed,
                        failures,
                    };
                    db.continue_job(
                        &job_id,
                        &serde_json::to_string(&next)
                            .map_err(|e| worker::Error::RustError(e.to_string()))?,
                    )
                    .await?;
                    Ok(None)
                }
            }
            task => {
                let result: worker::Result<String> = match task {
                    JobTask::RefreshAccount { account_id } => {
                        match db.get_account(account_id).await {
                            Ok(Some(account)) => {
                                let outcome = Box::pin(scheduler.refresh_account(&account)).await;
                                if outcome.success {
                                    Ok(format!(
                                        "{} 已刷新：国内 {} / 海外 {}",
                                        outcome.account_name,
                                        crate::models::human_bytes(outcome.domestic_bytes),
                                        crate::models::human_bytes(outcome.overseas_bytes)
                                    ) + &if outcome.warnings.is_empty() {
                                        String::new()
                                    } else {
                                        format!("；注意：{}", outcome.warnings.join("；"))
                                    })
                                } else {
                                    Err(worker::Error::RustError(if outcome.warnings.is_empty() {
                                        "刷新失败".to_string()
                                    } else {
                                        outcome.warnings.join("；")
                                    }))
                                }
                            }
                            Ok(None) => Err(worker::Error::RustError("账号不存在".to_string())),
                            Err(err) => Err(err),
                        }
                    }
                    JobTask::StartInstance {
                        account_id,
                        instance_id,
                        config_version,
                    } => {
                        scheduler
                            .instance_action(account_id, &instance_id, true, config_version)
                            .await
                    }
                    JobTask::StopInstance {
                        account_id,
                        instance_id,
                        config_version,
                    } => {
                        scheduler
                            .instance_action(account_id, &instance_id, false, config_version)
                            .await
                    }
                    JobTask::NotifyTest { channel } => {
                        let outcome = scheduler.test_notification(channel).await;
                        if outcome.results.is_empty() {
                            Err(worker::Error::RustError(
                                "未启用任何通知渠道，请先在设置中配置".to_string(),
                            ))
                        } else if outcome.any_success() {
                            Ok(outcome.summary())
                        } else {
                            Err(worker::Error::RustError(outcome.summary()))
                        }
                    }
                    JobTask::DailyReport => scheduler.push_daily_report().await,
                    JobTask::RefreshAll | JobTask::RefreshBatch { .. } => unreachable!(),
                };
                result.map(Some)
            }
        }
    })
    .await
    .unwrap_or_else(|e| Err(worker::Error::RustError(e.into())));
    match result {
        Ok(None) => return,
        Ok(Some(detail)) => {
            log_info!("任务 {job_id} 完成：{detail}");
            if let Err(err) = db.finish_job_success(&job_id, &detail, now_ms()).await {
                log_error!("任务 {job_id} 收尾失败：{err}");
            }
        }
        Err(err) => {
            let text = err.to_string();
            log_error!("任务 {job_id} 失败：{text}");
            if let Err(inner) = db.finish_job_failed(&job_id, &text, now_ms()).await {
                log_error!("任务 {job_id} 收尾失败：{inner}");
            }
        }
    }

    release_job_lock(&db, lock_name.as_deref(), &job_id).await;
}

/// 释放 Job 互斥锁（owner 不匹配时不会误删）。
async fn release_job_lock(db: &Db, lock_name: Option<&str>, owner: &str) {
    if let Some(name) = lock_name
        && let Err(err) = db.release_lock(name, owner).await
    {
        log_error!("释放任务锁 {name} 失败：{err}");
    }
}

/// 建 Job 行 → 队列派发 → 返回 202。
pub(crate) async fn spawn_job(
    _ctx: &Context,
    app: &AppCtx,
    task: JobTask,
) -> worker::Result<Response> {
    app.db.recover_jobs(now_ms()).await?;
    let mut task = if matches!(task, JobTask::RefreshAll) {
        let remaining: Vec<i64> = app
            .db
            .list_accounts(true)
            .await?
            .into_iter()
            .map(|a| a.id)
            .collect();
        if remaining.is_empty() {
            return error_response(400, "没有启用的账号可刷新");
        }
        JobTask::RefreshBatch {
            remaining,
            completed: 0,
            failures: Vec::new(),
        }
    } else {
        task
    };
    let job_type = task.job_type();
    let account_id = task.account_id();

    // 先确认账号存在：jobs 表对 account_id 有外键，直接插入会得到
    // 「FOREIGN KEY constraint failed」并被翻译成 500，掩盖了真实原因
    // （账号已被删除或 ID 手误）。在这里提前给出 404。
    if let Some(id) = account_id {
        let Some(account) = app.db.get_account(id).await? else {
            return error_response(404, "账号不存在");
        };
        match &mut task {
            JobTask::StartInstance { config_version, .. }
            | JobTask::StopInstance { config_version, .. } => {
                *config_version = account.config_version;
            }
            _ => {}
        }
    }

    let job_id =
        crate::crypto::random_id().map_err(|err| worker::Error::RustError(err.to_string()))?;

    // 跨实例互斥：同一刷新任务在 TTL 内只允许一个执行者。
    // 用 job_id 作为锁 owner，收尾时按 owner 释放，避免误删他人的锁。
    let lock_name = task.lock_name();
    if let Some(name) = lock_name.as_deref() {
        let acquired = app
            .db
            .acquire_lock(name, &job_id, now_ms(), app.job_lock_ttl_ms())
            .await?;
        if !acquired {
            return error_response_with_code(409, "同类任务正在执行中，请稍后再试", "job_locked");
        }
    }

    if let Err(err) = app
        .db
        .create_job(
            &job_id,
            account_id,
            job_type,
            &serde_json::to_string(&task).map_err(|e| worker::Error::RustError(e.to_string()))?,
            now_ms(),
        )
        .await
    {
        release_job_lock(&app.db, lock_name.as_deref(), &job_id).await;
        return Err(err);
    }

    // D1 是任务来源；入队失败时保留 pending，由 Cron 重新派发。
    if let Err(err) = crate::tasks::enqueue_job(&app.env, &job_id).await {
        log_error!("任务 {job_id} 入队失败，将由巡检补发：{err}");
    }

    json_response(
        &AcceptedJob {
            job_id,
            status: JobStatus::Pending,
            job_type,
        },
        202,
        None,
    )
}
