#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTEXT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
AGENT_FILE="${CONTEXT_ROOT}/AGENT.md"
RULES_DIR="${CONTEXT_ROOT}/rules"

fail=0

ok() {
  echo "[OK] $1"
}

fail_msg() {
  echo "[FAIL] $1"
  fail=1
}

check_file_exists() {
  local file="$1"
  if [[ -f "${file}" ]]; then
    ok "required file present: ${file#${CONTEXT_ROOT}/}"
  else
    fail_msg "missing required file: ${file#${CONTEXT_ROOT}/}"
  fi
}

check_router_entry() {
  local pattern="$1"
  local label="$2"
  if rg -n --fixed-strings "${pattern}" "${AGENT_FILE}" >/dev/null; then
    ok "router entry present: ${label}"
  else
    fail_msg "missing router entry (${label}) in AGENT.md: ${pattern}"
  fi
}

check_forbidden_token() {
  local token="$1"
  local matches
  matches="$(rg -n --fixed-strings "${token}" "${AGENT_FILE}" "${RULES_DIR}"/*.md || true)"
  if [[ -n "${matches}" ]]; then
    fail_msg "forbidden token detected: ${token}"
    echo "${matches}"
  else
    ok "forbidden token absent: ${token}"
  fi
}

echo "== check_agent_rules_v21 =="

# Required files from taskspec v5.1.3 scope.
check_file_exists "${AGENT_FILE}"
check_file_exists "${RULES_DIR}/git_collab.md"
check_file_exists "${RULES_DIR}/design_contract.md"
check_file_exists "${RULES_DIR}/session_mgmt.md"
check_file_exists "${RULES_DIR}/startup.md"
check_file_exists "${RULES_DIR}/collab_context.md"
check_file_exists "${RULES_DIR}/solo_pane.md"
check_file_exists "${RULES_DIR}/launch_mode.md"

# Key router expectations.
check_router_entry "task_type=copywriting\\|solo\\|multi_agent" "task_type routing"
check_router_entry "rules/launch_mode.md" "launch_mode rule route"
check_router_entry "rules/solo_pane.md" "solo pane rule route"

# Deprecated tokens banned by spec.
check_forbidden_token "executor_type"
check_forbidden_token "session_mode"
check_forbidden_token "api_call"
check_forbidden_token "solo_agent"
check_forbidden_token "judge overall:"
check_forbidden_token "/10"
check_forbidden_token "auto_pass_threshold"

if [[ "${fail}" -ne 0 ]]; then
  echo "== RESULT: FAIL =="
  exit 1
fi

echo "== RESULT: PASS =="
echo "required files present; router entries present; no deprecated tokens detected."
