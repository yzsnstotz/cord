#!/usr/bin/env bash
# call_coder_ccb.sh — semi-auto mode coder adapter
# Attaches to human tmux session via /ask; human can observe and intervene in the pane.
# Interface: $1=task_json $2=attempt_dir $3=worktree_dir $4=instruction_path [$5=provider (codex|gemini|claude|opencode|droid)]
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/stdout.log, attempt_dir/coder/rc.txt

set -uo pipefail

session_id=""
req_code=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) session_id="${2:-}"; shift 2 ;;
    --req-code) req_code="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

if [ -z "${session_id:-}" ] || [ -z "${req_code:-}" ]; then
  echo "Usage: call_coder_ccb.sh --session-id <id> --req-code <code> <task_json> <attempt_dir> <worktree_dir> <instruction_path> [provider]" >&2
  exit 2
fi

task_json="${1:-}"
attempt_dir="${2:-}"
worktree_dir="${3:-}"
instruction_path="${4:-}"
provider_arg="${5:-}"

[ -n "$task_json" ] || { echo "missing task_json" >&2; exit 2; }
[ -n "$attempt_dir" ] || { echo "missing attempt_dir" >&2; exit 2; }
[ -n "$worktree_dir" ] || { echo "missing worktree_dir" >&2; exit 2; }
[ -n "$instruction_path" ] || { echo "missing instruction_path" >&2; exit 2; }

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
if [ -z "$session_root" ] && [ -n "$worktree_dir" ] && [ -d "$worktree_dir" ]; then
  session_root="$(cd "$worktree_dir" 2>/dev/null && pwd || echo "$worktree_dir")"
fi
ccb_run_dir=""
if [ -n "$session_root" ]; then
  mkdir -p "${session_root}/.ccb" 2>/dev/null || true
  ccb_run_dir="${session_root}/.ccb/run"
  mkdir -p "$ccb_run_dir" 2>/dev/null || true
fi

# P16: provider from collab_roles.executor (5th arg) or fallback to coder_model prefix
ccb_bin="cask"
ccb_provider="codex"
if [ -n "$provider_arg" ]; then
  case "$provider_arg" in
    claude)  ccb_bin="lask"; ccb_provider="claude" ;;
    codex)   ccb_bin="cask"; ccb_provider="codex" ;;
    gemini|antigravity|googleantigravity)  ccb_bin="gask"; ccb_provider="gemini" ;;
    opencode) ccb_bin="oask"; ccb_provider="opencode" ;;
    droid)   ccb_bin="dask"; ccb_provider="droid" ;;
    *)       ccb_bin="cask"; ccb_provider="codex" ;;
  esac
else
  if [[ "$coder_model" == gemini* ]]; then ccb_bin="gask"; ccb_provider="gemini"; fi
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
if [ -n "$ccb_path_cfg" ] && [ -x "${ccb_path_cfg}/ccb" ]; then
  ccb_launcher_cmd="${ccb_path_cfg}/ccb"
elif [ -n "$ccb_path_cfg" ] && [ -x "${ccb_path_cfg}/bin/ccb" ]; then
  ccb_launcher_cmd="${ccb_path_cfg}/bin/ccb"
else
  found_ccb_launcher="$(command -v ccb 2>/dev/null || echo "")"
  [ -n "$found_ccb_launcher" ] && ccb_launcher_cmd="$found_ccb_launcher"
fi

bootstrap_ccb_provider() {
  local provider="$1"
  local launcher="$2"
  local bootstrap_dir="$3"
  local tmux_session=""
  local out=""
  local env_prefix=""

  env_prefix="CCB_TERMINAL=\"tmux\""
  if [ -n "${ccb_session_file:-}" ]; then
    env_prefix="${env_prefix} CCB_SESSION_FILE=\"${ccb_session_file}\""
  fi

  if command -v tmux >/dev/null 2>&1; then
    tmux_session="rdloop_ccb_${provider}_$$_$(date +%s)"
    if tmux new-session -d -s "$tmux_session" -c "$bootstrap_dir" "${env_prefix} CCB_GUI_LAUNCH=1 \"$launcher\" -a \"$provider\"" >/dev/null 2>&1; then
      echo "tmux bootstrap started (session=${tmux_session})"
      return 0
    fi
  fi

  if [ "$(uname -s)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
    local launch_cmd apple_cmd
    launch_cmd="cd \"$bootstrap_dir\" && ${env_prefix} CCB_GUI_LAUNCH=1 \"$launcher\" -a \"$provider\""
    apple_cmd="$(printf '%s' "$launch_cmd" | sed 's/\\/\\\\/g; s/\"/\\"/g')"
    if osascript -e "tell application \"Terminal\" to do script \"${apple_cmd}\"" >/dev/null 2>&1; then
      echo "terminal bootstrap started (Darwin/Terminal)"
      return 0
    fi
  fi

  out="$(cd "$bootstrap_dir" && eval "${env_prefix} CCB_GUI_LAUNCH=1 \"$launcher\" -a \"$provider\" </dev/null" 2>&1 | sed -n '1,30p' || true)"
  [ -n "$out" ] && echo "$out" | tr '\n' ' ' | sed 's/  */ /g'
  return 0
}

