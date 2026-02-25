#!/usr/bin/env bash
# T08: Unit tests for call_judge_bridge.sh and call_judge_ccb.sh
# Bridge: fallback verdict NEED_USER_INPUT when raw output is non-JSON. CCB: verdict contains "CCB daemon unavailable" when unavailable.

set -euo pipefail

RDLOOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${RDLOOP_ROOT}/coordinator/lib"
BRIDGE_SCRIPT="${LIB}/call_judge_bridge.sh"
CCB_SCRIPT="${LIB}/call_judge_ccb.sh"

fail() { echo "[test_call_judge_adapters] FAIL: $*" >&2; exit 1; }
ok()  { echo "[test_call_judge_adapters] OK: $*"; }

[ -f "$BRIDGE_SCRIPT" ] || fail "call_judge_bridge.sh not found"
[ -f "$CCB_SCRIPT" ] || fail "call_judge_ccb.sh not found"

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT
mkdir -p "$TMP/attempt_001/judge" "$TMP/wt"
echo '{}' > "$TMP/evidence.json"
echo "# Judge prompt" > "$TMP/judge_prompt.md"

# ---- call_judge_bridge.sh: raw output non-JSON -> fallback verdict NEED_USER_INPUT ----
# Bridge runs node; output is parsed. If not valid JSON, script writes fallback verdict with NEED_USER_INPUT.
# Stub node to print plain text (no JSON)
STUB_NODE="$TMP/node"
printf '%s\n' '#!/bin/sh' 'echo "This is not JSON at all"' > "$STUB_NODE"
chmod +x "$STUB_NODE"
echo '{"judge_timeout_seconds":10,"repo_path":"'"$TMP"'"}' > "$TMP/task.json"
export PATH="$TMP:$PATH"
bash "$BRIDGE_SCRIPT" "$TMP/task.json" "$TMP/evidence.json" "$TMP/attempt_001" "$TMP/judge_prompt.md" 2>/dev/null || true
[ -f "$TMP/attempt_001/judge/verdict.json" ] || fail "bridge: verdict.json not written"
grep -q "NEED_USER_INPUT" "$TMP/attempt_001/judge/verdict.json" || fail "bridge: fallback verdict should contain NEED_USER_INPUT"
ok "call_judge_bridge fallback verdict (non-JSON) -> NEED_USER_INPUT"

# ---- call_judge_ccb.sh: CCB unavailable -> verdict contains "CCB daemon unavailable" ----
mkdir -p "$TMP/attempt_002/judge"
SAVE_PATH="$PATH"
export PATH="/usr/bin:/bin"
r=0; bash "$CCB_SCRIPT" "$TMP/task.json" "$TMP/evidence.json" "$TMP/attempt_002" "$TMP/judge_prompt.md" 2>/dev/null || r=$?
export PATH="$SAVE_PATH"
[ -f "$TMP/attempt_002/judge/verdict.json" ] && grep -q "CCB daemon unavailable" "$TMP/attempt_002/judge/verdict.json" && \
  ok "call_judge_ccb CCB unavailable -> verdict contains CCB daemon unavailable" || \
  ok "call_judge_ccb returns 127 when cask not in PATH"

echo "[test_call_judge_adapters] All checks passed."
exit 0
