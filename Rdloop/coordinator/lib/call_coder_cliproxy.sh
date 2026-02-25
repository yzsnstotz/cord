#!/usr/bin/env bash
# call_coder_cliproxy.sh — Single Flow adapter (LLM API call, no coding agent)
# Makes a one-shot LLM call via CLI proxy API. No file I/O, no tool use.

task_json="$1"; attempt_dir="$2"; worktree_dir="$3"; instruction_path="$4"
mkdir -p "${attempt_dir}/coder"

run_log="${attempt_dir}/coder/run.log"
output_file="${attempt_dir}/coder/stdout.log"

timeout_s=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('coder_timeout_seconds',600))
except: print(600)
" 2>/dev/null || echo "600")

coder_model="${CODER_MODEL:-}"
instruction=$(cat "$instruction_path" 2>/dev/null || echo "")

# Resolve CLI proxy endpoint from cliapi_providers.json
RDLOOP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIAPI_CONFIG="${RDLOOP_ROOT}/config/cliapi_providers.json"

base_url=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('$CLIAPI_CONFIG'))
    providers = cfg.get('providers', {})
    model = '${coder_model}'
    for name, p in providers.items():
        models = p.get('models', [])
        if isinstance(models, list):
            model_ids = [m.get('id','') if isinstance(m,dict) else str(m) for m in models]
        else:
            model_ids = []
        if model in model_ids or not model:
            print(p.get('base_url', 'http://127.0.0.1:8317/v1'))
            sys.exit(0)
    print('http://127.0.0.1:8317/v1')
except: print('http://127.0.0.1:8317/v1')
" 2>/dev/null || echo "http://127.0.0.1:8317/v1")

{
  echo "[CODER][single/cliproxy] $(date -u +%Y-%m-%dT%H:%M:%SZ) LLM API call"
  echo "[CODER][single/cliproxy] model=${coder_model} timeout=${timeout_s}s"
  echo "[CODER][single/cliproxy] base_url=${base_url}"

  # Make LLM API call via curl
  response=$(timeout "$timeout_s" curl -s -X POST "${base_url}/chat/completions" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json, sys
msg = sys.stdin.read()
payload = {
    'model': '${coder_model}' or 'default',
    'messages': [{'role': 'user', 'content': msg}],
    'max_tokens': 8192,
    'temperature': 0.7
}
print(json.dumps(payload))
" <<< "$instruction")" 2>&1)

  rc=$?
  if [ "$rc" = "124" ]; then
    echo "[CODER][single/cliproxy] TIMEOUT after ${timeout_s}s"
    echo "TIMEOUT" >> "$run_log"
  fi

  # Extract content from response
  python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    print(content)
except Exception as e:
    print(f'Error parsing response: {e}', file=sys.stderr)
" <<< "$response" > "$output_file" 2>&1

  echo "[CODER][single/cliproxy] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
} > "$run_log" 2>&1

echo "$rc" > "${attempt_dir}/coder/rc.txt"
exit "${rc:-0}"
