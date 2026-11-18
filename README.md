# CDT Monitor (Worker)

运行在 Cloudflare Workers 上的阿里云 CDT 流量监控与 ECS 控制面板。可以查看本月公网出流量、余额和实例状态，按用量停机，也可以让多台实例共用一个服务域名。项目参考了 [wang4386/CDT-Monitor](https://github.com/wang4386/CDT-Monitor)。

## Cron + DDNS + 负载均衡

假设两个阿里云账号各有一台 ECS，运行同一服务，公网 IPv4 各不相同。用户始终访问 `app.example.com`。Cron 每 5 分钟巡检一次，按各实例的计划开关机，并检查账号用量。DDNS 根据阿里云返回的运行状态更新域名的 A 记录。

| 实例发生了什么 | `app.example.com` 的 A 记录 |
| --- | --- |
| A 在运行，B 尚未到开机时间 | 只有 A 的 IP |
| B 按 `0 9 * * *` 每天 09:00 开机，巡检确认已运行 | A 和 B 的 IP，客户端可连接任一台 |
| A 的账号达到流量阈值，巡检按「停机并通知」关机并确认已停止 | 移除 A 的 IP，B 继续提供服务 |
| A 解除流量限制后再次开机，巡检确认已运行 | 自动补回 A 当前的 IP |

这样可以用 Cron 安排不同账号的实例交替运行，也可以让它们同时分担流量。要在某台停机后继续提供服务，需提前安排另一台运行。记录使用 Cloudflare 的「仅 DNS」模式，TTL 为 300 秒，缓存到期前客户端仍可能拿到旧地址。[Cloudflare DNS 轮询说明](https://developers.cloudflare.com/dns/manage-dns-records/how-to/round-robin-dns/)

**启用方法**

1. 在「控制台设置 → DDNS」填写 Cloudflare Zone ID、完整域名和 API Token。给 Token 授予该域名所在 Zone 的 DNS 编辑权限。
2. 在「控制台设置 → 实例」添加或编辑每台 ECS，打开「启用该实例」和「停机模式」右侧的「负载均衡」。每台实例可单独选「每日时间」或填写「Cron 表达式」（分、时、日、月、周）。开关机时间按「系统」页设置的时区执行。
3. 需要按流量停机时，将「告警阈值（GB）」设为正数，「超限动作」选「停机并通知」。阈值比较的是该阿里云账号在实例所属地域额度池的本月累计用量。同一主账号、同一额度池的实例共享这份用量。

实例正在开关机或本轮状态查询失败时，DDNS 等待下次确认。关闭「负载均衡」后，已有记录会保留。旧版用户若曾在实例里配置 DNS 联动，请在「DDNS」重新填写配置，并核对旧域名的 A 记录。

## 部署到 Cloudflare

1. 将仓库 Fork 到自己的 GitHub。在 Cloudflare 的「Workers 和 Pages」中创建 Worker，连接该仓库，构建命令填 `bun run build`，部署命令填 `bun run deploy`。
2. 构建变量 `BUN_VERSION` 填 `1.4.4`。Node 默认读取仓库指定的版本，若已设置 `NODE_VERSION`，请确保与 `.node-version` 一致。[package.json](package.json) · [.node-version](.node-version)
3. 点击部署。脚本会创建 D1 数据库、任务队列和死信队列，应用数据库迁移并发布 Worker。自备构建 API Token 时，需授予 D1、Workers Scripts 和 Queues 编辑权限。
4. 在已部署 Worker 的「设置 → 变量和密钥」中添加以下三项，类型均选 **Secret**。保存并部署后，打开 Worker 地址登录面板。

| 运行时密钥 | 填写内容 |
| --- | --- |
| `MASTER_KEY` | 在本机运行 `openssl rand -hex 32`，填入输出的 64 个十六进制字符 |
| `ADMIN_USERNAME` | 面板管理员用户名 |
| `ADMIN_PASSWORD` | 面板管理员密码 |

请备份 `MASTER_KEY` 并在后续部署中沿用。面板用它解密已保存的云账号、DDNS、通知及人机校验凭据，也用它校验登录会话。

## 授权并添加阿里云实例

1. 在阿里云 RAM 中创建专用用户，启用 AccessKey 访问并保存生成的 AccessKey ID 和 AccessKey Secret。[国内站用户管理](https://ram.console.aliyun.com/users) · [国际站用户管理](https://ram.console.alibabacloud.com/users)
2. 创建自定义权限策略，选择「脚本编辑」，粘贴下方 JSON。将最后一项中的 `<region>`、`<主账号 UID>` 和 `<实例 ID>` 换成实际值。管理多台 ECS 时，`Resource` 可填各实例资源标识组成的数组。[国内站权限策略](https://ram.console.aliyun.com/policies) · [国际站权限策略](https://ram.console.alibabacloud.com/policies)

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cdt:ListCdtInternetTraffic",
        "bssapi:QueryAccountBalance",
        "ecs:DescribeInstances",
        "ecs:DescribeNetworkInterfaces"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:StartInstance", "ecs:StopInstance"],
      "Resource": "acs:ecs:<region>:<主账号 UID>:instance/<实例 ID>"
    }
  ]
}
```

3. 回到 RAM 用户列表，选择该用户，点击「新增授权」并绑定刚创建的策略。
4. 登录面板，在「控制台设置 → 实例」点击「添加实例」，选择站点和地域，填写 RAM 用户的 AccessKey 和 ECS 实例 ID。保存后刷新，在实例卡片核对状态与公网地址。实例详情缺少 IPv6 时，面板会查询已挂载的主、副网卡，所需权限为 `ecs:DescribeNetworkInterfaces`。

## 日常使用

- **采集与告警**　流量与实例状态每 5 分钟采集一次，余额每 30 分钟更新，手动刷新可立即查询。首页可按小时或天查看流量趋势。阈值填 `0` 可关闭流量告警，选择「仅通知」可在超限时继续运行。
- **启停与保活**　设定的时间落在两轮巡检之间时，下一轮会检查并执行到期计划。开关机指令提交后，卡片显示「启动中」或「停止中」，页面在前台时每分钟刷新概览。抢占式实例可在允许运行的时段自动拉起，如需手动保持停机，先关闭保活。
- **通知与日报**　在「Telegram」或「Bark」配置推送渠道，再到「日报」启用每日推送、选择时间，也可以点击「推送测试」查看效果。
- **排查与登录管理**　采集失败时，面板保留上次成功的数据，可到「日志」查看原因。「人机校验」可启用 Turnstile。登录会话有效期为 7 天，可在「登录设备」中让指定设备退出。

## 本地运行

安装 Node、Bun 和 Rust（rustup），Node 和 Bun 版本同上。先安装依赖并复制本地配置。

```bash
bun install --frozen-lockfile
bun run install:web
cp .dev.vars.example .dev.vars
```

在 `.dev.vars` 填入上面的三项运行时密钥，然后初始化本地 D1 并启动服务。

```bash
bun run db:migrate:local
bun run dev
```

打开 `http://localhost:8787`。需要前端热更新时，另开终端运行 `bun run dev:web` 并访问 `http://localhost:5173`。发布前可运行 `bun run build` 完成构建和测试。
