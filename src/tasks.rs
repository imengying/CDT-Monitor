//! Queues 负责唤醒，D1 负责任务进度和互斥。消息不携带凭据。
use crate::{db::Db, jobs, models::now_ms, scheduler::Scheduler};
use serde::{Deserialize, Serialize};
use worker::{Env, Result};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TaskMessage {
    Job { id: String },
    Cron { account_id: i64, scheduled_at: i64 },
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
            db.recover_jobs(now_ms()).await?;
            jobs::execute_job(env.clone(), id.clone()).await
        }
        TaskMessage::Maintenance => Scheduler::new(env).await?.maintenance().await,
        TaskMessage::Cron {
            account_id,
            scheduled_at,
        } => {
            // 积压过久的旧调度不执行开关机，等待最新一轮巡检。
            if now_ms().saturating_sub(*scheduled_at) >= 10 * 60_000 {
                return Ok(());
            }
            let Some(account) = db.get_account(*account_id).await? else {
                return Ok(());
            };
            if account.enabled == 0 {
                return Ok(());
            }
            let scheduler = Scheduler::new(env).await?;
            let key = format!("cron-account:{account_id}:{scheduled_at}");
            let owner = crate::crypto::random_hex(8)?;
            if !db.acquire_lock(&key, &owner, now_ms(), 10 * 60_000).await? {
                return Ok(());
            }
            let report = scheduler.run_account_cron(&account).await;
            log_info!("账号 {account_id} 巡检：{}", report.summary());
            if report.accounts_failed > 0 || report.thresholds_fired > 0 {
                scheduler
                    .notify_once(
                        &format!("cron-alert:{account_id}:{}", now_ms() / (6 * 60 * 60_000)),
                        6 * 60 * 60_000,
                        crate::notify::Message::alert(
                            format!("{} 巡检异常", account.name),
                            report.summary(),
                        )
                        .with_details(report.notes)
                        .with_group("CDT-Cron"),
                    )
                    .await;
            }
            Ok(())
        }
    }
}
