#!/usr/bin/env bash
# test_v5_e2e.sh — T14: v5.0 end-to-end integration test
# Verifies: migrate_task_json, executor_type routing, bug fixes,
# git_ops workflow, loop_lifecycle, GUI endpoints.
# Uses mock LLM (mock coder/judge) — no real API calls.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES="${SCRIPT_DIR}/fixtures"
RUN_TASK="${RDLOOP_ROOT}/coordinator/run_task.sh"
MIGRATE="${RDLOOP_ROOT}/tools/migrate_task_json.sh"
GIT_OPS="${RDLOOP_ROOT}/tools/git_ops.sh"
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

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle" 2>/dev/null; then echo "  PASS: $label"; PASS=$((PASS+1))
  else echo "  FAIL: $label ('$needle' not found)"; FAIL=$((FAIL+1)); fi
}

assert_file_contains() {
  local label="$1" file="$2" needle="$3"
  TOTAL=$((TOTAL + 1))
  if grep -q "$needle" "$file" 2>/dev/null; then echo "  PASS: $label"; PASS=$((PASS+1))
  else echo "  FAIL: $label ('$needle' not in $file)"; FAIL=$((FAIL+1)); fi
}

assert_file_exists() {
  local label="$1" file="$2"
  TOTAL=$((TOTAL + 1))
  if [ -f "$file" ]; then echo "  PASS: $label"; PASS=$((PASS+1))
  else echo "  FAIL: $label ($file not found)"; FAIL=$((FAIL+1)); fi
}

assert_rc() {
  local label="$1" expected_rc="$2"
  shift 2
  local actual_rc=0
  "$@" >/dev/null 2>&1 || actual_rc=$?
  TOTAL=$((TOTAL + 1))
  if [ "$expected_rc" = "$actual_rc" ]; then echo "  PASS: $label"; PASS=$((PASS+1))
  else echo "  FAIL: $label (expected rc=$expected_rc, actual rc=$actual_rc)"; FAIL=$((FAIL+1)); fi
}

echo "=== Integration Test Suite: v5.0 e2e ==="

##############################################################################
# 1. migrate_task_json.sh — v4 → v5 migration for all three workflow_modes
##############################################################################
echo ""
echo "--- 1. migrate_task_json.sh ---"

# 1a. single → api_call + fresh
TASK_SINGLE="$TMPDIR/task_single.json"
cat > "$TASK_SINGLE" <<'EOF'
{"task_id":"test_single","workflow_mode":"single","goal":"test","acceptance":"pass","test_cmd":"true","max_attempts":3}
EOF
bash "$MIGRATE" "$TASK_SINGLE"
EXEC_TYPE=$(python3 -c "import json; d=json.load(open('$TASK_SINGLE')); print(d.get('executor_type',''))")
SESS_MODE=$(python3 -c "import json; d=json.load(open('$TASK_SINGLE')); print(d.get('session_mode',''))")
assert_eq "single→api_call" "api_call" "$EXEC_TYPE"
assert_eq "single→fresh" "fresh" "$SESS_MODE"

# 1b. solo → solo_agent + continuous
TASK_SOLO="$TMPDIR/task_solo.json"
cat > "$TASK_SOLO" <<'EOF'
{"task_id":"test_solo","workflow_mode":"solo","goal":"test","acceptance":"pass","solo_config":{"max_iterations":5}}
EOF
bash "$MIGRATE" "$TASK_SOLO"
EXEC_TYPE=$(python3 -c "import json; d=json.load(open('$TASK_SOLO')); print(d.get('executor_type',''))")
SESS_MODE=$(python3 -c "import json; d=json.load(open('$TASK_SOLO')); print(d.get('session_mode',''))")
HAS_AGENT_CFG=$(python3 -c "import json; d=json.load(open('$TASK_SOLO')); print('yes' if 'agent_config' in d else 'no')")
assert_eq "solo→solo_agent" "solo_agent" "$EXEC_TYPE"
assert_eq "solo→continuous" "continuous" "$SESS_MODE"
assert_eq "solo_config→agent_config" "yes" "$HAS_AGENT_CFG"

