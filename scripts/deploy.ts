#!/usr/bin/env bun
/**
 * 部署脚本：建库 → 迁移 → 发布。
 * ============================================================================
 * `bun run deploy` 执行本脚本，也是 Cloudflare 控制台的 **Deploy command**。
 *
 * 三个步骤均可重复执行：
 *   1. 创建 D1 库，已存在则跳过
 *   2. 应用 `migrations/` 下未执行的 SQL（D1 记录已执行的文件名）
 *   3. `wrangler deploy`
 *
 * `wrangler.toml` 不写 `database_id`，由 wrangler 按 `database_name`
 * 解析绑定，首次部署无需先在控制台建库并回填 id。
 */

import { spawnSync } from "node:child_process";

/** D1 数据库名，必须与 wrangler.toml 的 database_name 一致。 */
const DATABASE = "cdt-monitor";

const log = (msg: string) => console.log(`\n\x1b[1;34m==> ${msg}\x1b[0m`);
const warn = (msg: string) => console.log(`\x1b[1;33m[warn] ${msg}\x1b[0m`);

function run(args: string[], capture = false): { ok: boolean; out: string } {
  const result = spawnSync("bun", ["x", "wrangler", ...args], {
    encoding: "utf8",
    // 不 capture 时让 wrangler 直接输出，保留它的进度提示。
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * 确保 D1 存在。
 *
 * 直接执行 `d1 create` 并按输出判断结果，不先 `d1 list`：list 输出为
 * 带颜色码的人读表格，依其格式判断不可靠。create 幂等，库已存在时返回
 * 「already exists」，视为成功继续。并发部署下后到的构建同样命中此分支。
 */
function ensureDatabase(): void {
  log(`确保 D1 数据库 ${DATABASE} 存在`);

  const created = run(["d1", "create", DATABASE], true);

  if (created.ok) {
    console.log("    创建成功");
    return;
  }

  const out = created.out;
  if (/already exists|已存在|已经存在|duplicate/i.test(out)) {
    console.log("    已存在，继续");
    return;
  }

  // 没登录 / 缺 token 是最常见的失败原因，单独给出可操作提示
  if (/CLOUDFLARE_API_TOKEN|not authenticated|wrangler login/i.test(out)) {
    console.error(out.trim());
    throw new Error(
      "缺少 Cloudflare 凭证。连接 GitHub 部署时 Cloudflare 会自动注入；" +
        "本地执行请先 `bunx wrangler login` 或设置 CLOUDFLARE_API_TOKEN。",
    );
  }

  // 把 wrangler 的原始输出完整打出来，否则用户只能看到一句「失败了」
  console.error(out.trim());
  throw new Error("创建 D1 数据库失败");
}

/** 应用未执行的迁移。首次部署时在这里建好全部表。 */
function migrate(): void {
  log("应用数据库迁移");
  if (!run(["d1", "migrations", "apply", "DB", "--remote"]).ok) {
    throw new Error("应用数据库迁移失败");
  }
}

/** 发布 Worker。 */
function deploy(): void {
  log("发布 Worker");
  if (!run(["deploy"]).ok) {
    throw new Error("wrangler deploy 失败");
  }
}

/** 部署后提示必填的运行时 Secret。 */
function remindSecrets(): void {
  console.log(
    [
      "",
      "\x1b[1;33m运行时 Secret（Settings → Variables and Secrets，均为 Secret）\x1b[0m",
      "",
      "  MASTER_KEY      openssl rand -hex 32",
      "  ADMIN_USERNAME  管理员用户名",
      "  ADMIN_PASSWORD  管理员密码",
      "",
      "其余配置（阿里云账号、人机校验、通知、日报、时区）在网页「设置」中维护。",
    ].join("\n"),
  );
}

function main(): void {
  ensureDatabase();
  migrate();
  deploy();
  log("部署完成");
  remindSecrets();
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n\x1b[1;31m部署失败：${message}\x1b[0m`);
  warn("若提示 D1 未绑定，请确认 wrangler.toml 的 database_name 与上面创建的名字一致。");
  process.exit(1);
}
