# CDT Monitor (Worker)

![Rust](https://img.shields.io/badge/Rust-2024_Edition-black?logo=rust)
![WebAssembly](https://img.shields.io/badge/Target-wasm32-654FF0?logo=webassembly)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers_%26_D1-F38020?logo=cloudflare)
![TypeScript](https://img.shields.io/badge/Frontend-Vanilla_TS_%2B_ECharts-3178C6?logo=typescript)

阿里云 **CDT 流量监控** 与 **ECS 自动化控制**面板，运行在 Cloudflare Workers 上。
参考 [`wang4386/CDT-Monitor`](https://github.com/wang4386/CDT-Monitor) 的业务语义，
实现为 **Rust/Wasm + D1 + Cron Triggers + Turnstile**，前端为无框架纯 TypeScript。

```
┌───────────────────────────────────────────────────────────────────┐
│  Cloudflare 边缘                                                  │
│                                                                   │
│  纯 TypeScript 前端 (DOM + ECharts)              ← ASSETS 绑定    │
│         │ fetch /api/v1/*（同源 Cookie）                          │
│         ▼                                                         │
│  Worker (Rust → Wasm)                                             │
│    ├─ fetch:     路由 + 登录 + Cookie 鉴权                        │
│    ├─ scheduled: */15 * * * * 巡检                                │
│    └─ wait_until: 异步 Job（刷新 / 开关机 / 通知测试 / 日报）     │
│         │                                                         │
│         ├─ D1：accounts / snapshots / history / jobs / logs       │
│         └─ fetch → 阿里云 RPC（CDT / ECS / BSS）                  │
│                       Telegram · Bark                             │
└───────────────────────────────────────────────────────────────────┘
```

## 核心特性

- **流量采样与熔断**：每 15 分钟采集 CDT 公网流量与账户余额，按小时 / 天查看 ECharts
  趋势，达到阈值自动告警或停机止损。
- **实例自动化控制**：面板手动启停、每日定时开关机、抢占式实例自动保活拉起。
- **多渠道推送**：Telegram 与 Bark，覆盖超限熔断、保活拉起与每日流量日报。
- **纵深安全**：AK Secret 与推送凭据经 XChaCha20-Poly1305 加密落盘，配合 Turnstile、
  常量时间比对、设备会话管理与跨站请求拦截。

---

## 一、准备阿里云子账号

需要一对 AccessKey 才能读流量、查实例、按阈值停机。不要用主账号的 AccessKey。

### 1. 创建 RAM 子账号

1. 进入阿里云 RAM 用户控制台（[🇨🇳 国内站](https://ram.console.aliyun.com/users) | [🌍 国际站](https://ram.console.alibabacloud.com/users)），点 **创建用户**。
2. 填写登录名称（例如 `cdt-monitor`），访问方式勾选 **「使用永久 AccessKey 访问」**。
3. 创建完成后，把页面上生成的 **AccessKey ID** 和 **AccessKey Secret** 复制保存下来，后面填进 CDT-Monitor 就用这两个值。

### 2. 创建自定义权限策略

官方预置的系统策略权限过宽，这里写一份最小权限策略。

1. 前往权限策略控制台（[🇨🇳 国内站](https://ram.console.aliyun.com/policies) | [🌍 国际站](https://ram.console.alibabacloud.com/policies)），点 **创建权限策略**。
2. 切到 **脚本编辑** 标签页，清空默认内容，粘贴：

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

> [!NOTE]
> **`bssapi:QueryAccountBalance` 可能提示「无效授权」**：忽略即可，实测余额可以正常
> 查到。删掉这一行也不影响其他功能，只是余额一栏显示 `—`。
>
> **`ecs:DescribeInstances` 不能省**：启停接口内部会先校验实例状态。若实例在 VPC 内
> 且报权限错误，再补 `vpc:DescribeVpcs` 等基础网络查询权限。

### 3. 替换成你的实例信息

最后一段的 `acs:ecs:<region>:<主账号 UID>:instance/<实例 ID>` 用来限制子账号只能开关
指定的机器，三个占位符都要换成实际值：

| 占位符 | 含义 | 去哪找 | 示例 |
|---|---|---|---|
| `<region>` | 地域 ID | 目标 ECS 所在的地域代号 | `cn-hongkong` |
| `<主账号 UID>` | 阿里云账号 ID | 鼠标移到控制台右上角头像即可看到 | `1234567890123456` |
| `<实例 ID>` | ECS 实例 ID | `instance` 后面**必须保留斜杠 `/`** | `i-bp1234567890abcdef` |

本项目是「一个账号对应一个地域和一台实例」，直接写死：

```json
"Resource": "acs:ecs:cn-hongkong:1234567890123456:instance/i-bp1234567890abcdef"
```

要用同一个子账号管理多台机器时，`Resource` 改成数组：

```json
"Resource": [
  "acs:ecs:cn-hongkong:1234567890123456:instance/i-bp1111111111abcdef",
  "acs:ecs:cn-hangzhou:1234567890123456:instance/i-bp2222222222abcdef"
]
```

### 4. 绑定到子账号

1. 回到 **RAM 用户列表**，找到刚才创建的账号，点右侧 **新增授权**。
2. **授权范围** 保持默认的「账号级别」。
3. 在 **权限策略** 里切到「自定义策略」，搜索并勾选刚建的策略，确认授权。

完成后，保存好 AK/SK 和实例 ID，配置 CDT-Monitor 时会用到。

---

## 二、部署到 Cloudflare

### 1. 连接仓库

**Workers 和 Pages** → **创建应用**（Create）→ **Workers** →
**从 GitHub 导入**（Connect with GitHub），选中本仓库，填两项：

| 项 | 值 |
|---|---|
| 构建命令（Build command） | `bun run build` |
| 部署命令（Deploy command） | `bun run deploy` |

### 2. 设置 `BUN_VERSION`

展开 **高级设置**（Advanced settings），添加一个构建变量：

| 变量名 | 变量值 |
|---|---|
| `BUN_VERSION` | `1.4.4` |

> [!IMPORTANT]
> 这一项**必须配**。Cloudflare 构建镜像预装的是 Bun 1.2.5，不指定版本就会用旧版编译，
> 可能直接失败。`build-ci.sh` 检测到版本不符会自行装指定版本；完全没设时脚本直接报错退出。

### 3. 部署

点 **部署**（Deploy）。`deploy.ts` 会依次完成：建 D1 库、执行 `migrations/`
下未应用的 SQL、上传 Worker。

`wrangler.toml` 里不写 `database_id`，由 `database_name` 在部署时解析，所以首次
部署不需要手动建库。

### 4. 配置运行时变量和密钥

**第一次部署完成之后**再进行这一步。

**设置**（Settings）→ **运行时变量和密钥**（Variables and Secrets），添加三项，
类型都选 **密钥**（Secret）：

| 名称 | 值 |
|---|---|
| `MASTER_KEY` | 见下方说明 |
| `ADMIN_USERNAME` | 你自己定的管理员用户名 |
| `ADMIN_PASSWORD` | 你自己定的管理员密码 |

添加完点 **部署** 使配置生效。

#### `MASTER_KEY` 怎么填

**它不是让你手写的一串固定值**，而是随机生成的一段密钥。在任意一台装有 OpenSSL
的电脑上执行：

```bash
openssl rand -hex 32
```

会输出 64 个十六进制字符，例如：

```
9f3c1a7e4b2d8f605a9e7c3b1d4f8a2e6c9b0d3f5a8e1c4b7d2f9a6e3c0b5d81
```

把这串完整复制，粘贴到 `MASTER_KEY` 的值里。**不要**把命令本身填进去。

没有 OpenSSL 时，任意 32 字节的随机串也可以（64 位 Hex、44 位 Base64 均可）；
随手编一串短字符串虽然能启动，但强度不够，不建议。

`ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 是登录后台用的账号密码，自己定即可。
修改后 Cloudflare 会自动重启 Worker，新值立即生效。

> [!WARNING]
> 改了 `MASTER_KEY` 会让已存的密文全部解不开，需要到设置页把每个实例的
> AccessKey Secret 重填一遍。

---

## 三、技术说明

以下几节给维护者看，普通部署不需要读。

### 日志与可观测性

| 项目 | 默认 | 调整方式 |
|---|---|---|
| 应用日志 | 仅 `error` | 设置 → 系统 → 日志级别 |
| Workers Logs | 关闭 | `wrangler.toml` 的 `[observability] enabled`，或控制台开关 |

```text
error  解密失败、D1 不可用、任务失败
warn   通知发送失败、动作后刷新失败
info   Cron 汇总、任务完成、保活拉起实例
debug  同 info
```

---

### 目录结构

```
cdt-monitor/
├── Cargo.toml                  # Rust 2024，cdylib → wasm32
├── wrangler.toml               # D1 / Assets / Cron / 构建入口
├── package.json                # 根脚本（Bun）
├── rust-toolchain.toml
├── .dev.vars.example           # 本地开发变量模板
├── scripts/
│   ├── build-ci.sh             # 构建入口：校验配置 → 装工具链 → 构建
│   ├── check-config.ts         # wrangler.toml 结构校验
│   └── deploy.ts               # 部署入口：建库 → 迁移 → 发布
├── migrations/
│   └── init_001.sql            # 9 张表 + 12 个索引
├── src/
│   ├── lib.rs                  # fetch / scheduled 入口、路由、鉴权、Job 执行器
│   ├── models.rs               # D1 实体行 + 前后端 DTO + 时区/单位换算
│   ├── db.rs                   # D1 SQL 封装（含幂等锁）
│   ├── crypto.rs               # XChaCha20-Poly1305、无状态 Token
│   ├── logging.rs              # 分级日志（默认只输出 error）
│   ├── aliyun.rs               # RPC V1 签名器 + CDT/ECS/BSS 客户端
│   ├── notify.rs               # Telegram + Bark
│   └── scheduler.rs            # 采样 / 熔断 / 定时开关机 / 保活 / 日报
└── web/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html              # 以 render=explicit 引入 Turnstile
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口
        ├── App.ts              # 主控制台
        ├── style.css           # 主题令牌与组件语义类
        ├── env.d.ts            # Turnstile 类型声明
        ├── api/client.ts       # API 客户端 + 202 Job 轮询
        ├── lib/
        │   ├── dom.ts          # el() / iconSvg() 等 DOM 工具
        │   ├── icons.ts        # 按需引入的 lucide 图标
        │   ├── echarts.ts      # 按需注册的 ECharts 模块（动态 import）
        │   ├── store.ts        # 状态容器 + toast
        │   └── actions.ts      # API 调用与状态写入
        └── components/
            ├── LoginModal.ts   # 登录卡片 + Turnstile
            ├── AccountCard.ts  # 账号卡片 + 实例控制
            ├── HistoryModal.ts # ECharts 历史流量弹窗
            ├── SettingsModal.ts # 设置弹窗（6 个标签页）
            ├── LogDrawer.ts    # 操作与审计日志抽屉
            └── ToastStack.ts   # 提示条容器
```

前端为纯 TypeScript 类组件，直接操作 DOM，不依赖任何框架。

---

### 本地开发

#### 1. 安装工具链与依赖

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
bun install
bun run install:web
```

#### 2. 初始化本地环境

```bash
cp .dev.vars.example .dev.vars
bun run db:migrate:local
```

本地 D1 位于 `.wrangler/state/`，与线上隔离。

#### 3. 启动

```bash
bun run dev                      # 构建前端 + wrangler dev（:8787）
```

前端独立热更新（`/api` 代理到 8787，保持 Cookie 同源）：

```bash
bun run dev:web                  # :5173
```

---

### 配置分布

| 类别 | 存放位置 | 内容 |
|---|---|---|
| 运行时密钥 | 设置 → 运行时变量和密钥 | `MASTER_KEY`、`ADMIN_USERNAME`、`ADMIN_PASSWORD` |
| 构建变量 | 设置 → 构建 → 高级设置 | `BUN_VERSION` |
| 业务配置 | D1，设置页面 | 阿里云账号、Turnstile、Telegram、Bark、日报、时区、日志级别等 |

`wrangler.toml` 不含 `[vars]` 段。业务配置改动即时生效，无需重新部署。

---

### 安全模型

#### 凭据加密

```
明文  ──XChaCha20-Poly1305(随机 24B Nonce)──▶  Base64(Nonce ‖ 密文 ‖ 16B Tag)  ──▶  D1 TEXT
```

* 算法 `chacha20poly1305::XChaCha20Poly1305`，192 位 Nonce
* 主密钥解析顺序：64 字符 Hex → Base64（三种变体）→ 恰 32 字节原文 → `blake3::derive_key`
* 任一字节被篡改都会导致 AEAD 认证失败并返回明确错误

#### 管理员认证

| 环节 | 实现 |
|---|---|
| 人机校验 | Turnstile `siteverify`，携带 `CF-Connecting-IP` 作为 `remoteip`；前端 `appearance: 'interaction-only'`，无交互需求时不渲染可见元素 |
| 开关 | 未配置 Site Key 与 Secret Key 时不校验；启用后私钥解密失败返回 `turnstile_broken` 并拒绝登录 |
| 凭证来源 | `ADMIN_USERNAME` / `ADMIN_PASSWORD`，唯一来源 |
| 比较方式 | 用户名与密码均常量时间比较且不短路 |
| 防枚举 | 用户名错与密码错返回同一提示，延迟一致 |
| 会话 | `v1.<payload>.<sig>`，`HMAC-SHA256(MASTER_KEY)` 签名，payload 含 `iat` / `exp` / `jti` |
| 传输 | `HttpOnly; Secure; SameSite=Strict` Cookie |

#### 纵深防御

* 写接口校验 `Sec-Fetch-Site` / `Origin` / `Referer`，拒绝跨站请求
* 所有文本经 `textContent` 写入，不拼接 `innerHTML`；仅静态 SVG 内联
* 响应统一携带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Cache-Control: no-store`

---

### 业务逻辑

#### Cron（`*/15 * * * *`）

```
1. housekeeping（每日一次，锁保护）
     清理过期锁 / 32 天前历史 / 32 天前日志 / 7 天前 Job
2. 逐账号：CDT 流量 + 余额 + 该地域 ECS 实例 → 写快照 → 采样历史
3. 额度判定：任一池（内地 / 非内地）超出各自额度
     首次超限 → 标记账期 + 通知 [+ 停机（stop_and_notify）]
4. 定时关机（60 分钟窗口，失败下轮重试）
5. 定时开机（同窗口，受熔断闸门约束）
6. 抢占式保活（见下方闸门）
7. 每日日报（60 分钟窗口，当天仅一次）
```

窗口取 60 分钟：巡检间隔 15 分钟，一次网络抖动后下一轮还能补上。

#### 抢占式保活

阿里云不提供区分「系统回收」与「用户手动停机」的字段 —— 两者都是
`Status == Stopped`；`OperationLocks` 只在回收前 5 分钟标记，比巡检间隔
还短、抓不住。因此靠四个前置条件收窄（与上游一致，任一不满足即跳过）：

1. 账号级与实例级保活开关都开启
2. 当前处于「允许运行时段」（只配关机时间时，关机后即不再保活）
3. 未触发流量熔断
4. 今天还没执行过定时关机

> [!WARNING]
> 在允许运行时段内手动停止已开启保活的实例，必须先在面板关闭该实例的保活开关，
> 否则下一次 Cron 巡检会将它重新拉起。

#### 优先级

```
流量熔断停机  >  抢占式保活  >  定时开机
```

当月已熔断且策略为 `stop_and_notify` 时，保活、定时开机、手动开机均不会拉起实例。
`notify_only` 不停机，不参与闸门。

#### 采集失败的处理

* CDT 查询失败 → 沿用上次快照流量值，不写 0
* 余额查询失败 → 沿用上次快照
* 实例查询失败 → 沿用该账号旧实例，卡片不会变空
* 逐实例保活开关 → 按 `instance_id` 从旧快照继承

#### 异步 Job

写接口返回 `202 Accepted + { job_id }`，前端轮询 `GET /api/v1/jobs/{job_id}`：

```json
{ "id": "uuid", "job_type": "start_instance", "status": "pending|running|success|failed",
  "error_msg": null, "created_at": 1792948752627, "finished_at": null }
```

刷新类任务以 D1 锁跨实例互斥（owner = `job_id`，收尾按 owner 释放），
并发提交返回 `409 job_locked`。

---

### API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/auth/session` | 会话探测（公开，返回 Turnstile site key，未启用时为空串） |
| `POST` | `/api/v1/auth/login` | 登录（用户名 + 密码，可选 Turnstile） |
| `POST` | `/api/v1/auth/logout` | 退出 |
| `GET` | `/api/v1/overview[?refresh=transitional]` | 首页数据（读快照表；`transitional` 时补采一次） |
| `GET` | `/api/v1/history?account_id` | 流量历史（小时 25 条 + 日 31 条一次返回） |
| `GET` | `/api/v1/logs?account_id&action&q&limit` | 操作日志（类型前缀 + 关键字） |
| `DELETE` | `/api/v1/logs?account_id&action&q` | 按同一套条件清空日志 |
| `GET` | `/api/v1/jobs[/{id}]` | 任务状态 |
| `POST` | `/api/v1/refresh` | 刷新全部 → 202 |
| `POST` | `/api/v1/accounts` | 新增账号 |
| `PUT/DELETE` | `/api/v1/accounts/{id}` | 修改 / 删除账号 |
| `POST` | `/api/v1/accounts/{id}/refresh` | 刷新单账号 → 202 |
| `POST` | `/api/v1/accounts/{id}/instances/{iid}/start` / `stop` | 开机 / 关机 → 202 |
| `PUT` | `/api/v1/accounts/{id}/instances/{iid}/keep-alive` | 逐实例保活开关 |
| `GET` | `/api/v1/settings` | 全部设置（脱敏） |
| `PUT` | `/api/v1/settings/{module}` | 更新设置，`module` 为 `turnstile` / `telegram` / `bark` / `daily-report` / `timezone` / `advanced` |
| `GET` | `/api/v1/sessions` | 登录设备 |
| `DELETE` | `/api/v1/sessions[/{sid}]` | 踢下线（指定 / 其它全部） |
| `POST` | `/api/v1/settings/notify-test` | 测试通知 → 202 |
| `POST` | `/api/v1/reports/daily` | 立即推送日报 → 202 |

错误体格式 `{ "error": "...", "code": "..." }`，`code` 取值：

`unauthenticated` · `invalid_credentials` · `credentials_not_configured` ·
`turnstile_failed` · `turnstile_unavailable` · `turnstile_broken` ·
`cross_origin` · `job_locked` · `init_failed` · `internal_error`

---

### 数据模型

| 表 | 用途 |
|---|---|
| `settings` | KV 配置（时区、日报、TG/Bark 密文、Turnstile 密文） |
| `accounts` | 阿里云账号（AK、加密 Secret、地域、实例 ID、告警阈值、策略、定时、保活） |
| `account_snapshots` | 每账号一行最新状态，首页只读此表 |
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

### 阿里云接口

| 用途 | Action | Version |
|---|---|---|
| CDT 流量 | `ListCdtInternetTraffic` | 2021-08-13 |
| ECS 查询 | `DescribeInstances`（自动翻页，上限 2000 台） | 2014-05-26 |
| ECS 控制 | `StartInstance` / `StopInstance`（含 `StoppedMode`） | 2014-05-26 |
| 余额 | `QueryAccountBalance` | 2017-12-14 |

`ListCdtInternetTraffic` 返回的 `Traffic` 单位是 **Byte**（与计费项 Code
`ECS_Out_Bytes` / `Eip_Out_Bytes` 的底层口径一致），控制台与账单才换算成 GB。
`traffic_unit_is_bytes` 测试钉死这一点。

#### 免费额度与阈值

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

#### RAM 权限的两点补充

完整创建步骤见文首 **一、准备阿里云子账号**，这里只补充容易踩的地方。

`bssapi:QueryAccountBalance` 可以不给 —— 不授权时余额一栏显示 `—`（通知里显示
「未知」），其余功能不受影响，适合不想让程序读财务数据的场景。

> 阿里云文档《QueryAccountBalance》的「授权信息」表写的是 `bss:DescribeAcccount`，
> 实测 `bssapi:QueryAccountBalance` 同样能查，两种写法都可用。

签名遵循 RPC V1（`HMAC-SHA1`），含针对官方样例的回归测试：

```rust
// src/aliyun.rs
assert_eq!(sign("testsecret", &to_sign), "OLeaidS1JvxuMvnyHOwuJ+uX5qY=");
```

重试仅针对可恢复错误（网络失败、HTTP 5xx、`Throttling*`、`ServiceUnavailable`、
`InternalError`），最多 2 次退避（200ms → 600ms）；参数错误与鉴权失败直接返回。

---

### 开发与校验

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
