#!/usr/bin/env bash
# test_e2e_v51.sh — end-to-end verification for v5.1 routing/migration/session flow.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"
SELF_CHECK="${RDLOOP_ROOT}/coordinator/self_check.sh"
MIGRATE="${RDLOOP_ROOT}/tools/migrate_task_json_v51.sh"
VALIDATE="${RDLOOP_ROOT}/tools/validate_schema.sh"
FIXTURE_DIR="${SCRIPT_DIR}/fixtures/mock_project_v51"

PASS=0
FAIL=0
TOTAL=0

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

assert_cmd() {
  local label="$1"
  shift
  TOTAL=$((TOTAL + 1))
  if "$@" >/dev/null 2>&1; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

assert_python() {
  local label="$1"
  local py="$2"
  shift 2
  TOTAL=$((TOTAL + 1))
  if python3 -c "$py" "$@" >/dev/null 2>&1; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Test Suite: e2e_v51 ==="

REPO_DIR="${TMPDIR}/repo"
TASKS_TMP="${TMPDIR}/tasks"
OUT_TMP="${TMPDIR}/out"
WORKTREES_TMP="${TMPDIR}/worktrees"
mkdir -p "$REPO_DIR" "$TASKS_TMP" "$OUT_TMP" "$WORKTREES_TMP"

assert_cmd "initialize fixture git repo" bash -c "
  set -euo pipefail
  git -C '$REPO_DIR' init >/dev/null
  git -C '$REPO_DIR' config user.email rdloop@test.local
  git -C '$REPO_DIR' config user.name rdloop-test
  echo '# fixture repo' > '$REPO_DIR/README.md'
  git -C '$REPO_DIR' add README.md
  git -C '$REPO_DIR' commit -m 'init fixture repo' >/dev/null
"

cp "${FIXTURE_DIR}/tasks/"*.json "$TASKS_TMP/"
for f in "$TASKS_TMP"/*.json; do
  python3 -c '
import pathlib, sys
p = pathlib.Path(sys.argv[1])
repo = sys.argv[2]
p.write_text(p.read_text(encoding="utf-8").replace("__REPO__", repo), encoding="utf-8")
' "$f" "$REPO_DIR"
done

# Batch migrate fixture tasks.
FIXTURE_TASKS=()
while IFS= read -r f; do
  FIXTURE_TASKS+=("$f")
done < <(find "$TASKS_TMP" -maxdepth 1 -name '*.json' | sort)
ALL_TASKS=("${FIXTURE_TASKS[@]}")

assert_cmd "batch migrate all task specs to v5.1" bash "$MIGRATE" --in-place --keep-legacy "${ALL_TASKS[@]}"
assert_cmd "validate migrated task specs via v5.1 schema rules" bash "$VALIDATE" "${ALL_TASKS[@]}"

copy_spec="${TASKS_TMP}/copywriting_ccb_legacy.json"
solo_spec="${TASKS_TMP}/solo_bridge_legacy.json"
multi_spec="${TASKS_TMP}/multi_agent_ccb_legacy.json"

assert_cmd "copywriting + ccb flow runs" env RDLOOP_OUT_DIR="$OUT_TMP" RDLOOP_WORKTREES_DIR="$WORKTREES_TMP" bash "$RUN_TASK" "$copy_spec"
assert_cmd "solo + bridge flow runs" env RDLOOP_OUT_DIR="$OUT_TMP" RDLOOP_WORKTREES_DIR="$WORKTREES_TMP" bash "$RUN_TASK" "$solo_spec"
assert_cmd "multi_agent + ccb flow runs" env RDLOOP_OUT_DIR="$OUT_TMP" RDLOOP_WORKTREES_DIR="$WORKTREES_TMP" bash "$RUN_TASK" "$multi_spec"

check_events_py='
import json,sys
task_dir, expected_mode, expected_roles_csv = sys.argv[1:4]
events_path = task_dir + "/events.jsonl"
state_path = task_dir + "/task_state.json"
status_path = task_dir + "/status.json"

expected_roles = [r for r in expected_roles_csv.split(",") if r]
with open(events_path, encoding="utf-8") as f:
    events = [json.loads(line) for line in f if line.strip()]

with open(status_path, encoding="utf-8") as f:
    status = json.load(f)
if status.get("state") != "READY_FOR_REVIEW":
    raise SystemExit("state not READY_FOR_REVIEW")

role_start = [e for e in events if e.get("type") == "role_start"]
role_transition = [e for e in events if e.get("type") == "role_transition"]
role_commit = [e for e in events if e.get("type") == "role_commit"]
if not role_start:
    raise SystemExit("missing role_start")
if not role_transition:
    raise SystemExit("missing role_transition")
if not role_commit:
    raise SystemExit("missing role_commit")

start_roles = [e.get("role") for e in role_start]
if start_roles != expected_roles:
    raise SystemExit("role_start sequence mismatch")

for e in role_start:
    if not e.get("session_id"):
        raise SystemExit("role_start missing session_id")
for e in role_transition:
    if not e.get("from") or not e.get("to") or not e.get("session_id"):
        raise SystemExit("role_transition missing fields")
for e in role_commit:
    if not e.get("session_id"):
        raise SystemExit("role_commit missing session_id")

with open(state_path, encoding="utf-8") as f:
    state = json.load(f)
panes = state.get("panes") or []
if len(panes) != len(expected_roles):
    raise SystemExit("pane count mismatch")
for pane in panes:
    if not pane.get("session_id"):
        raise SystemExit("pane missing session_id")
    if pane.get("launch_mode") != expected_mode:
        raise SystemExit("pane launch_mode mismatch")
'

assert_python "copywriting events/session_id/task_state checks" "$check_events_py" "${OUT_TMP}/copywriting_ccb_legacy" "ccb" "pm,executor,reviewer"
assert_python "solo events/session_id/task_state checks" "$check_events_py" "${OUT_TMP}/solo_bridge_legacy" "bridge" "pm,designer,executor,reviewer"
assert_python "multi_agent events/session_id/task_state checks" "$check_events_py" "${OUT_TMP}/multi_agent_ccb_legacy" "ccb" "pm,designer,executor,reviewer"

assert_cmd "self_check passes on isolated v5.1 out dir" bash "$SELF_CHECK" "$OUT_TMP"

assert_cmd "regression: test_run_task_routing_v51" bash "${RDLOOP_ROOT}/tests/test_run_task_routing_v51.sh"
assert_cmd "regression: test_task_schema_v51" bash "${RDLOOP_ROOT}/tests/test_task_schema_v51.sh"
assert_cmd "regression: test_session_id" bash "${RDLOOP_ROOT}/tests/test_session_id.sh"
assert_cmd "regression: test_req_boundary_extraction" bash "${RDLOOP_ROOT}/tests/test_req_boundary_extraction.sh"
assert_cmd "regression: test_git_ops_role_commit" bash "${RDLOOP_ROOT}/tests/test_git_ops_role_commit.sh"

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
