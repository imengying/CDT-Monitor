# CDT Monitor (Worker)

阿里云 **CDT 流量监控** 与 **ECS 自动化控制**，纯 Serverless 部署在 Cloudflare
Workers 上。参考 [`wang4386/CDT-Monitor`](https://github.com/wang4386/CDT-Monitor)
的业务语义与界面布局，重构为 **Rust/Wasm + D1 + Cron Triggers + Turnstile** 架构。

```
┌───────────────────────────────────────────────────────────────────┐
│  Cloudflare 边缘                                                   │
│                                                                   │
│  纯 TypeScript 前端 (DOM + ECharts + Tailwind)   ← ASSETS 绑定    │
│         │ fetch /api/v1/*（同源 Cookie）                           │
│         ▼                                                         │
│  Worker (Rust → Wasm)                                             │
│    ├─ fetch:     路由 + Turnstile 登录 + Cookie 鉴权               │
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
cdt-monitor-worker/
├── Cargo.toml                  Rust 2024，cdylib → wasm32
├── wrangler.toml               D1 / Assets / Cron / 环境变量
├── package.json                根脚本（Bun）
├── rust-toolchain.toml
├── .dev.vars.example           本地开发变量模板
├── scripts/
│   ├── build-ci.sh             Cloudflare 构建脚本（配置自检 → 装工具链 → 构建）
│   ├── check-config.ts         wrangler.toml 自检（防「部署成功但页面空白」）
│   └── deploy.ts               部署脚本（自动建 D1 → 迁移 → 发布）
├── migrations/
│   └── init_001.sql            7 张表 + 9 个索引
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
    ├── index.html              引入 Turnstile script
    ├── public/favicon.svg
    └── src/
        ├── main.ts             入口
        ├── App.ts              主控制台（对应原版 App.vue）
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
            ├── SettingsModal.ts 设置弹窗（5 个标签页）
            ├── LogDrawer.ts    日志抽屉
            └── ToastStack.ts   提示条容器
```

> 组件文件与规范里的 `.vue` 一一对应（`LoginModal` / `AccountCard` /
> `TrafficChart` / `SettingsModal` / `LogDrawer`），但实现为**纯 TypeScript 类**，
> 直接操作 DOM，不依赖任何前端框架。

---

## 部署（Cloudflare 连接 GitHub，推送即发布）

全部在 Cloudflare 网页完成，**不需要本地装 Rust 或 wrangler**。
建库、建表、上传全部自动化。

### 1. 建 Turnstile 站点

Dashboard → **Turnstile → Add site**，域名填你的 Worker 域名（可先用
`*.workers.dev`），拿到 **Site Key**（公开）与 **Secret Key**（机密）。

### 2. 连接 GitHub 仓库

**Workers & Pages → Create → Workers → Connect to Git**，选中本仓库，根目录 `/`。

| 构建配置 | 值 |
|---|---|
| Build command | `bun run build` |
| Deploy command | `bun run deploy` |
| Build variable | `BUN_VERSION=1.4.4`（可选，默认即此值） |

构建脚本开头会先跑 `scripts/check-config.ts`，核对 `wrangler.toml` 里
几个**删了会静默失败**的段落（`[assets]`、D1 绑定、Cron、日志默认值）。
这类问题部署能成功，但打开页面才报错，因此提前在构建阶段拦下。

`bun run deploy` 执行 `scripts/deploy.ts`，依次完成：

1. **创建 D1 数据库**（已存在则跳过）
2. **执行 `migrations/` 下的建表 SQL**（已执行过的不会重跑）
3. 上传 Worker

所以 **D1 与表结构都是自动建好的**，不用去控制台 Create，也不用粘 SQL。
`wrangler.toml` 里刻意**不写 `database_id`** —— wrangler 按 `database_name`
（`cdt-monitor`）自动发现并绑定。

### 3. 配 4 个 Secret

**Settings → Variables and Secrets**（运行时，**不是** Build variables），
全部选 **Secret**：

| 名称 | 必需 | 说明 |
|---|---|---|
| `MASTER_KEY` | ✅ | `openssl rand -hex 32`，**生成后不要再改**（改了已存密文全部失效） |
| `TURNSTILE_SECRET_KEY` | ✅ | 第 1 步拿到的私钥 |
| `ADMIN_USERNAME` | ✅ | 管理员用户名，例如 `admin` |
| `ADMIN_PASSWORD` | ✅ | 管理员密码，建议 16 位以上 |

`TURNSTILE_SITE_KEY` 是公钥，可以直接写进 `wrangler.toml` 的 `[vars]`。

**只有这四项在环境变量里。** 其余全部在网页「设置」里改：

| 配置 | 位置 |
|---|---|
| 阿里云账号（AccessKey、阈值、停机策略、定时、保活） | 设置 → 阿里云账号 |
| Telegram（Bot Token / Chat ID / 反代） | 设置 → Telegram |
| Bark（Server / Device Key / 推送级别） | 设置 → Bark |
| 日报推送时间 | 设置 → 日报 |
| 时区 | 设置 → 系统 |

这些全部存 D1，改完即时生效，**不需要重新部署**。

### 4. 首次登录

打开 Worker 域名 → 输入第 3 步的 `ADMIN_USERNAME` + `ADMIN_PASSWORD`。

> 凭证**只来自环境变量**，数据库里没有任何密码材料。想换用户名或密码，
> 直接改这两个 Secret 再重新部署即可；**不支持**在后台改（后台系统页只显示
> 当前生效的变量名，并给出轮换说明）。

之后每次 `git push`，Cloudflare 会自动重新构建并发布。

---

## 日志与可观测性（默认全关）

| 开关 | 默认 | 打开方式 |
|---|---|---|
| 应用日志 | 只输出 `error` | Worker 变量 `LOG_LEVEL=info`（或 `warn` / `debug`） |
| Workers Logs | **关闭** | `wrangler.toml` 的 `[observability] enabled = true`，或控制台切 |

默认安静的原因：Cron 每 5 分钟跑一次巡检，若把流程日志与 Workers Logs
都打开，会持续产生噪音与费用。

排障时只需临时把 `LOG_LEVEL` 改成 `info`（改环境变量，不用改代码）：

```text
error  只输出错误（默认）           —— 解密失败、D1 不可用、任务失败
warn   额外输出可自愈异常           —— 单地域查询失败、通知发送失败
info   额外输出正常流程             —— Cron 汇总、任务完成、保活拉起实例
debug  最细粒度（目前同 info）
```

`error` 级别**刻意保留**：把错误也一起关掉会让线上故障完全不可见。

---

## 本地开发

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
bun install
bun run install:web

cp .dev.vars.example .dev.vars   # 已预填 Turnstile 官方测试密钥
bun run db:migrate:local
bun run dev                      # 构建前端 + wrangler dev（:8787）
```

单独调试前端热更新（`/api` 代理到 8787，保证 Cookie 同源）：

```bash
bun run dev:web                  # :5173
```

本地 D1 是独立的（`.wrangler/state/`），与线上互不影响。

---

## 环境变量

**只有这四项需要配在 Cloudflare 控制台**，其余全在网页「设置」里。

| 名称 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `MASTER_KEY` | Secret | ✅ | 32 字节主密钥。加密 AK Secret / TG Token / Bark Key，同时作会话 Token 的 HMAC 密钥。轮换会导致已存密文全部失效 |
| `TURNSTILE_SECRET_KEY` | Secret | ✅ | Turnstile 私钥。缺失时登录返回 503（宁可不登录也不绕过人机校验） |
| `ADMIN_USERNAME` | Secret | ✅ | 管理员用户名，登录时使用 |
| `ADMIN_PASSWORD` | Secret | ✅ | 管理员密码。每次登录都对照此变量校验，**不落库** |

可选（多数场景用不到）：

| 名称 | 默认 | 说明 |
|---|---|---|
| `TURNSTILE_SITE_KEY` | 空 | 公钥，建议写进 `wrangler.toml` 的 `[vars]` |
| `LOG_LEVEL` | `error` | `error` / `warn` / `info` / `debug` |
| `JOB_LOCK_TTL_MS` | `600000` | 刷新任务跨实例互斥窗口 |
| `SESSION_TTL_MS` | `604800000` | 会话有效期（7 天） |
| `TURNSTILE_DISABLED` | 未设 | 仅本地调试：`true` 跳过人机校验。**生产环境绝不要设** |
| `ALIYUN_CDT_ENDPOINT` 等 | 官方默认 | 端点覆盖（私有网关 / 排障） |

**构建期**变量（与运行时是两处配置，别放错）：

| 名称 | 位置 | 值 |
|---|---|---|
| `BUN_VERSION` | Settings → **Build** → Build variables | `1.4.4`（可选） |

---

## 安全模型

### 凭据加密

```
明文  ──XChaCha20-Poly1305(随机 24B Nonce)──▶  Base64(Nonce ‖ 密文 ‖ 16B Tag)  ──▶  D1 TEXT
```

* 算法：`chacha20poly1305::XChaCha20Poly1305`（192 位 Nonce，无需担心 Nonce 复用）
* 主密钥解析顺序：64 字符 Hex → Base64（三种变体）→ 恰 32 字节原文 → `blake3::derive_key` 拉伸
* 任何字节被篡改都会导致 AEAD 认证失败，解密返回明确错误

### 管理员认证

| 环节 | 实现 |
|---|---|
| 人机校验 | Turnstile `siteverify`，携带 `CF-Connecting-IP` 作为 `remoteip`；前端用 `appearance: 'interaction-only'`，静默通过时不显示任何可见元素 |
| 用户名 | 环境变量 `ADMIN_USERNAME`，**唯一来源** |
| 密码 | 环境变量 `ADMIN_PASSWORD`，**唯一来源**；不哈希入库，数据库里没有任何密码材料 |
| 比较方式 | 用户名与密码都用常量时间比较，且不短路（避免通过响应时间差推断） |
| 防枚举 | 用户名错与密码错返回同一句「用户名或密码错误」，延迟也相同 |
| 会话 | `v1.<payload>.<sig>`，`HMAC-SHA256(MASTER_KEY)` 签名，payload 含 `iat/exp/jti` |
| 传输 | `HttpOnly; Secure; SameSite=Strict` Cookie |
| 轮换 | 改环境变量后重新部署；旧 Cookie 在有效期内仍可用，必要时手动清除 |

> 为什么不做「后台改密码」：那需要把密码哈希存进 D1、维护会话纪元、
> 处理「环境变量 vs 数据库谁优先」的冲突。凭证只有一个来源时，
> 「谁能登录」这件事没有歧义，轮换就是改环境变量。

### 纵深防御

* 写接口额外校验 `Sec-Fetch-Site` / `Origin` / `Referer`，拒绝跨站请求
* 所有文本经 `textContent` 写入，不拼接 `innerHTML`；仅静态 SVG 用内联
* 响应统一带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Cache-Control: no-store`

---

## 业务逻辑

### Cron（`*/5 * * * *`）

```
1. housekeeping（每天一次，锁保护）
     清理过期锁 / 90 天前历史 / 30 天前日志 / 7 天前 Job
2. 逐账号：CDT 流量 + 余额 + 各地域 ECS 实例 → 写快照 → 采样历史
3. 阈值判定：合计 ≥ traffic_limit_gb
     首次超限 → 标记账期 + 通知 [+ 停机（stop_and_notify）]
4. 定时关机（20 分钟短窗口，失败则下轮重试）
5. 定时开机（同窗口，受熔断闸门约束）
6. 抢占式保活（受熔断闸门 + 夜间停机窗口约束）
7. 每日日报（40 分钟窗口，当天只推一次）
```

### 优先级（硬性）

```
流量熔断停机  >  抢占式保活  >  定时开机
```

当月已熔断且策略为 `stop_and_notify` 时，保活、定时开机、手动开机**全部禁止拉起实例**。
`notify_only` 从不实际停机，因此不参与闸门。

### 采集失败的处理

* CDT 查询失败 → 沿用上次快照的流量值（**绝不写 0**，否则阈值会误判为安全）
* 余额查询失败 → 沿用上次快照
* 某地域实例查询失败 → 只保留该地域的旧实例（其余地域正常刷新）
* 逐实例保活开关 → 按 `instance_id` 从旧快照继承（阿里云接口不返回这个字段）

### 异步 Job

所有写接口返回 `202 Accepted + { job_id }`，前端轮询 `GET /api/v1/jobs/{job_id}`：

```json
{ "id": "uuid", "job_type": "start_instance", "status": "pending|running|success|failed",
  "error_msg": null, "created_at": 1792948752627, "finished_at": null }
```

刷新类任务用 D1 锁做跨实例互斥（owner = `job_id`，收尾时按 owner 释放），
并发提交第二个会得到 `409 job_locked`。

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/auth/session` | 会话探测（公开，返回 Turnstile site key） |
| POST | `/api/v1/auth/login` | 登录（Turnstile + 密码） |
| POST | `/api/v1/auth/logout` | 退出（清 Cookie） |
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
| PUT | `/api/v1/settings/telegram\|bark\|daily-report\|timezone` | 更新设置 |
| POST | `/api/v1/settings/notify-test` | 测试通知 → 202 |
| POST | `/api/v1/reports/daily` | 立即推送日报 → 202 |

错误体统一 `{ "error": "...", "code": "...?" }`。`code` 取值：

`unauthenticated` · `invalid_credentials` · `turnstile_failed` · `turnstile_unavailable` ·
`turnstile_not_configured` · `cross_origin` · `job_locked` · `credentials_not_configured`

---

## 数据模型

| 表 | 用途 |
|---|---|
| `settings` | KV 配置（时区、日报、TG/Bark 密文）。**不含任何密码材料** |
| `accounts` | 阿里云账号（AK、加密 Secret、地域、阈值、策略、定时、保活） |
| `account_snapshots` | 每账号一行最新状态，**首页只读这张表** |
| `traffic_history` | 流量采样（账期累计值），按 `(account_id, recorded_at)` 索引 |
| `jobs` | 异步任务状态 |
| `action_logs` | 自动化动作 / 告警 / 登录审计 |
| `locks` | 幂等锁（TTL 到期自动可抢占） |

时间戳一律 Unix 毫秒 `INTEGER`；布尔存 `0/1`（Rust 侧用 `i64` 承载再转换，
因为 `serde-wasm-bindgen` 反序列化 `bool` 只接受 JS `true/false`）。

---

## 阿里云接口

| 用途 | Action | Version |
|---|---|---|
| CDT 流量 | `ListCdtInternetTraffic`（失败回退 `GetCdtInternetTraffic`） | 2021-08-13 |
| ECS 查询 | `DescribeInstances`（自动翻页，最多 2000 台） | 2014-05-26 |
| ECS 控制 | `StartInstance` / `StopInstance`（含 `StoppedMode`） | 2014-05-26 |
| 余额 | `QueryAccountBalance` | 2017-12-14 |

签名实现遵循 RPC V1（`HMAC-SHA1`），并有针对阿里云官方样例的回归测试：

```rust
// src/aliyun.rs
assert_eq!(sign("testsecret", &to_sign), "OLeaidS1JvxuMvnyHOwuJ+uX5qY=");
```

重试策略：仅对可恢复错误（网络失败 / HTTP 5xx / `Throttling*` / `ServiceUnavailable` /
`InternalError`）重试，最多 2 次退避（200ms → 600ms）。参数错误与鉴权失败直接返回。

---

## 开发与校验

```bash
cargo test                                                    # 64 个单元测试
cargo clippy --target wasm32-unknown-unknown -- -D warnings
bun run typecheck:web
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
| 登录防护 | — | Turnstile（含 `remoteip`） |
| 通知 | SMTP / 通用 Webhook / TG / Bark | 仅 Telegram（支持反代）+ Bark（三级推送） |
| API Key / Scope | 有 | 已移除 |
| 桌面小组件接口 | `/api/v1/widget/*` | 已移除 |
| `/healthz` `/readyz` `/monitor.php` | 有 | 已移除 |
| 前端 | — | 纯 TypeScript + DOM（无框架、无 Vue）+ ECharts + Tailwind v4 |
| 部署 | 手工建库、粘 SQL | 连 GitHub 推送即发布；`deploy` 脚本自动建 D1 + 迁移 |
| 管理员账号 | 仅密码 | 用户名 + 密码都在环境变量，后台只管业务配置 |
| 日志 | 常开 | 默认只输出 error，Workers Logs 默认关闭 |
