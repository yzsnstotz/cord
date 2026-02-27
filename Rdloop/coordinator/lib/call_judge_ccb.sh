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

find_ccb_root() {
  local p="${1:-}"
  [ -n "$p" ] || return 1
  if [ ! -d "$p" ]; then
    p="$(dirname "$p" 2>/dev/null || echo "")"
  fi
  [ -d "$p" ] || return 1
  p="$(cd "$p" 2>/dev/null && pwd || echo "$p")"
  echo "$p"
  return 0
}

rdloop_root="$(cd "$(dirname "$0")/../.." && pwd)"
ccb_path_cfg=$(python3 -c "
import json
try:
  print((json.load(open('${rdloop_root}/rdloop.config.json')).get('ccb_path') or '').strip())
except:
  print('')
" 2>/dev/null || echo "")

session_root=""
if [ -n "$project_path" ]; then
  session_root="$(find_ccb_root "$project_path" 2>/dev/null || echo "")"
fi
ccb_run_dir=""
if [ -n "$session_root" ]; then
  mkdir -p "${session_root}/.ccb" 2>/dev/null || true
  ccb_run_dir="${session_root}/.ccb/run"
  mkdir -p "$ccb_run_dir" 2>/dev/null || true
fi
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
if [ -z "$session_root" ] && [ -n "$worktree_dir" ] && [ -d "$worktree_dir" ]; then
  session_root="$(cd "$worktree_dir" 2>/dev/null && pwd || echo "$worktree_dir")"
  mkdir -p "${session_root}/.ccb" 2>/dev/null || true
  ccb_run_dir="${session_root}/.ccb/run"
  mkdir -p "$ccb_run_dir" 2>/dev/null || true
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

ask_autostart_env_var=""
case "$ccb_bin" in
  cask) ask_autostart_env_var="CCB_CASKD_AUTOSTART" ;;
  gask) ask_autostart_env_var="CCB_GASKD_AUTOSTART" ;;
  lask) ask_autostart_env_var="CCB_LASKD_AUTOSTART" ;;
  oask) ask_autostart_env_var="CCB_OASKD_AUTOSTART" ;;
  dask) ask_autostart_env_var="CCB_DASKD_AUTOSTART" ;;
esac

ccb_bin_cmd="$ccb_bin"
if [ -n "$ccb_path_cfg" ] && [ -x "${ccb_path_cfg}/bin/${ccb_bin}" ]; then
  ccb_bin_cmd="${ccb_path_cfg}/bin/${ccb_bin}"
else
  found_ccb_bin="$(command -v "$ccb_bin" 2>/dev/null || echo "")"
  [ -n "$found_ccb_bin" ] && ccb_bin_cmd="$found_ccb_bin"
fi

ccb_ping_cmd=""
if [ -n "$ccb_path_cfg" ] && [ -x "${ccb_path_cfg}/bin/ccb-ping" ]; then
  ccb_ping_cmd="${ccb_path_cfg}/bin/ccb-ping"
else
  if [ -n "$ccb_bin_cmd" ] && [ -x "$(dirname "$ccb_bin_cmd")/ccb-ping" ]; then
    ccb_ping_cmd="$(dirname "$ccb_bin_cmd")/ccb-ping"
  else
    ccb_ping_cmd="$(command -v ccb-ping 2>/dev/null || echo ccb-ping)"
  fi
fi

ccb_launcher_cmd=""
if [ -n "$ccb_path_cfg" ] && [ -x "${ccb_path_cfg}/bin/ccb" ]; then
  ccb_launcher_cmd="${ccb_path_cfg}/bin/ccb"
else
  found_ccb_launcher="$(command -v ccb 2>/dev/null || echo "")"
  [ -n "$found_ccb_launcher" ] && ccb_launcher_cmd="$found_ccb_launcher"
fi

