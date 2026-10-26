#!/usr/bin/env bash
#
# Cloudflare Workers Builds 构建脚本
# ============================================================================
# Cloudflare 构建环境只有 Node，无 Rust 与 worker-build，本脚本负责
# 安装工具链并完成构建，可重复执行（产物新于源码时直接复用）。
#
# 调用来源：
#   1. Dashboard → Settings → Build → Build command
#   2. wrangler.toml 的 [build] command（wrangler deploy 时）
#
# 必需构建期变量（Settings → Build → Build variables）：
#   BUN_VERSION   Bun 版本，例如 1.4.4
#                 不指定会使用镜像预装的旧版本（1.2.5），构建可能失败
#
# 构建期变量仅在构建阶段可见。运行时变量 MASTER_KEY / ADMIN_USERNAME /
# ADMIN_PASSWORD 需配置在 Settings → Variables and Secrets 并选择 Secret。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# 0a. 结构校验：拦截部署成功但运行时失败的配置缺失
# ---------------------------------------------------------------------------
if [ -f scripts/check-config.ts ]; then
  log "配置自检"
  bun run scripts/check-config.ts || {
    echo "错误：wrangler.toml 配置自检未通过（见上方提示）" >&2
    exit 1
  }
fi

# ---------------------------------------------------------------------------
# 0b. 幂等：产物比源码新就直接复用
# ---------------------------------------------------------------------------
if [ -f build/worker/shim.mjs ] && [ -f web/dist/index.html ]; then
  if [ -z "$(find src Cargo.toml Cargo.lock web/src web/index.html web/package.json \
              -newer build/worker/shim.mjs 2>/dev/null)" ]; then
    log "已是最新构建，跳过（build/worker/shim.mjs 存在且比源码新）"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# 1. Bun
# ---------------------------------------------------------------------------
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

# 版本不匹配（含镜像预装旧版）时安装指定版本。
# 不能只在「未安装」时装：构建镜像自带 Bun 1.2.5，跳过安装会让 BUN_VERSION 失效。
installed="$(bun --version 2>/dev/null || true)"

if [ -z "${BUN_VERSION:-}" ]; then
  if [ -n "$installed" ]; then
    # 本地开发未指定版本：用现有版本，避免每次构建都下载
    warn "未设置 BUN_VERSION，使用当前 Bun $installed"
    BUN_VERSION="$installed"
  else
    echo "错误：未设置 BUN_VERSION，且环境中没有 Bun。" >&2
    echo "Cloudflare 构建需在 Settings → Build → Build variables 配置 BUN_VERSION。" >&2
    exit 1
  fi
fi

if [ "$installed" != "$BUN_VERSION" ]; then
  log "安装 Bun $BUN_VERSION（当前 ${installed:-未安装}）"
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
log "Bun: $(bun --version)"

# ---------------------------------------------------------------------------
# 2. Rust 工具链
# ---------------------------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  log "安装 Rust（rustup, minimal profile）"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"
log "Rust: $(cargo --version)"

# rust-toolchain.toml 声明了 wasm32-unknown-unknown，但 Cloudflare 用的是
# 一次性容器，rustup 可能还没装这个 target。
if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
  log "安装 wasm32-unknown-unknown target"
  rustup target add wasm32-unknown-unknown
fi

# ---------------------------------------------------------------------------
# 3. worker-build
# ---------------------------------------------------------------------------
# worker-build 通过 ureq / native-tls 间接依赖 openssl-sys，在某些镜像里
# 缺少 pkg-config 或头文件会直接 panic。显式给出路径就能绕开探测。
if [ -d /usr/include/openssl ]; then
  export OPENSSL_INCLUDE_DIR="${OPENSSL_INCLUDE_DIR:-/usr/include}"
  export OPENSSL_LIB_DIR="${OPENSSL_LIB_DIR:-/usr/lib/x86_64-linux-gnu}"
fi

if ! command -v worker-build >/dev/null 2>&1; then
  log "安装 worker-build 0.8.7（首次约 3-5 分钟）"
  # 在临时目录里安装：避免 rust-toolchain.toml 覆盖工具链导致
  # "default toolchain implicitly overridden by rustup toolchain file"。
  #
  # 不加 --locked：crate 自带的 Cargo.lock 会锁定依赖的精确版本，
  # 一旦其中某个版本被 crates.io yank，安装就会失败或告警
  # （曾出现 yoke-derive 0.8.3 被 yank）。交给 cargo 自行解析版本。
  ( cd "$(mktemp -d)" && cargo +stable install worker-build --version 0.8.7 )
fi
log "worker-build: $(command -v worker-build)"

# ---------------------------------------------------------------------------
# 4. 依赖安装
# ---------------------------------------------------------------------------
log "安装根依赖（wrangler）"
bun install --frozen-lockfile || bun install

log "安装前端依赖"
( cd web && { bun install --frozen-lockfile || bun install; } )

# ---------------------------------------------------------------------------
# 5. 构建前端
# ---------------------------------------------------------------------------
log "构建前端 → web/dist"
( cd web && bun run build )

if [ ! -f web/dist/index.html ]; then
  echo "错误：前端构建失败，web/dist/index.html 不存在" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 6. 构建 Worker（Rust → Wasm）
# ---------------------------------------------------------------------------
log "构建 Worker → build/worker/shim.mjs"
worker-build --release

if [ ! -f build/worker/shim.mjs ]; then
  echo "错误：Worker 构建失败，build/worker/shim.mjs 不存在" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 7. 体积报告（Workers 免费版单文件上限 3 MiB，付费 10 MiB）
# ---------------------------------------------------------------------------
# worker-build 把产物放在 build/ 下：index.js + index_bg.wasm，
# build/worker/shim.mjs 只是兼容旧路径的转发壳。
wasm_file="$(find build -maxdepth 2 -name '*_bg.wasm' | head -n1 || true)"
if [ -n "$wasm_file" ]; then
  size=$(stat -c%s "$wasm_file" 2>/dev/null || stat -f%z "$wasm_file")
  log "Wasm 体积: $((size / 1024)) KiB ($wasm_file)"
  # Workers 免费版单文件上限 3 MiB，付费版 10 MiB
  if [ "$size" -gt 10485760 ]; then
    warn "Wasm 超过 10 MiB（付费版上限），部署可能被拒绝"
  elif [ "$size" -gt 3145728 ]; then
    warn "Wasm 超过 3 MiB（免费版上限），免费账户部署会失败"
  fi
else
  warn "未找到 wasm 产物，请检查 worker-build 输出"
fi

log "完成。产物："
echo "  web/dist/index.html"
echo "  build/worker/shim.mjs"
