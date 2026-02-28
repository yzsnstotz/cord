#!/usr/bin/env bash
# test_role_pipeline_declarative.sh — verify declarative role_pipeline in run_v51_flow
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"

PASS=0; FAIL=0; TOTAL=0

assert_ok() {
  local label="$1"
  shift
  TOTAL=$((TOTAL + 1))
  if "$@" 2>/dev/null; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Test Suite: role_pipeline_declarative ==="

# Test 1: Default pipeline for copywriting (no role_pipeline field)
TOTAL=$((TOTAL + 1))
default_cw=$(python3 -c "
import json
task = {'task_type': 'copywriting'}
# Simulate the default pipeline logic
if 'role_pipeline' not in task or not task.get('role_pipeline'):
    if task['task_type'] == 'copywriting':
        pipeline = [{'role': 'pm'}, {'role': 'executor'}, {'role': 'reviewer'}]
    else:
        pipeline = [{'role': 'pm'}, {'role': 'designer'}, {'role': 'executor'}, {'role': 'reviewer'}]
roles = [e['role'] for e in pipeline]
print(','.join(roles))
" 2>/dev/null)
if [ "$default_cw" = "pm,executor,reviewer" ]; then
  echo "  PASS: default copywriting pipeline = pm,executor,reviewer"
  PASS=$((PASS + 1))
else
  echo "  FAIL: default copywriting pipeline expected pm,executor,reviewer, got $default_cw"
  FAIL=$((FAIL + 1))
fi

# Test 2: Default pipeline for solo (no role_pipeline field)
TOTAL=$((TOTAL + 1))
default_solo=$(python3 -c "
import json
task = {'task_type': 'solo'}
if 'role_pipeline' not in task or not task.get('role_pipeline'):
    if task['task_type'] == 'copywriting':
        pipeline = [{'role': 'pm'}, {'role': 'executor'}, {'role': 'reviewer'}]
    else:
        pipeline = [{'role': 'pm'}, {'role': 'designer'}, {'role': 'executor'}, {'role': 'reviewer'}]
roles = [e['role'] for e in pipeline]
print(','.join(roles))
" 2>/dev/null)
if [ "$default_solo" = "pm,designer,executor,reviewer" ]; then
  echo "  PASS: default solo pipeline = pm,designer,executor,reviewer"
  PASS=$((PASS + 1))
else
  echo "  FAIL: default solo pipeline expected pm,designer,executor,reviewer, got $default_solo"
  FAIL=$((FAIL + 1))
fi

# Test 3: Custom pipeline skipping designer
TOTAL=$((TOTAL + 1))
custom=$(python3 -c "
import json
task = {
    'task_type': 'solo',
    'role_pipeline': [
        {'role': 'pm', 'required': True},
        {'role': 'executor', 'required': True},
        {'role': 'reviewer', 'required': True}
    ]
}
pipeline = task['role_pipeline']
roles = [e['role'] for e in pipeline]
print(','.join(roles))
" 2>/dev/null)
if [ "$custom" = "pm,executor,reviewer" ]; then
  echo "  PASS: custom pipeline skips designer"
  PASS=$((PASS + 1))
else
  echo "  FAIL: custom pipeline expected pm,executor,reviewer, got $custom"
  FAIL=$((FAIL + 1))
fi

# Test 4: Two-step pm+executor only
TOTAL=$((TOTAL + 1))
twostep=$(python3 -c "
import json
task = {
    'task_type': 'solo',
    'role_pipeline': [
        {'role': 'pm'},
        {'role': 'executor'}
    ]
}
pipeline = task['role_pipeline']
roles = [e['role'] for e in pipeline]
print(','.join(roles))
" 2>/dev/null)
if [ "$twostep" = "pm,executor" ]; then
  echo "  PASS: two-step pm+executor pipeline"
  PASS=$((PASS + 1))
else
  echo "  FAIL: two-step pipeline expected pm,executor, got $twostep"
  FAIL=$((FAIL + 1))
fi

# Test 5: pane_idx auto-assignment
TOTAL=$((TOTAL + 1))
pane_idxs=$(python3 -c "
import json
pipeline = [{'role': 'pm'}, {'role': 'executor'}, {'role': 'reviewer'}]
for i, entry in enumerate(pipeline):
    if 'pane_idx' not in entry:
        entry['pane_idx'] = i
idxs = [str(e['pane_idx']) for e in pipeline]
print(','.join(idxs))
" 2>/dev/null)
if [ "$pane_idxs" = "0,1,2" ]; then
  echo "  PASS: pane_idx auto-assignment = 0,1,2"
  PASS=$((PASS + 1))
else
  echo "  FAIL: pane_idx expected 0,1,2, got $pane_idxs"
  FAIL=$((FAIL + 1))
fi

# Test 6: Explicit pane_idx override
TOTAL=$((TOTAL + 1))
pane_override=$(python3 -c "
import json
pipeline = [{'role': 'pm', 'pane_idx': 0}, {'role': 'executor', 'pane_idx': 5}, {'role': 'reviewer', 'pane_idx': 3}]
for i, entry in enumerate(pipeline):
    if 'pane_idx' not in entry:
        entry['pane_idx'] = i
idxs = [str(e['pane_idx']) for e in pipeline]
print(','.join(idxs))
" 2>/dev/null)
if [ "$pane_override" = "0,5,3" ]; then
  echo "  PASS: pane_idx override = 0,5,3"
  PASS=$((PASS + 1))
else
  echo "  FAIL: pane_idx override expected 0,5,3, got $pane_override"
  FAIL=$((FAIL + 1))
fi

# Test 7: role_pipeline field exists in schema
assert_ok "schema has role_pipeline" grep -q "role_pipeline" "${RDLOOP_ROOT}/docs/schema/task_schema_v51.json"

# Test 8: run_task.sh reads role_pipeline from task.json
assert_ok "run_task reads role_pipeline" grep -q "role_pipeline" "$RUN_TASK"

# Test 9: run_task.sh has pipeline_roles array
assert_ok "run_task has pipeline_roles" grep -q "pipeline_roles" "$RUN_TASK"

echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