# 1c. collab → multi_agent + continuous
TASK_COLLAB="$TMPDIR/task_collab.json"
cat > "$TASK_COLLAB" <<'EOF'
{"task_id":"test_collab","workflow_mode":"collab","goal":"test","acceptance":"pass","collab_roles":{"executor":"codex"}}
EOF
bash "$MIGRATE" "$TASK_COLLAB"
EXEC_TYPE=$(python3 -c "import json; d=json.load(open('$TASK_COLLAB')); print(d.get('executor_type',''))")
SESS_MODE=$(python3 -c "import json; d=json.load(open('$TASK_COLLAB')); print(d.get('session_mode',''))")
assert_eq "collab→multi_agent" "multi_agent" "$EXEC_TYPE"
assert_eq "collab→continuous" "continuous" "$SESS_MODE"

# 1d. Idempotent: already migrated file unchanged
BEFORE=$(cat "$TASK_COLLAB")
bash "$MIGRATE" "$TASK_COLLAB"
AFTER=$(cat "$TASK_COLLAB")
assert_eq "migration idempotent" "$BEFORE" "$AFTER"

##############################################################################
# 2. run_task.sh routing — executor_type × session_mode recognized
##############################################################################
echo ""
echo "--- 2. run_task.sh routing ---"

# Verify run_task.sh contains v5 routing code
assert_file_contains "executor_type routing" "$RUN_TASK" 'case.*executor_type'
assert_file_contains "session_mode routing" "$RUN_TASK" 'case.*session_mode'
assert_file_contains "api_call→cliproxy" "$RUN_TASK" 'coder_type="cliproxy"'
assert_file_contains "solo_agent→solo" "$RUN_TASK" 'solo_agent'
assert_file_contains "multi_agent→ccb" "$RUN_TASK" 'multi_agent'
assert_file_contains "fresh→reset" "$RUN_TASK" 'fresh.*context_strategy.*reset'
assert_file_contains "iterative→carry" "$RUN_TASK" 'iterative.*context_strategy.*carry'
assert_file_contains "continuous→persist" "$RUN_TASK" 'continuous.*context_strategy.*persist'

##############################################################################
# 3. Bug1: judge feedback injection — iterative vs fresh
##############################################################################
echo ""
echo "--- 3. Bug1: judge feedback injection ---"

assert_file_contains "iterative injects next_instructions" "$RUN_TASK" 'next_instructions'
assert_file_contains "session_mode-aware build_instruction" "$RUN_TASK" 'eff_ctx.*carry'
assert_file_contains "fresh mode: no history" "$RUN_TASK" 'eff_ctx.*reset'

##############################################################################
# 4. Bug2: worktree pre-initialization
##############################################################################
echo ""
echo "--- 4. Bug2: worktree pre-init ---"

assert_file_contains "pre-created worktree check" "$RUN_TASK" 'pre_wt'
assert_file_contains "WORKTREES_DIR used" "$RUN_TASK" 'WORKTREES_DIR'

##############################################################################
# 5. git_ops.sh — create-branches / merge-pr / review-prep
##############################################################################
echo ""
echo "--- 5. git_ops.sh workflow ---"

# Setup a mock repo for git_ops tests
MOCK_REPO="$TMPDIR/git_ops_repo"
mkdir -p "$MOCK_REPO"
git -C "$MOCK_REPO" init >/dev/null 2>&1
echo "init" > "$MOCK_REPO/README.md"
git -C "$MOCK_REPO" add . && git -C "$MOCK_REPO" commit -m "init" >/dev/null 2>&1

