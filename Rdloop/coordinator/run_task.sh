#!/usr/bin/env bash
# coordinator/run_task.sh — rdloop Coordinator core
# Usage:
#   run_task.sh <task_spec.json>           — Create new task and run
#   run_task.sh --continue <task_id>       — Continue existing task
#   run_task.sh --reset <task_id>          — Reset task
#   run_task.sh --rerun-attempt <task_id> <n> — Rerun from attempt n
#   run_task.sh --self-improve <idea.md>   — Meta-task self-improve mode

set -euo pipefail

export GIT_DISCOVERY_ACROSS_FILESYSTEM=1

##############################################################################
# 0. Constants & globals
##############################################################################
RDLOOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${RDLOOP_OUT_DIR:-${RDLOOP_ROOT}/out}"
WORKTREES_DIR="${RDLOOP_WORKTREES_DIR:-${RDLOOP_ROOT}/worktrees}"
LIB_DIR="${RDLOOP_ROOT}/coordinator/lib"
export COORDINATOR_LIB="$LIB_DIR"
PROMPTS_DIR="${RDLOOP_ROOT}/prompts"
SESSION_ID_GEN="${RDLOOP_ROOT}/tools/session_id_gen.sh"
REQ_CODE_GEN="${RDLOOP_ROOT}/tools/req_code_gen.sh"
REQ_SEGMENT_EXTRACTOR="${RDLOOP_ROOT}/tools/extract_req_segment.sh"
GIT_OPS_BIN="${RDLOOP_ROOT}/tools/git_ops.sh"

LOCK_STALE_SECONDS=1800
JUDGE_MAX_RETRIES=2
TEST_LOG_TAIL_LINES=200

TASK_ID=""
TASK_DIR=""
TASK_JSON=""
LOCK_DIR=""
LOCK_ACQUIRED=0
CURRENT_ATTEMPT=0
NORMAL_EXIT=0

# P0: state_version tracking
STATE_VERSION=1
EFFECTIVE_MAX_ATTEMPTS=3
PREV_STATE=""
PREV_PAUSE_REASON=""
PREV_LAST_DECISION=""
PREV_ATTEMPT=0
PREV_EFFECTIVE_MAX=""

# P0: consecutive timeout tracking
CONSECUTIVE_TIMEOUT_COUNT=0
CONSECUTIVE_TIMEOUT_KEY=""

# E5-2/K1-1a: last_user_input_ts_consumed — set after consume_user_input in run_attempt; passed to write_status
LAST_USER_INPUT_TS_CONSUMED=""

get_pause_category() {
  local code="$1"
  case "$code" in
    PAUSED_CODEX_MISSING|PAUSED_CRASH|PAUSED_NOT_GIT_REPO|PAUSED_TASK_ID_CONFLICT|PAUSED_CODER_FAILED|PAUSED_CODER_NO_OUTPUT|PAUSED_CODER_CCB_UNAVAILABLE|PAUSED_CODER_NO_PROGRESS|PAUSED_UNSUPPORTED_PROVIDER)
      echo "PAUSED_INFRA" ;;
    PAUSED_CODER_AUTH_195|PAUSED_JUDGE_AUTH_195)
      echo "PAUSED_INFRA" ;;
    PAUSED_JUDGE_INVALID|PAUSED_JUDGE_TIMEOUT|PAUSED_JUDGE_VERDICT_INVALID|PAUSED_JUDGE_VERDICT_INCONSISTENT|PAUSED_JUDGE_MODE_INVALID)
      echo "PAUSED_JUDGE" ;;
    PAUSED_CODER_TIMEOUT|PAUSED_TEST_TIMEOUT)
      echo "PAUSED_TIMEOUT" ;;
    PAUSED_ALLOWED_PATHS|PAUSED_FORBIDDEN_GLOBS)
      echo "PAUSED_POLICY" ;;
    PAUSED_USER|PAUSED_WAITING_USER_INPUT)
      echo "PAUSED_MANUAL" ;;
    PAUSED_SCORE_GATED|PAUSED_SCORE_BELOW_THRESHOLD)
      echo "PAUSED_SCORE" ;;
    *) echo "" ;;
  esac
}

##############################################################################
# 1. Utility functions
##############################################################################
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log_info() { echo "[COORDINATOR][INFO] $(now_iso) $*"; }
log_error() { echo "[COORDINATOR][ERROR] $(now_iso) $*" >&2; }

json_read() {
  local file="$1" field="$2" default="${3:-}"
  python3 -c "
import json,sys
try:
  with open(sys.argv[1]) as f: d=json.load(f)
  keys=sys.argv[2].split('.')
  v=d
  for k in keys: v=v[k]
  if isinstance(v,list): print(json.dumps(v))
  elif isinstance(v,bool): print('true' if v else 'false')
  elif v is None: print(sys.argv[3] if len(sys.argv)>3 else '')
  else: print(v)
except: print(sys.argv[3] if len(sys.argv)>3 else '')
" "$file" "$field" "$default" 2>/dev/null
}

epoch_from_iso() {
  python3 -c "
import sys,datetime,calendar
try:
  t=sys.argv[1][:19]
  dt=datetime.datetime.strptime(t,'%Y-%m-%dT%H:%M:%S')
  print(int(calendar.timegm(dt.timetuple())))
except: print(0)
" "$1" 2>/dev/null || echo "0"
}

# Derive v5.1 routing fields from task.json.
# Output: shell exports (DERIVED_*).
# - Compat mode (default): maps legacy executor_type/workflow_mode and run_surface/execution_mode.
# - Strict mode (RDLOOP_V51_STRICT_ROUTING=1): requires explicit v5.1 fields.
derive_v51_routing_exports() {
  local strict="${RDLOOP_V51_STRICT_ROUTING:-0}"
  python3 - "$TASK_JSON" "$strict" <<'PY'
import json
import shlex
import sys

task_json_path = sys.argv[1]
strict = str(sys.argv[2]).strip() in {"1", "true", "TRUE", "yes", "on"}

with open(task_json_path, encoding="utf-8") as f:
    doc = json.load(f)

if not isinstance(doc, dict):
    raise SystemExit("task.json must be a JSON object")

valid_task_types = {"copywriting", "solo", "multi_agent"}
valid_launch_modes = {"ccb", "bridge"}

def norm(v):
    return str(v or "").strip()

task_type = norm(doc.get("task_type"))
launch_mode = norm(doc.get("launch_mode")).lower()
locked = doc.get("launch_mode_locked")

migration_applied = False
reasons = []

if task_type not in valid_task_types:
    if strict:
        raise SystemExit(
            "task_type is required and must be one of copywriting|solo|multi_agent. "
            "Either migrate task.json to v5.1 first or unset RDLOOP_V51_STRICT_ROUTING."
        )
    map_executor = {
        "api_call": "copywriting",
        "solo_agent": "solo",
        "multi_agent": "multi_agent",
    }
    map_workflow = {
        "single": "copywriting",
        "solo": "solo",
        "collab": "multi_agent",
    }
    et = norm(doc.get("executor_type"))
    wf = norm(doc.get("workflow_mode"))
    cand_et = map_executor.get(et)
    cand_wf = map_workflow.get(wf)
    if cand_et and cand_wf and cand_et != cand_wf:
        raise SystemExit(
            f"ambiguous task_type mapping: executor_type={et}->{cand_et}, "
            f"workflow_mode={wf}->{cand_wf}. Set task_type explicitly."
        )
    task_type = cand_et or cand_wf
    if task_type:
        migration_applied = True
        reasons.append("task_type_mapped_from_legacy")
    else:
        raise SystemExit(
            "task_type missing and cannot be derived from legacy fields. "
            "Set task_type directly or provide a supported executor_type/workflow_mode."
        )

if launch_mode not in valid_launch_modes:
    if strict:
        raise SystemExit(
            "launch_mode is required and must be ccb|bridge. "
            "Either migrate task.json to v5.1 first or unset RDLOOP_V51_STRICT_ROUTING."
        )
    map_surface = {"visual_ccb": "ccb", "bridge": "bridge"}
    map_exec = {"semi-auto": "ccb", "auto": "bridge"}
    rs = norm(doc.get("run_surface")).lower()
    em = norm(doc.get("execution_mode")).lower()
    cand_rs = map_surface.get(rs)
    cand_em = map_exec.get(em)
    if cand_rs and cand_em and cand_rs != cand_em:
        raise SystemExit(
            f"ambiguous launch_mode mapping: run_surface={rs}->{cand_rs}, "
            f"execution_mode={em}->{cand_em}. Set launch_mode explicitly."
        )
    launch_mode = cand_rs or cand_em
    if launch_mode:
        migration_applied = True
        reasons.append("launch_mode_mapped_from_legacy")
    else:
        raise SystemExit(
            "launch_mode missing and cannot be derived from legacy fields. "
            "Set launch_mode directly or provide a supported run_surface/execution_mode."
        )

if isinstance(locked, bool):
    launch_mode_locked = locked
elif locked is None or locked == "":
    launch_mode_locked = False
    migration_applied = True
    reasons.append("launch_mode_locked_defaulted")
elif isinstance(locked, str) and locked.strip().lower() in {"true", "false"}:
    launch_mode_locked = locked.strip().lower() == "true"
    migration_applied = True
    reasons.append("launch_mode_locked_normalized")
elif isinstance(locked, int) and locked in {0, 1}:
    launch_mode_locked = bool(locked)
    migration_applied = True
    reasons.append("launch_mode_locked_normalized")
else:
    raise SystemExit("launch_mode_locked must be boolean")

def out(name, value):
    print(f"{name}={shlex.quote(value)}")

out("DERIVED_TASK_TYPE", task_type)
out("DERIVED_LAUNCH_MODE", launch_mode)
out("DERIVED_LAUNCH_MODE_LOCKED", "true" if launch_mode_locked else "false")
out("DERIVED_MIGRATION_APPLIED", "true" if migration_applied else "false")
out("DERIVED_MIGRATION_REASON", ";".join(reasons))
PY
}

extract_req_payload_segment() {
  local req_code="$1" input_file="$2" output_file="$3" role="$4"
  [ -n "$req_code" ] || return 0
  [ -f "$input_file" ] || return 0
  [ -x "$REQ_SEGMENT_EXTRACTOR" ] || return 0
  if ! grep -q "\[RDLOOP_REQ:${req_code}:START\]" "$input_file" 2>/dev/null; then
    return 0
  fi
  if "$REQ_SEGMENT_EXTRACTOR" "$req_code" "$input_file" > "$output_file"; then
    write_event_ext "req_segment_extracted" "{\"role\":\"${role}\",\"req_code\":\"${req_code}\",\"path\":\"${output_file}\"}"
    local payload_ok
    payload_ok=$(python3 - "$role" "$req_code" "$input_file" "$output_file" <<'PY'
import json, sys
role, req_code, input_file, output_file = sys.argv[1:5]
print(json.dumps({
  "event_type": "req_segment_extracted",
  "triggered_by": {"actor": "coordinator", "source": "extract_req_payload_segment"},
  "channel": {"name": "ccb", "direction": "inbound"},
  "delivery": {
    "from": role,
    "to": "coordinator",
    "req_code": req_code,
    "content_path": output_file
  },
  "executed_by": {"component": "extract_req_segment.sh", "input_path": input_file},
  "next": {"path": output_file},
  "details": {"input_path": input_file, "output_path": output_file}
}))
PY
)
    write_task_lifecycle_log "req_segment_extracted" "$payload_ok"
  else
    write_event_ext "req_segment_extract_error" "{\"role\":\"${role}\",\"req_code\":\"${req_code}\",\"path\":\"${input_file}\"}"
    local payload_err
    payload_err=$(python3 - "$role" "$req_code" "$input_file" <<'PY'
import json, sys
role, req_code, input_file = sys.argv[1:4]
print(json.dumps({
  "event_type": "req_segment_extract_error",
  "triggered_by": {"actor": "coordinator", "source": "extract_req_payload_segment"},
  "channel": {"name": "ccb", "direction": "inbound"},
  "delivery": {"from": role, "to": "coordinator", "req_code": req_code},
  "executed_by": {"component": "extract_req_segment.sh", "input_path": input_file},
  "next": {"target": "retry_or_manual_inspect"},
  "details": {"input_path": input_file}
}))
PY
)
    write_task_lifecycle_log "req_segment_extract_error" "$payload_err"
  fi
}

##############################################################################
# 2. JSON writers (atomic via atomic_write.py)
##############################################################################
ATOMIC_WRITE="${LIB_DIR}/atomic_write.py"

maybe_bump_state_version() {
  local state="$1" prcode="$2" last_dec="$3" cur_att="$4" eff_max="$5"
  if [ "$state" != "$PREV_STATE" ] || [ "$prcode" != "$PREV_PAUSE_REASON" ] || \
     [ "$last_dec" != "$PREV_LAST_DECISION" ] || [ "$cur_att" != "$PREV_ATTEMPT" ] || \
     [ "$eff_max" != "$PREV_EFFECTIVE_MAX" ]; then
    STATE_VERSION=$(( STATE_VERSION + 1 ))
  fi
  PREV_STATE="$state"; PREV_PAUSE_REASON="$prcode"
  PREV_LAST_DECISION="$last_dec"; PREV_ATTEMPT="$cur_att"
  PREV_EFFECTIVE_MAX="$eff_max"
}

# K1-1a: last_user_input_ts_consumed (optional) — pass null or ISO8601 string
write_status() {
  local state="$1" cur_att="$2" max_att="$3" pflag="$4" last_dec="$5"
  local msg="$6" q_json="$7" pcat="$8" prcode="$9"
  shift 9
  local last_trans_json="${1:-null}"
  local last_ui_ts="${2:-null}"
  maybe_bump_state_version "$state" "$prcode" "$last_dec" "$cur_att" "$EFFECTIVE_MAX_ATTEMPTS"
  local rubric_ver="null"
  [ -f "${TASK_JSON:-}" ] && rubric_ver=$(json_read "$TASK_JSON" "rubric_version" "null")
  [ "$rubric_ver" = "null" ] || rubric_ver="\"${rubric_ver}\""
  python3 -c '
import json,sys
lt_raw=sys.argv[13]
lt=json.loads(lt_raw) if lt_raw!="null" else None
lui=None
if len(sys.argv)>16:
  lui_raw=sys.argv[16].strip()
  if lui_raw and lui_raw!="null": lui=lui_raw
d={"task_id":sys.argv[1],"state":sys.argv[2],"current_attempt":int(sys.argv[3]),
   "max_attempts":int(sys.argv[4]),"pause_flag":sys.argv[5]=="true",
   "last_decision":sys.argv[6],"message":sys.argv[7],
   "questions_for_user":json.loads(sys.argv[8]),
   "pause_category":sys.argv[9],"pause_reason_code":sys.argv[10],
   "updated_at":sys.argv[11],
   "state_version":int(sys.argv[12]),
   "effective_max_attempts":int(sys.argv[14]),
   "paths":{"status_json":"status.json"},
   "rubric_version_used":json.loads(sys.argv[15]),
   "last_user_input_ts_consumed":lui}
if lt is not None: d["last_transition"]=lt
print(json.dumps(d))
' "$TASK_ID" "$state" "$cur_att" "$max_att" "$pflag" \
  "$last_dec" "$msg" "$q_json" "$pcat" "$prcode" \
  "$(now_iso)" "$STATE_VERSION" "$last_trans_json" "$EFFECTIVE_MAX_ATTEMPTS" \
  "$rubric_ver" "$last_ui_ts" \
  | python3 "$ATOMIC_WRITE" "${TASK_DIR}/status.json" -
  # Write _index entry (A1-6)
  write_index_entry "$state"
}

# K1-1b: state (enum) + decision (PASS|FAIL|NEED_USER_INPUT), verdict_summary optional
# Optional 15th arg: path to knowledge_entries.json (from coder); merged into final_summary when present
write_final_summary() {
  local state="$1" last_dec="$2" cur_att="$3" max_att="$4"
  local msg="$5" q_json="$6" pcat="$7" prcode="$8" head_c="$9"
  shift 9
  local score="${1:-null}" verdict_summary="${2:-}" knowledge_entries_path="${3:-}"
  python3 -c '
import json,sys,os
score_raw=sys.argv[11]
score=int(score_raw) if score_raw!="null" and score_raw!="" else None
# argv[2]=state (READY_FOR_REVIEW|FAILED|PAUSED), argv[3]=last_decision (PASS|FAIL|NEED_USER_INPUT)
d={"task_id":sys.argv[1],"state":sys.argv[2],"decision":sys.argv[3],"last_decision":sys.argv[3],
   "current_attempt":int(sys.argv[4]),"max_attempts":int(sys.argv[5]),
   "message":sys.argv[6],"questions_for_user":json.loads(sys.argv[7]),
   "pause_category":sys.argv[8],"pause_reason_code":sys.argv[9],
   "final_head_commit":sys.argv[10],"updated_at":sys.argv[12],
   "state_version":int(sys.argv[13]),
   "final_score_0_100":score,
   "verdict_summary":sys.argv[14] if len(sys.argv)>14 and sys.argv[14] else None,
   "paths":{"status_json":"status.json","final_summary_json":"final_summary.json"}}
if len(sys.argv)>15 and sys.argv[15].strip() and os.path.isfile(sys.argv[15]):
  try:
    with open(sys.argv[15], encoding="utf-8") as f:
      d["knowledge_entries"]=json.load(f)
  except Exception:
    pass
print(json.dumps(d))
' "$TASK_ID" "$state" "$last_dec" "$cur_att" "$max_att" \
  "$msg" "$q_json" "$pcat" "$prcode" "$head_c" \
  "$score" "$(now_iso)" "$STATE_VERSION" "$verdict_summary" "$knowledge_entries_path" \
  | python3 "$ATOMIC_WRITE" "${TASK_DIR}/final_summary.json" -
}

write_task_lifecycle_log() {
  local happened="$1" payload_json="${2-}"
  [ -z "${TASK_DIR:-}" ] && return 0
  [ -z "$payload_json" ] && payload_json='{}'
  python3 - "$TASK_DIR" "$TASK_ID" "${CURRENT_ATTEMPT:-0}" "$happened" "$payload_json" <<'PY' \
  | python3 "$ATOMIC_WRITE" --append "${TASK_DIR}/task_lifecycle.jsonl" - 2>/dev/null || true
import datetime, hashlib, json, os, sys
import ast

task_dir, task_id, current_attempt_raw, happened, payload_raw = sys.argv[1:6]
now = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

payload = {}
candidate = payload_raw if payload_raw else {}
for _ in range(4):
    if isinstance(candidate, dict):
        payload = candidate
        break
    if not isinstance(candidate, str):
        break
    text = candidate.strip()
    if not text:
        break
    decoded = None
    try:
        decoded = json.loads(text)
    except Exception:
        try:
            decoded = ast.literal_eval(text)
        except Exception:
            decoded = None
    if decoded is None:
        break
    candidate = decoded
if not isinstance(payload, dict):
    payload = {}

def as_obj(v):
    return v if isinstance(v, dict) else {}

def resolve_path(path_value):
    if not isinstance(path_value, str) or not path_value.strip():
        return None
    path_value = path_value.strip()
    if os.path.isabs(path_value):
        return path_value
    return os.path.join(task_dir, path_value)

def enrich_content(section, default_limit=1024 * 1024):
    if not isinstance(section, dict):
        return section
    path_value = section.get("content_path")
    resolved = resolve_path(path_value)
    if not resolved or not os.path.isfile(resolved):
        return section
    try:
        raw = open(resolved, "rb").read()
    except Exception:
        return section
    max_bytes = section.get("content_max_bytes", default_limit)
    try:
        max_bytes = int(max_bytes)
    except Exception:
        max_bytes = default_limit
    if max_bytes < 0:
        max_bytes = default_limit
    if max_bytes == 0:
        view = b""
    else:
        view = raw[:max_bytes]
    section["content_path"] = resolved
    section.setdefault("content_total_bytes", len(raw))
    section.setdefault("content_sha256", hashlib.sha256(raw).hexdigest())
    section.setdefault("content", view.decode("utf-8", "replace"))
    if len(raw) > len(view):
        section["content_truncated"] = True
    return section

attempt = payload.get("attempt")
if attempt in (None, ""):
    try:
        attempt = int(current_attempt_raw or "0")
    except Exception:
        attempt = 0
else:
    try:
        attempt = int(attempt)
    except Exception:
        attempt = 0

entry = {
    "ts": now,
    "task_id": task_id,
    "attempt": attempt,
    "what_happened": happened,
    "triggered_by": as_obj(payload.get("triggered_by")),
    "channel": as_obj(payload.get("channel")),
    "delivery": enrich_content(as_obj(payload.get("delivery"))),
    "executed_by": enrich_content(as_obj(payload.get("executed_by"))),
    "next": as_obj(payload.get("next")),
    "details": enrich_content(as_obj(payload.get("details")))
}

if "event_type" in payload:
    entry["event_type"] = payload["event_type"]

print(json.dumps(entry, ensure_ascii=False))
PY
}

write_agent_dispatch_log() {
  local stage="$1" role="$2" channel_name="$3" script_path="$4"
  local content_path="$5" session_id="${6:-}" req_code="${7:-}"
  local provider="${8:-}" next_target="${9:-}"
  local payload
  payload=$(python3 - "$stage" "$role" "$channel_name" "$script_path" "$content_path" "$session_id" "$req_code" "$provider" "$next_target" <<'PY'
import json, os, sys
stage, role, channel_name, script_path, content_path, session_id, req_code, provider, next_target = sys.argv[1:10]
delivery = {"from": "coordinator", "to": role}
if content_path:
    delivery["content_path"] = content_path
if session_id:
    delivery["session_id"] = session_id
if req_code:
    delivery["req_code"] = req_code
if provider:
    delivery["provider"] = provider
print(json.dumps({
  "event_type": f"{stage}_dispatch",
  "triggered_by": {"actor": "coordinator", "source": "run_task.sh"},
  "channel": {"name": channel_name, "direction": "outbound"},
  "delivery": delivery,
  "executed_by": {
    "component": os.path.basename(script_path) if script_path else "",
    "script_path": script_path
  },
  "next": {"target": next_target or role},
  "details": {"stage": stage}
}))
PY
)
  write_task_lifecycle_log "${stage}_dispatch" "$payload"
}

