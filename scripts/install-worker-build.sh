#!/usr/bin/env bash
# 使用官方源码包与项目维护的锁文件安装构建工具，避免上游锁文件中的撤回依赖。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_version="0.8.7"
source_sha256="1051c05ef088889a30ad3bad40c22a716ba8ca8d02a3fb01cef8c143ba952222"
tool_root="$ROOT/.tools/worker-build"
lock_file="$ROOT/scripts/worker-build.Cargo.lock"
hash_file() {
  node --input-type=module -e 'import {createHash} from "node:crypto"; import {readFileSync} from "node:fs"; console.log(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$1"
}
lock_hash="$(hash_file "$lock_file")"
stamp="$tool_version:$source_sha256:$lock_hash"
if [ -f "$tool_root/lock-stamp" ] && [ "$(cat "$tool_root/lock-stamp")" = "$stamp" ] &&
   [ "$("$tool_root/bin/worker-build" --version 2>/dev/null || true)" = "$tool_version" ]; then
  exit 0
fi

echo "安装 worker-build $tool_version（使用项目锁文件）"
tool_source="$(mktemp -d)"
trap 'rm -rf "$tool_source"' EXIT
curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 --max-time 120 \
  "https://static.crates.io/crates/worker-build/worker-build-$tool_version.crate" \
  -o "$tool_source/source.crate"
if [ "$(hash_file "$tool_source/source.crate")" != "$source_sha256" ]; then
  echo "worker-build 源码校验失败，停止安装" >&2
  exit 1
fi
tar -xzf "$tool_source/source.crate" -C "$tool_source"
cp "$lock_file" "$tool_source/worker-build-$tool_version/Cargo.lock"

# worker-build 的 native-tls 依赖 OpenSSL；与 Cloudflare Linux 构建镜像兼容。
if [ -d /usr/include/openssl ]; then
  export OPENSSL_INCLUDE_DIR="${OPENSSL_INCLUDE_DIR:-/usr/include}"
  export OPENSSL_LIB_DIR="${OPENSSL_LIB_DIR:-/usr/lib/x86_64-linux-gnu}"
fi
export CARGO_TARGET_DIR="$ROOT/target/worker-build"
cargo +stable install --path "$tool_source/worker-build-$tool_version" --bin worker-build \
  --root "$tool_root" --locked --force
printf '%s\n' "$stamp" > "$tool_root/lock-stamp"