# P18: Session file from task repo root. GUI ccb_work_dir is not used for task delivery.
ccb_session_file=""
if [ -n "$session_root" ]; then
  case "$ccb_bin" in
    cask) ccb_session_file="${session_root}/.ccb/.codex-session" ;;
    gask) ccb_session_file="${session_root}/.ccb/.gemini-session" ;;
    lask) ccb_session_file="${session_root}/.ccb/.claude-session" ;;
    oask) ccb_session_file="${session_root}/.ccb/.opencode-session" ;;
    dask) ccb_session_file="${session_root}/.ccb/.droid-session" ;;
    *)   ccb_session_file="${session_root}/.ccb/.codex-session" ;;
  esac
fi

# Build prompt from coordinator-owned request core when available.
judge_request_path="${JUDGE_REQUEST_PATH:-}"
if [ -n "$judge_request_path" ] && [ -f "$judge_request_path" ]; then
  full_prompt="$(cat "$judge_request_path")"
else
  full_prompt=""
  if [ -f "$judge_prompt_path" ]; then
    full_prompt=$(cat "$judge_prompt_path")
  fi
  full_prompt="${full_prompt}
---
"
  [ -f "$evidence_json_path" ] && full_prompt="${full_prompt}$(cat "$evidence_json_path")"
fi

