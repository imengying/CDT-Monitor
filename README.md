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
│    ├─ scheduled: */15 * * * * 巡检                                 │
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
            ├── HistoryModal.ts ECharts 历史流量弹窗
            ├── SettingsModal.ts 设置弹窗（6 个标签页）
            ├── LogDrawer.ts    日志抽屉
            └── ToastStack.ts   提示条容器
```

前端为纯 TypeScript 类组件，直接操作 DOM，不依赖任何框架。

---

## 部署

### 1. 连接仓库

**Workers & Pages → Create → Workers → Connect to Git**，选中本仓库。

| 项 | 值 |
|---|---|
| Build command | `bun run build` |
| Deploy command | `bun run deploy` |
| Build variable | `BUN_VERSION=1.4.4` |

`BUN_VERSION` **必须配置**。构建镜像预装 Bun 1.2.5，不指定会用它编译。
`build-ci.sh` 检测到版本不符时会安装指定版本，未设置则直接失败。

`deploy.ts` 完成首次部署：创建 D1 库、应用 `migrations/` 下未执行的 SQL、
上传 Worker。`wrangler.toml` 不写 `database_id`，由 `database_name` 解析。

### 2. Secret

**Settings → Variables and Secrets**，三项均选 **Secret**：

| 名称 | 说明 |
|---|---|
| `MASTER_KEY` | `openssl rand -hex 32` |
| `ADMIN_USERNAME` | 管理员用户名 |
| `ADMIN_PASSWORD` | 管理员密码 |

`MASTER_KEY` 轮换会使已存密文全部失效。凭证不落库，后台无改密入口，
修改后需重新部署。

### 3. 登录

访问 Worker 域名，使用上述凭证登录。其余配置在「设置」中维护：

| 配置 | 位置 |
|---|---|
| 阿里云账号、额度、停机策略、定时、保活 | 设置 → 阿里云账号 |
| Turnstile | 设置 → 人机校验 |
| Telegram | 设置 → Telegram |
| Bark | 设置 → Bark |
| 日报时间 | 设置 → 日报 |
| 时区、日志级别、任务锁窗口、会话有效期 | 设置 → 系统 |

---

## 日志与可观测性

| 项目 | 默认 | 调整方式 |
|---|---|---|
| 应用日志 | 仅 `error` | 设置 → 系统 → 日志级别 |
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

## 配置分布

| 类别 | 存放位置 | 内容 |
|---|---|---|
| Secret | Cloudflare 控制台 | `MASTER_KEY`、`ADMIN_USERNAME`、`ADMIN_PASSWORD` |
| 构建变量 | Settings → Build | `BUN_VERSION` |
| 业务配置 | D1，设置页面 | 阿里云账号、Turnstile、Telegram、Bark、日报、时区、日志级别等 |

`wrangler.toml` 不含 `[vars]` 段。业务配置改动即时生效，无需重新部署。

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

### Cron（`*/15 * * * *`）

```
1. housekeeping（每日一次，锁保护）
     清理过期锁 / 90 天前历史 / 30 天前日志 / 7 天前 Job
2. 逐账号：CDT 流量 + 余额 + 各地域 ECS 实例 → 写快照 → 采样历史
3. 额度判定：任一池（内地 / 非内地）超出各自额度
     首次超限 → 标记账期 + 通知 [+ 停机（stop_and_notify）]
