# CDT Monitor (Worker)

阿里云 **CDT 流量监控** 与 **ECS 自动化控制**，运行在 Cloudflare Workers 上。
参考 [`wang4386/CDT-Monitor`](https://github.com/wang4386/CDT-Monitor) 的业务语义，
实现为 **Rust/Wasm + D1 + Cron Triggers + Turnstile**。

```
┌───────────────────────────────────────────────────────────────────┐
│  Cloudflare 边缘                                                   │
│                                                                   │
│  纯 TypeScript 前端 (DOM + ECharts + Tailwind)   ← ASSETS 绑定    │
│         │ fetch /api/v1/*（同源 Cookie）                           │
│         ▼                                                         │
│  Worker (Rust → Wasm)                                             │
│    ├─ fetch:     路由 + 登录 + Cookie 鉴权                         │
│    ├─ scheduled: */5 * * * * 巡检                                  │
│    └─ wait_until: 异步 Job（刷新 / 开关机 / 通知测试 / 日报）        │
│         │                                                         │
│         ├─ D1：accounts / snapshots / history / jobs / logs        │
│         └─ fetch → 阿里云 RPC（CDT / ECS / BSS）                    │
│                       Telegram · Bark                             │
└───────────────────────────────────────────────────────────────────┘
```

---

## 目录结构

```
cdt-monitor/
├── Cargo.toml                  Rust 2024，cdylib → wasm32
├── wrangler.toml               D1 / Assets / Cron / 变量
├── package.json                根脚本（Bun）
├── rust-toolchain.toml
├── .dev.vars.example           本地开发变量模板
├── scripts/
│   ├── build-ci.sh             构建入口：校验配置 → 装工具链 → 构建
│   ├── check-config.ts         wrangler.toml 结构校验
│   └── deploy.ts               部署入口：建库 → 迁移 → 发布
├── migrations/
│   └── init_001.sql            7 张表 + 10 个索引
├── src/
│   ├── lib.rs                  fetch / scheduled 入口、路由、鉴权、Job 执行器
│   ├── models.rs               D1 实体行 + 前后端 DTO + 时区/单位换算
│   ├── db.rs                   D1 SQL 封装（含幂等锁）
│   ├── crypto.rs               XChaCha20-Poly1305、无状态 Token
│   ├── logging.rs              分级日志（默认只输出 error）
│   ├── aliyun.rs               RPC V1 签名器 + CDT/ECS/BSS 客户端
│   ├── notify.rs               Telegram + Bark
│   └── scheduler.rs            采样 / 熔断 / 定时开关机 / 保活 / 日报
└── web/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html              以 render=explicit 引入 Turnstile
    ├── public/favicon.svg
    └── src/
        ├── main.ts             入口
        ├── App.ts              主控制台
        ├── style.css           主题令牌与组件语义类
        ├── env.d.ts            Turnstile 类型声明
        ├── api/client.ts       API 客户端 + 202 Job 轮询
        ├── lib/
        │   ├── dom.ts          el() / iconSvg() 等 DOM 工具
        │   ├── icons.ts        按需引入的 lucide 图标
        │   ├── store.ts        状态容器 + toast
        │   └── actions.ts      API 调用与状态写入
        └── components/
            ├── LoginModal.ts   登录卡片 + Turnstile
            ├── AccountCard.ts  账号卡片 + 实例控制
            ├── TrafficChart.ts ECharts 趋势图
            ├── SettingsModal.ts 设置弹窗（6 个标签页）
            ├── LogDrawer.ts    日志抽屉
            └── ToastStack.ts   提示条容器
```

前端为纯 TypeScript 类组件，直接操作 DOM，不依赖任何框架。

---

## 部署（Cloudflare 连接 GitHub，推送即发布）

全部在 Cloudflare 网页完成，本机无需安装 Rust 或 wrangler。

### 1. 连接 GitHub 仓库

**Workers & Pages → Create → Workers → Connect to Git**，选中本仓库，根目录 `/`。

| 构建配置 | 值 |
|---|---|
| Build command | `bun run build` |
| Deploy command | `bun run deploy` |
| Build variable | `BUN_VERSION=1.4.4`（可选，默认即此值） |

构建前 `scripts/check-config.ts` 校验 `wrangler.toml` 的必需段落（`[assets]`、
D1 绑定、Cron、`main`、日志默认值），任一项缺失即中止构建。

`scripts/deploy.ts` 负责首次部署的自动化：创建 D1 库（已存在则跳过）、
应用 `migrations/` 下未执行的 SQL、上传 Worker。D1 绑定通过
`database_name = "cdt-monitor"` 解析，`wrangler.toml` 不写 `database_id`。

### 2. 配 3 个 Secret

**Settings → Variables and Secrets**（运行时变量），全部选 **Secret**：

| 名称 | 说明 |
|---|---|
| `MASTER_KEY` | `openssl rand -hex 32`。轮换会导致已存密文全部失效 |
| `ADMIN_USERNAME` | 管理员用户名 |
| `ADMIN_PASSWORD` | 管理员密码，建议 16 位以上 |

其余配置均在网页「设置」中维护，存于 D1，即时生效：

| 配置 | 位置 |
|---|---|
| 阿里云账号（AccessKey、阈值、停机策略、定时、保活） | 设置 → 阿里云账号 |
| 人机校验（Turnstile Site Key / Secret Key） | 设置 → 人机校验 |
| Telegram（Bot Token / Chat ID / 反代） | 设置 → Telegram |
| Bark（Server / Device Key / 推送级别） | 设置 → Bark |
| 日报推送时间 | 设置 → 日报 |
| 时区 | 设置 → 系统 |

### 3. 首次登录

打开 Worker 域名，使用第 2 步的 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD` 登录。

管理员凭证只读取环境变量，数据库不存储任何密码材料，后台不提供改密入口；
更换用户名或密码即修改对应 Secret 后重新部署。

此后每次 `git push` 触发自动构建与发布。

---

## 日志与可观测性

| 项目 | 默认 | 调整方式 |
|---|---|---|
| 应用日志 | 仅 `error` | Worker 变量 `LOG_LEVEL` |
| Workers Logs | 关闭 | `wrangler.toml` 的 `[observability] enabled`，或控制台开关 |

```text
error  解密失败、D1 不可用、任务失败
warn   单地域查询失败、通知发送失败
info   Cron 汇总、任务完成、保活拉起实例
debug  同 info
```

---

## 本地开发

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
bun install
bun run install:web

cp .dev.vars.example .dev.vars
bun run db:migrate:local
bun run dev                      # 构建前端 + wrangler dev（:8787）
```

前端独立热更新（`/api` 代理到 8787，保持 Cookie 同源）：

```bash
bun run dev:web                  # :5173
```

本地 D1 位于 `.wrangler/state/`，与线上隔离。

---

## 环境变量

| 名称 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `MASTER_KEY` | Secret | ✅ | 32 字节主密钥。加密 AK Secret / TG Token / Bark Key / Turnstile 私钥，并作为会话 Token 的 HMAC 密钥 |
| `ADMIN_USERNAME` | Secret | ✅ | 管理员用户名 |
| `ADMIN_PASSWORD` | Secret | ✅ | 管理员密码，每次登录对照校验，不落库 |
| `LOG_LEVEL` | 变量 | — | `error`（默认）/ `warn` / `info` / `debug` |
| `JOB_LOCK_TTL_MS` | 变量 | — | 刷新任务跨实例互斥窗口，默认 `600000` |
| `SESSION_TTL_MS` | 变量 | — | 会话有效期，默认 `604800000`（7 天） |
| `ALIYUN_CDT_ENDPOINT` | 变量 | — | CDT 端点覆盖 |
| `ALIYUN_ECS_ENDPOINT` | 变量 | — | ECS 端点覆盖 |
| `ALIYUN_BSS_ENDPOINT` | 变量 | — | BSS 端点覆盖 |

构建期变量位于 **Settings → Build → Build variables**：`BUN_VERSION`（默认 `1.4.4`）。

---

## 安全模型

### 凭据加密

```
明文  ──XChaCha20-Poly1305(随机 24B Nonce)──▶  Base64(Nonce ‖ 密文 ‖ 16B Tag)  ──▶  D1 TEXT
```

* 算法 `chacha20poly1305::XChaCha20Poly1305`，192 位 Nonce
* 主密钥解析顺序：64 字符 Hex → Base64（三种变体）→ 恰 32 字节原文 → `blake3::derive_key`
* 任一字节被篡改都会导致 AEAD 认证失败并返回明确错误

### 管理员认证

| 环节 | 实现 |
|---|---|
| 人机校验 | Turnstile `siteverify`，携带 `CF-Connecting-IP` 作为 `remoteip`；前端 `appearance: 'interaction-only'`，无交互需求时不渲染可见元素 |
| 开关 | 未配置 Site Key 与 Secret Key 时不校验；启用后私钥解密失败返回 `turnstile_broken` 并拒绝登录 |
| 凭证来源 | `ADMIN_USERNAME` / `ADMIN_PASSWORD`，唯一来源 |
| 比较方式 | 用户名与密码均常量时间比较且不短路 |
| 防枚举 | 用户名错与密码错返回同一提示，延迟一致 |
| 会话 | `v1.<payload>.<sig>`，`HMAC-SHA256(MASTER_KEY)` 签名，payload 含 `iat` / `exp` / `jti` |
| 传输 | `HttpOnly; Secure; SameSite=Strict` Cookie |

### 纵深防御

* 写接口校验 `Sec-Fetch-Site` / `Origin` / `Referer`，拒绝跨站请求
* 所有文本经 `textContent` 写入，不拼接 `innerHTML`；仅静态 SVG 内联
* 响应统一携带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Cache-Control: no-store`

---

## 业务逻辑

### Cron（`*/5 * * * *`）

```
1. housekeeping（每日一次，锁保护）
     清理过期锁 / 90 天前历史 / 30 天前日志 / 7 天前 Job
2. 逐账号：CDT 流量 + 余额 + 各地域 ECS 实例 → 写快照 → 采样历史
3. 阈值判定：合计 ≥ traffic_limit_gb
     首次超限 → 标记账期 + 通知 [+ 停机（stop_and_notify）]
4. 定时关机（20 分钟窗口，失败下轮重试）
5. 定时开机（同窗口，受熔断闸门约束）
6. 抢占式保活（受熔断闸门与夜间停机窗口约束）
7. 每日日报（40 分钟窗口，当天仅一次）
```

### 优先级

```
流量熔断停机  >  抢占式保活  >  定时开机
```

当月已熔断且策略为 `stop_and_notify` 时，保活、定时开机、手动开机均不会拉起实例。
`notify_only` 不停机，不参与闸门。

### 采集失败的处理

* CDT 查询失败 → 沿用上次快照流量值，不写 0
* 余额查询失败 → 沿用上次快照
* 某地域实例查询失败 → 仅保留该地域旧实例
* 逐实例保活开关 → 按 `instance_id` 从旧快照继承

### 异步 Job

写接口返回 `202 Accepted + { job_id }`，前端轮询 `GET /api/v1/jobs/{job_id}`：

```json
{ "id": "uuid", "job_type": "start_instance", "status": "pending|running|success|failed",
  "error_msg": null, "created_at": 1792948752627, "finished_at": null }
```

刷新类任务以 D1 锁跨实例互斥（owner = `job_id`，收尾按 owner 释放），
并发提交返回 `409 job_locked`。

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/auth/session` | 会话探测（公开，返回 Turnstile site key，未启用时为空串） |
| POST | `/api/v1/auth/login` | 登录（用户名 + 密码，可选 Turnstile） |
| POST | `/api/v1/auth/logout` | 退出 |
| GET | `/api/v1/overview` | 首页数据（读快照表） |
| GET | `/api/v1/history?account_id&bucket=hour\|day&limit` | 流量历史 |
| GET | `/api/v1/logs?account_id&limit` | 操作日志 |
| GET | `/api/v1/jobs[/{id}]` | 任务状态 |
| POST | `/api/v1/refresh` | 刷新全部 → 202 |
| POST | `/api/v1/accounts` | 新增账号 |
| PUT/DELETE | `/api/v1/accounts/{id}` | 修改 / 删除账号 |
| POST | `/api/v1/accounts/{id}/refresh` | 刷新单账号 → 202 |
| POST | `/api/v1/accounts/{id}/instances/{iid}/start\|stop` | 开机 / 关机 → 202 |
| PUT | `/api/v1/accounts/{id}/instances/{iid}/keep-alive` | 逐实例保活开关 |
| GET | `/api/v1/settings` | 全部设置（脱敏） |
| PUT | `/api/v1/settings/turnstile\|telegram\|bark\|daily-report\|timezone` | 更新设置 |
| POST | `/api/v1/settings/notify-test` | 测试通知 → 202 |
| POST | `/api/v1/reports/daily` | 立即推送日报 → 202 |

错误体格式 `{ "error": "...", "code": "..." }`，`code` 取值：

`unauthenticated` · `invalid_credentials` · `credentials_not_configured` ·
`turnstile_failed` · `turnstile_unavailable` · `turnstile_broken` ·
`cross_origin` · `job_locked` · `init_failed` · `internal_error`

---

## 数据模型

| 表 | 用途 |
|---|---|
| `settings` | KV 配置（时区、日报、TG/Bark 密文、Turnstile 密文） |
| `accounts` | 阿里云账号（AK、加密 Secret、地域、阈值、策略、定时、保活） |
| `account_snapshots` | 每账号一行最新状态，首页只读此表 |
| `traffic_history` | 流量采样（账期累计值），索引 `(account_id, recorded_at)` |
| `jobs` | 异步任务状态 |
| `action_logs` | 自动化动作 / 告警 / 登录审计 |
| `locks` | 幂等锁，TTL 到期可抢占 |

时间戳统一 Unix 毫秒 `INTEGER`；布尔存 `0/1`（Rust 侧以 `i64` 承载后转换，
`serde-wasm-bindgen` 反序列化 `bool` 只接受 JS `true/false`）。

---

## 阿里云接口

| 用途 | Action | Version |
|---|---|---|
| CDT 流量 | `ListCdtInternetTraffic`（失败回退 `GetCdtInternetTraffic`） | 2021-08-13 |
| ECS 查询 | `DescribeInstances`（自动翻页，上限 2000 台） | 2014-05-26 |
| ECS 控制 | `StartInstance` / `StopInstance`（含 `StoppedMode`） | 2014-05-26 |
| 余额 | `QueryAccountBalance` | 2017-12-14 |

签名遵循 RPC V1（`HMAC-SHA1`），含针对官方样例的回归测试：

```rust
// src/aliyun.rs
assert_eq!(sign("testsecret", &to_sign), "OLeaidS1JvxuMvnyHOwuJ+uX5qY=");
```

重试仅针对可恢复错误（网络失败、HTTP 5xx、`Throttling*`、`ServiceUnavailable`、
`InternalError`），最多 2 次退避（200ms → 600ms）；参数错误与鉴权失败直接返回。

---

## 开发与校验

```bash
cargo test                                                    # 70 个单元测试
cargo clippy --target wasm32-unknown-unknown -- -D warnings
bun run typecheck:web
bun run check:config
bun run build
```

本地触发 Cron：

```bash
curl http://localhost:8787/cdn-cgi/local/scheduled
```

---

## 与原版的差异

| 项 | 原版 | 本项目 |
|---|---|---|
| 运行时 | PHP 常驻 + MySQL + Cron | Cloudflare Workers + D1 + Cron Triggers |
| 凭据加密 | `master.key` + AES-GCM | `MASTER_KEY` + XChaCha20-Poly1305 |
| 管理员认证 | Argon2id + Session 表 | 环境变量凭证 + HMAC 无状态 Token |
| 登录防护 | — | Turnstile（含 `remoteip`），默认关闭 |
| 通知 | SMTP / 通用 Webhook / TG / Bark | Telegram（支持反代）+ Bark（三级推送） |
| API Key / Scope | 有 | 无 |
| 桌面小组件接口 | `/api/v1/widget/*` | 无 |
| `/healthz` `/readyz` `/monitor.php` | 有 | 无 |
| 前端 | — | 纯 TypeScript + DOM + ECharts + Tailwind v4 |
| 部署 | 手工建库、粘 SQL | 连接 GitHub 推送即发布 |
| 管理员账号 | 仅密码 | 用户名 + 密码 |
| 日志 | 常开 | 默认仅 error |
