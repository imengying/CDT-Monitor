#!/usr/bin/env bun
/**
 * 部署脚本：建库 → 迁移 → 发布。
 * ============================================================================
 * `bun run deploy` 执行本脚本，也是 Cloudflare 控制台的 **Deploy command**。
 *
 * 三步都可重复执行（幂等）：
 *   1. D1 不存在就创建（已存在则跳过）
 *   2. 应用 `migrations/` 下未执行的 SQL（D1 自己记录执行过的文件名）
 *   3. `wrangler deploy`
 *
 * 对应 `wrangler.toml` 里刻意**不写** `database_id` 的做法：让 wrangler
 * 按 `database_name` 自动发现/绑定，这样连 Git 仓库首次部署时不需要先去
 * 控制台建库、复制 id、再改配置。
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
 * 策略：**先直接 create，再按失败信息判断**。
 *
 * 为什么不先 `d1 list` 再决定：list 的输出是给人看的表格（还会带
 * 提示文案与颜色码），依赖它的格式做判断太脆。create 则是幂等的 ——
 * 已存在时返回明确的「already exists」，我们把它当作成功即可。
 *
 * 这样还有一个好处：并发部署时两个构建同时 create，后到的那个
 * 拿到 already exists，同样继续往下走，不会互相踩。
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

/** 部署后提示还没配的 Secret，避免用户对着 500 猜原因。 */
function remindSecrets(): void {
  console.log(
    [
      "",
      "\x1b[1;33m提醒：以下运行时 Secret 需要在 Cloudflare 控制台配置\x1b[0m",
      "  Settings → Variables and Secrets（不是 Build variables）",
      "",
      "  MASTER_KEY            必须，openssl rand -hex 32",
      "  TURNSTILE_SITE_KEY    必须（明文亦可，也可写进 wrangler.toml [vars]）",
      "  TURNSTILE_SECRET_KEY  必须",
      "  ADMIN_PASSWORD        必需（首次登录后自动转为哈希入库）",
      "",
      "未配置 MASTER_KEY 时 Worker 会返回「未绑定 MASTER_KEY」。",
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
