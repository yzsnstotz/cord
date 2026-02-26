#!/usr/bin/env bash
# call_judge_ccb.sh — semi-auto mode judge adapter
# Attaches to human tmux session; human can observe judge reasoning.
# Interface: $1=task_json_path $2=evidence_json_path $3=attempt_dir $4=judge_prompt_path [$5=provider (codex|gemini|claude|opencode|droid)]
# Outputs: attempt_dir/judge/verdict.json, attempt_dir/judge/rc.txt, attempt_dir/judge/stdout.log, run.log

set -uo pipefail

task_json_path="$1"
evidence_json_path="$2"
attempt_dir="$3"
judge_prompt_path="$4"
provider_arg="${5:-}"

mkdir -p "${attempt_dir}/judge"

run_log="${attempt_dir}/judge/run.log"
output_file="${attempt_dir}/judge/stdout.log"

judge_timeout=$(python3 -c "
import json
try: print(json.load(open('$task_json_path')).get('judge_timeout_seconds', 300))
except: print(300)
" 2>/dev/null || echo "300")

judge_model=$(python3 -c "
import json
try: print(json.load(open('$task_json_path')).get('judge_model',''))
except: print('')
" 2>/dev/null || echo "")

project_path=$(python3 -c "
import json
try: print(json.load(open('$task_json_path')).get('repo_path',''))
except: print('')
" 2>/dev/null || echo "")
worktree_dir="$project_path"
if [ -f "$evidence_json_path" ]; then
  wt=$(python3 -c "
import json,sys
try:
    with open('$evidence_json_path') as f:
        d = json.load(f)
    print(d.get('worktree_path',''))
except: print('')
" 2>/dev/null || echo "")
  [ -n "$wt" ] && [ -d "$wt" ] && worktree_dir="$wt"
fi

# P16: provider from collab_roles.reviewer (5th arg) or fallback to judge_model prefix
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
  if [[ "$judge_model" == gemini* ]]; then ccb_bin="gask"; ccb_provider="gemini"; fi
fi

# P18: Session file from repo_path/.ccb/ (project-level), not worktree.
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

# Build prompt: judge prompt + evidence
full_prompt=""
if [ -f "$judge_prompt_path" ]; then
  full_prompt=$(cat "$judge_prompt_path")
fi
full_prompt="${full_prompt}

[NOTE: semi-auto mode — human may observe judge reasoning in tmux]
---
"
[ -f "$evidence_json_path" ] && full_prompt="${full_prompt}$(cat "$evidence_json_path")"

{
  echo "[JUDGE][semi-auto/ccb] $(date -u +%Y-%m-%dT%H:%M:%SZ) attached to human session"
  echo "[JUDGE][semi-auto/ccb] provider=${ccb_bin} timeout=${judge_timeout}s"

  if [ -n "$ccb_session_file" ]; then
    if ! CCB_SESSION_FILE="$ccb_session_file" ccb-ping "$ccb_provider" > /dev/null 2>&1; then
      echo "[JUDGE][semi-auto/ccb] CCB daemon unavailable"
      cat > "${attempt_dir}/judge/verdict.json" <<'ENDJSON'
{"schema_version":"v1","decision":"NEED_USER_INPUT","reasons":["CCB daemon unavailable"],"next_instructions":"","questions_for_user":["Start CCB (cask/gask) and retry"]}
ENDJSON
      echo "127" > "${attempt_dir}/judge/rc.txt"
      exit 127
    fi
  else
    if ! (cd "$worktree_dir" && ccb-ping "$ccb_provider") > /dev/null 2>&1; then
      echo "[JUDGE][semi-auto/ccb] CCB daemon unavailable"
      cat > "${attempt_dir}/judge/verdict.json" <<'ENDJSON'
{"schema_version":"v1","decision":"NEED_USER_INPUT","reasons":["CCB daemon unavailable"],"next_instructions":"","questions_for_user":["Start CCB (cask/gask) and retry"]}
ENDJSON
      echo "127" > "${attempt_dir}/judge/rc.txt"
      exit 127
    fi
  fi

  if [ -n "$ccb_session_file" ]; then
    CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin" \
      --output "$output_file" \
      --timeout "$judge_timeout" \
      "$full_prompt" 2>&1
  else
    "$ccb_bin" \
      --output "$output_file" \
      --timeout "$judge_timeout" \
      "$full_prompt" 2>&1
  fi

  rc=$?
  # Extract verdict from stdout if possible
  if [ -f "$output_file" ]; then
    python3 -c "
import json,sys,re
raw=open('$output_file', encoding='utf-8').read()
d=None
try: d=json.loads(raw)
except: pass
if d is None:
    m=re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', raw, re.DOTALL)
    if m:
        try: d=json.loads(m.group())
        except: pass
if d and 'decision' in d and 'reasons' in d:
    with open('${attempt_dir}/judge/verdict.json','w',encoding='utf-8') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
" 2>/dev/null || true
  fi
  [ ! -f "${attempt_dir}/judge/verdict.json" ] && cat > "${attempt_dir}/judge/verdict.json" <<'ENDJSON'
{"schema_version":"v1","decision":"NEED_USER_INPUT","reasons":["Could not extract verdict"],"next_instructions":"","questions_for_user":[]}
ENDJSON
  echo "$rc" > "${attempt_dir}/judge/rc.txt"
  echo "[JUDGE][semi-auto/ccb] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
  exit "$rc"
} >> "$run_log" 2>&1

rc=$?
[ ! -f "${attempt_dir}/judge/rc.txt" ] && echo "$rc" > "${attempt_dir}/judge/rc.txt"
exit "$(cat "${attempt_dir}/judge/rc.txt" 2>/dev/null || echo "$rc")"