write_agent_response_log() {
  local stage="$1" role="$2" channel_name="$3" script_path="$4"
  local content_path="$5" session_id="${6:-}" req_code="${7:-}"
  local provider="${8:-}" next_target="${9:-}" rc="${10:-}"
  [ -n "$content_path" ] || return 0
  [ -f "$content_path" ] || return 0
  local payload
  payload=$(python3 - "$stage" "$role" "$channel_name" "$script_path" "$content_path" "$session_id" "$req_code" "$provider" "$next_target" "$rc" <<'PY'
import json, os, sys
stage, role, channel_name, script_path, content_path, session_id, req_code, provider, next_target, rc = sys.argv[1:11]
details = {"stage": stage}
if rc != "":
    try:
        details["rc"] = int(rc)
    except Exception:
        details["rc"] = rc
print(json.dumps({
  "event_type": f"{stage}_response",
  "triggered_by": {"actor": role or "agent", "source": os.path.basename(script_path) if script_path else "adapter"},
  "channel": {"name": channel_name, "direction": "inbound"},
  "delivery": {
    "from": role,
    "to": "coordinator",
    "content_path": content_path,
    "session_id": session_id,
    "req_code": req_code,
    "provider": provider
  },
  "executed_by": {
    "component": os.path.basename(script_path) if script_path else "",
    "script_path": script_path
  },
  "next": {"target": next_target or "coordinator"},
  "details": details
}))
PY
)
  write_task_lifecycle_log "${stage}_response" "$payload"
}

write_coordinator_simple_event() {
  local happened="$1" channel_name="${2:-coordinator}" direction="${3:-internal}" next_target="${4:-}"
  local summary="${5:-}" cmd="${6:-}" rc="${7:-}" repo_path="${8:-}" worktree_path="${9:-}" content_path="${10:-}"
  local payload
  payload=$(python3 - "$happened" "$channel_name" "$direction" "$next_target" "$summary" "$cmd" "$rc" "$repo_path" "$worktree_path" "$content_path" <<'PY'
import json, sys
happened, channel_name, direction, next_target, summary, cmd, rc_raw, repo_path, worktree_path, content_path = sys.argv[1:11]
details = {}
if summary:
    details["summary"] = summary
if cmd:
    details["command"] = cmd
if rc_raw != "":
    try:
        details["rc"] = int(rc_raw)
    except Exception:
        details["rc"] = rc_raw
if repo_path:
    details["repo_path"] = repo_path
if worktree_path:
    details["worktree_path"] = worktree_path
delivery = {}
if content_path:
    delivery["content_path"] = content_path
next_obj = {"target": next_target} if next_target else {}
print(json.dumps({
  "event_type": happened,
  "triggered_by": {"actor": "coordinator", "source": "run_task.sh"},
  "channel": {"name": channel_name, "direction": direction},
  "delivery": delivery,
  "executed_by": {"component": "run_task.sh", "function": "write_coordinator_simple_event"},
  "next": next_obj,
  "details": details
}))
PY
)
  write_task_lifecycle_log "$happened" "$payload"
}

write_event() {
  local att="$1" etype="$2" summary="$3"
  local att_dir="${4:-}" wt_dir="${5:-}"
  python3 -c '
import json,sys
e={"ts":sys.argv[1],"task_id":sys.argv[2],"attempt":int(sys.argv[3]) if sys.argv[3] else 0,
   "type":sys.argv[4],"summary":sys.argv[5],
   "paths":{"out_dir":sys.argv[6],"attempt_dir":sys.argv[7],
            "worktree_dir":sys.argv[8],"status_path":sys.argv[9]}}
print(json.dumps(e))
' "$(now_iso)" "$TASK_ID" "$att" "$etype" "$summary" \
  "${TASK_DIR}" "$att_dir" "$wt_dir" "${TASK_DIR}/status.json" \
  | python3 "$ATOMIC_WRITE" --append "${TASK_DIR}/events.jsonl" -
  local lifecycle_payload
  lifecycle_payload=$(python3 - "$etype" "$summary" "$att_dir" "$wt_dir" <<'PY'
import json, sys
etype, summary, att_dir, wt_dir = sys.argv[1:5]
print(json.dumps({
  "event_type": etype,
  "triggered_by": {"actor": "coordinator", "source": "run_task.sh"},
  "channel": {"name": "events.jsonl", "direction": "internal"},
  "executed_by": {"component": "run_task.sh", "function": "write_event"},
  "next": {"path": "events.jsonl"},
  "details": {"summary": summary, "attempt_dir": att_dir, "worktree_dir": wt_dir}
}))
PY
)
  write_task_lifecycle_log "$etype" "$lifecycle_payload"
}

# K3-1/K3-5: ATTEMPT_DECIDED with decision, next_state, pause_reason_code, effective_max_attempts, current_attempt
write_event_attempt_decided() {
  local att="$1" decision="$2" next_state="$3" prcode="${4:-}"
  python3 -c '
import json,sys
e={"ts":sys.argv[1],"task_id":sys.argv[2],"attempt":int(sys.argv[3]),
   "type":"ATTEMPT_DECIDED",
   "decision":sys.argv[4],"next_state":sys.argv[5],"pause_reason_code":sys.argv[6] if sys.argv[6] else None,
   "effective_max_attempts":int(sys.argv[7]),"current_attempt":int(sys.argv[3])}
print(json.dumps(e))
' "$(now_iso)" "$TASK_ID" "$att" "$decision" "$next_state" "$prcode" "$EFFECTIVE_MAX_ATTEMPTS" \
  | python3 "$ATOMIC_WRITE" --append "${TASK_DIR}/events.jsonl" -
  local lifecycle_payload
  lifecycle_payload=$(python3 - "$att" "$decision" "$next_state" "$prcode" "$EFFECTIVE_MAX_ATTEMPTS" <<'PY'
import json, sys
att, decision, next_state, prcode, effective_max = sys.argv[1:6]
print(json.dumps({
  "attempt": int(att) if att else 0,
  "event_type": "ATTEMPT_DECIDED",
  "triggered_by": {"actor": "coordinator", "source": "decision_table"},
  "channel": {"name": "events.jsonl", "direction": "internal"},
  "executed_by": {"component": "run_task.sh", "function": "write_event_attempt_decided"},
  "next": {"state": next_state},
  "details": {
    "decision": decision,
    "pause_reason_code": prcode if prcode else "",
    "effective_max_attempts": int(effective_max)
  }
}))
PY
)
  write_task_lifecycle_log "ATTEMPT_DECIDED" "$lifecycle_payload"
}

write_commands_log() {
  local att="$1" cmd="$2" rc="$3" secs="$4" logf="$5"
  python3 -c '
import json,sys
e={"ts":sys.argv[1],"attempt":int(sys.argv[2]),"cmd":sys.argv[3],
   "rc":int(sys.argv[4]),"seconds":float(sys.argv[5])}
print(json.dumps(e))
' "$(now_iso)" "$att" "$cmd" "$rc" "$secs" \
  | python3 "$ATOMIC_WRITE" --append "$logf" -
  local lifecycle_payload
  lifecycle_payload=$(python3 - "$att" "$cmd" "$rc" "$secs" "$logf" <<'PY'
import json, sys
att, cmd, rc, secs, logf = sys.argv[1:6]
print(json.dumps({
  "attempt": int(att) if att else 0,
  "event_type": "COMMAND_EXECUTED",
  "triggered_by": {"actor": "coordinator", "source": "run_attempt"},
  "channel": {"name": "local_shell", "direction": "internal"},
  "delivery": {"content": cmd},
  "executed_by": {"component": "bash", "log_path": logf},
  "next": {"path": logf},
  "details": {"rc": int(rc), "seconds": float(secs)}
}))
PY
)
  write_task_lifecycle_log "command_executed" "$lifecycle_payload"
}

write_metrics() {
  local att_dir="$1" att_num="$2" elapsed="$3" jretries="$4"
  local crc="$5" trc="$6" jrc="$7"
  local a_start="$8" c_start="${9:-}" c_fin="${10:-}"
  local t_start="${11:-}" t_fin="${12:-}" j_start="${13:-}" j_fin="${14:-}"
  local notes="${15:-[]}"
  python3 -c '
import json,sys
d={"schema_version":"v1","task_id":sys.argv[1],"attempt":int(sys.argv[2]),
   "elapsed_seconds":float(sys.argv[3]),"judge_retries":int(sys.argv[4]),
   "phase_ts":{"attempt_started_at":sys.argv[5],"coder_started_at":sys.argv[6],
     "coder_finished_at":sys.argv[7],"test_started_at":sys.argv[8],
     "test_finished_at":sys.argv[9],"judge_started_at":sys.argv[10],
     "judge_finished_at":sys.argv[11]},
   "coder_rc":int(sys.argv[12]),"test_rc":int(sys.argv[13]),
   "judge_rc":int(sys.argv[14]),"notes":json.loads(sys.argv[15])}
print(json.dumps(d))
' "$TASK_ID" "$att_num" "$elapsed" "$jretries" \
  "$a_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" \
  "$crc" "$trc" "$jrc" "$notes" \
  | python3 "$ATOMIC_WRITE" "${att_dir}/metrics.json" -
}

write_evidence() {
  local att_dir="$1" att_num="$2" wt_path="$3" head_c="$4"
  local tcmd="$5" trc="$6" tlog_tail="$7" cmds_json="$8"
  local coder_output_path="${9:-}"
  local task_code="${10:-}"
  python3 -c '
import json,sys
d={"schema_version":"v1","task_id":sys.argv[1],"attempt":int(sys.argv[2]),
   "task_code":sys.argv[11],"worktree_path":sys.argv[3],"created_at":sys.argv[4],
   "git":{"diff_stat_path":"diff.stat","diff_patch_path":"diff.patch",
          "head_commit":sys.argv[5]},
   "commands":json.loads(sys.argv[6]),
   "test":{"cmd":sys.argv[7],"rc":int(sys.argv[8]),"log_tail":sys.argv[9]},
   "artifacts":[],"metrics_path":"metrics.json"}
if len(sys.argv) > 10 and sys.argv[10]:
  try:
    with open(sys.argv[10], encoding="utf-8") as f: d["coder_output"]=f.read()
  except Exception: pass
print(json.dumps(d, ensure_ascii=False))
' "$TASK_ID" "$att_num" "$wt_path" "$(now_iso)" "$head_c" \
  "$cmds_json" "$tcmd" "$trc" "$tlog_tail" \
  "$coder_output_path" "$task_code" \
  | python3 "$ATOMIC_WRITE" "${att_dir}/evidence.json" -
}

write_env_json() {
  local att_dir="$1" task_code="${2:-}" att_num="${3:-}"
  local os_info git_ver node_ver py_ver
  os_info=$(uname -srm 2>/dev/null || echo "unknown")
  git_ver=$(git --version 2>/dev/null || echo "unknown")
  node_ver=$(node -v 2>/dev/null || echo "N/A")
  py_ver=$(python3 -V 2>/dev/null || echo "N/A")
  local codex_avail="false" codex_path="" claude_avail="false" claude_path=""
  # Cursor uses cliapi (8000), no local binary; other CLIs for env diagnostics only
  command -v codex >/dev/null 2>&1 && { codex_avail="true"; codex_path=$(command -v codex); }
  command -v claude >/dev/null 2>&1 && { claude_avail="true"; claude_path=$(command -v claude); }
  python3 -c '
import json,sys
d={"os":sys.argv[1],"node_version":sys.argv[2],"python_version":sys.argv[3],
   "git_version":sys.argv[4],
   "codex_available":sys.argv[5]=="true","codex_path":sys.argv[6],
   "claude_available":sys.argv[7]=="true","claude_path":sys.argv[8],
   "task_code":sys.argv[9],"attempt":int(sys.argv[10]) if sys.argv[10] else 0}
print(json.dumps(d))
' "$os_info" "$node_ver" "$py_ver" "$git_ver" \
  "$codex_avail" "$codex_path" \
  "$claude_avail" "$claude_path" \
  "$task_code" "$att_num" \
  | python3 "$ATOMIC_WRITE" "${att_dir}/env.json" -
}

write_index_entry() {
  local state="$1"
  local idx_dir="${OUT_DIR}/_index/tasks"
  mkdir -p "$idx_dir"
  python3 -c '
import json,sys
d={"task_id":sys.argv[1],"state":sys.argv[2],"updated_at":sys.argv[3],
   "state_version":int(sys.argv[4]),
   "paths":{"status_json":sys.argv[1]+"/status.json"}}
print(json.dumps(d))
' "$TASK_ID" "$state" "$(now_iso)" "$STATE_VERSION" \
  | python3 "$ATOMIC_WRITE" "${idx_dir}/${TASK_ID}.json" -
}

##############################################################################
# 2b. Verdict traceability injection (B4-2/B4-6)
##############################################################################
# inject_verdict_traceability <verdict_json_path> <task_json_path>
# Post-processes verdict.json to add rubric_version_used, rubric_hash_used,
# scoring_mode_used, thresholds_used, deliverability_index_0_100,
# improvement_potential_0_100 — only fills missing fields, never overwrites.
RUBRIC_JSON="${RDLOOP_ROOT}/schemas/judge_rubric.json"

inject_verdict_traceability() {
  local vpath="$1" tjson="$2"
  [ ! -f "$vpath" ] && return 0
  python3 - "$vpath" "$tjson" "$RUBRIC_JSON" "$ATOMIC_WRITE" <<'PYEOF'
import json, sys, os, math

vpath, tjson, rpath, atomic = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

try:
    with open(vpath, encoding='utf-8') as f:
        v = json.load(f)
except Exception:
    sys.exit(0)

changed = False

# Load rubric for version/hash
rubric_version = None
rubric_hash = None
if os.path.isfile(rpath):
    try:
        with open(rpath, encoding='utf-8') as f:
            r = json.load(f)
        rubric_version = r.get('rubric_version')
        rubric_hash = r.get('rubric_hash')
    except Exception:
        pass

# Load task spec for scoring_mode and thresholds
scoring_mode = 'rubric_analytic'
thresholds_used = None
if os.path.isfile(tjson):
    try:
        with open(tjson, encoding='utf-8') as f:
            t = json.load(f)
        scoring_mode = t.get('scoring_mode', 'rubric_analytic') or 'rubric_analytic'
        rt = t.get('rubric_thresholds')
        if rt:
            thresholds_used = rt
    except Exception:
        pass

def set_if_missing(key, val):
    global changed
    if val is not None and key not in v:
        v[key] = val
        changed = True

set_if_missing('rubric_version_used', rubric_version)
set_if_missing('rubric_hash_used', rubric_hash)
set_if_missing('scoring_mode_used', scoring_mode)
set_if_missing('thresholds_used', thresholds_used)

# Compute deliverability_index_0_100 and improvement_potential_0_100 if absent
if 'deliverability_index_0_100' not in v and 'scores' in v and isinstance(v.get('scores'), dict):
    scores = v['scores']
    task_type = v.get('task_type', '')
    # DI: based on final_score_0_100 if available, else raw weighted hard-gate dims
    final100 = v.get('final_score_0_100')
    if final100 is not None:
        di = max(0, min(100, int(final100)))
    else:
        di = 50
    set_if_missing('deliverability_index_0_100', di)

    # IP: improvement potential based on top_issues count and score headroom
    top_issues = v.get('top_issues', [])
    n_issues = len(top_issues) if isinstance(top_issues, list) else 0
    score_vals = [s for s in scores.values() if isinstance(s, (int, float))]
    headroom = 0.0
    if score_vals:
        headroom = (5.0 - sum(score_vals) / len(score_vals)) / 5.0
    ip = max(0, min(100, int(headroom * 60 + min(n_issues, 5) * 8)))
    set_if_missing('improvement_potential_0_100', ip)

if changed:
    import subprocess
    payload = json.dumps(v)
    proc = subprocess.run(
        ['python3', atomic, vpath, '-'],
        input=payload.encode('utf-8'),
        capture_output=True
    )
    if proc.returncode != 0:
        sys.stderr.write('inject_verdict_traceability: atomic write failed\n')
        sys.exit(1)
PYEOF
}

##############################################################################
# 2c. Runtime overrides + decision_table helpers
##############################################################################
DECISION_TABLE_CLI="${LIB_DIR}/decision_table_cli.js"

load_runtime_overrides() {
  local ovr="${TASK_DIR}/runtime_overrides.json"
  if [ -f "$ovr" ]; then
    local ov_max; ov_max=$(json_read "$ovr" "overrides.max_attempts" "")
    [ -n "$ov_max" ] && EFFECTIVE_MAX_ATTEMPTS="$ov_max"
  fi
}

# call_decision_table role rc error_class verdict_decision verdict_gated thresholds_pass
# Outputs JSON to stdout. Caller must parse.
call_decision_table() {
  local role="$1" rc="$2" err_class="$3"
  local v_dec="${4:-}" v_gated="${5:-false}" thresh="${6:-true}"
  local ctx_json
  ctx_json=$(python3 -c '
import json,sys
d={"role":sys.argv[1],"rc":int(sys.argv[2]),"error_class":sys.argv[3],
   "verdict_decision":sys.argv[4],"verdict_gated":sys.argv[5]=="true",
   "thresholds_pass":sys.argv[6]=="true",
   "current_attempt":int(sys.argv[7]),"effective_max_attempts":int(sys.argv[8]),
   "consecutive_timeout_count":int(sys.argv[9]),"consecutive_timeout_key":sys.argv[10]}
print(json.dumps(d))
' "$role" "$rc" "$err_class" "$v_dec" "$v_gated" "$thresh" \
  "$CURRENT_ATTEMPT" "$EFFECTIVE_MAX_ATTEMPTS" \
  "$CONSECUTIVE_TIMEOUT_COUNT" "$CONSECUTIVE_TIMEOUT_KEY")
  node "$DECISION_TABLE_CLI" "$ctx_json"
}

# act_on_decision <decision_json> <head_commit> <att_num> <max_att>
# Returns: "exit" if caller should exit, "continue" if loop continues
act_on_decision() {
  local dj="$1" hc="$2" att_num="$3" max_att="$4"
  local ns pr ca ld msg qj
  ns=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["next_state"])')
  pr=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["pause_reason_code"])')
  ca=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("true" if d["consume_attempt"] else "false")')
  ld=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["last_decision"])')
  msg=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["message"])')
  qj=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(json.dumps(d["questions_for_user"]))')

  log_info "decision_table: state=${ns} reason=${pr} consume=${ca} decision=${ld}"

  case "$ns" in
    READY_FOR_REVIEW)
      # B4-0: non rubric_analytic must not pass K8 Gate (cannot go to READY_FOR_REVIEW)
      local scoring_mode; scoring_mode=$(json_read "$TASK_JSON" "scoring_mode" "rubric_analytic")
      if [ "$scoring_mode" != "rubric_analytic" ]; then
        log_info "B4-0: scoring_mode=${scoring_mode} is not rubric_analytic; cannot pass K8 Gate"
        write_event_attempt_decided "$att_num" "FAIL" "PAUSED" "PAUSED_JUDGE_MODE_INVALID"
        enter_paused "PAUSED_JUDGE_MODE_INVALID" "scoring_mode must be rubric_analytic to pass Gate (current: ${scoring_mode})" "[\"Set TaskSpec.scoring_mode to rubric_analytic for Gate.\"]"
        NORMAL_EXIT=1; exit 0
      fi
      write_event_attempt_decided "$att_num" "$ld" "READY_FOR_REVIEW" ""
      write_status "READY_FOR_REVIEW" "$att_num" "$max_att" "false" "$ld" "$msg" "$qj" "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      write_final_summary "READY_FOR_REVIEW" "$ld" "$att_num" "$max_att" "$msg" "$qj" "" "" "$hc" "${final_score_for_summary:-}" "" "${TASK_DIR}/attempt_$(printf '%03d' "$att_num")/coder/knowledge_entries.json"
      write_event "$att_num" "STATE_CHANGED" "READY_FOR_REVIEW"
      NORMAL_EXIT=1; exit 0
      ;;
    FAILED)
      write_event_attempt_decided "$att_num" "$ld" "FAILED" ""
      write_status "FAILED" "$att_num" "$max_att" "false" "$ld" "$msg" "$qj" "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      write_final_summary "FAILED" "$ld" "$att_num" "$max_att" "$msg" "$qj" "" "" "$hc" "${final_score_for_summary:-}" "" "${TASK_DIR}/attempt_$(printf '%03d' "$att_num")/coder/knowledge_entries.json"
      write_event "$att_num" "STATE_CHANGED" "FAILED"
      NORMAL_EXIT=1; exit 0
      ;;
    PAUSED)
      enter_paused "$pr" "$msg" "$qj" "$ld" "$hc" "$ca"
      NORMAL_EXIT=1; exit 0
      ;;
    RUNNING)
      write_event_attempt_decided "$att_num" "$ld" "RUNNING" ""
      write_status "RUNNING" "$att_num" "$max_att" "false" "$ld" "$msg" "$qj" "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      log_info "Auto-advancing to attempt $(( att_num + 1 ))"
      return 0
      ;;
  esac
}

# update_consecutive_timeout role rc
# Call before decision_table to update consecutive tracking
update_consecutive_timeout() {
  local role="$1" rc="$2"
  if [ "$rc" = "124" ]; then
    local key="${role}_timeout"
    if [ "$CONSECUTIVE_TIMEOUT_KEY" = "$key" ]; then
      CONSECUTIVE_TIMEOUT_COUNT=$(( CONSECUTIVE_TIMEOUT_COUNT + 1 ))
    else
      CONSECUTIVE_TIMEOUT_COUNT=1
      CONSECUTIVE_TIMEOUT_KEY="$key"
    fi
  else
    # Non-timeout: reset
    CONSECUTIVE_TIMEOUT_COUNT=0
    CONSECUTIVE_TIMEOUT_KEY=""
  fi
}

