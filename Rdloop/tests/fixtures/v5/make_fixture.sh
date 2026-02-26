#!/usr/bin/env bash
set -euo pipefail

type=""
executor_type="api_call"
out=""

while [ $# -gt 0 ]; do
  case "$1" in
    --type) type="${2:-}"; shift 2 ;;
    --executor-type) executor_type="${2:-api_call}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$type" ]; then
  echo "--type is required" >&2
  exit 2
fi

if [ -z "$out" ]; then
  out="$(mktemp -d)/fixture.json"
fi

mk_bare_repo() {
  local dir
  dir="$(mktemp -d)"
  git init --bare "$dir/repo.git" >/dev/null 2>&1
  echo "$dir/repo.git"
}

case "$type" in
  v4-single)
    cat > "$out" <<JSON
{"task_id":"v4_single","workflow_mode":"single","goal":"g","acceptance":"a"}
JSON
    ;;
  v4-solo)
    cat > "$out" <<JSON
{"task_id":"v4_solo","workflow_mode":"solo","goal":"g","acceptance":"a"}
JSON
    ;;
  v4-collab)
    cat > "$out" <<JSON
{"task_id":"v4_collab","workflow_mode":"collab","goal":"g","acceptance":"a"}
JSON
    ;;
  v5-api_call-fresh)
    cat > "$out" <<JSON
{"task_id":"v5_api_fresh","executor_type":"api_call","session_mode":"fresh","goal":"g","acceptance":"a"}
JSON
    ;;
  v5-api_call-iterative)
    cat > "$out" <<JSON
{"task_id":"v5_api_iter","executor_type":"api_call","session_mode":"iterative","goal":"g","acceptance":"a"}
JSON
    ;;
  v5-solo_agent)
    cat > "$out" <<JSON
{"task_id":"v5_solo","executor_type":"solo_agent","session_mode":"continuous","goal":"g","acceptance":"a"}
JSON
    ;;
  v5-multi_agent)
    cat > "$out" <<JSON
{"task_id":"v5_multi","executor_type":"multi_agent","session_mode":"continuous","goal":"g","acceptance":"a","collab_roles":{"executor":"codex","reviewer":"gemini"}}
JSON
    ;;
  bare-repo)
    mk_bare_repo
    exit 0
    ;;
  pr-description)
    cat > "$out" <<TXT
# PR Description (${executor_type})

## 产出摘要
- 实现关键功能
- 完成测试

## 已知欠债
- [low] 待补充边界测试
TXT
    ;;
  *)
    echo "Unsupported --type: $type" >&2
    exit 2
    ;;
esac

echo "$out"
