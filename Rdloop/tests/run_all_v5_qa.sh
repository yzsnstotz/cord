#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

QA_TASKS=(
  "QA01|bash tests/mocks/mock_coder.sh --rc 0 --output-file /tmp/qa01_smoke.txt --content 'ok' && cat /tmp/qa01_smoke.txt | grep -q 'ok'"
  "QA02|bash tests/unit/test_task_schema_v5.sh"
  "QA03|bash tests/unit/test_run_task_routing_v5.sh"
  "QA04|bash tests/unit/test_git_ops.sh"
  "QA05|bash tests/integration/test_bug_fix_regression.sh"
  "QA06|bash tests/integration/test_api_call_state_machine.sh"
  "QA07|bash tests/integration/test_git_ops_lifecycle.sh"
  "QA08|bash tests/system/test_e2e_api_call.sh && bash tests/system/test_e2e_solo_agent.sh && bash tests/system/test_e2e_multi_agent.sh"
  "QA09|bash tests/system/test_cross_loop_lifecycle.sh"
  "QA10|bash tests/regression/test_v4_compat.sh"
  "QA11|bash tests/gui/test_gui_endpoints_v5.sh && node tests/gui/test_gui_frontend_constraints.js"
)

pass=0
fail=0

for entry in "${QA_TASKS[@]}"; do
  task_id="${entry%%|*}"
  cmd="${entry#*|}"
  echo "== $task_id =="
  set +e
  bash -lc "$cmd"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "[$task_id] PASS"
    pass=$((pass+1))
  else
    echo "[$task_id] FAIL (rc=$rc)"
    fail=$((fail+1))
  fi
  echo ""
done

echo "SUMMARY pass=$pass fail=$fail total=${#QA_TASKS[@]}"
[ "$fail" -eq 0 ]
