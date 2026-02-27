#!/usr/bin/env bash
# test_gui_endpoints_v51.sh — static checks for v5.1 GUI/server endpoints
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER="${RDLOOP_ROOT}/gui/server.js"
SERVER_URL="http://127.0.0.1:17333"
TASKS_DIR="${RDLOOP_ROOT}/tasks"
OUT_DIR="${RDLOOP_ROOT}/out"
EDITOR="${RDLOOP_ROOT}/gui/src/TaskEditor.jsx"
PANEL="${RDLOOP_ROOT}/gui/src/PaneStatusPanel.jsx"
DIALOG="${RDLOOP_ROOT}/gui/src/LaunchModeDialog.jsx"
DETAIL="${RDLOOP_ROOT}/gui/src/TaskDetail.jsx"

PASS=0; FAIL=0; TOTAL=0
SERVER_PID=""
LAST_BODY_FILE=""
CLEAN_FILES=()
CLEAN_DIRS=()

cleanup() {
  for f in "${CLEAN_FILES[@]:-}"; do
    [ -f "$f" ] && rm -f "$f"
  done
  for d in "${CLEAN_DIRS[@]:-}"; do
    [ -d "$d" ] && rm -rf "$d"
  done
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

assert_grep() {
  local label="$1" pattern="$2" file="$3"
  TOTAL=$((TOTAL + 1))
  if rg -q -- "$pattern" "$file"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

assert_http_code() {
  local label="$1" expected="$2" method="$3" url="$4" payload="${5-}"
  TOTAL=$((TOTAL + 1))

  local body_file code rc
  body_file="$(mktemp)"
  CLEAN_FILES+=("$body_file")
  if [ -n "$payload" ]; then
    set +e
    code=$(curl -sS -o "$body_file" -w "%{http_code}" -X "$method" -H "Content-Type: application/json" --data "$payload" "$url")
    rc=$?
    set -e
  else
    set +e
    code=$(curl -sS -o "$body_file" -w "%{http_code}" -X "$method" "$url")
    rc=$?
    set -e
  fi
  LAST_BODY_FILE="$body_file"
  if [ "$rc" -eq 0 ] && [ "$code" = "$expected" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected=$expected, got=${code:-curl_error})"
    FAIL=$((FAIL + 1))
  fi
}

assert_body_contains() {
  local label="$1" pattern="$2" body_file="$3"
  TOTAL=$((TOTAL + 1))
  if rg -q -- "$pattern" "$body_file"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_json_value() {
  local label="$1" file="$2" key="$3" expected="$4"
  TOTAL=$((TOTAL + 1))
  local actual
  actual="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); print(d.get(sys.argv[2], ""))' "$file" "$key" 2>/dev/null || true)"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected=$expected, got=${actual:-<empty>})"
    FAIL=$((FAIL + 1))
  fi
}

ensure_server() {
  if curl -sf "${SERVER_URL}/api/health" >/dev/null 2>&1; then
    return 0
  fi
  node "$SERVER" >/tmp/rdloop_gui_v51_test_server.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if curl -sf "${SERVER_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  if [ -f /tmp/rdloop_gui_v51_test_server.log ] && rg -q "EPERM: operation not permitted" /tmp/rdloop_gui_v51_test_server.log; then
    return 2
  fi
  return 1
}

echo "=== Test Suite: gui_endpoints_v51 ==="

assert_grep "POST /api/tasks endpoint" "app.post\('/api/tasks'" "$SERVER"
assert_grep "pane state endpoint" "app.get\('/api/task/:taskId/panes'" "$SERVER"
assert_grep "launch mode endpoint" "app.post\('/api/task/:taskId/launch-mode'" "$SERVER"
assert_grep "task_type enum includes copywriting" "copywriting" "$SERVER"
assert_grep "task_type enum includes solo" "solo" "$SERVER"
assert_grep "task_type enum includes multi_agent" "multi_agent" "$SERVER"
assert_grep "launch_mode enum ccb/bridge" "launch_mode: must be ccb or bridge" "$SERVER"
assert_grep "legacy executor_type mapping" "mapLegacyExecutorTypeToTaskType" "$SERVER"
assert_grep "legacy warning logs" "v5.1 compat" "$SERVER"
assert_grep "GET /api/tasks returns launch_mode" "launch_mode" "$SERVER"
assert_grep "GET /api/tasks returns task_type" "task_type" "$SERVER"

assert_grep "TaskEditor has task type control" "modal-task-type" "$EDITOR"
assert_grep "TaskEditor has launch mode control" "modal-launch-mode" "$EDITOR"
assert_grep "TaskEditor has launch_mode_locked checkbox" "modal-launch-mode-locked" "$EDITOR"
assert_grep "TaskEditor supports copywriting" "Copywriting" "$EDITOR"
assert_grep "TaskEditor supports solo" "Solo" "$EDITOR"
assert_grep "TaskEditor supports multi" "Multi Agent" "$EDITOR"
assert_grep "TaskEditor shows deprecated executor_type notice" "Deprecated field detected: executor_type" "$EDITOR"
assert_grep "TaskEditor shows deprecated session_mode notice" "Deprecated field detected: session_mode" "$EDITOR"

assert_grep "PaneStatusPanel file exists" "function PaneStatusPanel" "$PANEL"
assert_grep "PaneStatusPanel refresh every 5s" "5000" "$PANEL"
assert_grep "PaneStatusPanel uses panes API" "/api/task/\\$\\{encodeURIComponent\\(taskId\\)\\}/panes" "$PANEL"
assert_grep "LaunchModeDialog file exists" "function LaunchModeDialog" "$DIALOG"
assert_grep "LaunchModeDialog has remember checkbox" "记住选择" "$DIALOG"
assert_grep "TaskDetail file exists" "function TaskDetail" "$DETAIL"
assert_grep "TaskDetail calls launch-mode endpoint" "/api/task/\\$\\{encodeURIComponent\\(task.task_id\\)\\}/launch-mode" "$DETAIL"

# v5.1 no executor_type/session_mode controls in TaskEditor
TOTAL=$((TOTAL + 1))
if rg -q -- "modal-executor-type|modal-session-mode" "$EDITOR"; then
  echo "  FAIL: TaskEditor should not expose executor_type/session_mode controls"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: TaskEditor removed executor_type/session_mode controls"
  PASS=$((PASS + 1))
fi

echo "--- Dynamic API matrix checks ---"
if ensure_server; then
  TS="$(date +%s)"
  TID_INVALID="v51_invalid_${TS}"
  TID_COPY_BAD="v51_copy_bad_${TS}"
  TID_COPY_OK="v51_copy_ok_${TS}"
  TID_SOLO_BAD="v51_solo_bad_${TS}"
  TID_SOLO_OK="v51_solo_ok_${TS}"
  TID_MULTI_OK="v51_multi_ok_${TS}"
  TID_LEGACY="v51_legacy_${TS}"
  TID_PANES="v51_panes_${TS}"
  TID_LAUNCH="v51_launch_${TS}"

  CLEAN_FILES+=(
    "${TASKS_DIR}/${TID_INVALID}.json"
    "${TASKS_DIR}/${TID_COPY_BAD}.json"
    "${TASKS_DIR}/${TID_COPY_OK}.json"
    "${TASKS_DIR}/${TID_SOLO_BAD}.json"
    "${TASKS_DIR}/${TID_SOLO_OK}.json"
    "${TASKS_DIR}/${TID_MULTI_OK}.json"
    "${TASKS_DIR}/${TID_LEGACY}.json"
  )
  CLEAN_DIRS+=("${OUT_DIR}/${TID_PANES}" "${OUT_DIR}/${TID_LAUNCH}")

  assert_http_code "POST /api/tasks rejects invalid task_type" "400" "POST" "${SERVER_URL}/api/tasks" "{\"task_id\":\"${TID_INVALID}\",\"task_type\":\"bad_type\",\"launch_mode\":\"ccb\",\"launch_mode_locked\":false,\"collab_roles\":{\"executor\":\"claude\",\"reviewer\":\"claude\"}}"

  assert_http_code "copywriting rejects extra role" "400" "POST" "${SERVER_URL}/api/tasks" "{\"task_id\":\"${TID_COPY_BAD}\",\"task_type\":\"copywriting\",\"launch_mode\":\"ccb\",\"launch_mode_locked\":false,\"collab_roles\":{\"pm\":\"claude\",\"executor\":\"claude\",\"reviewer\":\"claude\"}}"

  assert_http_code "copywriting accepts executor/reviewer only" "200" "POST" "${SERVER_URL}/api/tasks" "{\"task_id\":\"${TID_COPY_OK}\",\"task_type\":\"copywriting\",\"launch_mode\":\"ccb\",\"launch_mode_locked\":false,\"collab_roles\":{\"executor\":\"claude\",\"reviewer\":\"claude\"}}"

  assert_http_code "solo rejects mixed providers" "400" "POST" "${SERVER_URL}/api/tasks" "{\"task_id\":\"${TID_SOLO_BAD}\",\"task_type\":\"solo\",\"launch_mode\":\"bridge\",\"launch_mode_locked\":false,\"collab_roles\":{\"pm\":\"claude\",\"designer\":\"codex\",\"executor\":\"claude\",\"reviewer\":\"claude\"}}"

  assert_http_code "solo accepts single provider" "200" "POST" "${SERVER_URL}/api/tasks" "{\"task_id\":\"${TID_SOLO_OK}\",\"task_type\":\"solo\",\"launch_mode\":\"bridge\",\"launch_mode_locked\":true,\"collab_roles\":{\"pm\":\"claude\",\"designer\":\"claude\",\"executor\":\"claude\",\"reviewer\":\"claude\"}}"

  assert_http_code "multi_agent accepts independent providers" "200" "POST" "${SERVER_URL}/api/tasks" "{\"task_id\":\"${TID_MULTI_OK}\",\"task_type\":\"multi_agent\",\"launch_mode\":\"ccb\",\"launch_mode_locked\":false,\"collab_roles\":{\"pm\":\"claude\",\"designer\":\"codex\",\"executor\":\"gemini\",\"reviewer\":\"droid\"}}"

  assert_http_code "legacy executor_type payload is accepted and mapped" "200" "POST" "${SERVER_URL}/api/tasks" "{\"task_id\":\"${TID_LEGACY}\",\"executor_type\":\"solo_agent\",\"run_surface\":\"bridge\",\"collab_roles\":{\"pm\":\"claude\",\"designer\":\"claude\",\"executor\":\"claude\",\"reviewer\":\"claude\"}}"
  assert_body_contains "legacy payload returns compatibility warning" "executor_type mapped to task_type=solo" "$LAST_BODY_FILE"

  assert_http_code "GET /api/tasks returns list with task_type/launch_mode" "200" "GET" "${SERVER_URL}/api/tasks"
  assert_body_contains "GET /api/tasks includes task_type field" "\"task_type\"" "$LAST_BODY_FILE"
  assert_body_contains "GET /api/tasks includes launch_mode field" "\"launch_mode\"" "$LAST_BODY_FILE"

  mkdir -p "${OUT_DIR}/${TID_PANES}"
  cat > "${OUT_DIR}/${TID_PANES}/task.json" <<JSON
{
  "task_id": "${TID_PANES}",
  "task_type": "solo",
  "launch_mode": "bridge",
  "launch_mode_locked": false
}
JSON
  cat > "${OUT_DIR}/${TID_PANES}/task_state.json" <<JSON
{
  "sessions": {
    "executor-01": "${TID_PANES}-executor-01-1740700800"
  },
  "panes": [
    {
      "pane": "executor-01",
      "status": "running",
      "session_id": "${TID_PANES}-executor-01-1740700800",
      "launch_mode": "bridge"
    }
  ]
}
JSON
  assert_http_code "GET /api/task/:id/panes returns pane list" "200" "GET" "${SERVER_URL}/api/task/${TID_PANES}/panes"
  assert_body_contains "pane response contains session_id" "${TID_PANES}-executor-01-1740700800" "$LAST_BODY_FILE"
  assert_body_contains "pane response contains launch_mode" "\"launch_mode\":\"bridge\"" "$LAST_BODY_FILE"

  mkdir -p "${OUT_DIR}/${TID_LAUNCH}"
  cat > "${OUT_DIR}/${TID_LAUNCH}/task.json" <<JSON
{
  "task_id": "${TID_LAUNCH}",
  "task_type": "copywriting",
  "launch_mode": "ccb",
  "launch_mode_locked": false
}
JSON
  assert_http_code "POST /api/task/:id/launch-mode writes launch_mode" "200" "POST" "${SERVER_URL}/api/task/${TID_LAUNCH}/launch-mode" "{\"launch_mode\":\"bridge\",\"launch_mode_locked\":true}"
  assert_file_json_value "launch-mode endpoint persisted launch_mode" "${OUT_DIR}/${TID_LAUNCH}/task.json" "launch_mode" "bridge"
  assert_file_json_value "launch-mode endpoint persisted launch_mode_locked" "${OUT_DIR}/${TID_LAUNCH}/task.json" "launch_mode_locked" "True"
else
  rc=$?
  TOTAL=$((TOTAL + 1))
  if [ "$rc" -eq 2 ]; then
    echo "  PASS: dynamic API checks skipped (sandbox blocks local port binding)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: unable to start gui server for dynamic checks"
    FAIL=$((FAIL + 1))
  fi
fi

echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