##############################################################################
# 3. Locking (mkdir atomic, macOS compatible)
##############################################################################
acquire_lock() {
  LOCK_DIR="${TASK_DIR}/.lockdir"
  if [ -d "$LOCK_DIR" ]; then
    local lock_pid="" lock_started="" is_stale=0
    [ -f "${LOCK_DIR}/pid" ] && lock_pid=$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")
    [ -f "${LOCK_DIR}/started_at" ] && lock_started=$(cat "${LOCK_DIR}/started_at" 2>/dev/null || echo "")
    if [ -n "$lock_pid" ]; then
      kill -0 "$lock_pid" 2>/dev/null || is_stale=1
    else
      is_stale=1
    fi
    if [ "$is_stale" = "0" ] && [ -n "$lock_started" ]; then
      local now_e; now_e=$(date +%s)
      local lock_e; lock_e=$(epoch_from_iso "$lock_started")
      if [ "$lock_e" != "0" ]; then
        local diff_s=$(( now_e - lock_e ))
        [ "$diff_s" -gt "$LOCK_STALE_SECONDS" ] && is_stale=1
      fi
    fi
    if [ "$is_stale" = "1" ]; then
      log_info "Clearing stale lock (pid=${lock_pid:-unknown})"
      rm -rf "$LOCK_DIR"
      write_event "$CURRENT_ATTEMPT" "LOCK_STALE_CLEARED" "stale lock cleared pid=${lock_pid:-unknown}"
    fi
  fi
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "${LOCK_DIR}/pid"
    hostname > "${LOCK_DIR}/host" 2>/dev/null || true
    now_iso > "${LOCK_DIR}/started_at"
    LOCK_ACQUIRED=1
    write_coordinator_simple_event "lock_acquired" "lock" "internal" "coordinator_run" "lock directory acquired" "" "0" "" "" "${LOCK_DIR}"
    return 0
  else
    write_coordinator_simple_event "lock_busy" "lock" "internal" "wait_or_exit" "lock directory already held" "" "1" "" "" "${LOCK_DIR}"
    return 1
  fi
}

release_lock() {
  if [ "$LOCK_ACQUIRED" = "1" ] && [ -d "${LOCK_DIR:-}" ]; then
    local lp=""; [ -f "${LOCK_DIR}/pid" ] && lp=$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")
    if [ "$lp" = "$$" ]; then
      write_coordinator_simple_event "lock_released" "lock" "internal" "" "lock directory released" "" "0" "" "" "${LOCK_DIR}"
      rm -rf "$LOCK_DIR"
      LOCK_ACQUIRED=0
    fi
  fi
}

##############################################################################
# 4. Trap / cleanup — §5.13, §19 check 4
##############################################################################
handle_signal() {
  # Capture signal, prevent re-entry, let cleanup handle it
  NORMAL_EXIT=0
  CAUGHT_SIGNAL="$1"
  exit $(( 128 + $1 ))
}
trap 'handle_signal 15' TERM
trap 'handle_signal 2' INT

cleanup() {
  local exit_code=$?
  set +e
  # Block signals during cleanup to prevent re-entry
  trap '' TERM INT
  if [ "$NORMAL_EXIT" = "1" ]; then
    release_lock; return
  fi
  # Determine signal name from exit code
  local sig_name="unknown"
  case "$exit_code" in
    130) sig_name="SIGINT" ;;
    143) sig_name="SIGTERM" ;;
    137) sig_name="SIGKILL" ;;
    1)   sig_name="ERR" ;;
    0)   sig_name="EXIT" ;;
    *)   sig_name="rc=${exit_code}" ;;
  esac
  # Abnormal: write PAUSED_CRASH if still RUNNING
  if [ -n "${TASK_DIR:-}" ] && [ -d "${TASK_DIR:-}" ]; then
    local cs=""
    [ -f "${TASK_DIR}/status.json" ] && cs=$(json_read "${TASK_DIR}/status.json" "state" "")
    if [ "$cs" = "RUNNING" ] || [ -z "$cs" ]; then
      local ma="${EFFECTIVE_MAX_ATTEMPTS:-3}"
      [ ! -f "${TASK_DIR}/status.json" ] && {
        write_status "RUNNING" "$CURRENT_ATTEMPT" "$ma" "false" "" "" '[]' "" "" "null" ""
      }
      local crash_lt
      crash_lt=$(python3 -c '
import json,sys
d={"reason_code":"PAUSED_CRASH","previous_state":"RUNNING",
   "message":"coordinator crashed ("+sys.argv[2]+", rc="+sys.argv[1]+")",
   "signal_or_rc":int(sys.argv[1]),"signal_name":sys.argv[2]}
print(json.dumps(d))
' "$exit_code" "$sig_name" 2>/dev/null || echo '{"reason_code":"PAUSED_CRASH","previous_state":"RUNNING"}')
      write_status "PAUSED" "$CURRENT_ATTEMPT" "$ma" "false" \
        "NEED_USER_INPUT" "coordinator crashed or was killed (${sig_name}, rc=${exit_code})" \
        '["Please check logs and re-run with --continue"]' \
        "PAUSED_INFRA" "PAUSED_CRASH" "$crash_lt" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      write_final_summary "PAUSED" "NEED_USER_INPUT" "$CURRENT_ATTEMPT" "$ma" \
        "coordinator crashed or was killed (${sig_name}, rc=${exit_code})" \
        '["Please check logs and re-run with --continue"]' \
        "PAUSED_INFRA" "PAUSED_CRASH" ""
      write_event "$CURRENT_ATTEMPT" "COORDINATOR_CRASHED" \
        "PAUSED_CRASH ${sig_name} rc=${exit_code}" 2>/dev/null || true
    fi
  fi
  release_lock
}
trap cleanup EXIT ERR

##############################################################################
# 5. Checkpoint: control.json PAUSE check — §5.11
##############################################################################
check_control_pause() {
  local cpname="$1"
  local cf="${TASK_DIR}/control.json"
  [ ! -f "$cf" ] && return 0
  local action; action=$(json_read "$cf" "action" "")
  if [ "$action" = "PAUSE" ]; then
    local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
    log_info "Checkpoint ${cpname}: PAUSE requested"
    local lt_user='{"reason_code":"PAUSED_USER","previous_state":"RUNNING","message":"user PAUSE at '"${cpname}"'"}'
    write_status "PAUSED" "$CURRENT_ATTEMPT" "$ma" "true" \
      "" "paused at checkpoint: ${cpname}" \
      '["User requested PAUSE. Use --continue to resume."]' \
      "PAUSED_MANUAL" "PAUSED_USER" "$lt_user" "${LAST_USER_INPUT_TS_CONSUMED:-}"
    write_final_summary "PAUSED" "NEED_USER_INPUT" "$CURRENT_ATTEMPT" "$ma" \
      "paused at checkpoint: ${cpname}" \
      '["User requested PAUSE. Use --continue to resume."]' \
      "PAUSED_MANUAL" "PAUSED_USER" ""
    write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "PAUSED_USER at ${cpname}"
    local pause_payload
    pause_payload=$(python3 - "$cpname" "$cf" <<'PY'
import json, sys
cpname, control_path = sys.argv[1:3]
print(json.dumps({
  "event_type": "CONTROL_PAUSE_AT_CHECKPOINT",
  "triggered_by": {"actor": "user", "source": "control.json"},
  "channel": {"name": "control_file", "direction": "inbound"},
  "delivery": {"from": "user", "to": "coordinator", "content_path": control_path},
  "executed_by": {"component": "run_task.sh", "function": "check_control_pause"},
  "next": {"state": "PAUSED", "checkpoint": cpname},
  "details": {"checkpoint": cpname}
}))
PY
)
    write_task_lifecycle_log "control_pause_checkpoint" "$pause_payload"
    rm -f "$cf"
    NORMAL_EXIT=1; exit 0
  fi
  return 0
}

# Set by process_control when RESUME was applied (so cmd_continue skips terminal-state exit)
CONTROL_RESUME_APPLIED=0
process_control() {
  local cf="${TASK_DIR}/control.json"
  CONTROL_RESUME_APPLIED=0
  [ ! -f "$cf" ] && return 0
  local action nonce pf
  action=$(json_read "$cf" "action" "")
  nonce=$(json_read "$cf" "nonce" "")
  pf="${TASK_DIR}/.processed_nonces"
  if [ -n "$nonce" ] && [ -f "$pf" ]; then
    grep -qF "$nonce" "$pf" 2>/dev/null && { rm -f "$cf"; return 0; }
  fi
  case "$action" in
    PAUSE)
      local pause_req_payload
      pause_req_payload=$(python3 - "$nonce" "$cf" <<'PY'
import json, sys
nonce, control_path = sys.argv[1:3]
print(json.dumps({
  "event_type": "CONTROL_PAUSE_REQUESTED",
  "triggered_by": {"actor": "user", "source": "control.json"},
  "channel": {"name": "control_file", "direction": "inbound"},
  "delivery": {"from": "user", "to": "coordinator", "content_path": control_path},
  "executed_by": {"component": "run_task.sh", "function": "process_control"},
  "next": {"target": "checkpoint_pause"},
  "details": {"nonce": nonce}
}))
PY
)
      write_task_lifecycle_log "control_pause_requested" "$pause_req_payload"
      return 0
      ;;
    RESUME)
      local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
      write_status "RUNNING" "$CURRENT_ATTEMPT" "$ma" "false" "" "" '[]' "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "RESUMED via control"
      local resume_payload
      resume_payload=$(python3 - "$action" "$nonce" "$cf" <<'PY'
import json, sys
action, nonce, control_path = sys.argv[1:4]
print(json.dumps({
  "event_type": "CONTROL_RESUME_APPLIED",
  "triggered_by": {"actor": "user", "source": "control.json"},
  "channel": {"name": "control_file", "direction": "inbound"},
  "delivery": {"from": "user", "to": "coordinator", "content_path": control_path},
  "executed_by": {"component": "run_task.sh", "function": "process_control"},
  "next": {"state": "RUNNING"},
  "details": {"action": action, "nonce": nonce}
}))
PY
)
      write_task_lifecycle_log "control_resume" "$resume_payload"
      rm -f "$cf"; [ -n "$nonce" ] && echo "$nonce" >> "$pf"
      CONTROL_RESUME_APPLIED=1
      ;;
    EDIT_INSTRUCTION)
      local ea et edit_prompt_path; ea=$(json_read "$cf" "payload.attempt" "0")
      et=$(json_read "$cf" "payload.instruction_text" "")
      edit_prompt_path=""
      if [ -n "$ea" ] && [ "$ea" != "0" ]; then
        local pad; pad=$(printf "%03d" "$ea")
        mkdir -p "${TASK_DIR}/attempt_${pad}/coder"
        echo "$et" > "${TASK_DIR}/attempt_${pad}/coder/prompt.txt"
        echo "$et" > "${TASK_DIR}/attempt_${pad}/coder/instruction.txt"
        edit_prompt_path="${TASK_DIR}/attempt_${pad}/coder/prompt.txt"
      fi
      local edit_payload
      edit_payload=$(python3 - "$ea" "$nonce" "$edit_prompt_path" "$cf" <<'PY'
import json, sys
attempt, nonce, prompt_path, control_path = sys.argv[1:5]
print(json.dumps({
  "event_type": "CONTROL_EDIT_INSTRUCTION_APPLIED",
  "triggered_by": {"actor": "user", "source": "control.json"},
  "channel": {"name": "control_file", "direction": "inbound"},
  "delivery": {"from": "user", "to": "coordinator", "content_path": control_path},
  "executed_by": {"component": "run_task.sh", "function": "process_control"},
  "next": {"path": prompt_path},
  "details": {"attempt": int(attempt) if str(attempt).isdigit() else 0, "nonce": nonce, "content_path": prompt_path}
}))
PY
)
      write_task_lifecycle_log "control_edit_instruction" "$edit_payload"
      rm -f "$cf"; [ -n "$nonce" ] && echo "$nonce" >> "$pf"
      ;;
    RUN_NEXT)
      local cs=""; [ -f "${TASK_DIR}/status.json" ] && cs=$(json_read "${TASK_DIR}/status.json" "state" "")
      if [ "$cs" = "PAUSED" ]; then
        local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
        write_status "RUNNING" "$CURRENT_ATTEMPT" "$ma" "false" "" "" '[]' "" ""
        write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "RUN_NEXT from PAUSED"
      fi
      local run_next_payload
      run_next_payload=$(python3 - "$nonce" "$cs" "$cf" <<'PY'
import json, sys
nonce, prev_state, control_path = sys.argv[1:4]
print(json.dumps({
  "event_type": "CONTROL_RUN_NEXT_APPLIED",
  "triggered_by": {"actor": "user", "source": "control.json"},
  "channel": {"name": "control_file", "direction": "inbound"},
  "delivery": {"from": "user", "to": "coordinator", "content_path": control_path},
  "executed_by": {"component": "run_task.sh", "function": "process_control"},
  "next": {"state": "RUNNING" if prev_state == "PAUSED" else prev_state},
  "details": {"nonce": nonce, "previous_state": prev_state}
}))
PY
)
      write_task_lifecycle_log "control_run_next" "$run_next_payload"
      rm -f "$cf"; [ -n "$nonce" ] && echo "$nonce" >> "$pf"
      ;;
  esac
}