run_ping_with_timeout() {
  local timeout_s="${RDLOOP_CCB_SINGLE_PING_TIMEOUT_SECONDS:-8}"
  python3 - "$timeout_s" "$@" <<'PY'
import subprocess, sys
timeout = int(sys.argv[1]) if len(sys.argv) > 1 else 8
cmd = sys.argv[2:]
try:
    cp = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    out = (cp.stdout or "") + (cp.stderr or "")
    if out:
        sys.stdout.write(out)
    sys.exit(cp.returncode)
except subprocess.TimeoutExpired as e:
    out = (e.stdout or "") + (e.stderr or "")
    if out:
        sys.stdout.write(out)
    sys.stdout.write(f"[rdloop] ccb-ping timed out after {timeout}s\n")
    sys.exit(124)
PY
}

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

restore_latest_stale_session() {
  local session_file="$1"
  [ -n "$session_file" ] || return 0
  [ -f "$session_file" ] && return 0
  local latest_stale=""
  latest_stale="$(ls -1t "${session_file}.stale."* 2>/dev/null | head -n 1 || true)"
  [ -n "$latest_stale" ] || return 0
  cp "$latest_stale" "$session_file" 2>/dev/null || return 0
  echo "[CODER][semi-auto/ccb] restored session file from stale backup: ${latest_stale}"
}

instruction=$(cat "$instruction_path" 2>/dev/null || echo "")
full_prompt="[RDLOOP_REQ:${req_code}:START]
${instruction}
[RDLOOP_REQ:${req_code}:END]"

