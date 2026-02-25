#!/usr/bin/env bash
# call_coder_solo.sh — solo agent mode adapter
# Spawns extended bridge in visible tmux, runs coordinator-agent loop

task_json="$1"; attempt_dir="$2"; worktree_dir="$3"; instruction_path="$4"

# json_read is not exported from run_task.sh when this script runs as child; provide local implementation
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

# Read solo_config from task.json
max_iterations=$(json_read "$task_json" "solo_config.max_iterations" "10")
approval_mode=$(json_read "$task_json" "solo_config.approval_mode" "agent_decides")
session_strategy=$(json_read "$task_json" "solo_config.session_strategy" "continuous")
auto_pass_threshold=$(json_read "$task_json" "solo_config.auto_pass_threshold" "0.85")
open_terminal=$(json_read "$task_json" "solo_config.open_terminal" "true")
knowledge_shards=$(json_read "$task_json" "solo_config.knowledge_shards" "[]")
knowledge_project=$(json_read "$task_json" "knowledge_project_path" "")
provider=$(json_read "$task_json" "coder_model" "claude")

# Determine bridge provider
bridge_provider="claude"
case "$provider" in
  codex*) bridge_provider="codex" ;;
  cursor*) bridge_provider="cursor" ;;
  gemini*) bridge_provider="gemini" ;;
esac

session_dir="${attempt_dir}/solo"
mkdir -p "$session_dir"
mkdir -p "${attempt_dir}/coder"

# Load knowledge shards if enabled
knowledge_context=""
if [ "$(json_read "$task_json" "knowledge_enabled" "false")" = "true" ] && [ -n "$knowledge_project" ]; then
  knowledge_dir="${knowledge_project}/.context/knowledge"
  if [ -d "$knowledge_dir" ]; then
    for shard in $(echo "$knowledge_shards" | python3 -c "import sys,json; [print(s) for s in json.load(sys.stdin)]" 2>/dev/null); do
      shard_file="${knowledge_dir}/${shard}.json"
      if [ -f "$shard_file" ]; then
        knowledge_context="${knowledge_context}\n[KNOWLEDGE SHARD: ${shard}]\n$(cat "$shard_file")\n"
      fi
    done
  fi
fi

# Create tmux session for bridge
task_id=$(json_read "$task_json" "task_id" "unknown")
tmux_session="solo_${task_id}"
tmux new-session -d -s "$tmux_session" -c "$worktree_dir" 2>/dev/null || true

# Start bridge in tmux
fresh_flag=""
[ "$session_strategy" = "fresh_per_step" ] && fresh_flag="--fresh-per-step"
tmux send-keys -t "$tmux_session" \
  "bash ${COORDINATOR_LIB}/solo_bridge.sh ${bridge_provider} ${session_dir} ${attempt_dir} ${fresh_flag}" Enter

# Open terminal for user if configured
if [ "$open_terminal" = "true" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    osascript -e "tell application \"Terminal\" to do script \"tmux attach -t ${tmux_session}\"" 2>/dev/null || true
  fi
fi

# Coordinator-agent loop
iteration=0
instruction=$(cat "$instruction_path")
goal=$(json_read "$task_json" "goal" "")
test_cmd=$(json_read "$task_json" "test_cmd" "")

while [ "$iteration" -lt "$max_iterations" ]; do
  iteration=$((iteration + 1))
  step_dir="${session_dir}/step_$(printf '%03d' $iteration)"
  mkdir -p "$step_dir"

  # Compose request
  if [ "$iteration" -eq 1 ]; then
    step_type="design"
    step_instruction="You are in Solo Agent mode.

GOAL: ${goal}
INSTRUCTION: ${instruction}
WORKING DIRECTORY: ${worktree_dir}
TEST COMMAND: ${test_cmd}

${knowledge_context}

STEP 1 — DESIGN:
Analyze the goal, read relevant files, create a detailed plan.
Then begin execution: write code, run tests.

OUTPUT FORMAT (JSON at end of your response):
{
  \"step_completed\": \"design\",
  \"self_eval\": \"goal_met|partial|blocked|need_user_input|dead_loop\",
  \"confidence\": 0.0-1.0,
  \"summary\": \"what was done\",
  \"test_result\": { \"passed\": 0, \"total\": 0, \"output\": \"\" },
  \"files_modified\": [],
  \"issues\": [],
  \"next_action\": \"execute|fix_and_retry|need_user_input|done\",
  \"question_for_user\": \"\",
  \"knowledge_entries\": {}
}"
  else
    # Read previous response for context
    prev_response=$(cat "${session_dir}/step_$(printf '%03d' $((iteration-1)))/response.json" 2>/dev/null || echo "{}")
    prev_summary=$(echo "$prev_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',''))" 2>/dev/null || echo "")
    prev_issues=$(echo "$prev_response" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('issues',[])))" 2>/dev/null || echo "[]")

    step_type="continue"
    step_instruction="CONTINUING — iteration ${iteration}/${max_iterations}

