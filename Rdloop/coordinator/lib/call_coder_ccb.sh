#!/usr/bin/env bash
# call_coder_ccb.sh — semi-auto mode coder adapter
# Attaches to human tmux session via /ask; human can observe and intervene in the pane.
# Interface: $1=task_json $2=attempt_dir $3=worktree_dir $4=instruction_path [$5=provider (codex|gemini|claude|opencode|droid)]
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/stdout.log, attempt_dir/coder/rc.txt

set -uo pipefail

task_json="$1"
attempt_dir="$2"
worktree_dir="$3"
instruction_path="$4"
provider_arg="${5:-}"

mkdir -p "${attempt_dir}/coder"

run_log="${attempt_dir}/coder/run.log"
output_file="${attempt_dir}/coder/stdout.log"

timeout_s=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('coder_timeout_seconds',600))
except: print(600)
" 2>/dev/null || echo "600")

coder_model=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('coder_model',''))
except: print('')
" 2>/dev/null || echo "")

project_path=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('repo_path',''))
except: print('')
" 2>/dev/null || echo "")

# P16: provider from collab_roles.executor (5th arg) or fallback to coder_model prefix
ccb_bin="cask"
ccb_provider="codex"
if [ -n "$provider_arg" ]; then
  case "$provider_arg" in
    claude)  ccb_bin="lask"; ccb_provider="claude" ;;
    codex)   ccb_bin="cask"; ccb_provider="codex" ;;
    gemini)  ccb_bin="gask"; ccb_provider="gemini" ;;
    opencode) ccb_bin="oask"; ccb_provider="opencode" ;;
    droid)   ccb_bin="dask"; ccb_provider="droid" ;;
    *)       ccb_bin="cask"; ccb_provider="codex" ;;
  esac
else
  if [[ "$coder_model" == gemini* ]]; then ccb_bin="gask"; ccb_provider="gemini"; fi
fi

# P18: Session file from repo_path/.ccb/ (project-level), not worktree. cwd for cask/gask remains worktree_dir.
ccb_session_file=""
if [ -n "$project_path" ] && [ -d "${project_path}/.ccb" ]; then
  case "$ccb_bin" in
    cask) ccb_session_file="${project_path}/.ccb/.codex-session" ;;
    gask) ccb_session_file="${project_path}/.ccb/.gemini-session" ;;
    lask) ccb_session_file="${project_path}/.ccb/.claude-session" ;;
    oask) ccb_session_file="${project_path}/.ccb/.opencode-session" ;;
    dask) ccb_session_file="${project_path}/.ccb/.droid-session" ;;
    *)   ccb_session_file="${project_path}/.ccb/.codex-session" ;;
  esac
fi

knowledge_cache="${project_path}/.context/knowledge_cache.json"
instruction=$(cat "$instruction_path" 2>/dev/null || echo "")

full_prompt="[WORKING DIRECTORY: ${worktree_dir}]
[KNOWLEDGE CACHE: ${knowledge_cache}]
[NOTE: semi-auto mode — human may observe and intervene via tmux]
${instruction}"

{
  echo "[CODER][semi-auto/ccb] $(date -u +%Y-%m-%dT%H:%M:%SZ) attached to human tmux session"
  echo "[CODER][semi-auto/ccb] provider=${ccb_bin} timeout=${timeout_s}s project_path=${project_path:-<unset>}"

  ccb_ping_ok=0
  ping_retries=3
  ping_interval=1
  for (( attempt=1; attempt <= ping_retries; attempt++ )); do
    if [ -n "$ccb_session_file" ]; then
      CCB_SESSION_FILE="$ccb_session_file" ccb-ping "$ccb_provider" > /dev/null 2>&1 && { ccb_ping_ok=1; break; }
    else
      (cd "$worktree_dir" && ccb-ping "$ccb_provider") > /dev/null 2>&1 && { ccb_ping_ok=1; break; }
    fi
    if [ "$attempt" -lt "$ping_retries" ]; then
      echo "[CODER][semi-auto/ccb] ping attempt ${attempt}/${ping_retries} failed, retrying in ${ping_interval}s..."
      sleep "$ping_interval"
    fi
  done

  if [ "$ccb_ping_ok" -ne 1 ]; then
    echo "[CODER][semi-auto/ccb] CCB daemon unavailable after ${ping_retries} ping(s)"
    echo "[CODER][semi-auto/ccb] diagnostic: provider=${ccb_provider} (ask=${ccb_bin}) session_file=${ccb_session_file:-<unset>} session_file_exists=$([ -n "$ccb_session_file" ] && [ -f "$ccb_session_file" ] && echo yes || echo no) ccb-ping=$(command -v ccb-ping 2>/dev/null || echo ccb-ping)"
    echo "127" > "${attempt_dir}/coder/rc.txt"
    exit 127
  fi

  if [ -n "$ccb_session_file" ]; then
    CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin" \
      --output "$output_file" \
      --timeout "$timeout_s" \
      "$full_prompt" 2>&1
  else
    "$ccb_bin" \
      --output "$output_file" \
      --timeout "$timeout_s" \
      "$full_prompt" 2>&1
  fi

  rc=$?
  echo "$rc" > "${attempt_dir}/coder/rc.txt"
  echo "[CODER][semi-auto/ccb] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
  exit "$rc"
} > "$run_log" 2>&1

rc=$?
[ ! -f "${attempt_dir}/coder/rc.txt" ] && echo "$rc" > "${attempt_dir}/coder/rc.txt"
exit "$(cat "${attempt_dir}/coder/rc.txt" 2>/dev/null || echo "$rc")"
