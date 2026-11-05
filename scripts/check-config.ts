#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

const config = Bun.TOML.parse(readFileSync('wrangler.toml', 'utf8')) as any
const crate = Bun.TOML.parse(readFileSync('Cargo.toml', 'utf8')) as any
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const webPkg = JSON.parse(readFileSync('web/package.json', 'utf8'))
const nodeVersion = readFileSync('.node-version', 'utf8').trim()
const date = config.compatibility_date
const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
  && date <= new Date().toISOString().slice(0, 10)
const checks: [string, boolean][] = [
  ['Node 26 构建版本一致', /^26\.\d+\.\d+$/.test(nodeVersion) && pkg.engines.node === `>=${nodeVersion} <27` && webPkg.engines.node === pkg.engines.node],
  ['Node 类型定义使用 26', /^\^26\./.test(webPkg.devDependencies['@types/node'])],
  ['静态资源绑定', config.assets?.binding === 'ASSETS'],
  ['静态资源目录', config.assets?.directory === './web/dist'],
  ['API 优先进入 Worker', config.assets?.run_worker_first?.includes('/api/*') === true],
  ['D1 绑定', config.d1_databases?.some((db: any) => db.binding === 'DB' && db.database_name === 'cdt-monitor') === true],
  ['五分钟巡检', config.triggers?.crons?.includes('*/5 * * * *') === true],
  ['任务队列绑定', config.queues?.producers?.some((q: any) => q.binding === 'TASKS' && q.queue === 'cdt-monitor-tasks') === true],
  ['每次只处理一条队列消息', config.queues?.consumers?.some((q: any) => q.queue === 'cdt-monitor-tasks' && q.max_batch_size === 1) === true],
  ['队列失败保留至死信队列', config.queues?.consumers?.some((q: any) => q.queue === 'cdt-monitor-tasks' && q.dead_letter_queue === 'cdt-monitor-tasks-dlq') === true],
  ['保留应用错误日志', config.observability?.logs?.enabled === true && config.observability?.logs?.head_sampling_rate === 1],
  ['关闭逐请求调用日志', config.observability?.logs?.invocation_logs === false],
  ['部署不重复构建', config.build === undefined],
  ['Rust 定时器兼容', config.compatibility_flags?.includes('no_nodejs_global_timers') === true],
  ['入口', config.main === 'build/worker/shim.mjs'],
  ['兼容日期有效且不晚于今天', validDate],
  ['项目名称一致', config.name === 'cdt-monitor' && crate.package?.name === config.name && pkg.name === config.name],
  ['业务配置存 D1', config.vars === undefined],
]
for (const [name, passed] of checks) console.log(`${passed ? '✔' : '✘'} ${name}`)
if (checks.some(([, passed]) => !passed)) process.exit(1)
console.log(`配置自检通过（${checks.length} 项）`)
