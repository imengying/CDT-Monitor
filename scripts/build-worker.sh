#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
bash scripts/install-worker-build.sh
exec "$ROOT/.tools/worker-build/bin/worker-build" --release --locked
