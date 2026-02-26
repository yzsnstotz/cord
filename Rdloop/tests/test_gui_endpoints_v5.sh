#!/usr/bin/env bash
# test_gui_endpoints_v5.sh — T13: Tests for v5 GUI changes
# Tests: server.js validation + new endpoints + app.js v5 controls
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_JS="${RDLOOP_ROOT}/gui/server.js"
APP_JS="${RDLOOP_ROOT}/gui/public/app.js"
GUI_SRC="${RDLOOP_ROOT}/gui/src"
TASK_EDITOR="${GUI_SRC}/TaskEditor.jsx"
GIT_STATUS_PANEL="${GUI_SRC}/GitStatusPanel.jsx"
KNOWLEDGE_DEBT_PANEL="${GUI_SRC}/KnowledgeDebtPanel.jsx"
LOOP_STATS_PANEL="${GUI_SRC}/LoopStatsPanel.jsx"

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

assert_file_not_contains() {
  local label="$1" file="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if grep -qE "$needle" "$file" 2>/dev/null; then
    echo "  FAIL: $label (pattern '$needle' should not be present)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  fi
}

echo "=== Test Suite: gui_endpoints_v5 ==="

# ---- server.js: New endpoints exist ----
echo ""
echo "--- server.js: v5 endpoints ---"
assert_file_contains "git-status endpoint" "$SERVER_JS" "api/task/:taskId/git-status"
assert_file_contains "debt endpoint" "$SERVER_JS" "api/knowledge/shards/debt"
assert_file_contains "loop-stats endpoint" "$SERVER_JS" "api/loop-stats"

# ---- server.js: 404 handling for missing files ----
echo ""
echo "--- server.js: 404 graceful handling ---"
assert_file_contains "git-status 404 on missing task" "$SERVER_JS" "status\(404\).*task.*not found"
assert_file_contains "debt 404 on missing file" "$SERVER_JS" "status\(404\).*no debt shard"
assert_file_contains "loop-stats 404 on missing file" "$SERVER_JS" "status\(404\).*no loop_stats"

# ---- server.js: v5 validation ----
echo ""
echo "--- server.js: v5 validation ---"
assert_file_contains "executor_type enum validation" "$SERVER_JS" "executor_type.*api_call.*solo_agent.*multi_agent"
assert_file_contains "session_mode enum validation" "$SERVER_JS" "session_mode.*fresh.*iterative.*continuous"
assert_file_contains "api_call + continuous blocked" "$SERVER_JS" "api_call.*does not support continuous"
assert_file_contains "solo/multi + fresh/iterative blocked" "$SERVER_JS" "only supports continuous"

# ---- v5 controls: TaskEditor.jsx (taskspec standard) + app.js no workflow_mode toggle ----
echo ""
echo "--- v5 controls (TaskEditor.jsx) ---"
assert_file_not_contains "no workflow_mode 3-button toggle" "$APP_JS" 'Workflow Mode.*button.*mode-btn-single'
assert_file_contains "TaskEditor.jsx executor_type" "$TASK_EDITOR" 'modal-executor-type'
assert_file_contains "TaskEditor.jsx session_mode" "$TASK_EDITOR" 'modal-session-mode'

# ---- TaskEditor.jsx: Executor Type and Session Mode options ----
echo ""
echo "--- TaskEditor.jsx: Executor/Session options ---"
assert_file_contains "API Call option" "$TASK_EDITOR" 'value="api_call"'
assert_file_contains "Solo Agent option" "$TASK_EDITOR" 'value="solo_agent"'
assert_file_contains "Multi Agent option" "$TASK_EDITOR" 'value="multi_agent"'
assert_file_contains "Fresh option" "$TASK_EDITOR" 'value="fresh"'
assert_file_contains "Iterative option" "$TASK_EDITOR" 'value="iterative"'
assert_file_contains "Continuous option" "$TASK_EDITOR" 'value="continuous"'

# ---- TaskEditor.jsx: Session Mode constraints ----
echo ""
echo "--- TaskEditor.jsx: constraints ---"
assert_file_contains "updateSessionModeConstraints" "$TASK_EDITOR" 'updateSessionModeConstraints'
assert_file_contains "continuous disabled for api_call" "$TASK_EDITOR" "isContinuousDisabled"
assert_file_contains "fresh disabled for solo/multi" "$TASK_EDITOR" "isFreshDisabled"

# ---- app.js: v5 spec fields in save ----
echo ""
echo "--- app.js: v5 fields in saveNewSpec ---"
assert_file_contains "executor_type in spec" "$APP_JS" 'spec\.executor_type.*=.*_currentExecutorType'
assert_file_contains "session_mode in spec" "$APP_JS" 'spec\.session_mode'
assert_file_contains "agent_config" "$APP_JS" 'spec\.agent_config'

# ---- v5 Panels: JSX components + app.js render functions ----
echo ""
echo "--- v5 panels (src/*.jsx + app.js) ---"
assert_file_contains "GitStatusPanel component" "$GIT_STATUS_PANEL" 'GitStatusPanel'
assert_file_contains "GitStatusPanel api path" "$GIT_STATUS_PANEL" 'git-status'
assert_file_contains "KnowledgeDebtPanel component" "$KNOWLEDGE_DEBT_PANEL" 'KnowledgeDebtPanel'
assert_file_contains "KnowledgeDebtPanel api path" "$KNOWLEDGE_DEBT_PANEL" 'shards/debt'
assert_file_contains "LoopStatsPanel component" "$LOOP_STATS_PANEL" 'LoopStatsPanel'
assert_file_contains "LoopStatsPanel api path" "$LOOP_STATS_PANEL" 'loop-stats'
assert_file_contains "renderGitStatusPanel" "$APP_JS" 'function renderGitStatusPanel'
assert_file_contains "renderKnowledgeDebtPanel" "$APP_JS" 'function renderKnowledgeDebtPanel'
assert_file_contains "renderLoopStatsPanel" "$APP_JS" 'function renderLoopStatsPanel'

# ---- app.js: Solo progress backward compat ----
echo ""
echo "--- app.js: backward compat ---"
assert_file_contains "solo detection uses executor_type" "$APP_JS" "executor_type === 'solo_agent'"
assert_file_contains "legacy workflow_mode fallback" "$APP_JS" "workflow_mode === 'solo'"

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