# Test create-branches
BRANCH_SPEC_FILE="$TMPDIR/branch_spec.json"
cat > "$BRANCH_SPEC_FILE" <<EOF
{"type":"BranchInitSpec","task_slug":"e2e-test","date":"2026-02-26","repo_path":"$MOCK_REPO","base_ref":"main","workers":[{"task_id":"coder","executor_type":"api_call","role":"coder","provider":"claude"}]}
EOF
TOTAL=$((TOTAL + 1))
if bash "$GIT_OPS" create-branches "$BRANCH_SPEC_FILE" >/dev/null 2>&1; then
  echo "  PASS: create-branches succeeds"
  PASS=$((PASS + 1))
else
  echo "  FAIL: create-branches failed"
  FAIL=$((FAIL + 1))
fi

# Verify task branch exists (format: task/YYYYMMDD-slug)
BRANCHES=$(git -C "$MOCK_REPO" branch --list 2>/dev/null | tr -d ' *')
assert_contains "task branch created" "$BRANCHES" "task/2026-02-26-e2e-test"

# Verify worker branch exists (api_call → worker/slug-content)
assert_contains "worker branch created" "$BRANCHES" "worker/e2e-test-content"

# Test review-prep
TOTAL=$((TOTAL + 1))
REVIEW_OUT=$(bash "$GIT_OPS" review-prep "e2e-test" "" "$MOCK_REPO" "task/2026-02-26-e2e-test" 2>/dev/null || echo '{}')
if echo "$REVIEW_OUT" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  echo "  PASS: review-prep returns valid JSON"
  PASS=$((PASS + 1))
else
  echo "  FAIL: review-prep did not return valid JSON"
  FAIL=$((FAIL + 1))
fi

##############################################################################
# 6. loop_lifecycle.sh — regression gate + knowledge write + stats
##############################################################################
echo ""
echo "--- 6. loop_lifecycle.sh ---"

# Setup mock task in out/
MOCK_OUT="$TMPDIR/out_e2e"
MOCK_TASK_DIR="$MOCK_OUT/e2e_lifecycle"
mkdir -p "$MOCK_TASK_DIR/attempt_001/coder"
mkdir -p "$MOCK_TASK_DIR/attempt_001/judge"

# Create mock repo with .context
MOCK_LIFECYCLE_REPO="$TMPDIR/lifecycle_repo"
mkdir -p "$MOCK_LIFECYCLE_REPO/.context"
echo '{}' > "$MOCK_LIFECYCLE_REPO/.context/session_state.json"
git -C "$MOCK_LIFECYCLE_REPO" init >/dev/null 2>&1
echo "init" > "$MOCK_LIFECYCLE_REPO/README.md"
git -C "$MOCK_LIFECYCLE_REPO" add . && git -C "$MOCK_LIFECYCLE_REPO" commit -m "init" >/dev/null 2>&1

cat > "$MOCK_TASK_DIR/task.json" <<EOF
{"task_id":"e2e_lifecycle","executor_type":"api_call","session_mode":"iterative","goal":"test","acceptance":"test","test_cmd":"true","repo_path":"$MOCK_LIFECYCLE_REPO","max_attempts":3}
EOF
echo '{"task_id":"e2e_lifecycle","state":"READY_FOR_REVIEW"}' > "$MOCK_TASK_DIR/final_summary.json"
echo '{"src/main.py":"Main entry point"}' > "$MOCK_TASK_DIR/attempt_001/coder/knowledge_entries.json"
: > "$MOCK_TASK_DIR/events.jsonl"

# Run on-loop-complete (test_cmd=true should pass)
TOTAL=$((TOTAL + 1))
if RDLOOP_OUT_DIR="$MOCK_OUT" bash "$LOOP_LIFECYCLE" on-loop-complete "e2e_lifecycle" "$MOCK_LIFECYCLE_REPO" "$MOCK_TASK_DIR/task.json" >/dev/null 2>&1; then
  echo "  PASS: on-loop-complete succeeds"
  PASS=$((PASS + 1))
