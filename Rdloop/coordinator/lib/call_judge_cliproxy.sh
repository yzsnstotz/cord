#!/usr/bin/env bash
# call_judge_cliproxy.sh — Single Flow judge adapter (LLM API call)
# Evaluates coder output against acceptance criteria via LLM API.

task_json="$1"; attempt_dir="$2"; worktree_dir="$3"
mkdir -p "${attempt_dir}/judge"

run_log="${attempt_dir}/judge/run.log"
output_file="${attempt_dir}/judge/stdout.log"
verdict_file="${attempt_dir}/judge/verdict.json"

timeout_s=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('judge_timeout_seconds',300))
except: print(300)
" 2>/dev/null || echo "300")

judge_model="${JUDGE_MODEL:-}"

# Build judge prompt from coder output + acceptance criteria
coder_output=$(cat "${attempt_dir}/coder/stdout.log" 2>/dev/null || echo "(no coder output)")
goal=$(python3 -c "import json; print(json.load(open('$task_json')).get('goal',''))" 2>/dev/null || echo "")
acceptance=$(python3 -c "import json; print(json.load(open('$task_json')).get('acceptance',''))" 2>/dev/null || echo "")

judge_prompt="You are a quality judge. Evaluate the following output against the acceptance criteria.

GOAL: ${goal}
ACCEPTANCE CRITERIA: ${acceptance}

CODER OUTPUT:
${coder_output}

Respond with a JSON verdict:
{\"verdict\": \"PASS\" or \"FAIL\", \"score\": 1-10, \"reasoning\": \"...\", \"feedback\": \"...\"}"

RDLOOP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIAPI_CONFIG="${RDLOOP_ROOT}/config/cliapi_providers.json"

base_url=$(python3 -c "
import json
try:
    cfg = json.load(open('$CLIAPI_CONFIG'))
    for name, p in cfg.get('providers', {}).items():
        print(p.get('base_url', 'http://127.0.0.1:8317/v1'))
        break
except: print('http://127.0.0.1:8317/v1')
" 2>/dev/null || echo "http://127.0.0.1:8317/v1")

{
  echo "[JUDGE][single/cliproxy] $(date -u +%Y-%m-%dT%H:%M:%SZ) LLM API call"

  response=$(timeout "$timeout_s" curl -s -X POST "${base_url}/chat/completions" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json, sys
payload = {
    'model': '${judge_model}' or 'default',
    'messages': [{'role': 'user', 'content': sys.stdin.read()}],
    'max_tokens': 4096,
    'temperature': 0.3
}
print(json.dumps(payload))
" <<< "$judge_prompt")" 2>&1)

  rc=$?

  # Extract and write verdict
  python3 -c "
import json, sys, re
try:
    data = json.loads(sys.stdin.read())
    content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    print(content)
    # Try to parse as JSON verdict
    match = re.search(r'\{[^}]*\"verdict\"[^}]*\}', content, re.DOTALL)
    if match:
        verdict = json.loads(match.group())
        json.dump(verdict, open('${verdict_file}', 'w'), indent=2)
    else:
        json.dump({'verdict': 'FAIL', 'score': 0, 'reasoning': 'Could not parse verdict', 'raw': content}, open('${verdict_file}', 'w'), indent=2)
except Exception as e:
    json.dump({'verdict': 'FAIL', 'score': 0, 'reasoning': str(e)}, open('${verdict_file}', 'w'), indent=2)
" <<< "$response" > "$output_file" 2>&1

  echo "[JUDGE][single/cliproxy] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
} > "$run_log" 2>&1

echo "$rc" > "${attempt_dir}/judge/rc.txt"
exit "${rc:-0}"
