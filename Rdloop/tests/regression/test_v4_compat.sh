#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_JS="$ROOT/../gui/public/app.js"

echo "=== Test Suite: v4_compat ==="

bash "$ROOT/integration/test_v3_e2e.sh"

grep -q "workflow_mode === 'solo'" "$APP_JS"
grep -q "executor_type === 'solo_agent'" "$APP_JS"

echo "[v4_compat] PASS"
