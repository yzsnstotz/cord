#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/yzliu/work/Cord"
RDLOOP="$ROOT/Rdloop"
TASKS_DIR="$RDLOOP/tasks"
TEST_ROOT="$ROOT/test/v5.1_test"
LIVE_DIR="$TEST_ROOT/live_gui_real"
SPEC_SNAPSHOT_DIR="$LIVE_DIR/spec_snapshots"
RUNS_DIR="$LIVE_DIR/runs"
REPORT_JSON="$LIVE_DIR/live_result.json"
REPORT_MD="$LIVE_DIR/live_result.md"
mkdir -p "$SPEC_SNAPSHOT_DIR" "$RUNS_DIR"

API="http://localhost:17333"
GUI_PID=""
GUI_STARTED_BY_SCRIPT=0

cleanup() {
  if [ "$GUI_STARTED_BY_SCRIPT" = "1" ] && [ -n "$GUI_PID" ]; then
    kill "$GUI_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[1/8] health check"
if ! HEALTH=$(curl -sS "$API/api/health" 2>/dev/null); then
  echo "GUI not reachable, starting local server.js ..."
  (cd "$RDLOOP/gui" && node server.js > "$LIVE_DIR/gui_server.log" 2>&1) &
  GUI_PID=$!
  GUI_STARTED_BY_SCRIPT=1
  sleep 2
  HEALTH=$(curl -sS "$API/api/health")
fi
echo "$HEALTH" > "$LIVE_DIR/health.json"

echo "[2/8] ensure CCB session codex+gemini"
# best effort cleanup first
curl -sS -X POST "$API/api/ccb/session/cleanup" -H 'Content-Type: application/json' -d '{}' > "$LIVE_DIR/ccb_cleanup.json" || true
curl -sS -X POST "$API/api/ccb/session/start" -H 'Content-Type: application/json' -d '{"providers":["codex","gemini"]}' > "$LIVE_DIR/ccb_start.json" || true
sleep 3
curl -sS "$API/api/ccb/session-status" > "$LIVE_DIR/ccb_session_status.json" || true
curl -sS "$API/api/ccb/status" > "$LIVE_DIR/ccb_status.json" || true

now_tag=$(date +%Y%m%d_%H%M%S)

# 6 cases: 3 task modes x 2 run modes (legacy mapping to force real coder/judge path)
# note: run_surface for copywriting/multi_agent may still route to CCB adapter by current coordinator design.
create_spec() {
  local spec_id="$1"
  local executor_type="$2"
  local workflow_mode="$3"
  local run_surface="$4"
  local execution_mode="$5"
  local coder_model="$6"
  local judge_model="$7"
  cat > "$TASKS_DIR/${spec_id}.json" <<JSON
{
  "schema_version": "v1",
  "task_id": "${spec_id}",
  "executor_type": "${executor_type}",
  "workflow_mode": "${workflow_mode}",
  "run_surface": "${run_surface}",
  "execution_mode": "${execution_mode}",
  "repo_path": "$ROOT",
  "base_ref": "main",
  "goal": "Live real-provider routing test for ${spec_id}. Produce concise output.",
  "acceptance": ["Task runs end-to-end with real provider calls"],
  "test_cmd": "true",
  "max_attempts": 1,
  "coder_timeout_seconds": 240,
  "judge_timeout_seconds": 240,
  "attempt_context_mode": "fresh_each",
  "constraints": [],
  "allowed_paths": [],
  "forbidden_globs": ["**/.env", "**/secrets*", "**/*.pem"],
  "coder": "ccb",
  "judge": "ccb",
  "coder_model": "${coder_model}",
  "judge_model": "${judge_model}",
  "collab_roles": {
    "pm": "codex",
    "designer": "gemini",
    "executor": "codex",
    "reviewer": "gemini"
  },
  "executor_instruction": "Write one short line confirming mode/provider path and stop."
}
JSON
  cp "$TASKS_DIR/${spec_id}.json" "$SPEC_SNAPSHOT_DIR/${spec_id}.json"
}

BASE="v51live_${now_tag}"
create_spec "${BASE}_copywriting_ccb" "api_call" "single" "visual_ccb" "semi-auto" "codex" "gemini"
create_spec "${BASE}_copywriting_bridge" "api_call" "single" "bridge" "auto" "codex" "gemini"
create_spec "${BASE}_solo_ccb" "solo_agent" "solo" "visual_ccb" "semi-auto" "codex" "gemini"
create_spec "${BASE}_solo_bridge" "solo_agent" "solo" "bridge" "auto" "gemini" "gemini"
create_spec "${BASE}_multi_agent_ccb" "multi_agent" "collab" "visual_ccb" "semi-auto" "codex" "gemini"
create_spec "${BASE}_multi_agent_bridge" "multi_agent" "collab" "bridge" "auto" "codex" "gemini"

echo "[3/8] trigger runs from localhost:17333"
SPECS=(
  "${BASE}_copywriting_ccb"
  "${BASE}_copywriting_bridge"
  "${BASE}_solo_ccb"
  "${BASE}_solo_bridge"
  "${BASE}_multi_agent_ccb"
  "${BASE}_multi_agent_bridge"
)

RUN_IDS_FILE="$LIVE_DIR/run_ids.tsv"
: > "$RUN_IDS_FILE"

for spec in "${SPECS[@]}"; do
  # do not pass run_surface override; use spec values exactly
  resp=$(curl -sS -X POST "$API/api/task_specs/${spec}/run" -H 'Content-Type: application/json' -d '{}')
  echo "$resp" > "$RUNS_DIR/${spec}_trigger.json"
  run_task_id=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("task_id",""))' <<< "$resp")
  if [ -z "$run_task_id" ]; then
    echo "${spec}		TRIGGER_FAILED" >> "$RUN_IDS_FILE"
    continue
  fi
  echo "${spec}	${run_task_id}	TRIGGERED" >> "$RUN_IDS_FILE"
  echo "triggered: $spec -> $run_task_id"
