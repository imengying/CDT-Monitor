//! Queues 负责唤醒，D1 负责任务进度和互斥。消息不携带凭据。
use crate::{db::Db, jobs, models::now_ms, scheduler::Scheduler};
use serde::{Deserialize, Serialize};
use worker::{Env, Result};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TaskMessage {
    Job { id: String },
    Cron { account_id: i64, scheduled_at: i64 },
    Refresh { account_id: i64, requested_at: i64 },
    Maintenance,
}

pub async fn enqueue_job(env: &Env, id: &str) -> Result<()> {
    env.queue("TASKS")?
        .send(TaskMessage::Job { id: id.into() })
        .await
}

pub async fn dispatch_cron(env: &Env, scheduled_at: i64) -> Result<()> {
    let db = Db::new(env);
    db.recover_jobs(now_ms()).await?;
    let mut messages: Vec<_> = db
        .list_accounts(true)
        .await?
        .into_iter()
        .map(|account| TaskMessage::Cron {
            account_id: account.id,
            scheduled_at,
        })
        .collect();
    messages.extend(
        db.pending_jobs()
            .await?
            .into_iter()
            .map(|job| TaskMessage::Job { id: job.id }),
    );
    let queue = env.queue("TASKS")?;
    for chunk in messages.chunks(100) {
        queue.send_batch(chunk.to_vec()).await?;
    }
    // 日报读取最近已完成的快照；稍作延迟，让正常采集优先完成。
    queue
        .send(
            worker::MessageBuilder::new(TaskMessage::Maintenance)
                .delay_seconds(30)
                .build(),
        )
        .await
}

pub async fn consume(env: &Env, message: &TaskMessage) -> Result<()> {
    let db = Db::new(env);
    match message {
        TaskMessage::Job { id } => {
            // 被中断的动作转为失败，绝不因队列重投而重放开关机指令。
            db.recover_job(id, now_ms()).await?;
            jobs::execute_job(env.clone(), id.clone()).await
        }
        TaskMessage::Maintenance => Scheduler::new(env).await?.maintenance().await,
        TaskMessage::Cron {
            account_id,
            scheduled_at,
        } => consume_account(env, *account_id, *scheduled_at, true).await,
        TaskMessage::Refresh {
            account_id,
            requested_at,
        } => consume_account(env, *account_id, *requested_at, false).await,
    }
}

/// 全局防抖避免多个页面重复派发同一批补采；HTTP 的 D1 调用数与账号数无关。
pub async fn enqueue_refreshes(env: &Env, ids: &[i64]) -> Result<()> {
    let db = Db::new(env);
    let owner = crate::crypto::random_hex(8)?;
    let now = now_ms();
    let key = "overview-refresh";
    if !db
        .acquire_lock(
            key,
            &owner,
            now,
            crate::scheduler::TRANSITION_REFRESH_TTL_MS,
        )
        .await?
    {
        return Ok(());
    }
    let result = async {
        let queue = env.queue("TASKS")?;
        for chunk in ids.chunks(100) {
            let messages: Vec<_> = chunk
                .iter()
                .map(|id| TaskMessage::Refresh {
                    account_id: *id,
                    requested_at: now,
                })
                .collect();
            queue.send_batch(messages).await?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = db.release_lock(key, &owner).await;
    }
    result
}

async fn consume_account(env: &Env, id: i64, requested_at: i64, cron: bool) -> Result<()> {
    let now = now_ms();
    // 过期消息不重新执行自动化；完成标记也只需覆盖此有效期。
    if now.saturating_sub(requested_at) >= 10 * 60_000 {
        return Ok(());
    }
    let db = Db::new(env);
    let kind = if cron {
        "cron-account"
    } else {
        "refresh-account"
    };
    let key = format!("{kind}:{id}:{requested_at}");
    if db.task_completed(&key).await? {
        return Ok(());
    }
    let owner = crate::crypto::random_hex(8)?;
    // 90 秒总预算小于租约；进程中断后后续投递可重新领取。
    if !db.acquire_lock(&key, &owner, now, 120_000).await? {
        return if db.task_completed(&key).await? {
            Ok(())
        } else {
            Err(worker::Error::RustError(
                "巡检正在执行，稍后重试核实".into(),
            ))
        };
    }
    let result = crate::runtime::timeout(90_000, async {
        let Some(account) = db.get_account(id).await? else {
            return Ok(());
        };
        if cron && account.enabled == 0 {
            return Ok(());
        }
        let scheduler = Scheduler::new(env).await?;
        if !cron {
            let outcome = scheduler.refresh_account(&account).await;
            return if outcome.success {
                Ok(())
            } else {
                Err(worker::Error::RustError(outcome.warnings.join("；")))
            };
        }
        let report = scheduler.run_account_cron(&account).await;
        let summary = report.summary();
        log_info!("账号 {id} 巡检：{summary}");
        if report.accounts_failed > 0 || report.thresholds_fired > 0 {
            scheduler
                .notify_once(
                    &format!("cron-alert:{id}:{}", now_ms() / (6 * 60 * 60_000)),
                    6 * 60 * 60_000,
                    crate::notify::Message::alert(format!("{} 巡检异常", account.name), &summary)
                        .with_details(report.notes)
                        .with_group("CDT-Cron"),
                )
                .await;
        }
        if report.retry_needed {
            return Err(worker::Error::RustError(format!(
                "巡检未完成，稍后重试：{summary}"
            )));
        }
        Ok(())
    })
    .await
    .unwrap_or_else(|err| Err(worker::Error::RustError(err.into())));
    match result {
        Ok(()) => {
            db.complete_task(&key, &owner, requested_at.saturating_add(10 * 60_000))
                .await
        }
        Err(err) => {
            let _ = db.release_lock(&key, &owner).await;
            Err(err)
        }
    }
}
