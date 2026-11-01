-- ---------------------------------------------------------------------------
-- 002：定时开关机支持 Cron 表达式
--
-- 背景：`init_001.sql` 只支持「每日 HH:MM」。进阶模式需要五字段 Cron 与
-- 「按触发时刻去重」，因此新增四个字段：
--
--   schedule_mode          定时模式，simple = 每日 HH:MM，advanced = Cron
--   schedule_start_cron    开机表达式（仅 advanced 使用）
--   schedule_stop_cron     关机表达式
--   last_schedule_start_at 上次定时开机的毫秒时间戳，Cron 模式据此去重
--
-- 为什么单独开一个文件而不是改 `init_001.sql`：
-- D1 按**文件名**记录迁移是否已执行。`init_001.sql` 已经部署过的库会被标记
-- 为已完成，再改它也不会重跑，新字段永远加不上。全新部署同样能从本文件
-- 得到正确结构（ALTER 在空表上执行是幂等的）。
--
-- 去重为什么不用日期：`*/5 * * * *` 这类高频表达式一天要触发多次，
-- 按 `last_schedule_*_date` 判断会导致当天只执行第一次。
-- ---------------------------------------------------------------------------

ALTER TABLE accounts ADD COLUMN schedule_mode TEXT NOT NULL DEFAULT 'simple';
ALTER TABLE accounts ADD COLUMN schedule_start_cron TEXT;
ALTER TABLE accounts ADD COLUMN schedule_stop_cron TEXT;
ALTER TABLE accounts ADD COLUMN last_schedule_start_at INTEGER;

-- 存量账号本来就只有「每日时间」语义，`simple` 是它们的正确默认值。
-- `schedule_mode` 的取值约束放在应用层校验：SQLite 的 ALTER TABLE 无法
-- 追加 CHECK 约束，只有在建表时才能声明（`init_001.sql` 里已声明）。
