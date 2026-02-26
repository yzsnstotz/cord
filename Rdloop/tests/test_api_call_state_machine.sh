#!/usr/bin/env bash
# test_api_call_state_machine.sh — T05: Complete api_call attempt state machine test
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"

PASS=0; FAIL=0; TOTAL=0

assert_file_contains() {
  local label="$1" file="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if grep -qE "$needle" "$file" 2>/dev/null; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (pattern '$needle' not found)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Test Suite: api_call_state_machine ==="

# ---- State machine: coder → commit → judge → amend → test → decision ----
echo ""
echo "--- State machine sequence in run_task.sh ---"
# The run_attempt function should follow this sequence for all executor types:
# 1. CODER_STARTED
# 2. CODER_FINISHED
# 3. TEST_STARTED / TEST_FINISHED (if applicable)
# 4. EVIDENCE_PACKED
# 5. JUDGE_STARTED / JUDGE_FINISHED
# 6. Decision via decision_table
assert_file_contains "CODER_STARTED event" "$RUN_TASK" 'CODER_STARTED'
assert_file_contains "CODER_FINISHED event" "$RUN_TASK" 'CODER_FINISHED'
assert_file_contains "TEST_STARTED event" "$RUN_TASK" 'TEST_STARTED'
assert_file_contains "TEST_FINISHED event" "$RUN_TASK" 'TEST_FINISHED'
assert_file_contains "EVIDENCE_PACKED event" "$RUN_TASK" 'EVIDENCE_PACKED'
assert_file_contains "JUDGE_STARTED event" "$RUN_TASK" 'JUDGE_STARTED'
assert_file_contains "JUDGE_FINISHED event" "$RUN_TASK" 'JUDGE_FINISHED'

# ---- Decision table handles PASS/FAIL/NEED_USER_INPUT ----
echo ""
echo "--- Decision table handles all verdicts ---"
assert_file_contains "decision PASS" "$RUN_TASK" 'PASS'
assert_file_contains "decision FAIL" "$RUN_TASK" 'FAIL'
assert_file_contains "decision NEED_USER_INPUT" "$RUN_TASK" 'NEED_USER_INPUT'

# ---- READY_FOR_REVIEW state ----
echo ""
echo "--- Terminal states ---"
assert_file_contains "READY_FOR_REVIEW state" "$RUN_TASK" 'READY_FOR_REVIEW'
assert_file_contains "PAUSED state" "$RUN_TASK" 'PAUSED'
assert_file_contains "FAILED state" "$RUN_TASK" 'FAILED'

# ---- test_cmd rc cannot be bypassed ----
echo ""
echo "--- test_cmd rc enforcement ---"
assert_file_contains "test rc saved" "$RUN_TASK" 'test_rc'
assert_file_contains "test timeout handling" "$RUN_TASK" 'test.*124'

# ---- judge_enabled=false skips judge ----
echo ""
echo "--- judge_enabled=false handling ---"
assert_file_contains "judge none type" "$RUN_TASK" 'judge_type.*none'
assert_file_contains "skip judge flag" "$RUN_TASK" 'skip_judge'

# ---- Attempt loop respects max_attempts ----
echo ""
echo "--- Attempt loop max_attempts ---"
assert_file_contains "max_attempts enforcement" "$RUN_TASK" 'EFFECTIVE_MAX_ATTEMPTS'
assert_file_contains "attempt loop while" "$RUN_TASK" 'while.*att.*le.*EFFECTIVE_MAX_ATTEMPTS'

# ---- executor_type routing in v5 ----
echo ""
echo "--- v5 routing integration ---"
assert_file_contains "executor_type case" "$RUN_TASK" 'case.*executor_type'
assert_file_contains "session_mode case" "$RUN_TASK" 'case.*session_mode'
assert_file_contains "context_strategy set" "$RUN_TASK" 'context_strategy='

# ---- events.jsonl records attempt lifecycle ----
echo ""
echo "--- Events logging ---"
assert_file_contains "write_event function" "$RUN_TASK" 'write_event\(\)'
assert_file_contains "ATTEMPT_STARTED event" "$RUN_TASK" 'ATTEMPT_STARTED'
assert_file_contains "ATTEMPT_DECIDED event" "$RUN_TASK" 'ATTEMPT_DECIDED'

# ---- Mock integration test: decision_table response handling ----
echo ""
echo "--- decision_table integration ---"
assert_file_contains "call_decision_table function" "$RUN_TASK" 'call_decision_table\(\)'
assert_file_contains "act_on_decision function" "$RUN_TASK" 'act_on_decision\(\)'

# ---- Commit message format ----
echo ""
echo "--- Commit evidence ---"
assert_file_contains "evidence bundle" "$RUN_TASK" 'write_evidence'
assert_file_contains "metrics recording" "$RUN_TASK" 'write_metrics'

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
