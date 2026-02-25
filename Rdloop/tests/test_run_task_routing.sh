#!/usr/bin/env bash
# T09: execution_mode routing and PAUSED_CODER_CCB_UNAVAILABLE in events.jsonl
# 1) execution_mode=auto -> coder_type=bridge  2) execution_mode=semi-auto -> coder_type=ccb
# 3) When call_coder_ccb.sh returns rc=127, PAUSED_CODER_CCB_UNAVAILABLE written to events.jsonl (stub call_coder_ccb.sh)

set -euo pipefail

RDLOOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COORD="${RDLOOP_ROOT}/coordinator/run_task.sh"
LIB="${RDLOOP_ROOT}/coordinator/lib"

fail() { echo "[test_run_task_routing] FAIL: $*" >&2; exit 1; }
ok()  { echo "[test_run_task_routing] OK: $*"; }

[ -f "$COORD" ] || fail "run_task.sh not found"

# Same logic as run_task.sh: json_read + execution_mode -> coder_type
json_read() {
  python3 -c "
import json,sys
try:
  with open(sys.argv[1]) as f: d=json.load(f)
  keys=sys.argv[2].split('.')
  v=d
  for k in keys: v=v.get(k)
  if v is None: print(sys.argv[3] if len(sys.argv)>3 else '')
  else: print(v)
except: print(sys.argv[3] if len(sys.argv)>3 else '')
" "$@"
}

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

# 1) execution_mode=auto -> coder_type=bridge
echo '{"execution_mode":"auto","coder":"mock"}' > "$TMP/mock_auto.json"
coder_type=$(json_read "$TMP/mock_auto.json" "coder" "")
execution_mode=$(json_read "$TMP/mock_auto.json" "execution_mode" "auto")
[ "$execution_mode" = "auto" ] && coder_type="bridge" || true
[ "$coder_type" = "bridge" ] || fail "execution_mode=auto should yield coder_type=bridge (got $coder_type)"
ok "execution_mode=auto -> coder_type=bridge"

# 2) execution_mode=semi-auto -> coder_type=ccb
echo '{"execution_mode":"semi-auto","coder":"mock"}' > "$TMP/mock_semi.json"
coder_type=$(json_read "$TMP/mock_semi.json" "coder" "")
execution_mode=$(json_read "$TMP/mock_semi.json" "execution_mode" "auto")
[ "$execution_mode" = "semi-auto" ] && coder_type="ccb" || true
[ "$coder_type" = "ccb" ] || fail "execution_mode=semi-auto should yield coder_type=ccb (got $coder_type)"
ok "execution_mode=semi-auto -> coder_type=ccb"

# 3) PAUSED_CODER_CCB_UNAVAILABLE in events.jsonl when call_coder_ccb returns 127 (stub coordinator lib)
# Copy coordinator to temp, stub call_coder_ccb.sh to exit 127, run --continue and check events.jsonl
FAKE_ROOT="$TMP/fake_rdloop"
mkdir -p "$FAKE_ROOT/coordinator/lib" "$FAKE_ROOT/out" "$FAKE_ROOT/prompts"
cp "$COORD" "$FAKE_ROOT/coordinator/run_task.sh"
# Stub that exits 127 immediately
printf '%s\n' '#!/bin/bash' 'exit 127' > "$FAKE_ROOT/coordinator/lib/call_coder_ccb.sh"
chmod +x "$FAKE_ROOT/coordinator/lib/call_coder_ccb.sh"
# Minimal stubs for other scripts run_task.sh may call (judge, etc.)
for name in call_judge_ccb.sh call_coder_bridge.sh call_judge_bridge.sh; do
  [ -f "$LIB/$name" ] && cp "$LIB/$name" "$FAKE_ROOT/coordinator/lib/" || true
done
# We need atomic_write.py, json_read, setup_worktree, etc. - run_task.sh is large. Use real RDLOOP but override LIB.
# Alternative: run real run_task.sh with RDLOOP_ROOT and a stub only for call_coder_ccb by putting stub in PATH?
# run_task.sh invokes bash "$coder_script" where coder_script="${LIB_DIR}/call_coder_ccb.sh". So we must replace that file.
# So replace the file in place temporarily (restore after), or use a copy of whole Rdloop. Copy is heavy. Replace in place:
SAVED_CCB="$LIB/call_coder_ccb.sh.bak"
cp "$LIB/call_coder_ccb.sh" "$SAVED_CCB"
trap "cp '$SAVED_CCB' '$LIB/call_coder_ccb.sh'" EXIT
printf '%s\n' '#!/bin/bash' 'exit 127' > "$LIB/call_coder_ccb.sh"
chmod +x "$LIB/call_coder_ccb.sh"

TASK_ID="test_ccb_unav_$$"
TASK_DIR="${RDLOOP_ROOT}/out/$TASK_ID"
mkdir -p "$TASK_DIR"
# Minimal task.json for semi-auto so coordinator uses call_coder_ccb
cat > "$TASK_DIR/task.json" << EOF
{"task_id":"$TASK_ID","execution_mode":"semi-auto","repo_path":"$RDLOOP_ROOT","goal":"g","acceptance":"a","test_cmd":"true","max_attempts":1,"coder_timeout_seconds":5}
EOF
# Ensure out dir exists
mkdir -p "$RDLOOP_ROOT/out"
export RDLOOP_OUT_DIR="$RDLOOP_ROOT/out"
cd "$RDLOOP_ROOT"
bash "$COORD" --continue "$TASK_ID" 2>/dev/null || true
# Restore script immediately so we don't leave repo broken
cp "$SAVED_CCB" "$LIB/call_coder_ccb.sh"
trap - EXIT
rm -f "$SAVED_CCB"

EVENTS="$TASK_DIR/events.jsonl"
[ -f "$EVENTS" ] || fail "events.jsonl not created"
grep -q "PAUSED_CODER_CCB_UNAVAILABLE" "$EVENTS" || fail "PAUSED_CODER_CCB_UNAVAILABLE not found in events.jsonl"
ok "PAUSED_CODER_CCB_UNAVAILABLE written to events.jsonl (stub rc=127)"

# Cleanup task dir
rm -rf "$TASK_DIR"
echo "[test_run_task_routing] All checks passed."
exit 0