done

echo "[4/8] poll statuses"
STATUS_TSV="$LIVE_DIR/statuses.tsv"
: > "$STATUS_TSV"

poll_task() {
  local spec="$1" task_id="$2"
  local max_wait=420
  local waited=0
  local state=""
  while [ "$waited" -lt "$max_wait" ]; do
    sresp=$(curl -sS "$API/api/tasks/${task_id}/status" || true)
    echo "$sresp" > "$RUNS_DIR/${task_id}_status_last.json"
    state=$(python3 -c 'import json,sys
try:
 d=json.load(sys.stdin);print(d.get("state",""))
except Exception:
 print("")' <<< "$sresp")
    if [ "$state" = "READY_FOR_REVIEW" ] || [ "$state" = "PAUSED" ] || [ "$state" = "FAILED" ]; then
      break
    fi
    sleep 5
    waited=$((waited+5))
  done
  echo -e "${spec}\t${task_id}\t${state}\t${waited}" >> "$STATUS_TSV"
}

while IFS=$'\t' read -r spec run_task_id mark; do
  [ -z "${run_task_id:-}" ] && continue
  [ "$mark" = "TRIGGERED" ] || continue
  poll_task "$spec" "$run_task_id"
done < "$RUN_IDS_FILE"

echo "[5/8] collect out artifacts"
while IFS=$'\t' read -r spec run_task_id state waited; do
  [ -z "${run_task_id:-}" ] && continue
  out_dir="$RDLOOP/out/$run_task_id"
  if [ -d "$out_dir" ]; then
    mkdir -p "$RUNS_DIR/$run_task_id"
    for f in task.json status.json final_summary.json events.jsonl task_state.json; do
      [ -f "$out_dir/$f" ] && cp "$out_dir/$f" "$RUNS_DIR/$run_task_id/$f"
    done
    # copy attempt logs if exist
    if ls "$out_dir"/attempt_* >/dev/null 2>&1; then
      mkdir -p "$RUNS_DIR/$run_task_id/attempts"
      cp -R "$out_dir"/attempt_* "$RUNS_DIR/$run_task_id/attempts/" 2>/dev/null || true
    fi
  fi
done < "$STATUS_TSV"

echo "[6/8] analyze real-call evidence"
python3 - "$RUN_IDS_FILE" "$STATUS_TSV" "$RUNS_DIR" "$REPORT_JSON" <<'PY'
import json,sys,os,glob
run_ids_file,status_file,runs_dir,report_json=sys.argv[1:5]
run_map={}
for line in open(run_ids_file,encoding='utf-8'):
    parts=line.rstrip('\n').split('\t')
    if len(parts)>=3:
        run_map[parts[0]]={'spec':parts[0],'task_id':parts[1],'trigger':parts[2]}
status_map={}
for line in open(status_file,encoding='utf-8'):
    parts=line.rstrip('\n').split('\t')
    if len(parts)>=4:
        status_map[parts[0]]={'task_id':parts[1],'state':parts[2],'wait_s':int(parts[3] or 0)}

rows=[]
for spec,meta in run_map.items():
    tid=meta.get('task_id','')
    row={'spec_id':spec,'task_id':tid,'trigger':meta.get('trigger')}
    st=status_map.get(spec,{})
    row.update(st)
    task_dir=os.path.join(runs_dir,tid)
    events=[]
    if os.path.isfile(os.path.join(task_dir,'events.jsonl')):
        for l in open(os.path.join(task_dir,'events.jsonl'),encoding='utf-8'):
            l=l.strip()
            if not l: continue
            try: events.append(json.loads(l))
            except: pass
    row['event_counts']={
        'ccb_call':sum(1 for e in events if e.get('type')=='ccb_call'),
        'bridge_call':sum(1 for e in events if e.get('type')=='bridge_call'),
        'session_id_assigned':sum(1 for e in events if e.get('type')=='session_id_assigned')
    }

    # real call hints in logs
    coder_runs=[]
    judge_runs=[]
    for p in glob.glob(os.path.join(task_dir,'attempts','attempt_*','coder','run.log')):
        try: coder_runs.append(open(p,encoding='utf-8',errors='ignore').read())
        except: pass
    for p in glob.glob(os.path.join(task_dir,'attempts','attempt_*','judge','run.log')):
        try: judge_runs.append(open(p,encoding='utf-8',errors='ignore').read())
        except: pass
    coder_blob='\n'.join(coder_runs)
    judge_blob='\n'.join(judge_runs)
    row['real_call_evidence']={
        'coder_log_exists':bool(coder_runs),
        'judge_log_exists':bool(judge_runs),
        'coder_has_ccb_marker':('[CODER][semi-auto/ccb]' in coder_blob),
        'coder_has_bridge_marker':('[CODER][auto/bridge]' in coder_blob or '[CODER][bridge]' in coder_blob),
        'judge_has_ccb_marker':('[JUDGE][semi-auto/ccb]' in judge_blob),
        'judge_has_bridge_marker':('[JUDGE][auto/bridge]' in judge_blob or '[JUDGE][bridge]' in judge_blob)
    }
    rows.append(row)

report={'cases':rows}
with open(report_json,'w',encoding='utf-8') as f:
    json.dump(report,f,indent=2,ensure_ascii=False)
PY

echo "[7/8] write markdown report"
python3 - "$REPORT_JSON" "$REPORT_MD" <<'PY'
import json,sys
jpath,mdpath=sys.argv[1:3]
d=json.load(open(jpath,encoding='utf-8'))
lines=[]
lines.append('# Live GUI Real-Provider Test (localhost:17333)')
lines.append('')
lines.append('| spec_id | task_id | trigger | state | wait_s | ccb_call | bridge_call | coder_ccb | coder_bridge | judge_ccb | judge_bridge |')
lines.append('|---|---|---|---|---:|---:|---:|---|---|---|---|')
for r in d.get('cases',[]):
    ec=r.get('event_counts',{})
    ev=r.get('real_call_evidence',{})
    lines.append('| {spec} | {tid} | {tr} | {st} | {w} | {ccb} | {br} | {cc} | {cb} | {jc} | {jb} |'.format(
      spec=r.get('spec_id',''), tid=r.get('task_id',''), tr=r.get('trigger',''), st=r.get('state',''), w=r.get('wait_s',0),
      ccb=ec.get('ccb_call',0), br=ec.get('bridge_call',0),
      cc='Y' if ev.get('coder_has_ccb_marker') else 'N', cb='Y' if ev.get('coder_has_bridge_marker') else 'N',
      jc='Y' if ev.get('judge_has_ccb_marker') else 'N', jb='Y' if ev.get('judge_has_bridge_marker') else 'N'
    ))
open(mdpath,'w',encoding='utf-8').write('\n'.join(lines)+'\n')
PY

echo "[8/8] done"
echo "Artifacts: $LIVE_DIR"