##############################################################################
# 6. PAUSED helper — always writes status + final_summary + event
# K2-6: last_transition must include consume_attempt, reason_key, consecutive_count, triggered_at
##############################################################################
enter_paused() {
  local rcode="$1" msg="$2" qjson="$3"
  local ldec="${4:-NEED_USER_INPUT}" hc="${5:-}" consume="${6:-false}"
  local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
  local cat; cat=$(get_pause_category "$rcode")
  local lt_json
  lt_json=$(python3 -c '
import json,sys
# K2-6: consume_attempt, reason_key, consecutive_count, triggered_at
d={"consume_attempt":sys.argv[5]=="true","reason_key":sys.argv[1],"triggered_at":sys.argv[6]}
if sys.argv[3]!="0": d["consecutive_count"]=int(sys.argv[3])
print(json.dumps(d))
' "$rcode" "$msg" "$CONSECUTIVE_TIMEOUT_COUNT" "$CONSECUTIVE_TIMEOUT_KEY" "$consume" "$(now_iso)")
  # ATTEMPT_DECIDED for PAUSED_JUDGE_MODE_INVALID is written by caller before enter_paused
  if [ "$rcode" != "PAUSED_JUDGE_MODE_INVALID" ]; then
    write_event_attempt_decided "$CURRENT_ATTEMPT" "$ldec" "PAUSED" "$rcode"
  fi
  write_status "PAUSED" "$CURRENT_ATTEMPT" "$ma" "false" \
    "$ldec" "$msg" "$qjson" "$cat" "$rcode" "$lt_json" "${LAST_USER_INPUT_TS_CONSUMED:-}"
  write_final_summary "PAUSED" "$ldec" "$CURRENT_ATTEMPT" "$ma" \
    "$msg" "$qjson" "$cat" "$rcode" "$hc"
  write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "$rcode"
}

##############################################################################
# 7. Security guardrails — §9
##############################################################################
check_guardrails() {
  local wt="$1" bref="$2"
  local changed; changed=$(git -C "$wt" diff --name-only "${bref}...HEAD" 2>/dev/null || echo "")
  local changed_count=0
  changed_count=$(printf '%s\n' "$changed" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ -z "$changed" ]; then
    write_coordinator_simple_event "guardrails_checked" "policy" "internal" "attempt_continue" "guardrails passed (no changed files)" "git -C <wt> diff --name-only <base_ref>...HEAD" "0" "" "$wt" ""
    return 0
  fi
  # allowed_paths
  local ap; ap=$(json_read "$TASK_JSON" "allowed_paths" "[]")
  local has_ap; has_ap=$(python3 -c "import json,sys;print('y' if len(json.loads(sys.argv[1]))>0 else 'n')" "$ap" 2>/dev/null || echo "n")
  if [ "$has_ap" = "y" ]; then
    local viol; viol=$(python3 -c "
import json,sys
ap=json.loads(sys.argv[1]); fs=sys.argv[2].strip().split('\n') if sys.argv[2].strip() else []
for f in fs:
  ok=any(f.startswith(a) or f==a for a in ap)
  if not ok: print(f); sys.exit(0)
print('')
" "$ap" "$changed" 2>/dev/null || echo "")
    if [ -n "$viol" ]; then
      write_coordinator_simple_event "guardrails_violation" "policy" "internal" "pause_task" "allowed_paths violation: ${viol}" "allowed_paths check" "1" "" "$wt" ""
      enter_paused "PAUSED_ALLOWED_PATHS" "File '${viol}' outside allowed_paths" \
        "[\"File ${viol} is outside allowed_paths. Please review.\"]"
      NORMAL_EXIT=1; exit 0
    fi
  fi
  # forbidden_globs
  local fg; fg=$(json_read "$TASK_JSON" "forbidden_globs" "[]")
  local has_fg; has_fg=$(python3 -c "import json,sys;print('y' if len(json.loads(sys.argv[1]))>0 else 'n')" "$fg" 2>/dev/null || echo "n")
  if [ "$has_fg" = "y" ]; then
    local viol; viol=$(python3 -c "
import json,fnmatch,sys
fg=json.loads(sys.argv[1]); fs=sys.argv[2].strip().split('\n') if sys.argv[2].strip() else []
for f in fs:
  for p in fg:
    if fnmatch.fnmatch(f,p): print(f); sys.exit(0)
print('')
" "$fg" "$changed" 2>/dev/null || echo "")
    if [ -n "$viol" ]; then
      write_coordinator_simple_event "guardrails_violation" "policy" "internal" "pause_task" "forbidden_globs violation: ${viol}" "forbidden_globs check" "1" "" "$wt" ""
      enter_paused "PAUSED_FORBIDDEN_GLOBS" "File '${viol}' matches forbidden_globs" \
        "[\"File ${viol} matches forbidden_globs. Please review.\"]"
      NORMAL_EXIT=1; exit 0
    fi
  fi
  write_coordinator_simple_event "guardrails_checked" "policy" "internal" "attempt_continue" "guardrails passed (changed_count=${changed_count})" "allowed_paths+forbidden_globs checks" "0" "" "$wt" ""
  return 0
}

##############################################################################
# 8. Worktree management — §5.3
##############################################################################
setup_worktree() {
  local att_num="$1" repo="$2" bref="$3"
  local pad; pad=$(printf "%03d" "$att_num")
  local wt="${WORKTREES_DIR}/${TASK_ID}/attempt_${pad}"
  [ -z "$bref" ] && bref="main"
  write_coordinator_simple_event "worktree_setup_started" "git" "internal" "worktree_prepare" "prepare worktree for attempt ${att_num}" "" "" "$repo" "$wt" ""
  if [ -z "$repo" ]; then
    enter_paused "PAUSED_NOT_GIT_REPO" "repo_path is empty" \
      "[\"Set repo_path to a directory.\"]"
    NORMAL_EXIT=1; exit 0
  fi
  # Auto-create and auto-initialize git repo when needed.
  if [ ! -d "$repo" ]; then
    mkdir -p "$repo" 2>/dev/null || {
      enter_paused "PAUSED_NOT_GIT_REPO" "Cannot create repo_path '${repo}'" \
        "[\"Check path permissions or choose another folder.\"]"
      NORMAL_EXIT=1; exit 0
    }
    write_coordinator_simple_event "worktree_repo_created" "filesystem" "internal" "git_repo_check" "created missing repo directory" "mkdir -p <repo_path>" "0" "$repo" "" ""
  fi
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$repo" init >/dev/null 2>&1 || {
      enter_paused "PAUSED_NOT_GIT_REPO" "Failed to initialize git repository at '${repo}'" \
        "[\"Check write permission and git availability, then run next.\"]"
      NORMAL_EXIT=1; exit 0
    }
    write_coordinator_simple_event "git_repo_initialized" "git" "internal" "git_head_check" "initialized git repository" "git -C <repo_path> init" "0" "$repo" "" ""
  fi
  # Ensure a usable base ref exists for worktree creation.
  if ! git -C "$repo" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$repo" checkout -B "$bref" >/dev/null 2>&1 || true
    git -C "$repo" -c user.name=rdloop -c user.email=rdloop@local \
      commit --allow-empty -m "Initialize repository for rdloop" >/dev/null 2>&1 || {
      enter_paused "PAUSED_NOT_GIT_REPO" "Failed to create initial commit in '${repo}'" \
        "[\"Check git config/permissions and run next.\"]"
      NORMAL_EXIT=1; exit 0
    }
    write_coordinator_simple_event "git_repo_initialized" "git" "internal" "git_base_ref" "created initial commit for empty repository" "git -C <repo_path> commit --allow-empty" "0" "$repo" "" ""
  fi
  if ! git -C "$repo" show-ref --verify --quiet "refs/heads/${bref}"; then
    git -C "$repo" branch "$bref" HEAD >/dev/null 2>&1 || true
  fi
  if ! git -C "$repo" show-ref --verify --quiet "refs/heads/${bref}"; then
    enter_paused "PAUSED_NOT_GIT_REPO" "base_ref '${bref}' unavailable in '${repo}'" \
      "[\"Choose a valid base_ref or rerun after fixing repository state.\"]"
    NORMAL_EXIT=1; exit 0
  fi
  mkdir -p "$(dirname "$wt")"
  [ -d "$wt" ] && rm -rf "$wt"

  # Try git worktree add first
  local wt_ok=0
  local tout=""
  local worktree_add_rc=1
  command -v timeout >/dev/null 2>&1 && tout="timeout"
  [ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"
  if [ -n "$tout" ]; then
    set +e
    $tout 15 git -C "$repo" worktree add --detach "$wt" "$bref" >/dev/null 2>&1
    worktree_add_rc=$?
    set -e
  else
    set +e
    git -C "$repo" worktree add --detach "$wt" "$bref" >/dev/null 2>&1
    worktree_add_rc=$?
    set -e
  fi
  if [ "$worktree_add_rc" = "0" ]; then
    wt_ok=1
    write_coordinator_simple_event "worktree_created" "git" "internal" "attempt_workspace" "worktree added from base_ref ${bref}" "git -C <repo_path> worktree add --detach <wt> <base_ref>" "0" "$repo" "$wt" ""
  else
    write_coordinator_simple_event "worktree_created" "git" "internal" "attempt_workspace" "worktree add failed; fallback will be used" "git -C <repo_path> worktree add --detach <wt> <base_ref>" "$worktree_add_rc" "$repo" "$wt" ""
  fi

  if [ "$wt_ok" = "0" ]; then
    # Fallback: export tracked files only (avoid copying heavy runtime dirs like out/)
    mkdir -p "$wt"
    local archive_rc=1
    local copy_rc=0
    set +e
    git -C "$repo" archive "$bref" | tar -x -C "$wt" >/dev/null 2>&1
    archive_rc=$?
    set -e
    if [ "$archive_rc" != "0" ]; then
      # Last resort: copy repo tree when archive is unavailable.
      set +e
      cp -R "$repo"/. "$wt"/ 2>/dev/null
      copy_rc=$?
      set -e
    fi
    write_coordinator_simple_event "worktree_archive_fallback" "git" "internal" "attempt_workspace" "archive_rc=${archive_rc} copy_rc=${copy_rc}" "git archive | tar (fallback cp -R)" "${archive_rc}" "$repo" "$wt" ""
    # Ensure standalone git repo for downstream git diff/log commands.
    [ -f "${wt}/.git" ] && rm -f "${wt}/.git"
    local wt_init_rc=0 wt_add_rc=0 wt_commit_rc=0
    set +e
    git -C "$wt" init >/dev/null 2>&1
    wt_init_rc=$?
    git -C "$wt" add -A >/dev/null 2>&1
    wt_add_rc=$?
    git -C "$wt" commit -m "worktree init" --allow-empty >/dev/null 2>&1
    wt_commit_rc=$?
    set -e
    write_coordinator_simple_event "worktree_fallback_initialized" "git" "internal" "attempt_workspace" "init_rc=${wt_init_rc} add_rc=${wt_add_rc} commit_rc=${wt_commit_rc}" "git -C <wt> init && add && commit --allow-empty" "${wt_init_rc}" "$repo" "$wt" ""
  fi
  write_coordinator_simple_event "worktree_ready" "git" "internal" "attempt_workspace" "worktree prepared for attempt ${att_num}" "" "0" "$repo" "$wt" ""
  echo "$wt"
}

# v5 git-context intent: coordinator bootstraps api_call git env via git_ops.sh
ensure_api_call_git_env() {
  local repo="$1" bref="$2"
  local git_ops="${RDLOOP_ROOT}/tools/git_ops.sh"
  write_coordinator_simple_event "git_env_bootstrap_started" "git" "internal" "git_env_bootstrap" "bootstrap api_call git environment" "git_ops.sh create-branches" "" "$repo" "" ""
  if [ ! -f "$git_ops" ]; then
    log_error "git_ops.sh not found: ${git_ops}"
    write_coordinator_simple_event "git_env_bootstrap_finished" "git" "internal" "pause_or_retry" "git_ops missing" "git_ops.sh create-branches" "1" "$repo" "" ""
    return 1
  fi
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    log_error "repo_path is not a git repo for git_ops bootstrap: ${repo}"
    write_coordinator_simple_event "git_env_bootstrap_finished" "git" "internal" "pause_or_retry" "repo is not a git repository" "git -C <repo_path> rev-parse --git-dir" "1" "$repo" "" ""
    return 1
  fi

  local created_at date_yyyymmdd
  created_at=$(json_read "$TASK_JSON" "created_at" "")
  date_yyyymmdd=$(python3 -c '
import re,sys,datetime
raw=(sys.argv[1] or "").strip()
m=re.match(r"^(\d{4})-(\d{2})-(\d{2})", raw)
if m:
    print(m.group(1)+m.group(2)+m.group(3))
else:
    print(datetime.datetime.utcnow().strftime("%Y%m%d"))
' "$created_at" 2>/dev/null || date -u +%Y%m%d)

  local spec_file="${TASK_DIR}/.branch_init_spec_${TASK_ID}.json"
  python3 -c '
import json,sys
spec={
  "type":"BranchInitSpec",
  "task_slug":sys.argv[1],
  "date":sys.argv[2],
  "repo_path":sys.argv[3],
  "base_ref":sys.argv[4] or "main",
  "workers":[
    {"task_id":sys.argv[1], "executor_type":"api_call", "label":"content"}
  ]
}
with open(sys.argv[5],"w",encoding="utf-8") as f:
  json.dump(spec,f,ensure_ascii=True)
' "$TASK_ID" "$date_yyyymmdd" "$repo" "$bref" "$spec_file" 2>/dev/null || return 1

  local out="" rc=0
  out=$(bash "$git_ops" create-branches "$spec_file" 2>&1) || rc=$?
  rm -f "$spec_file" 2>/dev/null || true
  if [ "$rc" -ne 0 ]; then
    log_error "git_ops bootstrap failed (rc=${rc}): ${out}"
    write_coordinator_simple_event "git_env_bootstrap_finished" "git" "internal" "pause_or_retry" "git_ops create-branches failed (rc=${rc})" "git_ops.sh create-branches <spec>" "$rc" "$repo" "" ""
    return "$rc"
  fi
  [ -n "$out" ] && log_info "git_ops bootstrap output: ${out}"
  write_coordinator_simple_event "git_env_bootstrap_finished" "git" "internal" "worktree_discovery" "git_ops create-branches succeeded" "git_ops.sh create-branches <spec>" "0" "$repo" "" ""
  return 0
}

##############################################################################
# 8b. Artifacts copy (K8-4) — worktree artifacts/ → out/<task_id>/artifacts/
##############################################################################
copy_artifacts() {
  local wt="$1" att_num="$2"
  local src="${wt}/artifacts"
  local dst="${TASK_DIR}/artifacts"
  [ ! -d "$src" ] && return 0
  local pad; pad=$(printf "%03d" "$att_num")
  mkdir -p "${dst}/attempt_${pad}"
  cp -R "${src}/." "${dst}/attempt_${pad}/" 2>/dev/null || true
  for f in requirements.md spec.json; do
    [ -f "${dst}/attempt_${pad}/${f}" ] && cp "${dst}/attempt_${pad}/${f}" "${dst}/${f}" 2>/dev/null || true
  done
  log_info "Artifacts copied from worktree to ${dst}/ (attempt ${att_num})"
  write_coordinator_simple_event "artifact_copy_completed" "filesystem" "internal" "task_artifacts" "copied artifacts for attempt ${att_num}" "cp -R <worktree>/artifacts -> out/<task>/artifacts" "0" "" "$wt" "${dst}/attempt_${pad}"
}

##############################################################################
# 9. Build coder instruction with context — §5.4
# attempt_context_mode: fresh_each = each attempt from scratch (divergent);
#   iterative = n+1 gets previous coder output as context (convergent).
##############################################################################
build_instruction() {
  local att_dir="$1" att_num="$2" wt="$3" bref="$4" goal="$5" acceptance="$6"
  local ifile="${att_dir}/coder/prompt.txt"
  local legacy_ifile="${att_dir}/coder/instruction.txt"
  local task_type; task_type=$(json_read "$TASK_JSON" "task_type" "")
  # v5: use session_mode / context_strategy for instruction assembly
  local cur_session_mode; cur_session_mode=$(json_read "$TASK_JSON" "session_mode" "")
  # Legacy fallback: attempt_context_mode
  local attempt_context_mode; attempt_context_mode=$(json_read "$TASK_JSON" "attempt_context_mode" "fresh_each")
  # Determine effective context strategy
  local eff_ctx="reset"  # default: fresh
  if [ -n "$cur_session_mode" ]; then
    case "$cur_session_mode" in
      iterative) eff_ctx="carry" ;;
      continuous) eff_ctx="persist" ;;
      fresh) eff_ctx="reset" ;;
    esac
  elif [ "$attempt_context_mode" = "iterative" ]; then
    eff_ctx="carry"
  fi
  local is_eng_impl=""
  [ "$task_type" = "engineering_impl" ] || [ "$task_type" = "engineering_implementation" ] && is_eng_impl="1"
  mkdir -p "${att_dir}/coder"
  {
    echo "=== CONTEXT ==="
    echo ""
    # v5 Bug1 fix: session_mode-aware context injection
    # fresh (reset): no previous output, no judge feedback — each attempt starts clean
    # iterative (carry): inject previous output + judge next_instructions
    # continuous (persist): agent maintains own context, inject judge feedback only
    if [ "$att_num" -gt 1 ] && [ "$eff_ctx" = "carry" ]; then
      local pp; pp=$(printf "%03d" $(( att_num - 1 )))
      # Inject previous coder output (iterative mode)
      local prev_run_log="${TASK_DIR}/attempt_${pp}/coder/run.log"
      [ ! -f "$prev_run_log" ] && prev_run_log="${TASK_DIR}/attempt_${pp}/coder/stdout.log"
      if [ -f "$prev_run_log" ]; then
        echo "=== PREVIOUS VERSION (attempt $(( att_num - 1 ))) ==="
        echo "(Use this as the basis to modify or improve; do not start from zero.)"
        echo ""
        tail -c 80000 "$prev_run_log" 2>/dev/null | head -c 80000
        echo ""
        echo ""
      fi
    fi
    # v5 Bug1 fix: inject judge next_instructions for iterative AND continuous modes
    # (fresh mode: skip entirely — each attempt starts from zero)
    if [ "$att_num" -gt 1 ] && [ "$eff_ctx" != "reset" ]; then
      local pp; pp=$(printf "%03d" $(( att_num - 1 )))
      # Try git first (.rdloop/attempt_N/verdict.json in worktree), then filesystem fallback
      local ni=""
      if [ -d "$wt/.git" ] || [ -f "$wt/.git" ]; then
        ni=$(git -C "$wt" show "HEAD:.rdloop/attempt_${pp}/verdict.json" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('next_instructions',''))" 2>/dev/null || echo "")
      fi
      # Filesystem fallback
      if [ -z "$ni" ]; then
        local pv="${TASK_DIR}/attempt_${pp}/judge/verdict.json"
        [ -f "$pv" ] && ni=$(json_read "$pv" "next_instructions" "")
      fi
      if [ -n "$ni" ]; then
        echo "=== Judge 修改指引 (attempt $(( att_num - 1 ))) ==="
        echo "$ni"
        echo ""
      fi
      # Previous test results (engineering tasks)
      if [ -n "$is_eng_impl" ]; then
        local prc_f="${TASK_DIR}/attempt_${pp}/test/rc.txt"
        local plog="${TASK_DIR}/attempt_${pp}/test/stdout.log"
        if [ -f "$prc_f" ]; then
          local prc; prc=$(cat "$prc_f" 2>/dev/null || echo "")
          echo "Previous test result: rc=${prc}"
          [ -f "$plog" ] && { echo "Previous test log (tail ${TEST_LOG_TAIL_LINES} lines):"; tail -n "$TEST_LOG_TAIL_LINES" "$plog" 2>/dev/null || true; }
          echo ""
        fi
      fi
    fi
    if [ -n "$is_eng_impl" ]; then
      echo "Current diff --stat from ${bref}:"
      git -C "$wt" diff --stat "${bref}...HEAD" 2>/dev/null || echo "(no diff)"
      echo ""
      echo "Current HEAD:"
      git -C "$wt" log -1 --oneline 2>/dev/null || echo "(no commits)"
      echo ""
    fi
    echo "=== END CONTEXT ==="
    echo ""
    echo "=== GOAL ==="
    echo "$goal"
    echo ""
    echo "=== ACCEPTANCE CRITERIA ==="
    echo "$acceptance"
    echo ""
    echo "=== KNOWLEDGE ENTRIES (optional) ==="
    echo "When you have finished implementing, write a JSON file at .rdloop/knowledge_entries.json (repo root): keys = relative paths of files you modified (e.g. src/auth.py), values = one-line summary of what the file does or what changed (e.g. \"JWT auth. verify_token().\"). Only include files you actually modified. If you did not modify any files, you may omit this file."
    echo ""
  } > "$ifile"
  # E5-2: Consume user_input.jsonl (incremental), append USER_INPUT block, set LAST_USER_INPUT_TS_CONSUMED
  consume_user_input "$ifile"
  cp "$ifile" "$legacy_ifile" 2>/dev/null || true
  echo "$ifile"
}

# E5-2: Read user_input.jsonl (lines after last_user_input_ts_consumed), append to instruction file; set LAST_USER_INPUT_TS_CONSUMED
consume_user_input() {
  local ifile="$1"
  [ -z "$ifile" ] || [ ! -f "$ifile" ] && return 0
  local ui_file="${TASK_DIR}/user_input.jsonl"
  [ ! -f "$ui_file" ] && return 0
  local prev_ts=""
  [ -f "${TASK_DIR}/status.json" ] && prev_ts=$(json_read "${TASK_DIR}/status.json" "last_user_input_ts_consumed" "" 2>/dev/null || echo "")
  LAST_USER_INPUT_TS_CONSUMED=$(python3 -c "
import json,sys,os
ifile=sys.argv[1]
ui_file=sys.argv[2]
prev_ts=sys.argv[3].strip() if len(sys.argv)>3 else ''
new_ts=prev_ts
lines_added=[]
try:
  with open(ui_file, encoding='utf-8') as f:
    for line in f:
      line=line.strip()
      if not line: continue
      try:
        ob=json.loads(line)
        ts=ob.get('ts') or ob.get('timestamp') or ''
        text=ob.get('text') or ob.get('content') or ''
        if not ts: continue
        if prev_ts and ts <= prev_ts: continue
        lines_added.append((ts,text))
        if not new_ts or ts > new_ts: new_ts=ts
      except: pass
  if lines_added:
    with open(ifile, 'a', encoding='utf-8') as out:
      out.write('\n\n=== USER_INPUT ===\n\n')
      for ts, text in lines_added:
        out.write(text)
        if not text.endswith('\n'): out.write('\n')
    print(new_ts)
  else:
    print(prev_ts if prev_ts else '')
except Exception as e:
  print(prev_ts if prev_ts else '')
" "$ifile" "$ui_file" "$prev_ts" 2>/dev/null || echo "")
  if [ -n "${LAST_USER_INPUT_TS_CONSUMED:-}" ] && [ "$LAST_USER_INPUT_TS_CONSUMED" != "${prev_ts:-}" ]; then
    local ui_payload
    ui_payload=$(python3 - "$ui_file" "${prev_ts:-}" "$LAST_USER_INPUT_TS_CONSUMED" <<'PY'
import json, sys
ui_file, prev_ts, new_ts = sys.argv[1:4]
entries = []
try:
    with open(ui_file, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ob = json.loads(line)
            except Exception:
                continue
            ts = (ob.get('ts') or ob.get('timestamp') or '').strip()
            if not ts:
                continue
            if prev_ts and ts <= prev_ts:
                continue
            if new_ts and ts > new_ts:
                continue
            entries.append({
                "ts": ts,
                "request_id": ob.get('request_id', ''),
                "text": ob.get('text') or ob.get('content') or ''
            })
except Exception:
    entries = []
print(json.dumps({
  "event_type": "USER_INPUT_CONSUMED",
  "triggered_by": {"actor": "user", "source": "user_input.jsonl"},
  "channel": {"name": "user_input_jsonl", "direction": "inbound"},
  "delivery": {
    "from": "user",
    "to": "coordinator",
    "content_path": ui_file,
    "entries": entries
  },
  "executed_by": {"component": "run_task.sh", "function": "consume_user_input"},
  "next": {"target": "coder_prompt"},
  "details": {"consumed_count": len(entries), "from_ts": prev_ts, "to_ts": new_ts}
}))
PY
)
    write_task_lifecycle_log "user_input_consumed" "$ui_payload"
  fi
  [ -z "$LAST_USER_INPUT_TS_CONSUMED" ] || export LAST_USER_INPUT_TS_CONSUMED
}

##############################################################################
# 10. Run a single attempt
##############################################################################
run_attempt() {
  local att_num="$1"
  local pad; pad=$(printf "%03d" "$att_num")
  local att_dir="${TASK_DIR}/attempt_${pad}"
  local cmd_log="${att_dir}/commands.log"
  CURRENT_ATTEMPT=$att_num
  # E5-2/K1-1a: Load previous last_user_input_ts_consumed so write_status can pass it; consume_user_input may update it
  [ -f "${TASK_DIR}/status.json" ] && LAST_USER_INPUT_TS_CONSUMED=$(json_read "${TASK_DIR}/status.json" "last_user_input_ts_consumed" "" 2>/dev/null || echo "")

  local repo base_ref goal acceptance test_cmd coder_type judge_type
  local coder_timeout test_timeout judge_timeout max_att
  repo=$(json_read "$TASK_JSON" "repo_path" "")
  base_ref=$(json_read "$TASK_JSON" "base_ref" "main")
  goal=$(json_read "$TASK_JSON" "goal" "")
  acceptance=$(json_read "$TASK_JSON" "acceptance" "")
  test_cmd=$(json_read "$TASK_JSON" "test_cmd" "true")
  coder_type=$(json_read "$TASK_JSON" "coder" "")
  judge_type=$(json_read "$TASK_JSON" "judge" "")
  coder_model=$(json_read "$TASK_JSON" "coder_model" "")
  judge_model=$(json_read "$TASK_JSON" "judge_model" "")
  # A6-2: Fallback to rdloop.config.json when TaskSpec does not specify coder/judge/model
  local config_json="${RDLOOP_ROOT}/rdloop.config.json"
  if [ -f "$config_json" ]; then
    [ -z "$coder_type" ] && coder_type=$(json_read "$config_json" "default_coder" "mock")
    [ -z "$judge_type" ] && judge_type=$(json_read "$config_json" "default_judge" "mock")
    [ -z "$coder_model" ] && coder_model=$(json_read "$config_json" "default_coder_model" "")
    [ -z "$judge_model" ] && judge_model=$(json_read "$config_json" "default_judge_model" "")
  fi
  # v5.1 routing derivation (task_type + launch_mode), with legacy compat mapping.
  local task_type launch_mode launch_mode_locked
  local derive_exports=""
  if ! derive_exports="$(derive_v51_routing_exports 2>&1)"; then
    log_error "${derive_exports}"
    log_error "Routing remediation: run tools/migrate_task_json_v51.sh --in-place --keep-legacy <task.json> and set task_type/launch_mode explicitly if ambiguous."
    exit 1
  fi
  eval "${derive_exports}"
  task_type="${DERIVED_TASK_TYPE}"
  launch_mode="${DERIVED_LAUNCH_MODE}"
  launch_mode_locked="${DERIVED_LAUNCH_MODE_LOCKED}"

  if [ "${DERIVED_MIGRATION_APPLIED}" = "true" ]; then
    write_event "$att_num" "MIGRATION_APPLIED" "in-memory v5.1 routing mapping applied: ${DERIVED_MIGRATION_REASON}" "$att_dir"
  fi

  local executor_type=""
  case "$task_type" in
    copywriting) executor_type="api_call" ;;
    solo) executor_type="solo_agent" ;;
    multi_agent) executor_type="multi_agent" ;;
    *)
      log_error "task_type is required and must be one of: copywriting, solo, multi_agent"
      exit 1
      ;;
  esac

  local run_surface=""
  case "$launch_mode" in
    ccb) run_surface="visual_ccb" ;;
    bridge) run_surface="bridge" ;;
    *)
      log_error "launch_mode is required and must be one of: ccb, bridge"
      exit 1
      ;;
  esac
  write_event_ext "launch_mode_selected" "{\"launch_mode\":\"${launch_mode}\",\"locked\":${launch_mode_locked}}"

  # session_mode is accepted for backward compatibility but does not control routing.
  local session_mode; session_mode=$(json_read "$TASK_JSON" "session_mode" "continuous")
  local context_strategy=""
  case "$session_mode" in
    fresh)      context_strategy="reset"   ;;
    iterative)  context_strategy="carry"   ;;
    continuous|"") context_strategy="persist" ;;
    *)
      log_info "Unknown legacy session_mode='${session_mode}', fallback to context_strategy=persist"
      context_strategy="persist"
      ;;
  esac

  local judge_enabled_flag task_provider executor_provider reviewer_provider pm_provider solo_provider
  judge_enabled_flag=$(json_read "$TASK_JSON" "judge_enabled" "true")
  task_provider=$(normalize_provider_v51 "$(json_read "$TASK_JSON" "agent_config.provider" "claude")")
  executor_provider=$(normalize_provider_v51 "$(json_read "$TASK_JSON" "collab_roles.executor" "")")
  reviewer_provider=$(normalize_provider_v51 "$(json_read "$TASK_JSON" "collab_roles.reviewer" "")")
  pm_provider=$(normalize_provider_v51 "$(json_read "$TASK_JSON" "collab_roles.pm" "")")
  [ -z "$task_provider" ] && task_provider="claude"
  [ -z "$executor_provider" ] && executor_provider="$task_provider"
  [ -z "$reviewer_provider" ] && reviewer_provider="$executor_provider"

  case "$executor_type" in
    api_call)
      if [ "$executor_provider" = "mock" ]; then
        coder_type="mock"
      else
        if [ "$run_surface" = "visual_ccb" ]; then
          coder_type="ccb"
        else
          coder_type=$(resolve_nonvisual_coder_type_v51 "$executor_provider")
        fi
      fi
      if [ "$judge_enabled_flag" = "false" ]; then
        judge_type="none"
      elif [ "$reviewer_provider" = "mock" ]; then
        judge_type="mock"
      else
        if [ "$run_surface" = "visual_ccb" ]; then
          judge_type="ccb"
        else
          judge_type=$(resolve_nonvisual_judge_type_v51 "$reviewer_provider")
        fi
      fi
      ;;
    solo_agent)
      [ -z "$judge_model" ] && judge_model="$coder_model"
      solo_provider="$pm_provider"
      [ -z "$solo_provider" ] && solo_provider="$executor_provider"
      [ -z "$solo_provider" ] && solo_provider="$task_provider"
      if [ -z "$solo_provider" ]; then
        case "${coder_model}" in
          codex*|*codex*) solo_provider="codex" ;;
          gemini*|*gemini*|antigravity*|*antigravity*) solo_provider="gemini" ;;
          opencode*|*opencode*) solo_provider="opencode" ;;
          droid*|*droid*) solo_provider="droid" ;;
          cursor*|*cursor*) solo_provider="cursor" ;;
          *) solo_provider="claude" ;;
        esac
      fi
      if [ "$solo_provider" = "mock" ]; then
        coder_type="mock"
        if [ "$judge_enabled_flag" = "false" ]; then judge_type="none"; else judge_type="mock"; fi
      else
        if [ "$run_surface" = "visual_ccb" ]; then
          coder_type="ccb"
          if [ "$judge_enabled_flag" = "false" ]; then judge_type="none"; else judge_type="ccb"; fi
        else
          coder_type=$(resolve_nonvisual_coder_type_v51 "$solo_provider")
          if [ "$judge_enabled_flag" = "false" ]; then
            judge_type="none"
          else
            judge_type=$(resolve_nonvisual_judge_type_v51 "$reviewer_provider")
          fi
        fi
      fi
      ;;
    multi_agent)
      if [ "$executor_provider" = "mock" ]; then
        coder_type="mock"
      else
        if [ "$run_surface" = "visual_ccb" ]; then
          coder_type="ccb"
        else
          coder_type=$(resolve_nonvisual_coder_type_v51 "$executor_provider")
        fi
      fi
      if [ "$judge_enabled_flag" = "false" ]; then
        judge_type="none"
      elif [ "$reviewer_provider" = "mock" ]; then
        judge_type="mock"
      else
        if [ "$run_surface" = "visual_ccb" ]; then
          judge_type="ccb"
        else
          judge_type=$(resolve_nonvisual_judge_type_v51 "$reviewer_provider")
        fi
      fi
      ;;
  esac
  [ -z "$coder_type" ] && coder_type="mock"
  [ -z "$judge_type" ] && judge_type="mock"
  # Unique task code + attempt for handoff tracing (coder/judge 1:1)
  local task_code; task_code=$(json_read "$TASK_JSON" "task_code" "")
  if [ -z "$task_code" ]; then
    task_code="rdloop-$(date +%s)-$$-${RANDOM}"
    python3 -c "import json; d=json.load(open('$TASK_JSON')); d['task_code']='$task_code'; json.dump(d, open('$TASK_JSON','w'), indent=2)"
  fi
  export RDLOOP_TASK_CODE="$task_code"
  export RDLOOP_ATTEMPT="$att_num"
  export CODER_MODEL="$coder_model"
  export JUDGE_MODEL="$judge_model"
  # Map display names to script suffix (call_coder_${suffix}.sh / call_judge_${suffix}.sh)
  case "$coder_type" in cursor-agent|cursor_cli) coder_script_suffix="cursor";; codex-cli|codex_cli) coder_script_suffix="codex";; claude-bridge|claude_bridge) coder_script_suffix="claude_bridge";; antigravity-cli|gemini-cli) coder_script_suffix="antigravity";; bridge) coder_script_suffix="bridge";; ccb) coder_script_suffix="ccb";; *) coder_script_suffix="$coder_type";; esac
  case "$judge_type" in cursor-agent|cursor_cli) judge_script_suffix="cursor";; codex-cli|codex_cli) judge_script_suffix="codex";; claude-cli|claude_bridge) judge_script_suffix="claude";; antigravity-cli|gemini-cli) judge_script_suffix="antigravity";; bridge) judge_script_suffix="bridge";; ccb) judge_script_suffix="ccb";; *) judge_script_suffix="$judge_type";; esac
  # P16: collab_roles for semi-auto (ccb) — pass executor/reviewer to call_coder_ccb/call_judge_ccb
  local ccb_coder_provider ccb_judge_provider
  ccb_coder_provider="$executor_provider"
  ccb_judge_provider="$reviewer_provider"
  if [ "$executor_type" = "solo_agent" ]; then
    [ -n "$solo_provider" ] && ccb_coder_provider="$solo_provider"
    [ -z "$ccb_judge_provider" ] && ccb_judge_provider="$ccb_coder_provider"
  fi
  [ -z "$ccb_coder_provider" ] && ccb_coder_provider="$task_provider"
  [ -z "$ccb_judge_provider" ] && ccb_judge_provider="$ccb_coder_provider"
  coder_timeout=$(json_read "$TASK_JSON" "coder_timeout_seconds" "600")
  test_timeout=$(json_read "$TASK_JSON" "test_timeout_seconds" "300")
  judge_timeout=$(json_read "$TASK_JSON" "judge_timeout_seconds" "300")
  max_att=$(json_read "$TASK_JSON" "max_attempts" "3")
  local is_eng_impl=""
  [ "$task_type" = "engineering_impl" ] || [ "$task_type" = "engineering_implementation" ] && is_eng_impl="1"

  mkdir -p "${att_dir}/coder" "${att_dir}/test" "${att_dir}/judge"
  : > "${att_dir}/coder/prompt.txt"
  : > "${att_dir}/coder/stdout.log"
  : > "${att_dir}/coder/stderr.log"
  : > "${att_dir}/judge/prompt.txt"
  : > "${att_dir}/judge/stdout.log"
  : > "${att_dir}/judge/stderr.log"

  local att_start; att_start=$(now_iso)
  write_status "RUNNING" "$att_num" "$max_att" "false" "" "" '[]' "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
  write_event "$att_num" "ATTEMPT_STARTED" "attempt ${att_num} started" "$att_dir"

  # Worktree
  local wt
  # api_call: skip worktree if no repo_path; v5 worktree pre-created by git_ops.sh
  if [ "$executor_type" = "api_call" ]; then
    local repo_path_check; repo_path_check=$(json_read "$TASK_JSON" "repo_path" "")
    if [ -z "$repo_path_check" ] || [ "$repo_path_check" = "dummy_repo" ]; then
      wt="${TASK_DIR}"
      mkdir -p "$wt"
    else
      # v5: check for pre-created worktree from git_ops.sh create-branches
      local pre_wt="${WORKTREES_DIR}/${TASK_ID}"
      # Use first found worktree subdirectory
      local found_wt=""
      if [ -d "$pre_wt" ]; then
        for d in "$pre_wt"/*/; do
          [ -d "$d" ] && { found_wt="$d"; break; }
        done
      fi
      if [ -z "$found_wt" ]; then
        log_info "Pre-created worktree missing for api_call; bootstrapping via git_ops.sh create-branches (task_id=${TASK_ID})"
        if ensure_api_call_git_env "$repo_path_check" "$base_ref"; then
          if [ -d "$pre_wt" ]; then
            for d in "$pre_wt"/*/; do
              [ -d "$d" ] && { found_wt="$d"; break; }
            done
          fi
        fi
      fi
      if [ -n "$found_wt" ]; then
        wt="$found_wt"
      else
        if [ -d "$pre_wt" ]; then
          write_event "$att_num" "STATE_CHANGED" "PAUSED_NOT_GIT_REPO (pre-created worktree missing)"
          enter_paused "PAUSED_NOT_GIT_REPO" \
            "Pre-created worktree not found under '${pre_wt}', and bootstrap via git_ops.sh create-branches failed." \
            "[\"Ensure repo_path is a valid git repo and run tools/git_ops.sh create-branches <branch_init_spec.json>; then use Run Next.\"]" \
            "NEED_USER_INPUT" "" "true"
        else
          write_event "$att_num" "STATE_CHANGED" "PAUSED_NOT_GIT_REPO (pre-created worktree directory missing)"
          enter_paused "PAUSED_NOT_GIT_REPO" \
            "Pre-created worktree directory '${pre_wt}' is missing, and bootstrap via git_ops.sh create-branches failed." \
            "[\"Ensure repo_path is a valid git repo and run tools/git_ops.sh create-branches <branch_init_spec.json>; then use Run Next.\"]" \
            "NEED_USER_INPUT" "" "true"
        fi
        NORMAL_EXIT=1; exit 0
      fi
    fi
  else
    wt=$(setup_worktree "$att_num" "$repo" "$base_ref")
  fi
  # Safety: if setup_worktree failed in subshell command substitution, wt can be empty.
  # Never continue coder/test/judge with an invalid worktree, or execution may fall back to coordinator cwd.
  if [ -z "${wt:-}" ] || [ ! -d "$wt" ]; then
    local cur_state=""
    [ -f "${TASK_DIR}/status.json" ] && cur_state=$(json_read "${TASK_DIR}/status.json" "state" "")
    if [ "$cur_state" != "PAUSED" ]; then
      enter_paused "PAUSED_CRASH" "worktree setup failed or returned empty path" \
        '["Fix repo_path/base_ref and run next."]' "NEED_USER_INPUT" "" "true"
    fi
    NORMAL_EXIT=1; exit 0
  fi
  write_env_json "$att_dir" "$task_code" "$att_num"

  # ---- BEFORE_CODER ----
  check_control_pause "BEFORE_CODER"

  # ---- CODER ----
  local c_start c_fin coder_rc=0
  c_start=$(now_iso)
  write_event "$att_num" "CODER_STARTED" "coder=${coder_type}" "$att_dir" "$wt"

  # Cursor uses cliapi (cursorcliapi 8000), same as other adapters; no queue CLI required
  local ifile; ifile=$(build_instruction "$att_dir" "$att_num" "$wt" "$base_ref" "$goal" "$acceptance")
  export CODER_PROMPT_PATH="${att_dir}/coder/prompt.txt"
  export CODER_STDOUT_PATH="${att_dir}/coder/stdout.log"
  export CODER_STDERR_PATH="${att_dir}/coder/stderr.log"
  export CODER_RC_PATH="${att_dir}/coder/rc.txt"
  local coder_script="${LIB_DIR}/call_coder_${coder_script_suffix}.sh"
  if [ ! -f "$coder_script" ]; then
    log_error "Coder script not found: ${coder_script}"
    coder_rc=1
  else
    local c_s_epoch; c_s_epoch=$(date +%s)
    local coder_channel_name="" coder_session_id="" coder_req_code=""
    coder_channel_name=$(channel_name_for_adapter_suffix "$coder_script_suffix")
    if [ "$coder_channel_name" = "ccb" ] || [ "$coder_channel_name" = "bridge" ]; then
      coder_session_id="$("$SESSION_ID_GEN" "$TASK_ID" "executor" "$att_num")"
      write_event_ext "session_id_assigned" "{\"session_id\":\"${coder_session_id}\",\"role\":\"executor\",\"attempt\":${att_num}}"
      if [ "$coder_channel_name" = "ccb" ]; then
        coder_req_code="$("$REQ_CODE_GEN" "$coder_session_id")"
        write_event_ext "req_code_assigned" "{\"session_id\":\"${coder_session_id}\",\"req_code\":\"${coder_req_code}\",\"role\":\"executor\",\"attempt\":${att_num}}"
        write_event_ext "ccb_call" "{\"session_id\":\"${coder_session_id}\",\"req_code\":\"${coder_req_code}\",\"role\":\"executor\",\"provider\":\"${ccb_coder_provider}\",\"planned\":false,\"adapter_suffix\":\"${coder_script_suffix}\"}"
      else
        write_event_ext "bridge_call" "{\"session_id\":\"${coder_session_id}\",\"role\":\"executor\",\"provider\":\"${ccb_coder_provider}\",\"planned\":false,\"adapter_suffix\":\"${coder_script_suffix}\"}"
      fi
    fi
    local coder_dispatch_provider="${ccb_coder_provider:-$coder_type}"
    write_event_ext "coder_channel_resolved" "{\"attempt\":${att_num},\"channel\":\"${coder_channel_name}\",\"run_surface\":\"${run_surface}\",\"adapter_suffix\":\"${coder_script_suffix}\",\"provider\":\"${coder_dispatch_provider}\"}"
    write_agent_dispatch_log "coder" "executor" "$coder_channel_name" "$coder_script" "$ifile" "$coder_session_id" "$coder_req_code" "$coder_dispatch_provider" "coder_execution"
    # timeout
    local tout=""
    command -v timeout >/dev/null 2>&1 && tout="timeout"
    [ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"
    if [ "$coder_script_suffix" = "ccb" ]; then
      if [ -n "$tout" ]; then
        set +e; $tout "$coder_timeout" bash "$coder_script" --session-id "$coder_session_id" --req-code "$coder_req_code" "$TASK_JSON" "$att_dir" "$wt" "$ifile" ${ccb_coder_provider:+"$ccb_coder_provider"}; coder_rc=$?; set -e
      else
        set +e; bash "$coder_script" --session-id "$coder_session_id" --req-code "$coder_req_code" "$TASK_JSON" "$att_dir" "$wt" "$ifile" ${ccb_coder_provider:+"$ccb_coder_provider"}; coder_rc=$?; set -e
      fi
    elif [ "$coder_script_suffix" = "bridge" ]; then
      if [ -n "$tout" ]; then
        set +e; $tout "$coder_timeout" bash "$coder_script" --session-id "$coder_session_id" "$TASK_JSON" "$att_dir" "$wt" "$ifile"; coder_rc=$?; set -e
      else
        set +e; bash "$coder_script" --session-id "$coder_session_id" "$TASK_JSON" "$att_dir" "$wt" "$ifile"; coder_rc=$?; set -e
      fi
    else
      if [ -n "$tout" ]; then
        set +e; $tout "$coder_timeout" bash "$coder_script" "$TASK_JSON" "$att_dir" "$wt" "$ifile" ${ccb_coder_provider:+"$ccb_coder_provider"}; coder_rc=$?; set -e
      else
        set +e; bash "$coder_script" "$TASK_JSON" "$att_dir" "$wt" "$ifile" ${ccb_coder_provider:+"$ccb_coder_provider"}; coder_rc=$?; set -e
      fi
    fi
    local c_e_epoch; c_e_epoch=$(date +%s)
    local c_secs=$(( c_e_epoch - c_s_epoch ))
    # rc=124 (timeout) and rc=195 (auth) take precedence over rc.txt
    if [ "$coder_rc" != "124" ] && [ "$coder_rc" != "195" ]; then
      [ -f "${att_dir}/coder/rc.txt" ] && coder_rc=$(cat "${att_dir}/coder/rc.txt" 2>/dev/null || echo "$coder_rc")
    fi
    [ ! -f "${att_dir}/coder/rc.txt" ] && echo "$coder_rc" > "${att_dir}/coder/rc.txt"
    if [ ! -s "${att_dir}/coder/stdout.log" ] && [ -f "${att_dir}/coder/run.log" ]; then
      cp "${att_dir}/coder/run.log" "${att_dir}/coder/stdout.log" 2>/dev/null || true
    fi
    if [ "$coder_script_suffix" = "ccb" ] && [ -n "$coder_req_code" ]; then
      extract_req_payload_segment "$coder_req_code" "${att_dir}/coder/stdout.log" "${att_dir}/coder/req_payload.txt" "executor"
    fi
    [ -f "${att_dir}/coder/stderr.log" ] || : > "${att_dir}/coder/stderr.log"
    local coder_response_path=""
    [ -f "${att_dir}/coder/req_payload.txt" ] && coder_response_path="${att_dir}/coder/req_payload.txt"
    [ -z "$coder_response_path" ] && [ -f "${att_dir}/coder/stdout.log" ] && coder_response_path="${att_dir}/coder/stdout.log"
    [ -z "$coder_response_path" ] && [ -f "${att_dir}/coder/run.log" ] && coder_response_path="${att_dir}/coder/run.log"
    write_agent_response_log "coder" "executor" "$coder_channel_name" "$coder_script" "$coder_response_path" "$coder_session_id" "$coder_req_code" "$coder_dispatch_provider" "coordinator" "$coder_rc"
    write_commands_log "$att_num" "coder:${coder_type}" "$coder_rc" "$c_secs" "$cmd_log"
  fi
  c_fin=$(now_iso)
  write_event "$att_num" "CODER_FINISHED" "rc=${coder_rc}" "$att_dir" "$wt"

  # If coder wrote knowledge_entries in worktree, copy to attempt_dir for merge into final_summary later
  if [ -f "${wt}/.rdloop/knowledge_entries.json" ]; then
    cp "${wt}/.rdloop/knowledge_entries.json" "${att_dir}/coder/knowledge_entries.json" 2>/dev/null || true
  fi

  # rc=127 with ccb adapter: CCB daemon unavailable → PAUSED_CODER_CCB_UNAVAILABLE
  if [ "$coder_rc" = "127" ] && [ "$coder_script_suffix" = "ccb" ]; then
    write_event "$att_num" "STATE_CHANGED" "PAUSED_CODER_CCB_UNAVAILABLE (CCB daemon not reachable)"
    enter_paused "PAUSED_CODER_CCB_UNAVAILABLE" \
      "CCB daemon unavailable (cask/gask ping failed). Start CCB in tmux or ensure cask/gask is running." \
      '["Start CCB (cask or gask) and ensure it responds to ping; then use Run Next to retry."]' \
      "NEED_USER_INPUT" "" "true"
    NORMAL_EXIT=1; exit 0
  fi

  # rc=195: coder auth failure → decision_table
  if [ "$coder_rc" = "195" ]; then
    update_consecutive_timeout "coder" "$coder_rc"
    local dj; dj=$(call_decision_table "coder" 195 "AUTH")
    act_on_decision "$dj" "" "$att_num" "$max_att"
    # act_on_decision exits for PAUSED; won't reach here
  fi

  # rc=124: coder timeout → decision_table
  if [ "$coder_rc" = "124" ]; then
    update_consecutive_timeout "coder" "$coder_rc"
    local dj; dj=$(call_decision_table "coder" 124 "TIMEOUT")
    act_on_decision "$dj" "" "$att_num" "$max_att"
  fi

  # rc=206: solo coder produced no observable output progress for too long
  if [ "$coder_rc" = "206" ]; then
    write_event "$att_num" "STATE_CHANGED" "PAUSED_CODER_NO_PROGRESS (solo bridge no-output stall)"
    enter_paused "PAUSED_CODER_NO_PROGRESS" \
      "Coder stalled with no output progress. Paused early instead of waiting full timeout." \
      "[\"Check out/<task_id>/attempt_*/coder/stderr.log for the no-output threshold details, verify bridge/provider connectivity, then use Run Next to retry.\"]" \
      "NEED_USER_INPUT" "" "true"
    NORMAL_EXIT=1; exit 0
  fi

  # Coder did not complete successfully (any other non-zero): do not run test or judge — no valid coder output to evaluate
  if [ "$coder_rc" != "0" ]; then
    log_info "Coder did not complete (rc=${coder_rc}); skipping test and judge"
    write_event "$att_num" "CODER_FAILED_SKIP_JUDGE" "rc=${coder_rc} — no test/judge run"
    enter_paused "PAUSED_CODER_FAILED" \
      "Coder did not complete (rc=${coder_rc}). Test and judge were not run." \
      "[\"Coder step failed (rc=${coder_rc}). Check coder/run.log and adapter (cliapi gateway); then use Run Next to retry.\"]" \
      "NEED_USER_INPUT" "" "true"
    NORMAL_EXIT=1; exit 0
  fi

  # Keep observability for tiny coder output, but do not pause/skip pipeline.
  # Some valid implementations can produce compact logs.
  local coder_log="${att_dir}/coder/run.log"
  [ ! -f "$coder_log" ] && coder_log="${att_dir}/coder/stdout.log"
  local coder_log_size=0
  [ -f "$coder_log" ] && coder_log_size=$(wc -c < "$coder_log" 2>/dev/null || echo "0")
  if [ "$coder_log_size" -lt 600 ] 2>/dev/null; then
    log_info "Coder run.log is small (${coder_log_size} bytes); continuing to test/judge"
    write_event "$att_num" "CODER_OUTPUT_SMALL_CONTINUE" "run.log size=${coder_log_size}"
  fi

  check_control_pause "AFTER_CODER"
  check_control_pause "BEFORE_TEST"

  # ---- TEST (only for engineering_impl; other task types skip test) ----
  local t_start t_fin test_rc
  t_start=$(now_iso)
  if [ -n "$is_eng_impl" ]; then
    write_event "$att_num" "TEST_STARTED" "cmd=${test_cmd}" "$att_dir" "$wt"
    local t_s_epoch; t_s_epoch=$(date +%s)

    local tout=""
    command -v timeout >/dev/null 2>&1 && tout="timeout"
    [ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"

    set +e
    if [ -n "$tout" ]; then
      $tout "$test_timeout" bash -lc "cd '${wt}' && ${test_cmd}" > "${att_dir}/test/stdout.log" 2>&1
      test_rc=$?
    else
      bash -lc "cd '${wt}' && ${test_cmd}" > "${att_dir}/test/stdout.log" 2>&1
      test_rc=$?
    fi
    set -e
    [ "$test_rc" = "124" ] && echo "TIMEOUT after ${test_timeout}s" >> "${att_dir}/test/stdout.log"

    local t_e_epoch; t_e_epoch=$(date +%s)
    local t_secs=$(( t_e_epoch - t_s_epoch ))
    echo "$test_rc" > "${att_dir}/test/rc.txt"
    t_fin=$(now_iso)
    write_event "$att_num" "TEST_FINISHED" "rc=${test_rc}" "$att_dir" "$wt"
    write_commands_log "$att_num" "test:${test_cmd}" "$test_rc" "$t_secs" "$cmd_log"

    # rc=124: test timeout → decision_table (consume=true for test)
    if [ "$test_rc" = "124" ]; then
      update_consecutive_timeout "test" "$test_rc"
      local dj; dj=$(call_decision_table "test" 124 "TIMEOUT")
      act_on_decision "$dj" "" "$att_num" "$max_att"
    fi
  else
    echo "0" > "${att_dir}/test/rc.txt"
    echo "(test skipped for non-engineering_impl task_type)" > "${att_dir}/test/stdout.log"
    test_rc=0
    t_fin=$(now_iso)
    write_event "$att_num" "TEST_FINISHED" "rc=0 skipped (task_type=${task_type})" "$att_dir" "$wt"
    write_commands_log "$att_num" "test:skipped" "0" "0" "$cmd_log"
  fi

  check_control_pause "AFTER_TEST"

  # ---- GIT EVIDENCE ----
  local git_diff_patch_rc=0 git_diff_stat_rc=0 git_head_rc=0
  set +e
  git -C "$wt" diff "${base_ref}...HEAD" > "${att_dir}/diff.patch" 2>/dev/null
  git_diff_patch_rc=$?
  git -C "$wt" diff --stat "${base_ref}...HEAD" > "${att_dir}/diff.stat" 2>/dev/null
  git_diff_stat_rc=$?
  git -C "$wt" rev-parse HEAD > "${att_dir}/head_commit.txt" 2>/dev/null
  git_head_rc=$?
  set -e
  [ "$git_diff_patch_rc" = "0" ] || echo "" > "${att_dir}/diff.patch"
  [ "$git_diff_stat_rc" = "0" ] || echo "" > "${att_dir}/diff.stat"
  [ "$git_head_rc" = "0" ] || echo "" > "${att_dir}/head_commit.txt"
  local git_evidence_rc=0
  [ "$git_head_rc" = "0" ] || git_evidence_rc=1
  write_coordinator_simple_event "git_evidence_collected" "git" "internal" "evidence_bundle" "diff_patch_rc=${git_diff_patch_rc} diff_stat_rc=${git_diff_stat_rc} head_rc=${git_head_rc}" "git diff; git diff --stat; git rev-parse HEAD" "$git_evidence_rc" "$repo" "$wt" "${att_dir}/head_commit.txt"
  local hc; hc=$(cat "${att_dir}/head_commit.txt" 2>/dev/null || echo "")

  # Guardrails
  check_guardrails "$wt" "$base_ref"

  # ---- EVIDENCE BUNDLE ----
  local tlog_tail=""
  [ -f "${att_dir}/test/stdout.log" ] && tlog_tail=$(tail -n "$TEST_LOG_TAIL_LINES" "${att_dir}/test/stdout.log" 2>/dev/null || echo "")

  local cmds_json="[]"
  if [ -f "$cmd_log" ]; then
    cmds_json=$(python3 -c "
import json,sys
cs=[]
with open(sys.argv[1]) as f:
  for l in f:
    l=l.strip()
    if l:
      try: c=json.loads(l); cs.append({'cmd':c.get('cmd',''),'rc':c.get('rc',0),'seconds':c.get('seconds',0)})
      except: pass
print(json.dumps(cs))
" "$cmd_log" 2>/dev/null || echo "[]")
  fi

  write_evidence "$att_dir" "$att_num" "$wt" "$hc" "$test_cmd" "$test_rc" "$tlog_tail" "$cmds_json" "${att_dir}/coder/stdout.log" "$task_code"
  write_event "$att_num" "EVIDENCE_PACKED" "evidence.json written" "$att_dir" "$wt"

  check_control_pause "BEFORE_JUDGE"

  # ---- JUDGE ----
  local j_start j_fin judge_rc=0 j_retries=0
  j_start=$(now_iso)
  write_event "$att_num" "JUDGE_STARTED" "judge=${judge_type}" "$att_dir" "$wt"

  # Check codex CLI for codex-cli / codex_cli
  if [ "$judge_type" = "codex_cli" ] || [ "$judge_type" = "codex-cli" ]; then
    local cxcmd; cxcmd=$(json_read "$TASK_JSON" "codex_cmd" "codex")
    if ! command -v "$cxcmd" >/dev/null 2>&1; then
      write_event "$att_num" "JUDGE_FINISHED" "rc=127 codex missing" "$att_dir" "$wt"
      enter_paused "PAUSED_CODEX_MISSING" "codex CLI not found (${cxcmd})" \
        "[\"codex CLI missing, please install/login\"]"
      NORMAL_EXIT=1; exit 0
    fi
  fi

  # Skip judge entirely if judge_type is "none" (solo mode, or judge_enabled=false)
  local skip_judge=0
  if [ "$judge_type" = "none" ]; then
    mkdir -p "${att_dir}/judge"
    local coder_rc_val; coder_rc_val=$(cat "${att_dir}/coder/rc.txt" 2>/dev/null || echo "1")
    if [ "$coder_rc_val" = "0" ]; then
      cat > "${att_dir}/judge/verdict.json" <<'EOF'
{
  "schema_version": "v1",
  "decision": "PASS",
  "reasons": ["Solo mode auto-pass (coder exit 0)"],
  "next_instructions": "",
  "questions_for_user": []
}
EOF
    elif [ "$coder_rc_val" = "2" ]; then
      cat > "${att_dir}/judge/verdict.json" <<'EOF'
{
  "schema_version": "v1",
  "decision": "NEED_USER_INPUT",
  "reasons": ["Agent requested user input"],
  "next_instructions": "",
  "questions_for_user": ["Please provide the requested clarification and run next attempt."]
}
EOF
    else
      cat > "${att_dir}/judge/verdict.json" <<EOF
{
  "schema_version": "v1",
  "decision": "FAIL",
  "reasons": ["Coder exited with non-zero: ${coder_rc_val}"],
  "next_instructions": "Fix the coder failure (rc=${coder_rc_val}), then rerun the task.",
  "questions_for_user": []
}
EOF
    fi
    echo "0" > "${att_dir}/judge/rc.txt"
    log_info "Judge skipped (judge_type=none), auto-verdict based on coder rc=${coder_rc_val}"
    local auto_judge_payload
    auto_judge_payload=$(python3 - "$coder_rc_val" "${att_dir}/judge/verdict.json" <<'PY'
import json, sys
coder_rc, verdict_path = sys.argv[1:3]
print(json.dumps({
  "event_type": "JUDGE_SKIPPED_AUTO_VERDICT",
  "triggered_by": {"actor": "coordinator", "source": "run_attempt"},
  "channel": {"name": "local", "direction": "internal"},
  "delivery": {"from": "coordinator", "to": "reviewer", "content_path": verdict_path},
  "executed_by": {"component": "run_task.sh", "function": "run_attempt"},
  "next": {"path": verdict_path},
  "details": {"coder_rc": int(coder_rc) if str(coder_rc).isdigit() else coder_rc}
}))
PY
)
    write_task_lifecycle_log "judge_skipped_auto_verdict" "$auto_judge_payload"
    skip_judge=1
  fi

  if [ "$skip_judge" = "0" ]; then
  local judge_script="${LIB_DIR}/call_judge_${judge_script_suffix}.sh"
  if [ ! -f "$judge_script" ]; then
    log_error "Judge script not found: ${judge_script}"
    enter_paused "PAUSED_JUDGE_INVALID" "judge script not found: ${judge_script}" \
      "[\"Judge adapter ${judge_type} not found.\"]"
    NORMAL_EXIT=1; exit 0
  fi

  # Judge prompt: prefer task_type-specific file (e.g. judge.prompt.requirements_doc.md), fallback to judge.prompt.md
  local task_type_tt; task_type_tt=$(json_read "$TASK_JSON" "task_type" "")
  local jprompt="${PROMPTS_DIR}/judge.prompt.md"
  if [ -n "$task_type_tt" ] && [ -f "${PROMPTS_DIR}/judge.prompt.${task_type_tt}.md" ]; then
    jprompt="${PROMPTS_DIR}/judge.prompt.${task_type_tt}.md"
  fi
  cp "$jprompt" "${att_dir}/judge/prompt.txt" 2>/dev/null || : > "${att_dir}/judge/prompt.txt"
  export JUDGE_PROMPT_PATH="${att_dir}/judge/prompt.txt"
  local jrequest="${att_dir}/judge/request.txt"
  {
    [ -f "$jprompt" ] && cat "$jprompt"
    printf '\n---\n'
    [ -f "${att_dir}/evidence.json" ] && cat "${att_dir}/evidence.json"
  } > "$jrequest"
  export JUDGE_REQUEST_PATH="$jrequest"
  export JUDGE_STDOUT_PATH="${att_dir}/judge/stdout.log"
  export JUDGE_STDERR_PATH="${att_dir}/judge/stderr.log"
  export JUDGE_RC_PATH="${att_dir}/judge/rc.txt"
  export JUDGE_VERDICT_PATH="${att_dir}/judge/verdict.json"
  local jvalid=0

  # B4-7: run.log records Judge temperature=0 (deterministic output)
  log_info "Judge run with temperature=0 (B4-7)"
  local judge_channel_name="" judge_session_id="" judge_req_code=""
  judge_channel_name=$(channel_name_for_adapter_suffix "$judge_script_suffix")
  if [ "$judge_channel_name" = "ccb" ] || [ "$judge_channel_name" = "bridge" ]; then
    judge_session_id="$("$SESSION_ID_GEN" "$TASK_ID" "reviewer" "$att_num")"
    write_event_ext "session_id_assigned" "{\"session_id\":\"${judge_session_id}\",\"role\":\"reviewer\",\"attempt\":${att_num}}"
    if [ "$judge_channel_name" = "ccb" ]; then
      judge_req_code="$("$REQ_CODE_GEN" "$judge_session_id")"
      write_event_ext "req_code_assigned" "{\"session_id\":\"${judge_session_id}\",\"req_code\":\"${judge_req_code}\",\"role\":\"reviewer\",\"attempt\":${att_num}}"
      write_event_ext "ccb_call" "{\"session_id\":\"${judge_session_id}\",\"req_code\":\"${judge_req_code}\",\"role\":\"reviewer\",\"provider\":\"${ccb_judge_provider}\",\"planned\":false,\"adapter_suffix\":\"${judge_script_suffix}\"}"
    else
      write_event_ext "bridge_call" "{\"session_id\":\"${judge_session_id}\",\"role\":\"reviewer\",\"provider\":\"${ccb_judge_provider}\",\"planned\":false,\"adapter_suffix\":\"${judge_script_suffix}\"}"
    fi
  fi
  local judge_dispatch_provider="${ccb_judge_provider:-$judge_type}"
  write_event_ext "judge_channel_resolved" "{\"attempt\":${att_num},\"channel\":\"${judge_channel_name}\",\"run_surface\":\"${run_surface}\",\"adapter_suffix\":\"${judge_script_suffix}\",\"provider\":\"${judge_dispatch_provider}\"}"
  write_agent_dispatch_log "judge" "reviewer" "$judge_channel_name" "$judge_script" "$jrequest" "$judge_session_id" "$judge_req_code" "$judge_dispatch_provider" "judge_execution"

  while [ "$j_retries" -le "$JUDGE_MAX_RETRIES" ]; do
    local j_s_e; j_s_e=$(date +%s)
    local tout=""
    command -v timeout >/dev/null 2>&1 && tout="timeout"
    [ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"
    set +e
    if [ "$judge_script_suffix" = "ccb" ]; then
      if [ -n "$tout" ]; then
        $tout "$judge_timeout" bash "$judge_script" --session-id "$judge_session_id" --req-code "$judge_req_code" "$TASK_JSON" "${att_dir}/evidence.json" "$att_dir" "$jprompt" ${ccb_judge_provider:+"$ccb_judge_provider"}
        judge_rc=$?
      else
        bash "$judge_script" --session-id "$judge_session_id" --req-code "$judge_req_code" "$TASK_JSON" "${att_dir}/evidence.json" "$att_dir" "$jprompt" ${ccb_judge_provider:+"$ccb_judge_provider"}
        judge_rc=$?
      fi
    elif [ "$judge_script_suffix" = "bridge" ]; then
      if [ -n "$tout" ]; then
        $tout "$judge_timeout" bash "$judge_script" --session-id "$judge_session_id" "$TASK_JSON" "${att_dir}/evidence.json" "$att_dir" "$jprompt"
        judge_rc=$?
      else
        bash "$judge_script" --session-id "$judge_session_id" "$TASK_JSON" "${att_dir}/evidence.json" "$att_dir" "$jprompt"
        judge_rc=$?
      fi
    else
      if [ -n "$tout" ]; then
        $tout "$judge_timeout" bash "$judge_script" "$TASK_JSON" "${att_dir}/evidence.json" "$att_dir" "$jprompt" ${ccb_judge_provider:+"$ccb_judge_provider"}
        judge_rc=$?
      else
        bash "$judge_script" "$TASK_JSON" "${att_dir}/evidence.json" "$att_dir" "$jprompt" ${ccb_judge_provider:+"$ccb_judge_provider"}
        judge_rc=$?
      fi
    fi
    set -e
    [ ! -f "${att_dir}/judge/rc.txt" ] && echo "$judge_rc" > "${att_dir}/judge/rc.txt"
    local j_e_e; j_e_e=$(date +%s)
    local j_secs=$(( j_e_e - j_s_e ))
    write_commands_log "$att_num" "judge:${judge_type}" "$judge_rc" "$j_secs" "$cmd_log"
    if [ ! -s "${att_dir}/judge/stdout.log" ] && [ -f "${att_dir}/judge/run.log" ]; then
      cp "${att_dir}/judge/run.log" "${att_dir}/judge/stdout.log" 2>/dev/null || true
    fi
    if [ "$judge_script_suffix" = "ccb" ] && [ -n "$judge_req_code" ]; then
      extract_req_payload_segment "$judge_req_code" "${att_dir}/judge/stdout.log" "${att_dir}/judge/req_payload.txt" "reviewer"
    fi
    [ -f "${att_dir}/judge/stderr.log" ] || : > "${att_dir}/judge/stderr.log"

    if [ "$judge_rc" = "0" ] && [ -f "${att_dir}/judge/verdict.json" ]; then
      set +e
      python3 "${LIB_DIR}/validate_verdict.py" "${att_dir}/judge/verdict.json" 2>/dev/null
      local vrc=$?
      set -e
      # exit 0=valid, exit 2=K5-3 inconsistent (structurally valid, flagged in DECISION)
      if [ "$vrc" = "0" ] || [ "$vrc" = "2" ]; then jvalid=1; break; fi
      log_info "Verdict invalid (retry $((j_retries+1)))"
    else
      log_info "Judge failed rc=${judge_rc} (retry $((j_retries+1)))"
    fi
    j_retries=$(( j_retries + 1 ))
  done

  local judge_response_path=""
  [ -f "${att_dir}/judge/verdict.json" ] && judge_response_path="${att_dir}/judge/verdict.json"
  [ -z "$judge_response_path" ] && [ -f "${att_dir}/judge/req_payload.txt" ] && judge_response_path="${att_dir}/judge/req_payload.txt"
  [ -z "$judge_response_path" ] && [ -f "${att_dir}/judge/stdout.log" ] && judge_response_path="${att_dir}/judge/stdout.log"
  [ -z "$judge_response_path" ] && [ -f "${att_dir}/judge/run.log" ] && judge_response_path="${att_dir}/judge/run.log"
  write_agent_response_log "judge" "reviewer" "$judge_channel_name" "$judge_script" "$judge_response_path" "$judge_session_id" "$judge_req_code" "$judge_dispatch_provider" "coordinator" "$judge_rc"

  j_fin=$(now_iso)
  write_event "$att_num" "JUDGE_FINISHED" "rc=${judge_rc} valid=${jvalid} retries=${j_retries}" "$att_dir" "$wt"

  if [ "$jvalid" != "1" ]; then
    local att_e; att_e=$(date +%s)
    local att_s_e; att_s_e=$(epoch_from_iso "$att_start")
    local el=$(( att_e - att_s_e ))
    write_metrics "$att_dir" "$att_num" "$el" "$j_retries" "$coder_rc" "$test_rc" "$judge_rc" \
      "$att_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" "[]"
    # Classify via decision_table
    local err_cls="VERDICT_INVALID"
    [ "$judge_rc" = "124" ] && err_cls="TIMEOUT"
    # Log verdict validation details when invalid for debugging
    if [ "$err_cls" = "VERDICT_INVALID" ] && [ -f "${att_dir}/judge/verdict.json" ]; then
      local val_err; val_err=$(python3 "${LIB_DIR}/validate_verdict.py" "${att_dir}/judge/verdict.json" 2>&1) || true
      [ -n "$val_err" ] && echo "$val_err" | while read -r line; do log_info "[validate_verdict] $line"; done
    fi
    log_info "Check judge output: ${att_dir}/judge/verdict.json and ${att_dir}/judge/extract_err.log (or codex_stderr.log / cursor_stderr.log)"
    update_consecutive_timeout "judge" "$judge_rc"
    local dj; dj=$(call_decision_table "judge" "$judge_rc" "$err_cls")
    act_on_decision "$dj" "" "$att_num" "$max_att"
    # act_on_decision exits for PAUSED/FAILED; should not reach here
    NORMAL_EXIT=1; exit 0
  fi

  fi  # end skip_judge=0

  check_control_pause "AFTER_JUDGE"

  # ---- B4-2/B4-6: Inject traceability fields into verdict.json ----
  inject_verdict_traceability "${att_dir}/judge/verdict.json" "$TASK_JSON" || true

  # ---- DECISION (via decision_table) ----
  # 1. Run validate_verdict.py to check structural + K5-3 consistency
  local validate_rc=0
  set +e
  python3 "${LIB_DIR}/validate_verdict.py" "${att_dir}/judge/verdict.json" 2>/dev/null
  validate_rc=$?
  set -e

  local error_class=""
  if [ "$validate_rc" = "1" ]; then
    error_class="VERDICT_INVALID"
    log_info "Verdict structurally invalid (validate_verdict exit 1)"
    local val_err; val_err=$(python3 "${LIB_DIR}/validate_verdict.py" "${att_dir}/judge/verdict.json" 2>&1) || true
    [ -n "$val_err" ] && echo "$val_err" | while read -r line; do log_info "[validate_verdict] $line"; done
    log_info "Check judge output: ${att_dir}/judge/verdict.json and ${att_dir}/judge/extract_err.log (or codex_stderr.log / cursor_stderr.log)"
  elif [ "$validate_rc" = "2" ]; then
    error_class="VERDICT_INCONSISTENT"
    log_info "Verdict K5-3 inconsistent (validate_verdict exit 2)"
  fi

  # 2. Read decision and detect B4 mode
  local decision; decision=$(json_read "${att_dir}/judge/verdict.json" "decision" "FAIL")
  decision=$(echo "$decision" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  case "$decision" in
    PASS|FAIL|NEED_USER_INPUT) ;;
    *) log_info "Verdict decision '${decision}' not in PASS/FAIL/NEED_USER_INPUT; normalizing to FAIL"
       decision="FAIL" ;;
  esac
  local verdict_gated="false"
  local thresholds_pass="true"
  local final_score_for_summary=""

  local has_task_type; has_task_type=$(json_read "${att_dir}/judge/verdict.json" "task_type" "")
  local has_scores; has_scores=$(json_read "${att_dir}/judge/verdict.json" "scores" "")
  if [ -n "$has_task_type" ] && [ -n "$has_scores" ] && [ "$has_scores" != "{}" ]; then
    # B4 mode: read gated and final_score directly from verdict
    verdict_gated=$(json_read "${att_dir}/judge/verdict.json" "gated" "false")
    local final_score; final_score=$(json_read "${att_dir}/judge/verdict.json" "final_score_0_5" "0")
    final_score_for_summary=$(json_read "${att_dir}/judge/verdict.json" "final_score_0_100" "")
    thresholds_pass="true"
    # Check thresholds from task.json or rubric defaults
    local min_threshold; min_threshold=$(json_read "$TASK_JSON" "rubric_thresholds.min_score" "")
    if [ -n "$min_threshold" ]; then
      python3 -c "exit(0 if float('$final_score') >= float('$min_threshold') else 1)" 2>/dev/null || thresholds_pass="false"
    fi
    log_info "B4 verdict: task_type=${has_task_type} gated=${verdict_gated} final_0_5=${final_score} thresholds_pass=${thresholds_pass}"
  else
    # Legacy v1 mode: keep existing score/score_gate/score_threshold logic
    local score; score=$(json_read "${att_dir}/judge/verdict.json" "score" "")
    local gated_threshold; gated_threshold=$(json_read "$TASK_JSON" "score_gate" "")
    local min_threshold; min_threshold=$(json_read "$TASK_JSON" "score_threshold" "")
    if [ -n "$gated_threshold" ] && [ -n "$score" ]; then
      [ "$score" -lt "$gated_threshold" ] 2>/dev/null && verdict_gated="true"
    fi
    if [ -n "$min_threshold" ] && [ -n "$score" ]; then
      [ "$score" -lt "$min_threshold" ] 2>/dev/null && thresholds_pass="false"
    fi
  fi

  # If validate_verdict returned an error, route through decision_table with error_class
  if [ -n "$error_class" ]; then
    local att_e; att_e=$(date +%s)
    local att_s_e; att_s_e=$(epoch_from_iso "$att_start")
    local el=$(( att_e - att_s_e ))
    write_metrics "$att_dir" "$att_num" "$el" "$j_retries" "$coder_rc" "$test_rc" "$judge_rc" \
      "$att_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" "[]"
    update_consecutive_timeout "judge" "$judge_rc"
    local dj; dj=$(call_decision_table "judge" "$judge_rc" "$error_class" "$decision" "$verdict_gated" "$thresholds_pass")
    act_on_decision "$dj" "$hc" "$att_num" "$max_att"
    NORMAL_EXIT=1; exit 0
  fi

  local att_e; att_e=$(date +%s)
  local att_s_e; att_s_e=$(epoch_from_iso "$att_start")
  local el=$(( att_e - att_s_e ))
  write_metrics "$att_dir" "$att_num" "$el" "$j_retries" "$coder_rc" "$test_rc" "$judge_rc" \
    "$att_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" "[]"

  log_info "Attempt ${att_num} verdict: ${decision}"

  # Reset consecutive timeout on successful judge completion
  update_consecutive_timeout "judge" "$judge_rc"

  # K8-4: Copy artifacts from worktree to out/<task_id>/artifacts/ when judge will PASS
  if [ "$decision" = "PASS" ] && [ "$verdict_gated" = "false" ] && [ "$thresholds_pass" = "true" ]; then
    copy_artifacts "$wt" "$att_num"
  fi

  local dj; dj=$(call_decision_table "judge" "$judge_rc" "" "$decision" "$verdict_gated" "$thresholds_pass")
  act_on_decision "$dj" "$hc" "$att_num" "$max_att"
}

##############################################################################
# 10b. v5.1 role-based flow (task_type + launch_mode)
##############################################################################
is_v51_role_task() {
  local tt=""
  [ -f "${TASK_JSON:-}" ] && tt=$(json_read "$TASK_JSON" "task_type" "")
  case "$tt" in
    copywriting|solo|multi_agent) return 0 ;;
    *) return 1 ;;
  esac
}