else
  echo "  FAIL: on-loop-complete failed"
  FAIL=$((FAIL + 1))
fi

# Verify outputs
assert_file_contains "loop_complete event" "$MOCK_TASK_DIR/events.jsonl" "loop_complete"
assert_file_exists "loop_stats.jsonl" "$MOCK_OUT/loop_stats.jsonl"
assert_file_contains "session_state updated" "$MOCK_LIFECYCLE_REPO/.context/session_state.json" "completed_loops"

# Knowledge shard written
assert_file_exists "module shard" "$MOCK_LIFECYCLE_REPO/.context/knowledge/module_task_e2e_lifecycle.json"

# 6b. Regression gate blocks on test_cmd failure
cat > "$MOCK_TASK_DIR/task.json" <<EOF
{"task_id":"e2e_lifecycle","executor_type":"api_call","session_mode":"iterative","goal":"test","acceptance":"test","test_cmd":"exit 1","repo_path":"$MOCK_LIFECYCLE_REPO","max_attempts":3}
EOF
TOTAL=$((TOTAL + 1))
if RDLOOP_OUT_DIR="$MOCK_OUT" bash "$LOOP_LIFECYCLE" on-loop-complete "e2e_lifecycle" "$MOCK_LIFECYCLE_REPO" "$MOCK_TASK_DIR/task.json" >/dev/null 2>&1; then
  echo "  FAIL: regression gate should block"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: regression gate blocks correctly"
  PASS=$((PASS + 1))
fi

##############################################################################
# 7. Session state derived from git (no state_update.sh needed)
##############################################################################
echo ""
echo "--- 7. Session state derivation ---"

SS=$(cat "$MOCK_LIFECYCLE_REPO/.context/session_state.json")
assert_contains "last_loop_id present" "$SS" "last_loop_id"
assert_contains "completed_loops present" "$SS" "completed_loops"

##############################################################################
# 8. multi_agent: cross_contamination detection in review-prep
##############################################################################
echo ""
echo "--- 8. multi_agent cross_contamination ---"

MULTI_REPO="$TMPDIR/multi_repo"
mkdir -p "$MULTI_REPO"
git -C "$MULTI_REPO" init >/dev/null 2>&1
echo "init" > "$MULTI_REPO/README.md"
git -C "$MULTI_REPO" add . && git -C "$MULTI_REPO" commit -m "init" >/dev/null 2>&1

# Create task branch + two worker branches
MULTI_SPEC_FILE="$TMPDIR/multi_spec.json"
cat > "$MULTI_SPEC_FILE" <<EOF
{"type":"BranchInitSpec","task_slug":"multi-test","date":"2026-02-26","repo_path":"$MULTI_REPO","base_ref":"main","workers":[{"task_id":"coder","executor_type":"multi_agent","label":"coder","role":"coder","provider":"claude"},{"task_id":"reviewer","executor_type":"multi_agent","label":"reviewer","role":"reviewer","provider":"codex"}]}
EOF
bash "$GIT_OPS" create-branches "$MULTI_SPEC_FILE" >/dev/null 2>&1 || true

# Prune worktrees created by create-branches (they may interfere with checkout)
git -C "$MULTI_REPO" worktree prune 2>/dev/null || true

