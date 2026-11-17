-- 配置及小型同步状态随账号一起读取；默认关闭，不增加未启用账号的巡检开销。
ALTER TABLE accounts ADD COLUMN dns_json TEXT NOT NULL DEFAULT '{}';