is_v51_signature_task() {
  local sv lm ll tt
  sv=$(json_read "$TASK_JSON" "schema_version" "")
  lm=$(json_read "$TASK_JSON" "launch_mode" "")
  ll=$(json_read "$TASK_JSON" "launch_mode_locked" "")
  tt=$(json_read "$TASK_JSON" "task_type" "")
  case "$tt" in
    copywriting|solo|multi_agent) return 0 ;;
  esac
  [ "$sv" = "v51" ] && return 0
  [ -n "$lm" ] && return 0
  [ -n "$ll" ] && return 0
  return 1
}

task_json_set_top_field() {
  local field="$1" value="$2" vtype="${3:-string}"
  python3 - "$TASK_JSON" "$field" "$value" "$vtype" <<'PY'
import json, os, sys
fpath, field, value, vtype = sys.argv[1:5]
with open(fpath, encoding="utf-8") as f:
    d = json.load(f)
if vtype == "bool":
    d[field] = str(value).lower() == "true"
elif vtype == "int":
    d[field] = int(value)
else:
    d[field] = value
tmp = fpath + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, fpath)
PY
}

write_event_ext() {
  local etype="$1" payload_json="${2-}"
  [ -z "$payload_json" ] && payload_json='{}'
  python3 - "$TASK_DIR" "$TASK_ID" "$etype" "$payload_json" <<'PY' \
  | python3 "$ATOMIC_WRITE" --append "${TASK_DIR}/events.jsonl" -
import datetime, json, os, sys
task_dir, task_id, etype, payload_raw = sys.argv[1:5]
payload = {}
try:
    payload = json.loads(payload_raw)
except Exception:
    payload = {}
event = {
    "ts": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "task_id": task_id,
    "type": etype
}
event.update(payload)
print(json.dumps(event, ensure_ascii=False))
PY

  local lifecycle_payload
  lifecycle_payload=$(python3 - "$etype" "$payload_json" <<'PY'
import json, sys
etype, payload_raw = sys.argv[1:3]
try:
    payload = json.loads(payload_raw) if payload_raw else {}
except Exception:
    payload = {}

channel_name = "events.jsonl"
if etype == "ccb_call":
    channel_name = "ccb"
elif etype == "bridge_call":
    channel_name = "bridge"
elif etype in ("role_action_started", "coder_channel_resolved", "judge_channel_resolved"):
    pch = str(payload.get("channel", "")).strip().lower()
    if pch in ("ccb", "bridge", "local"):
        channel_name = pch
elif etype == "knowledge_inject":
    channel_name = "knowledge"
elif etype in ("handoff_pointer_written", "role_transition"):
    channel_name = "handoff"
elif etype in ("session_id_assigned", "req_code_assigned"):
    channel_name = "session"

delivery = {}
for k in ("from", "to", "role", "session_id", "req_code", "provider", "from_role", "to_role", "from_session_id"):
    if k in payload and payload.get(k) not in (None, ""):
        delivery[k] = payload.get(k)
if "path" in payload and payload.get("path"):
    delivery["content_path"] = payload.get("path")
if "handoff_path" in payload and payload.get("handoff_path"):
    delivery["content_path"] = payload.get("handoff_path")
if "req_code" in payload and payload.get("req_code"):
    delivery["req_code"] = payload.get("req_code")

next_hop = {}
if payload.get("to"):
    next_hop["to"] = payload.get("to")
if payload.get("to_role"):
    next_hop["to"] = payload.get("to_role")
if payload.get("session_id"):
    next_hop["session_id"] = payload.get("session_id")
if payload.get("handoff_path"):
    next_hop["handoff_path"] = payload.get("handoff_path")

details = dict(payload)
if "path" in details and details["path"]:
    details["content_path"] = details["path"]
if "handoff_path" in details and details["handoff_path"]:
    details["content_path"] = details["handoff_path"]

print(json.dumps({
  "event_type": etype,
  "triggered_by": {"actor": "coordinator", "source": "run_task.sh"},
  "channel": {"name": channel_name, "direction": "internal"},
  "delivery": delivery,
  "executed_by": {"component": "run_task.sh", "function": "write_event_ext"},
  "next": next_hop,
  "details": details
}))
PY
)
  write_task_lifecycle_log "$etype" "$lifecycle_payload"
}

