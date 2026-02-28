#!/usr/bin/env bash
# test_run_task_routing_v51.sh — v5.1 task_type + launch_mode routing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"

PASS=0; FAIL=0; TOTAL=0
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

assert_ok() {
  local label="$1"
  shift
  TOTAL=$((TOTAL + 1))
  if "$@"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

run_case() {
  local task_type="$1" launch_mode="$2"
  local task_id="${task_type}_${launch_mode}"
  local spec="${TMPDIR}/${task_id}.json"
  local repo_path=""
  local roles_json='{"pm":"mock","designer":"mock","executor":"mock","reviewer":"mock"}'
  if [ "$task_type" = "copywriting" ]; then
    roles_json='{"executor":"mock","reviewer":"mock"}'
  else
    repo_path="${TMPDIR}/repo_${task_id}"
    mkdir -p "$repo_path"
    git -C "$repo_path" init -q
    git -C "$repo_path" checkout -q -b main
    echo "seed" > "${repo_path}/README.md"
    git -C "$repo_path" add README.md
    git -C "$repo_path" -c user.name=rdloop-test -c user.email=rdloop-test@example.com commit -q -m "init"
  fi

  cat > "$spec" <<JSON
{
  "schema_version": "v51",
  "task_id": "${task_id}",
  "task_type": "${task_type}",
  "launch_mode": "${launch_mode}",
  "launch_mode_locked": true,
  "collab_roles": ${roles_json},
  "agent_config": {"provider":"mock"},
  "repo_path": "${repo_path}",
  "base_ref": "main",
  "goal": "test",
  "acceptance": "ok",
  "test_cmd": "true",
  "max_attempts": 1
}
JSON

  set +e
  RDLOOP_OUT_DIR="${TMPDIR}/out" RDLOOP_WORKTREES_DIR="${TMPDIR}/wt" bash "$RUN_TASK" "$spec" >"${TMPDIR}/${task_id}.log" 2>&1
  local rc=$?
  set -e
  assert_ok "${task_id} run rc=0" bash -lc '[ "'$rc'" = "0" ]'

  local tdir="${TMPDIR}/out/${task_id}"
  local events="${tdir}/events.jsonl"
  local lifecycle="${tdir}/task_lifecycle.jsonl"
  local status="${tdir}/status.json"
  local task_state="${tdir}/task_state.json"

  assert_ok "${task_id} events exists" test -f "$events"
  assert_ok "${task_id} lifecycle log exists" test -f "$lifecycle"
  assert_ok "${task_id} status READY_FOR_REVIEW" bash -lc 'grep -q "READY_FOR_REVIEW" "'$status'"'
  assert_ok "${task_id} task_state sessions exists" bash -lc 'python3 - <<PY
import json
with open("'$task_state'", encoding="utf-8") as f:
  d=json.load(f)
assert isinstance(d.get("sessions"), dict) and len(d.get("sessions"))>0
PY'

  local expected_role_starts="1"
  local expected_transitions="1"
  if [ "$task_type" != "copywriting" ]; then
    expected_role_starts="2"
    expected_transitions="2"
  fi

  assert_ok "${task_id} launch_mode_selected event has fields" bash -lc 'python3 - <<PY
import json
ok=False
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="launch_mode_selected":
    ok=(e.get("launch_mode")=="'$launch_mode'" and e.get("locked") is True)
assert ok
PY'

  assert_ok "${task_id} role_start count (real PM/Designer actions)" bash -lc 'python3 - <<PY
import json
n=0
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="role_start":
    assert e.get("session_id")
    n+=1
assert n=='$expected_role_starts'
PY'

  assert_ok "${task_id} role_transition includes from/to/session_id" bash -lc 'python3 - <<PY
import json
n=0
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="role_transition":
    assert e.get("from")
    assert e.get("to")
    assert e.get("session_id")
    n+=1
assert n=='$expected_transitions'
PY'

  assert_ok "${task_id} lifecycle has required trace fields" bash -lc 'python3 - <<PY
import json
required=("what_happened","triggered_by","channel","delivery","executed_by","next","details")
ok=False
for line in open("'$lifecycle'", encoding="utf-8"):
  line=line.strip()
  if not line: continue
  e=json.loads(line)
  if e.get("what_happened") in ("ccb_call","bridge_call","role_transition","role_pm_dispatch","role_designer_dispatch"):
    for k in required:
      assert k in e, (k, e)
    ok=True
    break
assert ok
PY'

  if [ "$launch_mode" = "ccb" ]; then
    assert_ok "${task_id} uses ccb_call for role panes" bash -lc 'python3 - <<PY
import json
n=0
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="ccb_call":
    assert e.get("session_id") and e.get("req_code")
    n+=1
assert n=='$expected_role_starts'
PY'
  else
    assert_ok "${task_id} uses bridge_call for role panes" bash -lc 'python3 - <<PY
import json
n=0
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="bridge_call":
    assert e.get("session_id")
    n+=1
assert n=='$expected_role_starts'
PY'
  fi

  assert_ok "${task_id} role_action_finished emitted" bash -lc 'python3 - <<PY
import json
n=0
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="role_action_finished":
    assert e.get("role")
    assert e.get("session_id")
    n+=1
assert n >= 1
PY'

  assert_ok "${task_id} real executor attempt started" bash -lc 'python3 - <<PY
import json
ok=False
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="ATTEMPT_STARTED":
    ok=True
    break
assert ok
PY'

  if [ "$task_type" = "copywriting" ]; then
    assert_ok "${task_id} skips designer role execution" bash -lc 'python3 - <<PY
import json
roles=[]
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="role_action_finished":
    roles.append(e.get("role"))
assert roles==["pm"]
PY'
  else
    assert_ok "${task_id} executes pm+designer role actions" bash -lc 'python3 - <<PY
import json
roles=[]
for line in open("'$events'", encoding="utf-8"):
  e=json.loads(line)
  if e.get("type")=="role_action_finished":
    roles.append(e.get("role"))
assert roles==["pm","designer"]
PY'
  fi
}

echo "=== Test Suite: run_task_routing_v51 ==="
for tt in copywriting solo multi_agent; do
  for lm in ccb bridge; do
    run_case "$tt" "$lm"
  done
done

# missing task_type should fail in v51 signature
bad="${TMPDIR}/missing_task_type.json"
cat > "$bad" <<'JSON'
{
  "schema_version": "v51",
  "task_id": "missing_task_type",
  "launch_mode": "ccb",
  "launch_mode_locked": true,
  "goal": "x",
  "acceptance": "x",
  "test_cmd": "true"
}
JSON
set +e
RDLOOP_OUT_DIR="${TMPDIR}/out" RDLOOP_WORKTREES_DIR="${TMPDIR}/wt" bash "$RUN_TASK" "$bad" >"${TMPDIR}/missing.log" 2>&1
bad_rc=$?
set -e
assert_ok "missing task_type returns non-zero" bash -lc '[ "'$bad_rc'" -ne 0 ]'
assert_ok "missing task_type message clear" bash -lc 'grep -q "task_type is required" "'$TMPDIR'/missing.log"'

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
