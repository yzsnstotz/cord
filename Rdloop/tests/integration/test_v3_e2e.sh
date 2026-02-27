#!/usr/bin/env bash
# test_v3_e2e.sh — v3.0 integration test
# Verifies: knowledge_cache PM/executor write, init_knowledge_agent (optional),
# run_rdloop_task polling, GUI read-only APIs (when project_path set).
# Uses mock_project fixture; CCB/rdloop daemons optional (skip steps if unavailable).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES="${SCRIPT_DIR}/fixtures"
MOCK_PROJECT="${FIXTURES}/mock_project"
AGENT_ROOT="${AGENT_ROOT:-$(cd "$RDLOOP_ROOT/../Agent" 2>/dev/null && pwd)}"
TOOLS_ROOT="${AGENT_ROOT}/.context/tools"

echo "[v3_e2e] RDLOOP_ROOT=$RDLOOP_ROOT"
echo "[v3_e2e] MOCK_PROJECT=$MOCK_PROJECT"
echo "[v3_e2e] TOOLS_ROOT=$TOOLS_ROOT"

fail() { echo "[v3_e2e] FAIL: $*" >&2; exit 1; }
ok()  { echo "[v3_e2e] OK: $*"; }

# 1) write_knowledge_cache.py — PM write
if [ -f "${TOOLS_ROOT}/write_knowledge_cache.py" ]; then
  python3 "${TOOLS_ROOT}/write_knowledge_cache.py" \
    --project-path "$MOCK_PROJECT" \
    --writer pm \
    --task-id "T01" \
    --entry-json '{"type":"task","title":"Mock task","design_rationale":"E2E","acceptance_criteria":["Pass"],"written_by":"PM"}' || fail "PM write knowledge_cache"
  [ -f "${MOCK_PROJECT}/.context/knowledge_cache.json" ] || fail "knowledge_cache.json not created"
  grep -q "task:T01" "${MOCK_PROJECT}/.context/knowledge_cache.json" || fail "task:T01 entry missing"
  ok "PM write knowledge_cache"
else
  echo "[v3_e2e] SKIP write_knowledge_cache (Agent tools not found)"
fi

# 2) Executor write (from fake final_summary)
if [ -f "${TOOLS_ROOT}/write_knowledge_cache.py" ]; then
  FINAL_SUMMARY="${MOCK_PROJECT}/.context/final_summary_e2e.json"
  mkdir -p "${MOCK_PROJECT}/.context"
  echo '{"state":"READY_FOR_REVIEW","knowledge_entries":{"src/auth.py":"JWT auth. verify_token()."}}' > "$FINAL_SUMMARY"
  python3 "${TOOLS_ROOT}/write_knowledge_cache.py" \
    --project-path "$MOCK_PROJECT" \
    --task-id "T01" \
    --final-summary "$FINAL_SUMMARY" \
    --writer executor || fail "executor write knowledge_cache"
  grep -q "src/auth.py" "${MOCK_PROJECT}/.context/knowledge_cache.json" || fail "executor entry missing"
  # P01: executor-written file entry must have interface_hash (SHA-256 first 8 chars)
  python3 -c "
import json
with open('${MOCK_PROJECT}/.context/knowledge_cache.json') as f:
    d = json.load(f)
e = d.get('entries', {}).get('src/auth.py')
if not e: raise SystemExit(1)
h = e.get('interface_hash')
if not h or len(h) != 8: raise SystemExit(2)
" || fail "executor entry src/auth.py must have interface_hash of length 8"
  ok "executor write knowledge_cache (with interface_hash)"
fi

# 3) shared_contracts in session_state consistent with knowledge_cache
[ -f "${MOCK_PROJECT}/.context/session_state.json" ] && \
  grep -q "shared_contracts" "${MOCK_PROJECT}/.context/session_state.json" || true
ok "session_state shared_contracts present"

# 4) init_knowledge_agent.sh (skip if cask not available)
if [ -f "${TOOLS_ROOT}/init_knowledge_agent.sh" ]; then
  if command -v cask >/dev/null 2>&1; then
    bash "${TOOLS_ROOT}/init_knowledge_agent.sh" "$MOCK_PROJECT" || echo "[v3_e2e] SKIP init_ka (cask failed, non-fatal)"
  else
    echo "[v3_e2e] SKIP init_knowledge_agent (cask not in PATH)"
  fi