upsert_task_state_pane() {
  local role="$1" pane_idx="$2" status="$3" session_id="$4" launch_mode="$5"
  python3 - "$TASK_DIR" "$role" "$pane_idx" "$status" "$session_id" "$launch_mode" <<'PY'
import json, os, sys
task_dir, role, pane_idx, status, session_id, launch_mode = sys.argv[1:7]
state_path = os.path.join(task_dir, "task_state.json")
data = {"sessions": {}, "panes": []}
if os.path.exists(state_path):
    try:
        with open(state_path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {"sessions": {}, "panes": []}
sessions = data.get("sessions") or {}
panes = data.get("panes") or []
pane_key = f"{role}-{int(pane_idx):02d}"
sessions[pane_key] = session_id
found = False
for pane in panes:
    if pane.get("pane") == pane_key:
        pane["role"] = role
        pane["status"] = status
        pane["session_id"] = session_id
        pane["launch_mode"] = launch_mode
        found = True
        break
if not found:
    panes.append({
        "pane": pane_key,
        "role": role,
        "status": status,
        "session_id": session_id,
        "launch_mode": launch_mode
    })
data["sessions"] = sessions
data["panes"] = panes
tmp = state_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, state_path)
PY
}

get_commit_sha() {
  local repo="$1"
  git -C "$repo" rev-parse HEAD 2>/dev/null || true
}

