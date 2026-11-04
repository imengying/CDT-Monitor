-- 保留采集来源的成功时间；存量数据无法证明各来源成功，首次刷新后补齐。
ALTER TABLE account_snapshots ADD COLUMN traffic_updated_at INTEGER;
ALTER TABLE account_snapshots ADD COLUMN balance_updated_at INTEGER;
ALTER TABLE account_snapshots ADD COLUMN instances_updated_at INTEGER;
ALTER TABLE account_snapshots ADD COLUMN sync_errors_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE account_snapshots ADD COLUMN threshold_limit_gb REAL;
ALTER TABLE account_snapshots ADD COLUMN threshold_notified_month TEXT;
ALTER TABLE account_snapshots ADD COLUMN threshold_stop_status TEXT;
UPDATE account_snapshots SET threshold_limit_gb = (
  SELECT traffic_threshold_gb FROM accounts WHERE accounts.id = account_snapshots.account_id
) WHERE threshold_triggered_month IS NOT NULL;

-- 任务参数及批量进度持久化，running 超时后明确失败，避免重放启停指令。
ALTER TABLE jobs ADD COLUMN payload_json TEXT;
ALTER TABLE jobs ADD COLUMN started_at INTEGER;
ALTER TABLE jobs ADD COLUMN result_msg TEXT;
UPDATE jobs SET status = 'failed', error_msg = '任务执行器已升级，请重新提交',
  finished_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status IN ('pending', 'running');
DELETE FROM locks WHERE owner IN (SELECT id FROM jobs WHERE status = 'failed');

CREATE TABLE login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts_expiry ON login_attempts(expires_at);
