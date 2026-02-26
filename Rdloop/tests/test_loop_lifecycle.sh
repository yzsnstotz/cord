#!/usr/bin/env bash
# test_loop_lifecycle.sh — T08: Tests for loop_lifecycle.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOOP_LIFECYCLE="${RDLOOP_ROOT}/tools/loop_lifecycle.sh"

PASS=0; FAIL=0; TOTAL=0
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then echo "  PASS: $label"; PASS=$((PASS+1))
  else echo "  FAIL: $label (expected='$expected', actual='$actual')"; FAIL=$((FAIL+1)); fi
}

assert_file_exists() {
  local label="$1" file="$2"
  TOTAL=$((TOTAL + 1))
  if [ -f "$file" ]; then echo "  PASS: $label"; PASS=$((PASS+1))
  else echo "  FAIL: $label ($file not found)"; FAIL=$((FAIL+1)); fi
}

assert_file_contains_str() {
  local label="$1" file="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if grep -q "$needle" "$file" 2>/dev/null; then echo "  PASS: $label"; PASS=$((PASS+1))
  else echo "  FAIL: $label ('$needle' not in $file)"; FAIL=$((FAIL+1)); fi
}

echo "=== Test Suite: loop_lifecycle ==="

# ---- Setup mock project ----
MOCK_REPO="$TMPDIR/repo"
mkdir -p "$MOCK_REPO/.context"
echo '{}' > "$MOCK_REPO/.context/session_state.json"
git -C "$MOCK_REPO" init >/dev/null 2>&1
echo "init" > "$MOCK_REPO/README.md"
git -C "$MOCK_REPO" add . && git -C "$MOCK_REPO" commit -m "init" >/dev/null 2>&1

# Create a mock task in out/
MOCK_OUT="$TMPDIR/out"
mkdir -p "$MOCK_OUT/test_lifecycle_task/attempt_001/coder"
mkdir -p "$MOCK_OUT/test_lifecycle_task/attempt_001/judge"
cat > "$MOCK_OUT/test_lifecycle_task/task.json" <<EOF
{
  "task_id": "test_lifecycle_task",
  "executor_type": "api_call",
  "session_mode": "iterative",
  "goal": "test",
  "acceptance": "test",
  "test_cmd": "true",
  "repo_path": "$MOCK_REPO",
  "max_attempts": 3
}
EOF
echo '{"task_id":"test_lifecycle_task","state":"READY_FOR_REVIEW"}' > "$MOCK_OUT/test_lifecycle_task/final_summary.json"
echo '{"src/auth.ts":"JWT auth module"}' > "$MOCK_OUT/test_lifecycle_task/attempt_001/coder/knowledge_entries.json"
: > "$MOCK_OUT/test_lifecycle_task/events.jsonl"

# ---- on-loop-complete: basic run ----
echo ""
echo "--- on-loop-complete: basic run ---"
TOTAL=$((TOTAL + 1))
if RDLOOP_OUT_DIR="$MOCK_OUT" bash "$LOOP_LIFECYCLE" on-loop-complete "test_lifecycle_task" "$MOCK_REPO" "$MOCK_OUT/test_lifecycle_task/task.json" >/dev/null 2>&1; then
  echo "  PASS: on-loop-complete succeeds"
  PASS=$((PASS + 1))
else
  echo "  FAIL: on-loop-complete failed"
  FAIL=$((FAIL + 1))
fi

# ---- events.jsonl has loop_complete ----
echo ""
echo "--- events.jsonl ---"
assert_file_contains_str "loop_complete event" "$MOCK_OUT/test_lifecycle_task/events.jsonl" "loop_complete"

# ---- loop_stats.jsonl created ----
echo ""
echo "--- loop_stats.jsonl ---"
assert_file_exists "loop_stats.jsonl exists" "$MOCK_OUT/loop_stats.jsonl"
assert_file_contains_str "loop_id in stats" "$MOCK_OUT/loop_stats.jsonl" "test_lifecycle_task"

# ---- session_state.json updated ----
echo ""
echo "--- session_state.json ---"
assert_file_contains_str "session_state updated" "$MOCK_REPO/.context/session_state.json" "completed_loops"

# ---- Idempotent: run again ----
echo ""
echo "--- Idempotent ---"
local_lines_before=$(wc -l < "$MOCK_OUT/loop_stats.jsonl" 2>/dev/null || echo "0")
RDLOOP_OUT_DIR="$MOCK_OUT" bash "$LOOP_LIFECYCLE" on-loop-complete "test_lifecycle_task" "$MOCK_REPO" "$MOCK_OUT/test_lifecycle_task/task.json" >/dev/null 2>&1
local_lines_after=$(wc -l < "$MOCK_OUT/loop_stats.jsonl" 2>/dev/null || echo "0")
assert_eq "loop_stats idempotent" "$local_lines_before" "$local_lines_after"

# ---- Regression gate: failure blocks ----
echo ""
echo "--- Regression gate: failure blocks ---"
cat > "$MOCK_OUT/test_lifecycle_task/task.json" <<EOF
{
  "task_id": "test_lifecycle_task",
  "executor_type": "api_call",
  "session_mode": "iterative",
  "goal": "test",
  "acceptance": "test",
  "test_cmd": "exit 1",
  "repo_path": "$MOCK_REPO",
  "max_attempts": 3
}
EOF
TOTAL=$((TOTAL + 1))
if RDLOOP_OUT_DIR="$MOCK_OUT" bash "$LOOP_LIFECYCLE" on-loop-complete "test_lifecycle_task" "$MOCK_REPO" "$MOCK_OUT/test_lifecycle_task/task.json" >/dev/null 2>&1; then
  echo "  FAIL: regression failure should block"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: regression failure blocks correctly"
  PASS=$((PASS + 1))
fi

# Check REGRESSION_FAILED event
assert_file_contains_str "REGRESSION_FAILED event" "$MOCK_OUT/test_lifecycle_task/events.jsonl" "REGRESSION_FAILED"

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