knowledge_agent_query() {
  local to_role="$1" from_role="${2:-}" from_sid="${3:-}" commit_sha="${4:-}" handoff_path="${5:-}"
  write_event_ext "knowledge_inject" "{\"to_role\":\"${to_role}\",\"from_role\":\"${from_role}\",\"from_session_id\":\"${from_sid}\",\"commit_sha\":\"${commit_sha}\",\"handoff_path\":\"${handoff_path}\"}"
  # v5.1: coordinator-owned context assembly hook. Keep lightweight by default.
  echo ""
}

resolve_provider_for_role() {
  local role="$1" task_type="$2"
  local fallback=""
  fallback=$(json_read "$TASK_JSON" "agent_config.provider" "claude")
  [ -z "$fallback" ] && fallback="claude"
  case "$task_type" in
    solo)
      local p=""
      # v5.1 solo uses one provider; agent_config.provider is the canonical source.
      p=$(json_read "$TASK_JSON" "agent_config.provider" "")
      [ -z "$p" ] && p=$(json_read "$TASK_JSON" "collab_roles.pm" "")
      [ -z "$p" ] && p=$(json_read "$TASK_JSON" "collab_roles.executor" "")
      [ -z "$p" ] && p=$(json_read "$TASK_JSON" "collab_roles.designer" "")
      [ -z "$p" ] && p=$(json_read "$TASK_JSON" "collab_roles.reviewer" "")
      [ -z "$p" ] && p="$fallback"
      echo "$p"
      ;;
    copywriting)
      local p=""
      p=$(json_read "$TASK_JSON" "collab_roles.${role}" "")
      [ -z "$p" ] && p="$fallback"
      echo "$p"
      ;;
    multi_agent)
      local p=""
      p=$(json_read "$TASK_JSON" "collab_roles.${role}" "")
      [ -z "$p" ] && p="$fallback"
      echo "$p"
      ;;
    *)
      echo "$fallback"
      ;;
  esac
}

normalize_provider_v51() {
  local provider="${1:-}"
  provider=$(echo "$provider" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  case "$provider" in
    antigravity|googleantigravity) echo "gemini" ;;
    *) echo "$provider" ;;
  esac
}

resolve_nonvisual_coder_type_v51() {
  local provider
  provider=$(normalize_provider_v51 "${1:-}")
  case "$provider" in
    codex) echo "codex_cli" ;;
    gemini) echo "antigravity-cli" ;;
    cursor) echo "cursor_cli" ;;
    bridge|claude|"") echo "bridge" ;;
    *) echo "bridge" ;;
  esac
}

resolve_nonvisual_judge_type_v51() {
  local provider
  provider=$(normalize_provider_v51 "${1:-}")
  case "$provider" in
    codex) echo "codex_cli" ;;
    gemini) echo "antigravity-cli" ;;
    cursor) echo "cursor_cli" ;;
    bridge|claude|"") echo "bridge" ;;
    *) echo "bridge" ;;
  esac
}

channel_name_for_adapter_suffix() {
  local suffix="${1:-}"
  case "$suffix" in
    ccb) echo "ccb" ;;
    bridge|codex|antigravity|cursor|claude_bridge|opencode|droid) echo "bridge" ;;
    *) echo "local" ;;
  esac
}

resolve_role_adapter_suffix_v51() {
  local provider="${1:-}" launch_mode="${2:-}"
  provider=$(normalize_provider_v51 "$provider")
  if [ "$provider" = "mock" ]; then
    echo "mock"
    return 0
  fi
  if [ "$launch_mode" = "ccb" ]; then
    echo "ccb"
    return 0
  fi
  case "$provider" in
    codex) echo "codex" ;;
    gemini) echo "antigravity" ;;
    cursor) echo "cursor" ;;
    bridge|claude|"") echo "bridge" ;;
    *) echo "bridge" ;;
  esac
}

resolve_launch_mode_v51() {
  local locked launch_mode waited cfg mode_from_cfg
  locked=$(json_read "$TASK_JSON" "launch_mode_locked" "false")
  launch_mode=$(json_read "$TASK_JSON" "launch_mode" "")

  if [ "$locked" = "true" ]; then
    if [ -z "$launch_mode" ]; then
      cfg="${RDLOOP_ROOT}/rdloop.config.json"
      mode_from_cfg=$(json_read "$cfg" "default_launch_mode" "")
      if [ -z "$mode_from_cfg" ]; then
        local rs
        rs=$(json_read "$cfg" "default_run_surface" "")
        case "$rs" in
          visual_ccb) mode_from_cfg="ccb" ;;
          bridge) mode_from_cfg="bridge" ;;
          *) mode_from_cfg="" ;;
        esac
      fi
      case "$mode_from_cfg" in
        ccb|bridge) launch_mode="$mode_from_cfg" ;;
        *) launch_mode="ccb" ;;
      esac
      task_json_set_top_field "launch_mode" "$launch_mode" "string"
    fi
  else
    local wait_max="${RDLOOP_LAUNCH_MODE_WAIT_SECONDS:-60}"
    waited=0
    while [ "$waited" -lt "$wait_max" ]; do
      launch_mode=$(json_read "$TASK_JSON" "launch_mode" "")
      case "$launch_mode" in
        ccb|bridge) break ;;
      esac
      sleep 1
      waited=$((waited + 1))
    done
    case "$launch_mode" in
      ccb|bridge) ;;
      *)
        launch_mode="ccb"
        task_json_set_top_field "launch_mode" "$launch_mode" "string"
        ;;
    esac
  fi

  write_event_ext "launch_mode_selected" "{\"launch_mode\":\"${launch_mode}\",\"locked\":${locked}}"
  echo "$launch_mode"
}

ccb_launch_pane() {
  local role="$1" pane_idx="$2" provider="$3" session_id="$4" _context="$5"
  local req_code=""
  req_code="$("$REQ_CODE_GEN" "$session_id")"
  write_event_ext "session_id_assigned" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"pane_idx\":${pane_idx}}"
  write_event_ext "req_code_assigned" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"req_code\":\"${req_code}\"}"
  upsert_task_state_pane "$role" "$pane_idx" "running" "$session_id" "ccb"
  write_event_ext "role_start" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"launch_mode\":\"ccb\",\"planned\":true}"
  write_event_ext "ccb_call" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"req_code\":\"${req_code}\",\"provider\":\"${provider}\",\"planned\":true}"
}

bridge_launch_pane() {
  local role="$1" pane_idx="$2" provider="$3" session_id="$4" _context="$5"
  write_event_ext "session_id_assigned" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"pane_idx\":${pane_idx}}"
  upsert_task_state_pane "$role" "$pane_idx" "running" "$session_id" "bridge"
  write_event_ext "role_start" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"launch_mode\":\"bridge\",\"planned\":true}"
  write_event_ext "bridge_call" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"provider\":\"${provider}\",\"planned\":true}"
}

build_role_instruction_v51() {
  local role="$1" role_dir="$2" context="$3" task_type="$4" provider="$5"
  local goal acceptance repo_path role_prompt ifile
  goal=$(json_read "$TASK_JSON" "goal" "")
  acceptance=$(json_read "$TASK_JSON" "acceptance" "")
  repo_path=$(json_read "$TASK_JSON" "repo_path" "")
  ifile="${role_dir}/coder/prompt.txt"
  mkdir -p "${role_dir}/coder"

  # §v5.1.4: Use role-specific prompt file if exists, fallback to hardcoded
  local fname="$role"
  [ "$role" = "executor" ] && fname="coder"
  [ "$role" = "reviewer" ] && fname="judge"
  
  # Task-scope override: check out/<task_id>/prompts/ first
  local role_prompt_file="${TASK_DIR}/prompts/${fname}.prompt.md"
  if [ ! -f "$role_prompt_file" ]; then
    # Fallback to global default
    role_prompt_file="${PROMPTS_DIR}/${fname}.prompt.md"
  fi

  if [ -f "$role_prompt_file" ]; then
    role_prompt=$(cat "$role_prompt_file")
  else
    case "$role" in
      pm)
        role_prompt="You are PM. Produce actionable task decomposition and execution notes in .rdloop/pm_notes.md. Do not execute git commands."
        ;;
      designer)
        role_prompt="You are Designer. Produce a concrete design contract in design_contract.md (files, interfaces, and implementation plan)."
        ;;
      *)
        role_prompt="You are ${role}. Follow the task goal and acceptance criteria."
        ;;
    esac
  fi

  {
    echo "=== ROLE ==="
    echo "${role}"
    echo ""
    echo "=== TASK TYPE ==="
    echo "${task_type}"
    echo ""
    echo "=== PROVIDER ==="
    echo "${provider}"
    echo ""
    echo "=== REPO PATH ==="
    echo "${repo_path}"
    echo ""
    echo "=== GOAL ==="
    echo "${goal}"
    echo ""
    echo "=== ACCEPTANCE CRITERIA ==="
    echo "${acceptance}"
    echo ""
    echo "=== ROLE REQUIREMENTS ==="
    echo "${role_prompt}"
    echo ""
    if [ -n "$context" ]; then
      echo "=== KNOWLEDGE CONTEXT ==="
      echo "${context}"
      echo ""
    fi
    echo "Keep the output deterministic and concrete."
  } > "$ifile"

  echo "$ifile"
}

run_role_action_v51() {
  local role="$1" pane_idx="$2" session_id="$3" provider="$4" launch_mode="$5" context="$6" task_type="$7"
  local role_dir role_script role_script_suffix role_channel_name req_code role_rc timeout_s prompt_path
  role_dir="${TASK_DIR}/roles/${role}-$(printf '%02d' "$pane_idx")"
  mkdir -p "${role_dir}/coder"
  prompt_path=$(build_role_instruction_v51 "$role" "$role_dir" "$context" "$task_type" "$provider")
  timeout_s=$(json_read "$TASK_JSON" "role_timeout_seconds" "")
  if [ -z "$timeout_s" ]; then
    timeout_s=$(json_read "$TASK_JSON" "coder_timeout_seconds" "600")
  fi
  # Only apply cap if explicitly set in environment (not a default 180)
  if [ -n "${RDLOOP_ROLE_TIMEOUT_CAP_SECONDS:-}" ]; then
    local role_timeout_cap="$RDLOOP_ROLE_TIMEOUT_CAP_SECONDS"
    if [[ "$timeout_s" =~ ^[0-9]+$ ]] && [[ "$role_timeout_cap" =~ ^[0-9]+$ ]] && [ "$timeout_s" -gt "$role_timeout_cap" ]; then
      timeout_s="$role_timeout_cap"
    fi
  fi

  role_script_suffix=$(resolve_role_adapter_suffix_v51 "$provider" "$launch_mode")
  role_channel_name=$(channel_name_for_adapter_suffix "$role_script_suffix")
  role_script="${LIB_DIR}/call_coder_${role_script_suffix}.sh"
  if [ ! -f "$role_script" ]; then
    enter_paused "PAUSED_ROLE_FAILED" \
      "Role ${role} adapter missing: ${role_script}" \
      "[\"Check coordinator/lib adapters for v5.1 role execution and rerun.\"]" \
      "NEED_USER_INPUT" "" "true"
    NORMAL_EXIT=1; exit 0
  fi

  write_event_ext "role_action_started" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"provider\":\"${provider}\",\"launch_mode\":\"${launch_mode}\",\"channel\":\"${role_channel_name}\",\"adapter_suffix\":\"${role_script_suffix}\",\"script\":\"${role_script}\"}"
  if [ "$role_channel_name" = "ccb" ]; then
    req_code="$("$REQ_CODE_GEN" "$session_id")"
    write_event_ext "req_code_assigned" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"req_code\":\"${req_code}\",\"planned\":false}"
    write_event_ext "ccb_call" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"req_code\":\"${req_code}\",\"provider\":\"${provider}\",\"planned\":false}"
  elif [ "$role_channel_name" = "bridge" ]; then
    write_event_ext "bridge_call" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"provider\":\"${provider}\",\"planned\":false}"
  fi
  write_agent_dispatch_log "role_${role}" "$role" "$role_channel_name" "$role_script" "$prompt_path" "$session_id" "$req_code" "$provider" "$role"

  local tout=""
  command -v timeout >/dev/null 2>&1 && tout="timeout"
  [ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"
  role_rc=1
  if [ "$role_script_suffix" = "ccb" ]; then
    if [ -n "$tout" ]; then
      set +e; $tout "$timeout_s" bash "$role_script" --session-id "$session_id" --req-code "$req_code" "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path" "$provider"; role_rc=$?; set -e
    else
      set +e; bash "$role_script" --session-id "$session_id" --req-code "$req_code" "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path" "$provider"; role_rc=$?; set -e
    fi
    if [ -f "${role_dir}/coder/stdout.log" ]; then
      extract_req_payload_segment "$req_code" "${role_dir}/coder/stdout.log" "${role_dir}/coder/req_payload.txt" "$role"
    fi
  elif [ "$role_script_suffix" = "bridge" ]; then
    if [ -n "$tout" ]; then
      set +e; $tout "$timeout_s" bash "$role_script" --session-id "$session_id" "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path"; role_rc=$?; set -e
    else
      set +e; bash "$role_script" --session-id "$session_id" "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path"; role_rc=$?; set -e
    fi
  else
    if [ -n "$tout" ]; then
      set +e; $tout "$timeout_s" bash "$role_script" "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path"; role_rc=$?; set -e
    else
      set +e; bash "$role_script" "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path"; role_rc=$?; set -e
    fi
  fi

  [ -f "${role_dir}/coder/rc.txt" ] && role_rc=$(cat "${role_dir}/coder/rc.txt" 2>/dev/null || echo "$role_rc")
  [ -f "${role_dir}/coder/stdout.log" ] || [ ! -f "${role_dir}/coder/run.log" ] || cp "${role_dir}/coder/run.log" "${role_dir}/coder/stdout.log" 2>/dev/null || true

  local role_response_path=""
  [ -f "${role_dir}/coder/req_payload.txt" ] && role_response_path="${role_dir}/coder/req_payload.txt"
  [ -z "$role_response_path" ] && [ -f "${role_dir}/coder/stdout.log" ] && role_response_path="${role_dir}/coder/stdout.log"
  [ -z "$role_response_path" ] && [ -f "${role_dir}/coder/run.log" ] && role_response_path="${role_dir}/coder/run.log"
  write_agent_response_log "role_${role}" "$role" "$role_channel_name" "$role_script" "$role_response_path" "$session_id" "$req_code" "$provider" "coordinator" "$role_rc"

  write_event_ext "role_action_finished" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"rc\":${role_rc},\"path\":\"${role_dir}\"}"
  if [ "$role_rc" != "0" ]; then
    # Transient failures (timeout / daemon unavailable): retry once before pausing
    if [ "$role_rc" = "124" ] || [ "$role_rc" = "127" ]; then
      if [ "${_role_retry_done:-0}" != "1" ]; then
        _role_retry_done=1
        log_info "Role ${role} failed (rc=${role_rc}), retrying once..."
        write_event_ext "role_action_retry" "{\"role\":\"${role}\",\"session_id\":\"${session_id}\",\"rc\":${role_rc},\"reason\":\"transient_retry\"}"
        if [ "$role_rc" = "127" ]; then sleep 5; fi
        run_role_action_v51 "$role" "$pane_idx" "$session_id" "$provider" "$launch_mode" "$context" "$task_type"
        return
      fi
    fi
    enter_paused "PAUSED_ROLE_FAILED" \
      "Role ${role} failed (rc=${role_rc})." \
      "[\"Inspect out/<task_id>/roles/${role}-*/coder/run.log and retry.\"]" \
      "NEED_USER_INPUT" "" "true"
    NORMAL_EXIT=1; exit 0
  fi
}

write_role_handoff_pointer() {
  local from_role="$1" from_sid="$2" to_role="$3" to_sid="$4" commit_sha="$5" launch_mode="$6"
  python3 - "$TASK_DIR" "$TASK_ID" "$from_role" "$from_sid" "$to_role" "$to_sid" "$commit_sha" "$launch_mode" <<'PY'
import json
import os
import sys
import datetime

task_dir, task_id, from_role, from_sid, to_role, to_sid, commit_sha, launch_mode = sys.argv[1:9]
handoff_dir = os.path.join(task_dir, "handoff")
os.makedirs(handoff_dir, exist_ok=True)
fname = f"{from_role}_to_{to_role}_{from_sid}.json"
path = os.path.join(handoff_dir, fname)
doc = {
    "task_id": task_id,
    "from_role": from_role,
    "from_session_id": from_sid,
    "to_role": to_role,
    "to_session_id": to_sid,
    "commit_sha": commit_sha,
    "launch_mode": launch_mode,
    "ts": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
}
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
print(path)
PY
}

role_transition_v51() {
  local from_role="$1" from_idx="$2" from_sid="$3"
  local to_role="$4" to_idx="$5" to_sid="$6"
  local launch_mode="$7" provider="$8"
  local launch_next="${9:-true}"
  local repo_path="" commit_sha="" next_context="" handoff_path=""

  upsert_task_state_pane "$from_role" "$from_idx" "done" "$from_sid" "$launch_mode"
  write_event_ext "role_end" "{\"role\":\"${from_role}\",\"session_id\":\"${from_sid}\"}"

  repo_path=$(json_read "$TASK_JSON" "repo_path" "")
  if [ -n "$repo_path" ] && [ -d "$repo_path" ]; then
    local role_commit_rc=0
    set +e
    bash "$GIT_OPS_BIN" role-commit --task "$TASK_ID" --role "$from_role" --session-id "$from_sid" --attempt-id "$from_idx" --message "phase complete" --repo "$repo_path" >/dev/null 2>&1
    role_commit_rc=$?
    set -e
    write_coordinator_simple_event "git_role_commit" "git" "internal" "role_transition" "role=${from_role} session_id=${from_sid}" "git_ops.sh role-commit" "$role_commit_rc" "$repo_path" "" ""
    commit_sha=$(get_commit_sha "$repo_path")
  fi
  write_event_ext "role_commit" "{\"task_id\":\"${TASK_ID}\",\"role\":\"${from_role}\",\"commit_sha\":\"${commit_sha}\",\"timestamp\":\"$(now_iso)\",\"session_id\":\"${from_sid}\"}"

  handoff_path=$(write_role_handoff_pointer "$from_role" "$from_sid" "$to_role" "$to_sid" "$commit_sha" "$launch_mode")
  write_event_ext "handoff_pointer_written" "{\"path\":\"${handoff_path}\",\"from\":\"${from_role}\",\"to\":\"${to_role}\",\"session_id\":\"${from_sid}\"}"
  next_context=$(knowledge_agent_query "$to_role" "$from_role" "$from_sid" "$commit_sha" "$handoff_path")
  if [ "$launch_next" = "true" ]; then
    case "$launch_mode" in
      ccb) ccb_launch_pane "$to_role" "$to_idx" "$provider" "$to_sid" "$next_context" ;;
      bridge) bridge_launch_pane "$to_role" "$to_idx" "$provider" "$to_sid" "$next_context" ;;
    esac
  else
    upsert_task_state_pane "$to_role" "$to_idx" "waiting" "$to_sid" "$launch_mode"
  fi
  write_event_ext "role_transition" "{\"from\":\"${from_role}\",\"to\":\"${to_role}\",\"session_id\":\"${to_sid}\",\"handoff_path\":\"${handoff_path}\"}"
}