Previous step summary: ${prev_summary}
Issues to address: ${prev_issues}
TEST COMMAND: ${test_cmd}

Continue working toward the goal. Fix issues, run tests, verify.

OUTPUT FORMAT (same JSON as before)."
  fi

  # Write request
  python3 -c "
import json, sys
req = {'step': '${step_type}', 'iteration': ${iteration}, 'instruction': sys.stdin.read()}
json.dump(req, open('${step_dir}/request.json','w'), indent=2)
" <<< "$step_instruction"

  # Signal bridge: new request available
  cp "${step_dir}/request.json" "${session_dir}/request.json"

  # Wait for bridge to write response
  timeout_s=$(json_read "$task_json" "coder_timeout_seconds" "600")
  elapsed=0
  while [ ! -f "${session_dir}/response.json" ] || \
        [ "$(stat -f%m "${session_dir}/response.json" 2>/dev/null || stat -c%Y "${session_dir}/response.json" 2>/dev/null || echo 0)" -le \
          "$(stat -f%m "${session_dir}/request.json" 2>/dev/null || stat -c%Y "${session_dir}/request.json" 2>/dev/null || echo 999999999)" ]; do
    sleep 5
    elapsed=$((elapsed + 5))
    if [ "$elapsed" -ge "$timeout_s" ]; then
      echo '{"self_eval":"dead_loop","summary":"timeout"}' > "${step_dir}/response.json"
      break
    fi
  done

  # Copy response to step dir
  cp "${session_dir}/response.json" "${step_dir}/response.json" 2>/dev/null || true

  # Run coordinator decision (deterministic, no LLM)
  decision=$(python3 "${COORDINATOR_LIB}/decision_solo.py" \
    --response "${step_dir}/response.json" \
    --iteration "$iteration" \
    --max-iterations "$max_iterations" \
    --approval-mode "$approval_mode" \
    --auto-pass-threshold "$auto_pass_threshold" 2>/dev/null || echo '{"action":"CONTINUE","reason":"decision error"}')

  echo "$decision" > "${step_dir}/decision.json"

  action=$(echo "$decision" | python3 -c "import sys,json; print(json.load(sys.stdin).get('action','CONTINUE'))" 2>/dev/null || echo "CONTINUE")

  case "$action" in
    READY_FOR_REVIEW)
      # Write final summary from last response
      cp "${step_dir}/response.json" "${attempt_dir}/coder/stdout.log"
      echo "0" > "${attempt_dir}/coder/rc.txt"
      break
      ;;
    PAUSED|PAUSED_MANUAL|PAUSED_AGENT_STUCK|PAUSED_MAX_ITERATIONS|PAUSED_STEP_APPROVAL)
      echo "$action" > "${attempt_dir}/coder/pause_reason.txt"
      echo "2" > "${attempt_dir}/coder/rc.txt"
      break
      ;;
    ABORT)
      cp "${step_dir}/response.json" "${attempt_dir}/coder/stdout.log"
      echo "1" > "${attempt_dir}/coder/rc.txt"
      break
      ;;
    CONTINUE)
      # Loop continues
      ;;
  esac
done

# Signal bridge to exit
echo '{"action":"exit"}' > "${session_dir}/control.json"

# Write solo summary
python3 -c "
import json, glob, os
steps = sorted(glob.glob('${session_dir}/step_*/response.json'))
summary = {'total_iterations': ${iteration}, 'steps': []}
for s in steps:
    try:
        data = json.load(open(s))
        summary['steps'].append({'step': os.path.basename(os.path.dirname(s)), 'summary': data.get('summary',''), 'self_eval': data.get('self_eval','')})
    except: pass
json.dump(summary, open('${session_dir}/solo_summary.json','w'), indent=2)
"

exit $(cat "${attempt_dir}/coder/rc.txt" 2>/dev/null || echo 1)