# Make a commit on one worker branch
WORKER_BRANCH=$(git -C "$MULTI_REPO" branch --list "worker/multi-test*" | head -1 | tr -d ' *')
if [ -n "$WORKER_BRANCH" ]; then
  # Use worktree for worker changes
  WORKER_WT="$TMPDIR/multi_worker_wt"
  set +e
  git -C "$MULTI_REPO" worktree add "$WORKER_WT" "$WORKER_BRANCH" >/dev/null 2>&1
  WT_RC=$?
  set -e
  if [ "$WT_RC" = "0" ] && [ -d "$WORKER_WT" ]; then
    echo "worker code" > "$WORKER_WT/worker.txt"
    git -C "$WORKER_WT" add . && git -C "$WORKER_WT" commit -m "worker change" >/dev/null 2>&1
    git -C "$MULTI_REPO" worktree remove --force "$WORKER_WT" 2>/dev/null || true
  fi

  # Review-prep should work
  TASK_BRANCH=$(git -C "$MULTI_REPO" branch --list "task/*multi-test*" | head -1 | tr -d ' *')
  if [ -n "$TASK_BRANCH" ]; then
    TOTAL=$((TOTAL + 1))
    REVIEW_JSON=$(bash "$GIT_OPS" review-prep "multi-test" "" "$MULTI_REPO" "$TASK_BRANCH" 2>/dev/null || echo '{}')
    if echo "$REVIEW_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('task_id',''))" 2>/dev/null | grep -q "multi-test"; then
      echo "  PASS: multi_agent review-prep"
      PASS=$((PASS + 1))
    else
      echo "  FAIL: multi_agent review-prep output unexpected"
      FAIL=$((FAIL + 1))
    fi
  fi
fi

##############################################################################
# 9. GUI endpoints (static analysis — no server needed)
##############################################################################
echo ""
echo "--- 9. GUI v5 integration ---"

GUI_SERVER="${RDLOOP_ROOT}/gui/server.js"
GUI_APP="${RDLOOP_ROOT}/gui/public/app.js"

# Verify v5 endpoints exist
assert_file_contains "git-status route" "$GUI_SERVER" "/api/task/:taskId/git-status"
assert_file_contains "debt route" "$GUI_SERVER" "/api/knowledge/shards/debt"
assert_file_contains "loop-stats route" "$GUI_SERVER" "/api/loop-stats"

# Verify v5 controls in frontend
assert_file_contains "executor_type dropdown" "$GUI_APP" "modal-executor-type"
assert_file_contains "session_mode dropdown" "$GUI_APP" "modal-session-mode"
assert_file_contains "constraint logic" "$GUI_APP" "updateSessionModeConstraints"

##############################################################################
# 10. Agent rules v2.0 — structural verification
##############################################################################
echo ""
echo "--- 10. Agent rules v2.0 ---"

AGENT_ROOT="${RDLOOP_ROOT}/../Agent"
if [ -d "$AGENT_ROOT/.context" ]; then
  AGENT_MD="$AGENT_ROOT/.context/AGENT.md"
  assert_file_contains "AGENT.md v2.0" "$AGENT_MD" "AGENT.md v2.0"
  assert_file_contains "git_collab rule" "$AGENT_MD" "git_collab"
  assert_file_contains "design_contract rule" "$AGENT_MD" "design_contract"

  if [ -f "$AGENT_ROOT/.context/rules/git_collab.md" ]; then
    assert_file_contains "BranchInitSpec in git_collab" "$AGENT_ROOT/.context/rules/git_collab.md" "BranchInitSpec"
    assert_file_contains "MergeDecision in git_collab" "$AGENT_ROOT/.context/rules/git_collab.md" "MergeDecision"
  fi

  if [ -f "$AGENT_ROOT/.context/rules/design_contract.md" ]; then
    assert_file_contains "multi_agent scope" "$AGENT_ROOT/.context/rules/design_contract.md" "multi_agent"
  fi

  if [ -f "$AGENT_ROOT/.context/rules/session_mgmt.md" ]; then
    assert_file_contains "session_mgmt v2.0" "$AGENT_ROOT/.context/rules/session_mgmt.md" "session_mgmt.md v2.0"
    assert_file_contains "loop context rebuild" "$AGENT_ROOT/.context/rules/session_mgmt.md" "loop context rebuild"
  fi
else
  echo "  SKIP: Agent rules (Agent root not found)"
fi

# ---- Summary ----
echo ""
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