run_v51_flow() {
  local task_type launch_mode max_att
  task_type=$(json_read "$TASK_JSON" "task_type" "")
  if [ -z "$task_type" ]; then
    log_error "task_type is required in task.json"
    exit 1
  fi
  case "$task_type" in
    copywriting|solo|multi_agent) ;;
    *)
      log_error "Unsupported task_type for v5.1 flow: ${task_type}"
      exit 1
      ;;
  esac

  launch_mode=$(resolve_launch_mode_v51)
  max_att="${EFFECTIVE_MAX_ATTEMPTS:-$(json_read "$TASK_JSON" "max_attempts" "1")}"
  write_status "RUNNING" "0" "$max_att" "false" "" "v5.1 role flow started" "[]" "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"

  local roles=()
  case "$task_type" in
    copywriting) roles=(pm executor reviewer) ;;
    solo|multi_agent) roles=(pm designer executor reviewer) ;;
  esac

  if [ "$task_type" = "solo" ]; then
    local solo_values
    solo_values=$(python3 - "$TASK_JSON" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    d = json.load(f)
roles = d.get("collab_roles") if isinstance(d.get("collab_roles"), dict) else {}
vals = {str(v).strip().lower() for v in roles.values() if str(v).strip()}
print(len(vals))
PY
)
    if [ "${solo_values:-0}" -gt 1 ]; then
      log_error "task_type=solo requires the same provider for all collab_roles"
      exit 1
    fi
  fi

  local pm_sid pm_provider pm_ctx
  pm_sid="$("$SESSION_ID_GEN" "$TASK_ID" "pm" "0")"
  pm_provider=$(normalize_provider_v51 "$(resolve_provider_for_role "pm" "$task_type")")
  [ -z "$pm_provider" ] && pm_provider="claude"
  pm_ctx=$(knowledge_agent_query "pm" "" "" "" "")
  case "$launch_mode" in
    ccb) ccb_launch_pane "pm" "0" "$pm_provider" "$pm_sid" "$pm_ctx" ;;
    bridge) bridge_launch_pane "pm" "0" "$pm_provider" "$pm_sid" "$pm_ctx" ;;
  esac
  run_role_action_v51 "pm" "0" "$pm_sid" "$pm_provider" "$launch_mode" "$pm_ctx" "$task_type"

  if [ "$task_type" = "copywriting" ]; then
    local ex_sid ex_provider
    ex_sid="$("$SESSION_ID_GEN" "$TASK_ID" "executor" "1")"
    ex_provider=$(normalize_provider_v51 "$(resolve_provider_for_role "executor" "$task_type")")
    role_transition_v51 "pm" "0" "$pm_sid" "executor" "1" "$ex_sid" "$launch_mode" "$ex_provider" "false"
  else
    local designer_sid designer_provider designer_ctx ex_sid ex_provider
    designer_sid="$("$SESSION_ID_GEN" "$TASK_ID" "designer" "1")"
    designer_provider=$(normalize_provider_v51 "$(resolve_provider_for_role "designer" "$task_type")")
    [ -z "$designer_provider" ] && designer_provider="$pm_provider"
    role_transition_v51 "pm" "0" "$pm_sid" "designer" "1" "$designer_sid" "$launch_mode" "$designer_provider" "true"
    designer_ctx=$(knowledge_agent_query "designer" "pm" "$pm_sid" "" "")
    run_role_action_v51 "designer" "1" "$designer_sid" "$designer_provider" "$launch_mode" "$designer_ctx" "$task_type"

    ex_sid="$("$SESSION_ID_GEN" "$TASK_ID" "executor" "1")"
    ex_provider=$(normalize_provider_v51 "$(resolve_provider_for_role "executor" "$task_type")")
    role_transition_v51 "designer" "1" "$designer_sid" "executor" "1" "$ex_sid" "$launch_mode" "$ex_provider" "false"
  fi

  local att=1
  while [ "$att" -le "$EFFECTIVE_MAX_ATTEMPTS" ]; do
    process_control
    load_runtime_overrides
    run_attempt "$att"
    att=$(( att + 1 ))
  done
}

##############################################################################
# 11. --reset
##############################################################################
cmd_reset() {
  local tid="$1"; TASK_ID="$tid"; TASK_DIR="${OUT_DIR}/${tid}"; TASK_JSON="${TASK_DIR}/task.json"
  [ ! -d "$TASK_DIR" ] && { log_error "Task dir not found: ${TASK_DIR}"; NORMAL_EXIT=1; exit 1; }
  LOCK_DIR="${TASK_DIR}/.lockdir"
  if [ -d "$LOCK_DIR" ]; then
    local lp=""; [ -f "${LOCK_DIR}/pid" ] && lp=$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")
    local stale=0
    if [ -n "$lp" ]; then kill -0 "$lp" 2>/dev/null || stale=1; else stale=1; fi
    if [ "$stale" = "0" ] && [ -f "${LOCK_DIR}/started_at" ]; then
      local ls_t; ls_t=$(cat "${LOCK_DIR}/started_at" 2>/dev/null || echo "")
      local ne; ne=$(date +%s); local le; le=$(epoch_from_iso "$ls_t")
      [ "$le" != "0" ] && [ $(( ne - le )) -gt "$LOCK_STALE_SECONDS" ] && stale=1
    fi
    if [ "$stale" = "1" ]; then rm -rf "$LOCK_DIR"
    else log_error "Task still running (pid=${lp}). Stop it first."; NORMAL_EXIT=1; exit 1; fi
  fi
  # Clean worktrees
  local wtb="${WORKTREES_DIR}/${tid}"
  if [ -d "$wtb" ]; then
    local removed_count=0 remove_fail_count=0
    local rp=""; [ -f "$TASK_JSON" ] && rp=$(json_read "$TASK_JSON" "repo_path" "")
    if [ -n "$rp" ] && [ -d "$rp" ]; then
      for w in "${wtb}"/attempt_*; do
        [ -d "$w" ] || continue
        if git -C "$rp" worktree remove --force "$w" 2>/dev/null; then
          removed_count=$(( removed_count + 1 ))
        else
          remove_fail_count=$(( remove_fail_count + 1 ))
        fi
      done
    fi
    write_coordinator_simple_event "reset_worktree_cleanup" "git" "internal" "task_reset" "removed=${removed_count} failed=${remove_fail_count}" "git -C <repo_path> worktree remove --force <worktree>" "$remove_fail_count" "$rp" "$wtb" ""
    rm -rf "$wtb"
  fi
  local ma=3; [ -f "$TASK_JSON" ] && ma=$(json_read "$TASK_JSON" "max_attempts" "3")
  local lt_reset='{"reason_code":"PAUSED_USER","previous_state":"RUNNING","message":"task reset"}'
  write_status "PAUSED" "0" "$ma" "false" "NEED_USER_INPUT" "reset performed" \
    '["Task has been reset. Use --continue or create new task."]' "PAUSED_MANUAL" "PAUSED_USER" "$lt_reset" ""
  write_final_summary "PAUSED" "NEED_USER_INPUT" "0" "$ma" "reset performed" \
    '["Task has been reset. Use --continue or create new task."]' "PAUSED_MANUAL" "PAUSED_USER" ""
  write_event "0" "TASK_RESET" "task reset performed"
  log_info "Task ${tid} has been reset"
  NORMAL_EXIT=1; exit 0
}

##############################################################################
# 12. --rerun-attempt
##############################################################################
cmd_rerun_attempt() {
  local tid="$1" from_att="$2"
  TASK_ID="$tid"; TASK_DIR="${OUT_DIR}/${tid}"; TASK_JSON="${TASK_DIR}/task.json"
  [ ! -f "$TASK_JSON" ] && { log_error "Task not found"; NORMAL_EXIT=1; exit 1; }
  local mx=0
  for d in "${TASK_DIR}"/attempt_*; do
    if [ -d "$d" ]; then
      local n; n=$(basename "$d" | sed 's/attempt_//' | sed 's/^0*//')
      [ -n "$n" ] && [ "$n" -gt "$mx" ] && mx=$n
    fi
  done
  local nxt=$(( mx + 1 )); CURRENT_ATTEMPT=$nxt
  local fp; fp=$(printf "%03d" "$from_att")
  local np; np=$(printf "%03d" "$nxt")
  local nad="${TASK_DIR}/attempt_${np}"
  mkdir -p "${nad}/coder"
  if [ -f "${TASK_DIR}/attempt_${fp}/coder/prompt.txt" ]; then
    cp "${TASK_DIR}/attempt_${fp}/coder/prompt.txt" "${nad}/coder/prompt.txt"
    cp "${TASK_DIR}/attempt_${fp}/coder/prompt.txt" "${nad}/coder/instruction.txt" 2>/dev/null || true
  elif [ -f "${TASK_DIR}/attempt_${fp}/coder/instruction.txt" ]; then
    cp "${TASK_DIR}/attempt_${fp}/coder/instruction.txt" "${nad}/coder/instruction.txt"
    cp "${TASK_DIR}/attempt_${fp}/coder/instruction.txt" "${nad}/coder/prompt.txt" 2>/dev/null || true
  fi
  write_event "$nxt" "ATTEMPT_STARTED" "RERUN_FROM=attempt_${fp}" "$nad"
  if ! acquire_lock; then ensure_status_on_lock_fail; NORMAL_EXIT=1; exit 0; fi
  run_attempt "$nxt"
  release_lock; NORMAL_EXIT=1
}

##############################################################################
# 13. --self-improve
##############################################################################
cmd_self_improve() {
  local idea="$1"
  [ ! -f "$idea" ] && { log_error "idea file not found: ${idea}"; exit 1; }
  local ic; ic=$(cat "$idea")
  local ts; ts=$(date +%Y%m%d_%H%M%S)
  local tid="self_improve_${ts}"
  local sf="/tmp/rdloop_self_improve_${ts}.json"
  python3 -c "
import json,sys
d={'schema_version':'v1','task_id':sys.argv[1],'repo_path':sys.argv[2],
   'base_ref':'main','goal':sys.argv[3],'acceptance':sys.argv[3],
   'test_cmd':'bash regression/run_regression.sh','max_attempts':3,
   'coder':'cursor_cli','judge':'codex_cli','constraints':[],
   'created_at':'','target_type':'rdloop_self',
   'allowed_paths':[],'forbidden_globs':['**/.env','**/secrets*','**/*.pem'],
   'cursor_cmd':'cursor','codex_cmd':'codex',
   'coder_timeout_seconds':600,'judge_timeout_seconds':300,'test_timeout_seconds':300}
with open(sys.argv[4],'w') as f: json.dump(d,f,indent=2)
" "$tid" "$RDLOOP_ROOT" "$ic" "$sf"
  log_info "Generated self-improve task: ${tid}"
  exec bash "$0" "$sf"
}

##############################################################################
# 14. ensure_status_on_lock_fail — §19 check 2
##############################################################################
ensure_status_on_lock_fail() {
  if [ ! -f "${TASK_DIR}/status.json" ]; then
    local ma=3; [ -f "${TASK_JSON:-}" ] && ma=$(json_read "$TASK_JSON" "max_attempts" "3")
    write_status "RUNNING" "0" "$ma" "false" "" "" '[]' "" "" "null" ""
  fi
  local ma; ma=$(json_read "${TASK_DIR}/status.json" "max_attempts" "3")
  local ca; ca=$(json_read "${TASK_DIR}/status.json" "current_attempt" "0")
  local st; st=$(json_read "${TASK_DIR}/status.json" "state" "RUNNING")
  write_status "$st" "$ca" "$ma" "false" "" "already running" '[]' "" "" "null" ""
  write_coordinator_simple_event "lock_fail_status_written" "lock" "internal" "status_update" "status refreshed while lock is held by another process" "" "0" "" "" "${TASK_DIR}/status.json"
}

##############################################################################
# 15. New task
##############################################################################
cmd_new_task() {
  local sf="$1"
  [ ! -f "$sf" ] && { log_error "Spec not found: ${sf}"; exit 1; }
  TASK_ID=$(json_read "$sf" "task_id" "")
  [ -z "$TASK_ID" ] && { log_error "task_id missing in spec"; exit 1; }
  TASK_DIR="${OUT_DIR}/${TASK_ID}"
  # §5.2 uniqueness
  if [ -f "${TASK_DIR}/task.json" ]; then
    TASK_JSON="${TASK_DIR}/task.json"
    enter_paused "PAUSED_TASK_ID_CONFLICT" "task_id '${TASK_ID}' already exists" \
      "[\"task_id ${TASK_ID} already exists. Use --continue or choose a different task_id.\"]"
    NORMAL_EXIT=1; exit 0
  fi
  mkdir -p "$TASK_DIR"
  # Copy spec + fill created_at + generate unique task_code for handoff tracing
  python3 -c "
import json,sys,datetime,uuid
with open(sys.argv[1]) as f: d=json.load(f)
if not d.get('created_at'): d['created_at']=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
if not d.get('task_code'): d['task_code']=str(uuid.uuid4())
with open(sys.argv[2],'w') as f: json.dump(d,f,indent=2)
" "$sf" "${TASK_DIR}/task.json"
  TASK_JSON="${TASK_DIR}/task.json"

  # Resolve relative repo_path
  local rp; rp=$(json_read "$TASK_JSON" "repo_path" "")
  if [ -n "$rp" ]; then
    case "$rp" in
      /*) ;;
      *)
        local sd; sd=$(cd "$(dirname "$sf")" && pwd)
        local ar="${sd}/${rp}"
        if [ -d "$ar" ]; then
          rp=$(cd "$ar" && pwd)
          python3 -c "
import json,sys
with open(sys.argv[1]) as f: d=json.load(f)
d['repo_path']=sys.argv[2]
with open(sys.argv[1],'w') as f: json.dump(d,f,indent=2)
" "$TASK_JSON" "$rp"
        fi ;;
    esac
  fi

  local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
  EFFECTIVE_MAX_ATTEMPTS="$ma"
  load_runtime_overrides
  write_status "RUNNING" "0" "$EFFECTIVE_MAX_ATTEMPTS" "false" "" "" '[]' "" "" "null" ""
  write_event "0" "TASK_CREATED" "task created from ${sf}"

  if ! acquire_lock; then
    ensure_status_on_lock_fail
    log_info "Task ${TASK_ID} already running"
    NORMAL_EXIT=1; exit 0
  fi

  if is_v51_signature_task; then
    if ! is_v51_role_task; then
      log_error "task_type is required and must be one of: copywriting, solo, multi_agent"
      release_lock
      NORMAL_EXIT=1
      exit 1
    fi
    run_v51_flow
    release_lock
    NORMAL_EXIT=1
    exit 0
  fi

  local att=1
  while [ "$att" -le "$EFFECTIVE_MAX_ATTEMPTS" ]; do
    process_control
    load_runtime_overrides
    run_attempt "$att"
    att=$(( att + 1 ))
  done
  release_lock; NORMAL_EXIT=1
}

##############################################################################
# 16. --continue
##############################################################################
cmd_continue() {
  local tid="$1"; TASK_ID="$tid"; TASK_DIR="${OUT_DIR}/${tid}"; TASK_JSON="${TASK_DIR}/task.json"
  [ ! -f "$TASK_JSON" ] && { log_error "Task not found: ${TASK_JSON}"; NORMAL_EXIT=1; exit 1; }
  local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
  EFFECTIVE_MAX_ATTEMPTS="$ma"
  load_runtime_overrides
  # Load consecutive timeout state from previous status
  if [ -f "${TASK_DIR}/status.json" ]; then
    local prev_lt_count; prev_lt_count=$(json_read "${TASK_DIR}/status.json" "last_transition.consecutive_count" "0")
    local prev_lt_key; prev_lt_key=$(json_read "${TASK_DIR}/status.json" "last_transition.reason_key" "")
    case "$prev_lt_key" in
      PAUSED_JUDGE_TIMEOUT) prev_lt_key="judge_timeout" ;;
      PAUSED_CODER_TIMEOUT) prev_lt_key="coder_timeout" ;;
      PAUSED_TEST_TIMEOUT) prev_lt_key="test_timeout" ;;
    esac
    [ -n "$prev_lt_count" ] && [ "$prev_lt_count" != "0" ] && {
      CONSECUTIVE_TIMEOUT_COUNT="$prev_lt_count"
      CONSECUTIVE_TIMEOUT_KEY="$prev_lt_key"
    }
    # Restore state_version
    local prev_sv; prev_sv=$(json_read "${TASK_DIR}/status.json" "state_version" "1")
    [ -n "$prev_sv" ] && STATE_VERSION="$prev_sv"
  fi
  local mx=0
  for d in "${TASK_DIR}"/attempt_*; do
    if [ -d "$d" ]; then
      local n; n=$(basename "$d" | sed 's/attempt_//' | sed 's/^0*//')
      [ -n "$n" ] && [ "$n" -gt "$mx" ] && mx=$n
    fi
  done
  CURRENT_ATTEMPT=$mx
  process_control
  # If user sent RESUME from READY_FOR_REVIEW/FAILED, we just set RUNNING; do not exit as terminal state
  local cs=""; [ -f "${TASK_DIR}/status.json" ] && cs=$(json_read "${TASK_DIR}/status.json" "state" "")
  if [ "$CONTROL_RESUME_APPLIED" = "1" ]; then
    cs="RUNNING"
  fi
  if [ "$cs" = "READY_FOR_REVIEW" ] || [ "$cs" = "FAILED" ]; then
    log_info "Task ${tid} in terminal state: ${cs}"; NORMAL_EXIT=1; exit 0
  fi
  if ! acquire_lock; then
    ensure_status_on_lock_fail; log_info "Task ${TASK_ID} already running"; NORMAL_EXIT=1; exit 0
  fi
  if is_v51_signature_task; then
    if ! is_v51_role_task; then
      log_error "task_type is required and must be one of: copywriting, solo, multi_agent"
      release_lock
      NORMAL_EXIT=1
      exit 1
    fi
    run_v51_flow
    release_lock
    NORMAL_EXIT=1
    exit 0
  fi
  local nxt=$(( mx + 1 ))
  if [ "$nxt" -le "$EFFECTIVE_MAX_ATTEMPTS" ]; then
    write_status "RUNNING" "$CURRENT_ATTEMPT" "$EFFECTIVE_MAX_ATTEMPTS" "false" "" "" '[]' "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
    local att=$nxt
    while [ "$att" -le "$EFFECTIVE_MAX_ATTEMPTS" ]; do
      process_control; load_runtime_overrides; run_attempt "$att"; att=$(( att + 1 ))
    done
  else
    log_info "No more attempts (${mx}/${EFFECTIVE_MAX_ATTEMPTS})"
  fi
  release_lock; NORMAL_EXIT=1
}

##############################################################################
# 17. Entry point
##############################################################################
main() {
  mkdir -p "$OUT_DIR" "$WORKTREES_DIR"
  if [ $# -lt 1 ]; then
    echo "Usage:"
    echo "  run_task.sh <task_spec.json>"
    echo "  run_task.sh --continue <task_id>"
    echo "  run_task.sh --reset <task_id>"
    echo "  run_task.sh --rerun-attempt <task_id> <n>"
    echo "  run_task.sh --self-improve <idea.md>"
    exit 1
  fi
  case "$1" in
    --continue) [ $# -lt 2 ] && { log_error "--continue needs task_id"; exit 1; }; cmd_continue "$2" ;;
    --reset) [ $# -lt 2 ] && { log_error "--reset needs task_id"; exit 1; }; cmd_reset "$2" ;;
    --rerun-attempt) [ $# -lt 3 ] && { log_error "needs task_id + attempt"; exit 1; }; cmd_rerun_attempt "$2" "$3" ;;
    --self-improve) [ $# -lt 2 ] && { log_error "needs idea.md"; exit 1; }; cmd_self_improve "$2" ;;
    *) cmd_new_task "$1" ;;
  esac
}

main "$@"