{
  echo "[CODER][semi-auto/ccb] $(date -u +%Y-%m-%dT%H:%M:%SZ) attached to human tmux session"
  echo "[CODER][semi-auto/ccb] session_id=${session_id} req_code=${req_code}"
  echo "[CODER][semi-auto/ccb] provider=${ccb_bin} timeout=${timeout_s}s project_path=${project_path:-<unset>} session_root=${session_root:-<unset>}"
  if [ -n "$ccb_session_file" ]; then
    restore_latest_stale_session "$ccb_session_file"
  fi
  if [ -n "$ccb_session_file" ] && [ ! -f "$ccb_session_file" ]; then
    echo "[CODER][semi-auto/ccb] session file missing, attempting provider autostart/readiness bootstrap: ${ccb_session_file}"
  fi

  ccb_ping_ok=0
  ping_retries="${RDLOOP_CCB_PING_RETRIES:-12}"
  ping_interval="${RDLOOP_CCB_PING_INTERVAL_SECONDS:-2}"
  [[ "$ping_retries" =~ ^[0-9]+$ ]] || ping_retries=12
  [[ "$ping_interval" =~ ^[0-9]+$ ]] || ping_interval=2
  [ "$ping_retries" -lt 1 ] && ping_retries=12
  [ "$ping_interval" -lt 1 ] && ping_interval=2
  bootstrap_attempted=0
  wezterm_stale_reset_done=0
  ccb_bootstrap_dir="${session_root:-$worktree_dir}"
  for (( attempt=1; attempt <= ping_retries; attempt++ )); do
    last_ping_diag=""
    ping_rc=1
    if [ -n "$ccb_session_file" ]; then
      if [ -n "$ccb_run_dir" ]; then
        if last_ping_diag="$(CCB_RUN_DIR="$ccb_run_dir" CCB_SESSION_FILE="$ccb_session_file" run_ping_with_timeout "$ccb_ping_cmd" "$ccb_provider" --session-file "$ccb_session_file" --autostart 2>&1)"; then
          ping_rc=0
        else
          ping_rc=$?
        fi
      else
        if last_ping_diag="$(CCB_SESSION_FILE="$ccb_session_file" run_ping_with_timeout "$ccb_ping_cmd" "$ccb_provider" --session-file "$ccb_session_file" --autostart 2>&1)"; then
          ping_rc=0
        else
          ping_rc=$?
        fi
      fi
    else
      if [ -n "$ccb_run_dir" ]; then
        if last_ping_diag="$(cd "$worktree_dir" && CCB_RUN_DIR="$ccb_run_dir" run_ping_with_timeout "$ccb_ping_cmd" "$ccb_provider" --autostart 2>&1)"; then
          ping_rc=0
        else
          ping_rc=$?
        fi
      else
        if last_ping_diag="$(cd "$worktree_dir" && run_ping_with_timeout "$ccb_ping_cmd" "$ccb_provider" --autostart 2>&1)"; then
          ping_rc=0
        else
          ping_rc=$?
        fi
      fi
    fi
    # Keep session for tmux-style respawn recovery, but if the session backend is
    # irrecoverably stale in WezTerm (CLI unavailable), rotate once to force rebind.
    if echo "$last_ping_diag" | grep -Eqi "WezTerm CLI error|wezterm cli list failed|wezterm cli .*parse failed"; then
      if [ "$wezterm_stale_reset_done" -ne 1 ] && [ -n "$ccb_session_file" ] && [ -f "$ccb_session_file" ]; then
        wezterm_stale_reset_done=1
        stale_backup="${ccb_session_file}.stale.$(date +%s)"
        mv "$ccb_session_file" "$stale_backup" 2>/dev/null || true
        echo "[CODER][semi-auto/ccb] rotated stale WezTerm session file; moved to ${stale_backup}"
      fi
    fi
    if [ "$ping_rc" -eq 0 ]; then
      ccb_ping_ok=1
      break
    fi
    if [ "$bootstrap_attempted" -ne 1 ] && [ -n "$ccb_launcher_cmd" ]; then
      bootstrap_attempted=1
      echo "[CODER][semi-auto/ccb] ping failed; attempting provider bootstrap via ccb launcher: ${ccb_launcher_cmd} ${ccb_provider}"
      bootstrap_out="$(bootstrap_ccb_provider "$ccb_provider" "$ccb_launcher_cmd" "$ccb_bootstrap_dir")"
      if [ -n "$bootstrap_out" ]; then
        echo "[CODER][semi-auto/ccb] bootstrap output: ${bootstrap_out}"
      fi
    fi
    if [ "$attempt" -lt "$ping_retries" ]; then
      echo "[CODER][semi-auto/ccb] ping attempt ${attempt}/${ping_retries} failed, retrying in ${ping_interval}s..."
      sleep "$ping_interval"
    fi
  done

  if [ "$ccb_ping_ok" -ne 1 ]; then
    ping_diag="$last_ping_diag"
    if [ -n "$ping_diag" ]; then
      echo "[CODER][semi-auto/ccb] ping diagnostic output: $(echo "$ping_diag" | tr '\n' ' ' | sed 's/  */ /g')"
    fi
    echo "[CODER][semi-auto/ccb] CCB daemon unavailable after ${ping_retries} ping(s)"
    echo "[CODER][semi-auto/ccb] diagnostic: provider=${ccb_provider} (ask=${ccb_bin_cmd}) session_root=${session_root:-<unset>} session_file=${ccb_session_file:-<unset>} session_file_exists=$([ -n "$ccb_session_file" ] && [ -f "$ccb_session_file" ] && echo yes || echo no) ccb_run_dir=${ccb_run_dir:-<unset>} ccb_path_cfg=${ccb_path_cfg:-<unset>} ccb-ping=${ccb_ping_cmd:-<unset>}"
    echo "127" > "${attempt_dir}/coder/rc.txt"
    exit 127
  fi

  echo "[CODER][semi-auto/ccb] provider ping ready; dispatching request via ${ccb_bin_cmd}"

  if [ -n "$ccb_session_file" ]; then
    if [ -n "$ask_autostart_env_var" ]; then
      if [ -n "$ccb_run_dir" ]; then
        env "$ask_autostart_env_var=1" CCB_RUN_DIR="$ccb_run_dir" CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$timeout_s" \
          "$full_prompt" 2>&1
      else
        env "$ask_autostart_env_var=1" CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$timeout_s" \
          "$full_prompt" 2>&1
      fi
    else
      if [ -n "$ccb_run_dir" ]; then
        CCB_RUN_DIR="$ccb_run_dir" CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$timeout_s" \
          "$full_prompt" 2>&1
      else
        CCB_SESSION_FILE="$ccb_session_file" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$timeout_s" \
          "$full_prompt" 2>&1
      fi
    fi
  else
    if [ -n "$ask_autostart_env_var" ]; then
      if [ -n "$ccb_run_dir" ]; then
        env "$ask_autostart_env_var=1" CCB_RUN_DIR="$ccb_run_dir" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$timeout_s" \
          "$full_prompt" 2>&1
      else
        env "$ask_autostart_env_var=1" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$timeout_s" \
          "$full_prompt" 2>&1
      fi
    else
      if [ -n "$ccb_run_dir" ]; then
        CCB_RUN_DIR="$ccb_run_dir" "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$timeout_s" \
          "$full_prompt" 2>&1
      else
        "$ccb_bin_cmd" \
          --output "$output_file" \
          --timeout "$timeout_s" \
          "$full_prompt" 2>&1
      fi
    fi
  fi

  rc=$?
  echo "$rc" > "${attempt_dir}/coder/rc.txt"
  echo "[CODER][semi-auto/ccb] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
  exit "$rc"
} > "$run_log" 2>&1

rc=$?
[ ! -f "${attempt_dir}/coder/rc.txt" ] && echo "$rc" > "${attempt_dir}/coder/rc.txt"
exit "$(cat "${attempt_dir}/coder/rc.txt" 2>/dev/null || echo "$rc")"
