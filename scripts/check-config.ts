#!/usr/bin/env bun
/**
 * 配置自检
 * ============================================================================
 * 部署前把 `wrangler.toml` 里几个**删了会静默失败**的段落核对一遍。
 *
 * 背景：`[assets]` 段一旦缺失，Worker 仍然能部署成功，但所有静态资源请求
 * 都会返回「静态资源不可用」——因为 `env.assets("ASSETS")` 拿不到绑定。
 * 这类问题只有打开页面才会发现，因此放进 CI 提前拦。
 *
 * 运行：`bun run check:config`（`bun run build` 也会先跑它）
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
    name: "[triggers] 含 */5 定时",
    ok: /crons\s*=\s*\[[^\]]*"\*\/5 \* \* \* \*"/.test(raw),
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
  checks.push({
    name: "LOG_LEVEL 默认 error",
    ok: /^LOG_LEVEL\s*=\s*"error"/m.test(raw),
    hint: "正常巡检不应输出流程日志",
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