4. 定时关机（60 分钟窗口，失败下轮重试）
5. 定时开机（同窗口，受熔断闸门约束）
6. 抢占式保活（见下方闸门）
7. 每日日报（60 分钟窗口，当天仅一次）
```

窗口取 60 分钟：巡检间隔 15 分钟，一次网络抖动后下一轮还能补上。

### 抢占式保活

阿里云不提供区分「系统回收」与「用户手动停机」的字段 —— 两者都是
`Status == Stopped`；`OperationLocks` 只在回收前 5 分钟标记，比巡检间隔
还短、抓不住。因此靠四个前置条件收窄（与上游一致，任一不满足即跳过）：

1. 账号级与实例级保活开关都开启
2. 当前处于「允许运行时段」（只配关机时间时，关机后即不再保活）
3. 未触发流量熔断
4. 今天还没执行过定时关机

剩余情形（允许时段内手动停机）仍会被拉起，这是接口能力的边界：
手动停机前请先关闭保活开关。

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
* 未勾选任何地域 → 只采集 CDT 流量与余额，不查询实例（不会回退到默认地域）
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
| GET | `/api/v1/logs?account_id&action&q&limit` | 操作日志（类型前缀 + 关键字） |
| GET | `/api/v1/jobs[/{id}]` | 任务状态 |
| POST | `/api/v1/refresh` | 刷新全部 → 202 |
| POST | `/api/v1/accounts` | 新增账号 |
| PUT/DELETE | `/api/v1/accounts/{id}` | 修改 / 删除账号 |
| POST | `/api/v1/accounts/{id}/refresh` | 刷新单账号 → 202 |
| POST | `/api/v1/accounts/{id}/instances/{iid}/start\|stop` | 开机 / 关机 → 202 |
| POST | `/api/v1/accounts/{id}/instances/start-all\|stop-all` | 批量开关机 → 202 |
| PUT | `/api/v1/accounts/{id}/instances/{iid}/keep-alive` | 逐实例保活开关 |
| GET | `/api/v1/settings` | 全部设置（脱敏） |
| PUT | `/api/v1/settings/turnstile\|telegram\|bark\|daily-report\|timezone\|advanced` | 更新设置 |
| GET | `/api/v1/sessions` | 登录设备 |
| DELETE | `/api/v1/sessions[/{sid}]` | 踢下线（指定 / 其它全部） |
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
| `accounts` | 阿里云账号（AK、加密 Secret、地域、实例 ID、告警阈值、策略、定时、保活） || `account_snapshots` | 每账号一行最新状态，首页只读此表 |
| `traffic_hourly` / `traffic_daily` | 流量采样（账期累计值），索引 `(account_id, recorded_at)` |
| `jobs` | 异步任务状态 |
| `action_logs` | 自动化动作 / 告警 / 登录审计 |
| `sessions` | 登录设备，用于踢下线 |
| `locks` | 幂等锁，TTL 到期可抢占 |

时间戳统一 Unix 毫秒 `INTEGER`；布尔存 `0/1`（Rust 侧以 `i64` 承载后转换，
`serde-wasm-bindgen` 反序列化 `bool` 只接受 JS `true/false`）。

`accounts.instance_id` 为 `NOT NULL`：一个账号固定作用于一个地域内的一台实例。
留空会让熔断停机、定时开关机、保活作用到该地域下的所有实例，因此实例 ID 必填。

---

## 阿里云接口

| 用途 | Action | Version |
|---|---|---|
| CDT 流量 | `ListCdtInternetTraffic` | 2021-08-13 |
| ECS 查询 | `DescribeInstances`（自动翻页，上限 2000 台） | 2014-05-26 |
| ECS 控制 | `StartInstance` / `StopInstance`（含 `StoppedMode`） | 2014-05-26 |
| 余额 | `QueryAccountBalance` | 2017-12-14 |

`ListCdtInternetTraffic` 返回的 `Traffic` 单位是 **Byte**（与计费项 Code
`ECS_Out_Bytes` / `Eip_Out_Bytes` 的底层口径一致），控制台与账单才换算成 GB。
`traffic_unit_is_bytes` 测试钉死这一点。

### 免费额度与阈值

CDT 公网流量的免费额度按地域分为**两个独立池**，不共享、不合并计算：

| 池 | 免费额度 |
|---|---|
| 中国内地 | 20 GB / 月 |
| 非中国内地（含中国香港） | 200 GB / 月 |

一个账号只落在一个池里 —— 由它的 `region_id` 决定（`cn-` 开头且不是
`cn-hongkong` 的算内地，其余含香港算非内地）。查询 CDT 用量时取对应那一类
的累计值即可，不需要两池相加。

额度是阿里云定的固定值，不算用户配置项。用户能设的是**告警阈值**
（`traffic_threshold_gb`）：

* `0` → 不限制也不告警
* `> 0` → 累计流量达到该值即告警，并按策略停机（`stop_and_notify`）

### RAM 最小权限

阿里云 RAM 用户只授予 CDT 查询、ECS 查询/启停和可选 BSS 查询所需的最小权限。

只读查询 + 实例启停所需的最小策略：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "cdt:ListCdtInternetTraffic",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "bssapi:QueryAccountBalance",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "ecs:DescribeInstances",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:StartInstance",
        "ecs:StopInstance"
      ],
      "Resource": "acs:ecs:<region>:<主账号 UID>:instance/<实例 ID>"
    }
  ]
}
```

#### ARN 里三段占位怎么填

`acs:ecs:<region>:<主账号 UID>:instance/<实例 ID>` 三段都要替换成实际值：

| 占位 | 含义 | 说明 | 示例 |
|---|---|---|---|
| `<region>` | 地域 ID | 目标实例所在地域。可用 `*` 表示对所有地域生效 | `cn-hongkong` |
| `<主账号 UID>` | 阿里云账号 ID | 资源所属的主账号。登录控制台后把鼠标移到右上角头像即可看到。可用 `*` 表示不限制账号 | `1234567890123456` |
| `<实例 ID>` | ECS 实例 ID | 要授权的具体实例，`instance` 后**必须带斜杠 `/`** | `i-bp1234567890abcdef` |

本项目一个账号固定对应一个地域和一台实例，三段都写实际值即可，不必用通配符。
通配符会把权限放大到该账号下达所有地域/实例，与「一账号一实例」的模型不符：

```json
"Resource": "acs:ecs:cn-hongkong:1234567890123456:instance/i-bp1234567890abcdef"
```

需要授权多台实例时，`Resource` 写成数组：

```json
"Resource": [
  "acs:ecs:cn-hongkong:1234567890123456:instance/i-bp1111111111abcdef",
  "acs:ecs:cn-hangzhou:1234567890123456:instance/i-bp2222222222abcdef"
]
```

`bssapi:QueryAccountBalance` 是可选的 —— 不授权时余额一栏显示 `—`
（通知里显示「未知」），其余功能不受影响，适合不想让程序读财务数据的场景。

`ecs:DescribeInstances` 不能省：启停接口内部会先校验实例状态。
若实例在 VPC 内且报权限错误，再补 `vpc:DescribeVpcs` 等基础网络查询权限。

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
cargo test                                                    # 92 个单元测试
cargo clippy --target wasm32-unknown-unknown -- -D warnings
bun run typecheck:web
bun run check:config
bun run build
```

本地触发 Cron：

```bash
curl http://localhost:8787/cdn-cgi/local/scheduled
```
