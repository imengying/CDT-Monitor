-- 云账号身份与配置版本：区分密钥轮换和账号替换，拒绝旧配置下排队的启停。
ALTER TABLE accounts ADD COLUMN cloud_account_id TEXT;
ALTER TABLE accounts ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_locks_owner ON locks(owner);