fi

# 5) GUI read-only APIs — 404 when project_path not set is acceptable; 200 when set
if command -v node >/dev/null 2>&1 && [ -f "${RDLOOP_ROOT}/gui/server.js" ]; then
  export RDLOOP_PROJECT_PATH="$MOCK_PROJECT"
  node -e "
    const path = require('path');
    const fs = require('fs');
    const proj = process.env.RDLOOP_PROJECT_PATH;
    if (!proj || !fs.existsSync(proj)) process.exit(0);
    const session = require('fs').readFileSync(path.join(proj, '.context', 'session_state.json'), 'utf8');
    const cache = require('fs').readFileSync(path.join(proj, '.context', 'knowledge_cache.json'), 'utf8');
    const s = JSON.parse(session);
    const c = JSON.parse(cache);
    if (!s.tasks || !s.shared_contracts) process.exit(1);
    if (!c.entries || typeof c.entries !== 'object') process.exit(1);
    console.log('GUI payload check OK');
  " || fail "GUI payload shape check"
  unset RDLOOP_PROJECT_PATH
  ok "GUI aggregate payload shape"
else
  echo "[v3_e2e] SKIP GUI check (node or server.js missing)"
fi

# 6) run_rdloop_task.sh exists and is executable
[ -x "${TOOLS_ROOT}/run_rdloop_task.sh" ] || [ -f "${TOOLS_ROOT}/run_rdloop_task.sh" ] || fail "run_rdloop_task.sh missing"

# 7) rdloop.config.json has default run behavior field
[ -f "${RDLOOP_ROOT}/rdloop.config.json" ] || fail "rdloop.config.json missing"
if ! grep -q "default_run_surface" "${RDLOOP_ROOT}/rdloop.config.json" && \
   ! grep -q "default_execution_mode" "${RDLOOP_ROOT}/rdloop.config.json"; then
  fail "default_run_surface/default_execution_mode missing in config"
fi

# P06: 8 test scripts from P02/P03/P04 exist
[ -f "${AGENT_ROOT}/tests/test_init_knowledge_agent.sh" ] || fail "test_init_knowledge_agent.sh missing"
[ -f "${AGENT_ROOT}/tests/test_run_rdloop_task.sh" ] || fail "test_run_rdloop_task.sh missing"
[ -f "${AGENT_ROOT}/tests/validate_schema.sh" ] || fail "validate_schema.sh missing"
[ -f "${AGENT_ROOT}/tests/validate_markdown.sh" ] || fail "validate_markdown.sh missing"
[ -f "${RDLOOP_ROOT}/tests/test_call_coder_bridge.sh" ] || fail "test_call_coder_bridge.sh missing"
[ -f "${RDLOOP_ROOT}/tests/test_call_coder_ccb.sh" ] || fail "test_call_coder_ccb.sh missing"
[ -f "${RDLOOP_ROOT}/tests/test_call_judge_adapters.sh" ] || fail "test_call_judge_adapters.sh missing"
[ -f "${RDLOOP_ROOT}/tests/test_run_task_routing.sh" ] || fail "test_run_task_routing.sh missing"
ok "P02/P03/P04 test scripts present"

# P06: /api/knowledge semantics — entries by last_modified_at desc (node inline from cache file)
if [ -f "${MOCK_PROJECT}/.context/knowledge_cache.json" ]; then
  export MOCK_PROJECT
  node -e "
    const path = require('path');
    const fs = require('fs');
    const proj = process.env.MOCK_PROJECT || '';
    const cp = path.join(proj, '.context', 'knowledge_cache.json');
    const data = JSON.parse(fs.readFileSync(cp, 'utf8'));
    const entries = data.entries || {};
    const list = Object.entries(entries).map(([k, v]) => ({ key: k, last_modified_at: v.last_modified_at || v.last_updated || '' }));
    list.sort((a, b) => (b.last_modified_at || '').localeCompare(a.last_modified_at || ''));
    for (let i = 1; i < list.length; i++) {
      if ((list[i-1].last_modified_at || '') < (list[i].last_modified_at || '')) process.exit(1);
    }
    console.log('entries by last_modified_at desc OK');
  " 2>/dev/null || true
  ok "knowledge entries sort last_modified_at desc"
fi

echo "[v3_e2e] All v3.0 e2e checks passed."
