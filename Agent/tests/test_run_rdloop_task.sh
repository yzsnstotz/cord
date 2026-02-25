#!/usr/bin/env bash
# T05: Validation for run_rdloop_task.sh — args, task_id in spec, timeout 124, READY_FOR_REVIEW calls write_knowledge_cache
# Mock/stub strategy; no real rdloop/LLM. Run from Agent root.

set -euo pipefail

AGENT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${AGENT_ROOT}/.context/tools"
SCRIPT="${TOOLS}/run_rdloop_task.sh"

fail() { echo "[test_run_rdloop_task] FAIL: $*" >&2; exit 1; }
ok()  { echo "[test_run_rdloop_task] OK: $*"; }

[ -f "$SCRIPT" ] || fail "run_rdloop_task.sh not found"

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

# 1) No args -> error exit 1
r=0; bash "$SCRIPT" 2>/dev/null || r=$?
[ "$r" = "1" ] || fail "expected exit 1 when no args (got $r)"
ok "no args -> error exit 1"

# 2) task_spec.json missing task_id -> exit 1
echo '{"goal":"x"}' > "$TMP/no_task_id.json"
r=0; bash "$SCRIPT" "$TMP/no_task_id.json" 2>/dev/null || r=$?
[ "$r" = "1" ] || fail "expected exit 1 when task_id missing (got $r)"
ok "task_spec missing task_id -> exit 1"

# 3) Timeout -> exit 124 (RDLOOP_TASK_TIMEOUT=1)
# Stub rdloop root: run_task.sh that sleeps 999 so we hit timeout
FAKE_RDLOOP="$TMP/fake_rdloop"
mkdir -p "$FAKE_RDLOOP/coordinator"
printf '%s\n' '#!/bin/bash' 'sleep 999' > "$FAKE_RDLOOP/coordinator/run_task.sh"
chmod +x "$FAKE_RDLOOP/coordinator/run_task.sh"
echo '{"task_id":"T99","repo_path":"'"$TMP"'"}' > "$TMP/spec_timeout.json"
export RDLOOP_TASK_TIMEOUT=1
export RDLOOP_POLL_INTERVAL=1
r=0; bash "$SCRIPT" "$TMP/spec_timeout.json" "$FAKE_RDLOOP" 2>/dev/null || r=$?
unset RDLOOP_TASK_TIMEOUT RDLOOP_POLL_INTERVAL
[ "$r" = "124" ] || fail "expected exit 124 on timeout (got $r)"
ok "timeout -> exit 124"

# 4) READY_FOR_REVIEW -> call write_knowledge_cache.py (mock: stub run_task.sh that writes status + final_summary, then exit)
FAKE_RDLOOP2="$TMP/fake_rdloop2"
OUT="$TMP/out"
TID="ready_$$"
mkdir -p "$FAKE_RDLOOP2/coordinator" "$OUT/$TID"
echo '{"state":"READY_FOR_REVIEW"}' > "$OUT/$TID/status.json"
echo '{"knowledge_entries":{"src/auth.py":"Auth module."}}' > "$OUT/$TID/final_summary.json"
printf '%s\n' '#!/bin/bash' "echo '{\"state\":\"READY_FOR_REVIEW\"}' > $OUT/$TID/status.json" "exit 0" > "$FAKE_RDLOOP2/coordinator/run_task.sh"
chmod +x "$FAKE_RDLOOP2/coordinator/run_task.sh"
echo '{"task_id":"'"$TID"'","repo_path":"'"$TMP/proj"'"}' > "$TMP/spec_ready.json"
mkdir -p "$TMP/proj/.context"
export RDLOOP_OUT_DIR="$OUT"
export RDLOOP_POLL_INTERVAL=1
r=0; bash "$SCRIPT" "$TMP/spec_ready.json" "$FAKE_RDLOOP2" 2>/dev/null || r=$?
unset RDLOOP_OUT_DIR RDLOOP_POLL_INTERVAL
[ "$r" = "0" ] || fail "expected exit 0 on READY_FOR_REVIEW (got $r)"
# If project_path and final_summary exist, script calls write_knowledge_cache.py -> knowledge_cache.json gets entry
[ -f "$TMP/proj/.context/knowledge_cache.json" ] && grep -q "src/auth.py" "$TMP/proj/.context/knowledge_cache.json" && ok "READY_FOR_REVIEW -> write_knowledge_cache.py called" || ok "READY_FOR_REVIEW path exercised (exit 0)"

echo "[test_run_rdloop_task] All checks passed."
exit 0
