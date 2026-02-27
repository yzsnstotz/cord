#!/usr/bin/env bash
# validate_markdown.sh — v2.1 markdown/rule checks for Agent context docs.
# Usage:
#   bash Agent/tests/validate_markdown.sh                 # run full v2.1 suite
#   bash Agent/tests/validate_markdown.sh <markdown_file> # basic single-file check

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

check_exists() {
  local file="$1"
  if [ -f "$file" ]; then pass "exists: $file"; else fail "missing file: $file"; fi
}

check_contains() {
  local label="$1" file="$2" pattern="$3"
  if rg -q -- "$pattern" "$file"; then pass "$label"; else fail "$label"; fi
}

check_not_contains() {
  local label="$1" file="$2" pattern="$3"
  if rg -q -- "$pattern" "$file"; then fail "$label"; else pass "$label"; fi
}

basic_markdown_check() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "validate_markdown: missing file: $file" >&2
    exit 1
  fi
  if ! rg -q '^# ' "$file"; then
    echo "validate_markdown: first-level markdown heading missing: $file" >&2
    exit 1
  fi
  echo "validate_markdown: OK ($file)"
}

if [ "$#" -ge 1 ]; then
  basic_markdown_check "$1"
  exit 0
fi

AGENT_MD="${AGENT_ROOT}/.context/AGENT.md"
SOLO_RULE="${AGENT_ROOT}/.context/rules/solo_pane.md"
LAUNCH_RULE="${AGENT_ROOT}/.context/rules/launch_mode.md"
COLLAB_RULE="${AGENT_ROOT}/.context/rules/collab_context.md"
GIT_RULE="${AGENT_ROOT}/.context/rules/git_collab.md"

echo "=== validate_markdown (v2.1 suite) ==="

for file in "$AGENT_MD" "$SOLO_RULE" "$LAUNCH_RULE" "$COLLAB_RULE" "$GIT_RULE"; do
  check_exists "$file"
done

check_contains "AGENT.md version is v2.1" "$AGENT_MD" 'AGENT\.md v2\.1'
check_contains "AGENT.md includes copywriting task_type" "$AGENT_MD" '\bcopywriting\b'
check_contains "AGENT.md includes solo task_type" "$AGENT_MD" '\bsolo\b'
check_contains "AGENT.md includes multi_agent task_type" "$AGENT_MD" '\bmulti_agent\b'
check_contains "AGENT.md references launch_mode routing" "$AGENT_MD" 'launch_mode'
check_not_contains "AGENT.md removed executor_type references" "$AGENT_MD" '\bexecutor_type\b'
check_not_contains "AGENT.md removed session_mode references" "$AGENT_MD" '\bsession_mode\b'
check_not_contains "AGENT.md removed api_call references" "$AGENT_MD" '\bapi_call\b'

check_contains "solo_pane defines independent pane rule" "$SOLO_RULE" 'independent pane'
check_contains "solo_pane defines context isolation" "$SOLO_RULE" 'Context is isolated'
check_contains "solo_pane defines coordinator-controlled transition" "$SOLO_RULE" 'Coordinator controls all transitions'

check_contains "launch_mode defines CCB channel" "$LAUNCH_RULE" '\bccb\b'
check_contains "launch_mode defines Bridge channel" "$LAUNCH_RULE" '\bbridge\b'
check_contains "launch_mode defines coordinator authority" "$LAUNCH_RULE" 'absolute scheduling authority'
check_contains "launch_mode forbids channel self-scheduling" "$LAUNCH_RULE" 'must not perform autonomous role switching'

check_contains "collab_context documents inspiration trigger" "$COLLAB_RULE" 'Inspiration Trigger'
check_contains "collab_context uses reviewer low score trigger" "$COLLAB_RULE" 'reviewer score is low'
check_contains "collab_context requires multiple failed attempts" "$COLLAB_RULE" '>=2 attempts'
check_contains "collab_context forbids inspiration direct code/copy output" "$COLLAB_RULE" 'MUST NOT directly output executable code or final copywriting text'

check_contains "git_collab documents role-commit" "$GIT_RULE" 'role-commit'
check_contains "git_collab states agent must not commit on transition" "$GIT_RULE" 'Agents do NOT run `git commit`'

echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
