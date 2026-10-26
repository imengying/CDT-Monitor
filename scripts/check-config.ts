#!/usr/bin/env bun
/**
 * wrangler.toml 结构校验
 * ============================================================================
 * 校验必需段落的存在与取值，缺失即退出非零。
 *
 * 这些段落缺失时 Worker 仍能部署成功，但会在运行时失败。例如缺少
 * `[assets]` 会使 `env.assets("ASSETS")` 无绑定，所有静态资源请求返回错误，
 * 且仅在打开页面时暴露。
 *
 * 运行：`bun run check:config`；`bun run build` 会先执行本脚本。
 */

import { readFileSync } from "node:fs";

const TOML_PATH = "wrangler.toml";

/** 最小 TOML 读取：只解析我们关心的段落，不引第三方依赖。 */
function readToml(path: string): string {
  return readFileSync(path, "utf8");
}

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly hint: string;
}

function main(): void {
  const raw = readToml(TOML_PATH);
  const checks: Check[] = [];

  // --- 静态资源绑定 ---
  checks.push({
    name: "[assets] 段存在",
    ok: /^\[assets\]/m.test(raw),
    hint: "缺失时页面会报「静态资源不可用」：env.assets('ASSETS') 拿不到绑定",
  });
  checks.push({
    name: "[assets].binding = \"ASSETS\"",
    ok: /^\[assets\][\s\S]*?^binding\s*=\s*"ASSETS"/m.test(raw),
    hint: "Rust 侧用 env.assets(\"ASSETS\") 取绑定，名字必须一致",
  });
  checks.push({
    name: "[assets].directory 指向 web/dist",
    ok: /^\[assets\][\s\S]*?^directory\s*=\s*"\.\/web\/dist"/m.test(raw),
    hint: "构建脚本把前端产物输出到 web/dist",
  });
  checks.push({
    name: "[assets].run_worker_first 含 /api/*",
    ok: /run_worker_first\s*=\s*\[[^\]]*"\/api\/\*"/.test(raw),
    hint: "否则 API 请求可能被 SPA 回退吞掉",
  });

  // --- Worker 名称 ---
  //
  // 名称必须与仓库里其它地方一致（Cargo.toml / package.json / D1 库名）。
  // 改名后若只改了一处，Cloudflare 会在构建时提示配置不一致，并可能
  // 自动提 PR 覆盖；这里提前拦住。
  checks.push({
    name: 'name = "cdt-monitor"',
    ok: /^name\s*=\s*"cdt-monitor"\s*$/m.test(raw),
    hint: "Worker 名需与 Cargo.toml、package.json、D1 database_name 保持一致",
  });

  // --- 兼容日期 ---
  //
  // 决定 Workers 运行时行为的时间锚点。缺失或格式错误会被 wrangler 拒绝，
  // 但写成未来日期时 wrangler 只在部署时才报错，这里提前校验格式。
  checks.push({
    name: "compatibility_date 为合法日期",
    ok: /^compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"\s*$/m.test(raw),
    hint: "格式应为 YYYY-MM-DD，且不晚于当前日期",
  });

  // --- D1 绑定 ---
  checks.push({
    name: "[[d1_databases]] 绑定名为 DB",
    ok: /^\[\[d1_databases\]\][\s\S]*?^binding\s*=\s*"DB"/m.test(raw),
    hint: "Rust 侧 env.d1(\"DB\")",
  });
  checks.push({
    name: "D1 database_name = cdt-monitor",
    ok: /^\[\[d1_databases\]\][\s\S]*?^database_name\s*=\s*"cdt-monitor"/m.test(raw),
    hint: "必须与 scripts/deploy.ts 里自动创建的库名一致",
  });

  // --- Cron ---
  checks.push({
    name: "[triggers] 含 */15 定时",
    ok: /crons\s*=\s*\[[^\]]*"\*\/15 \* \* \* \*"/.test(raw),
    hint: "巡检依赖 Cron，缺失则不会自动采集/熔断",
  });

  // --- 入口 ---
  checks.push({
    name: "main 指向 build/worker/shim.mjs",
    ok: /^main\s*=\s*"build\/worker\/shim\.mjs"/m.test(raw),
    hint: "worker-build 的产物路径",
  });

  // --- 默认安静 ---
  checks.push({
    name: "observability 默认关闭",
    ok: /^\[observability\][\s\S]*?^enabled\s*=\s*false/m.test(raw),
    hint: "按需打开，避免持续产生日志费用",
  });
  // 运行时只应有三个 Secret，其余配置都在 D1。若再次引入 [vars]，
  // 说明有配置被放回了需要重新部署才能改的地方。
  checks.push({
    name: "无 [vars] 段（配置全部存 D1）",
    ok: !/^\[vars\]/m.test(raw),
    hint: "只有 MASTER_KEY / ADMIN_USERNAME / ADMIN_PASSWORD 走 Secret，其余在后台设置",
  });

  // --- 跨文件名称一致性 ---
  //
  // 这三处任一不同步，都会在 Cloudflare 侧表现为「配置与仓库不一致」。
  const nameIn = (file: string, pattern: RegExp): string | null => {
    try {
      const text = readFileSync(file, "utf8");
      return text.match(pattern)?.[1] ?? null;
    } catch {
      return null;
    }
  };

  const workerName = raw.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const crateName =
    nameIn("Cargo.toml", /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
  const pkgName = nameIn("package.json", /"name"\s*:\s*"([^"]+)"/);

  checks.push({
    name: "Cargo.toml 的 crate 名与 Worker 名一致",
    ok: workerName !== null && crateName === workerName,
    hint: `wrangler.toml=${workerName ?? "?"}，Cargo.toml=${crateName ?? "?"}`,
  });
  checks.push({
    name: "package.json 的 name 与 Worker 名一致",
    ok: workerName !== null && pkgName === workerName,
    hint: `wrangler.toml=${workerName ?? "?"}，package.json=${pkgName ?? "?"}`,
  });

  let failed = 0;
  for (const check of checks) {
    if (check.ok) {
      console.log(`\x1b[32m✔\x1b[0m ${check.name}`);
    } else {
      failed += 1;
      console.log(`\x1b[31m✘ ${check.name}\x1b[0m`);
      console.log(`    ${check.hint}`);
    }
  }

  console.log("");
  if (failed > 0) {
    console.error(`\x1b[1;31m配置自检失败：${failed} 项\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[1;32m配置自检通过（${checks.length} 项）\x1b[0m`);
}

main();