{
  echo "[JUDGE][semi-auto/ccb] $(date -u +%Y-%m-%dT%H:%M:%SZ) attached to human session"
  echo "[JUDGE][semi-auto/ccb] provider=${ccb_bin} timeout=${judge_timeout}s project_path=${project_path:-<unset>} session_root=${session_root:-<unset>}"
  if [ -n "$ccb_session_file" ] && [ ! -f "$ccb_session_file" ]; then
    echo "[JUDGE][semi-auto/ccb] session file missing, attempting provider autostart/readiness bootstrap: ${ccb_session_file}"
  fi
  ccb_bootstrap_dir="${session_root:-$worktree_dir}"
  bootstrap_attempted=0

  if [ -n "$ccb_session_file" ]; then
    if [ -n "$ccb_run_dir" ]; then
      CCB_RUN_DIR="$ccb_run_dir" CCB_SESSION_FILE="$ccb_session_file" "$ccb_ping_cmd" "$ccb_provider" --session-file "$ccb_session_file" --autostart > /dev/null 2>&1
      ping_rc=$?
    else
      CCB_SESSION_FILE="$ccb_session_file" "$ccb_ping_cmd" "$ccb_provider" --session-file "$ccb_session_file" --autostart > /dev/null 2>&1
      ping_rc=$?
    fi
    if [ "$ping_rc" -ne 0 ]; then
      if [ "$bootstrap_attempted" -ne 1 ] && [ -n "$ccb_launcher_cmd" ]; then
        bootstrap_attempted=1
        echo "[JUDGE][semi-auto/ccb] ping failed; attempting provider bootstrap via ccb launcher: ${ccb_launcher_cmd} ${ccb_provider}"
        bootstrap_out="$(cd "$ccb_bootstrap_dir" && "$ccb_launcher_cmd" "$ccb_provider" </dev/null 2>&1 | sed -n '1,8p' || true)"
        if [ -n "$bootstrap_out" ]; then
          echo "[JUDGE][semi-auto/ccb] bootstrap output: $(echo "$bootstrap_out" | tr '\n' ' ' | sed 's/  */ /g')"
        fi
        sleep 1
        if [ -n "$ccb_run_dir" ]; then
          CCB_RUN_DIR="$ccb_run_dir" CCB_SESSION_FILE="$ccb_session_file" "$ccb_ping_cmd" "$ccb_provider" --session-file "$ccb_session_file" --autostart > /dev/null 2>&1
          ping_rc=$?
        else
          CCB_SESSION_FILE="$ccb_session_file" "$ccb_ping_cmd" "$ccb_provider" --session-file "$ccb_session_file" --autostart > /dev/null 2>&1
          ping_rc=$?
        fi
      fi
    fi
    if [ "$ping_rc" -ne 0 ]; then
      echo "[JUDGE][semi-auto/ccb] CCB daemon unavailable (session_root=${session_root:-<unset>} session_file=${ccb_session_file:-<unset>})"
      cat > "${attempt_dir}/judge/verdict.json" <<'ENDJSON'
{"schema_version":"v1","decision":"NEED_USER_INPUT","reasons":["CCB daemon unavailable"],"next_instructions":"","questions_for_user":["Start CCB (cask/gask) and retry"]}
ENDJSON
      echo "127" > "${attempt_dir}/judge/rc.txt"
      exit 127
    fi
  else
    if [ -n "$ccb_run_dir" ]; then
      (cd "$worktree_dir" && CCB_RUN_DIR="$ccb_run_dir" "$ccb_ping_cmd" "$ccb_provider" --autostart) > /dev/null 2>&1
      ping_rc=$?
    else
      (cd "$worktree_dir" && "$ccb_ping_cmd" "$ccb_provider" --autostart) > /dev/null 2>&1
      ping_rc=$?
    fi
    if [ "$ping_rc" -ne 0 ]; then
      if [ "$bootstrap_attempted" -ne 1 ] && [ -n "$ccb_launcher_cmd" ]; then
        bootstrap_attempted=1
        echo "[JUDGE][semi-auto/ccb] ping failed; attempting provider bootstrap via ccb launcher: ${ccb_launcher_cmd} ${ccb_provider}"
        bootstrap_out="$(cd "$ccb_bootstrap_dir" && "$ccb_launcher_cmd" "$ccb_provider" </dev/null 2>&1 | sed -n '1,8p' || true)"
        if [ -n "$bootstrap_out" ]; then
          echo "[JUDGE][semi-auto/ccb] bootstrap output: $(echo "$bootstrap_out" | tr '\n' ' ' | sed 's/  */ /g')"
        fi
        sleep 1
        if [ -n "$ccb_run_dir" ]; then
          (cd "$worktree_dir" && CCB_RUN_DIR="$ccb_run_dir" "$ccb_ping_cmd" "$ccb_provider" --autostart) > /dev/null 2>&1
          ping_rc=$?
        else
          (cd "$worktree_dir" && "$ccb_ping_cmd" "$ccb_provider" --autostart) > /dev/null 2>&1
          ping_rc=$?
        fi
      fi
    fi
    if [ "$ping_rc" -ne 0 ]; then
      echo "[JUDGE][semi-auto/ccb] CCB daemon unavailable (no session_file; worktree_dir=${worktree_dir:-<unset>})"
      cat > "${attempt_dir}/judge/verdict.json" <<'ENDJSON'
{"schema_version":"v1","decision":"NEED_USER_INPUT","reasons":["CCB daemon unavailable"],"next_instructions":"","questions_for_user":["Start CCB (cask/gask) and retry"]}
ENDJSON
      echo "127" > "${attempt_dir}/judge/rc.txt"
      exit 127
    fi
  fi

  if [ -n "$ccb_session_file" ]; then
    if [ -n "$ask_autostart_env_var" ]; then
      if [ -n "$ccb_run_dir" ]; then
        env "$ask_autostart_env_var=1" CCB_RUN_DIR="$ccb_run_dir" CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$judge_timeout" \
          "$full_prompt" 2>&1
      else
        env "$ask_autostart_env_var=1" CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$judge_timeout" \
          "$full_prompt" 2>&1
      fi
    else
      if [ -n "$ccb_run_dir" ]; then
        CCB_RUN_DIR="$ccb_run_dir" CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$judge_timeout" \
          "$full_prompt" 2>&1
      else
        CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$judge_timeout" \
          "$full_prompt" 2>&1
      fi
    fi
  else
    if [ -n "$ask_autostart_env_var" ]; then
      if [ -n "$ccb_run_dir" ]; then
        env "$ask_autostart_env_var=1" CCB_RUN_DIR="$ccb_run_dir" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$judge_timeout" \
          "$full_prompt" 2>&1
      else
        env "$ask_autostart_env_var=1" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$judge_timeout" \
          "$full_prompt" 2>&1
      fi
    else
      if [ -n "$ccb_run_dir" ]; then
        CCB_RUN_DIR="$ccb_run_dir" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$judge_timeout" \
          "$full_prompt" 2>&1
      else
        "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$judge_timeout" \
          "$full_prompt" 2>&1
      fi
    fi
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
