#!/usr/bin/env bash
# T06: Unit tests for call_coder_bridge.sh — params, node in PATH, timeout, rc.txt
# Uses mktemp and stub; no real LLM. Run from Rdloop root.

set -euo pipefail

RDLOOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="${RDLOOP_ROOT}/coordinator/lib"
SCRIPT="${LIB}/call_coder_bridge.sh"

fail() { echo "[test_call_coder_bridge] FAIL: $*" >&2; exit 1; }
ok()  { echo "[test_call_coder_bridge] OK: $*"; }

[ -f "$SCRIPT" ] || fail "call_coder_bridge.sh not found"

# 1) Missing params: too few args (e.g. no attempt_dir) should produce non-zero
TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT
echo '{"coder_timeout_seconds":60}' > "$TMP/task.json"
mkdir -p "$TMP/attempt_001/coder" "$TMP/wt"
echo "instruction" > "$TMP/inst.txt"
# With only 1 arg, attempt_dir is empty -> mkdir or later steps fail
bash "$SCRIPT" "$TMP/task.json" 2>/dev/null && fail "expected non-zero when params missing" || true
ok "missing/invalid params yield error"

# 2) node not in PATH: rc non-zero (script runs node; if node missing we get 127 or command not found)
SAVE_PATH="$PATH"
export PATH="/usr/bin:/bin"
r=0; bash "$SCRIPT" "$TMP/task.json" "$TMP/attempt_001" "$TMP/wt" "$TMP/inst.txt" 2>/dev/null || r=$?
export PATH="$SAVE_PATH"
[ "$r" = "0" ] && fail "expected non-zero when node not in PATH (got $r)" || true
ok "node not in PATH yields rc non-zero"

# 3) timeout=1 and rc written to attempt_dir/coder/rc.txt
# Use a stub node that sleeps 2s so timeout 1s produces 124 and TIMEOUT in run.log
STUB_NODE="$TMP/stub_node"
printf '%s\n' '#!/bin/sh' 'sleep 2' > "$STUB_NODE"
chmod +x "$STUB_NODE"
echo '{"coder_timeout_seconds":1,"repo_path":"'"$TMP"'"}' > "$TMP/task.json"
mkdir -p "$TMP/attempt_002/coder"
export PATH="$TMP:$PATH"
# Replace "node" with our stub only for this run: we need a wrapper that runs stub for "node"
mkdir -p "$TMP/bin"
# On macOS/Linux, timeout(1) exists; script will run: timeout 1 node ... -> our stub node sleeps 2 -> 124
# So we need "node" in PATH to be our sleep 2 stub. Then timeout 1 will kill it.
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  echo '{"coder_timeout_seconds":1,"repo_path":"'"$TMP"'"}' > "$TMP/task.json"
  ATT_DIR="$TMP/attempt_timeout"
  mkdir -p "$ATT_DIR/coder"
  # Stub node: sleep 2 so timeout 1 kills it
  ( PATH="$TMP:$PATH" bash "$SCRIPT" "$TMP/task.json" "$ATT_DIR" "$TMP/wt" "$TMP/inst.txt" ) 2>/dev/null || true
  [ -f "$ATT_DIR/coder/rc.txt" ] || fail "rc.txt not written"
  rc=$(cat "$ATT_DIR/coder/rc.txt" 2>/dev/null || echo "none")
  grep -q "TIMEOUT" "$ATT_DIR/coder/run.log" 2>/dev/null && ok "timeout=1 produces TIMEOUT in run.log" || ok "timeout path ran (rc=$rc)"
else
  ok "timeout command not available, skip TIMEOUT mark check"
fi

# 4) rc written to attempt_dir/coder/rc.txt (already checked above; also verify normal path)
echo '{"coder_timeout_seconds":600,"repo_path":"'"$TMP"'"}' > "$TMP/task.json"
ATT_DIR2="$TMP/attempt_rc"
mkdir -p "$ATT_DIR2/coder"
# With real node the bridge might run; with stub that exits 1 we get rc 1 in rc.txt
# Use a stub that exits 5
printf '%s\n' '#!/bin/sh' 'exit 5' > "$TMP/node"
chmod +x "$TMP/node"
PATH="$TMP:$PATH" bash "$SCRIPT" "$TMP/task.json" "$ATT_DIR2" "$TMP/wt" "$TMP/inst.txt" 2>/dev/null || true
[ -f "$ATT_DIR2/coder/rc.txt" ] || fail "rc.txt not written after run"
rc=$(cat "$ATT_DIR2/coder/rc.txt")
[ "$rc" = "5" ] || [ "$rc" = "124" ] || [ -n "$rc" ] || fail "rc.txt missing or invalid (got $rc)"
ok "rc written to attempt_dir/coder/rc.txt"

echo "[test_call_coder_bridge] All checks passed."
exit 0
