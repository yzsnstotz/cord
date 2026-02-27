#!/usr/bin/env bash
# migrate_task_json_v51.sh — migrate task.json from legacy formats to v5.1.
# Default behavior writes <input>.v51.json and keeps the source file unchanged.
#
# Usage:
#   migrate_task_json_v51.sh [--in-place] [--keep-legacy|--drop-legacy] <task.json> [<task.json> ...]
#
# Notes:
# - Deterministic: migration depends only on input fields.
# - Idempotent: rerunning with same flags yields byte-identical output.
# - No silent fallback: unresolved task_type/launch_mode fails with remediation hints.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: migrate_task_json_v51.sh [--in-place] [--keep-legacy|--drop-legacy] <task.json> [<task.json> ...]
  --in-place     Overwrite input files. Default writes <input>.v51.json.
  --keep-legacy  Keep deprecated fields (executor_type/session_mode/run_surface/workflow_mode) in output.
  --drop-legacy  Remove deprecated fields in output.
EOF
}

in_place=0
keep_legacy=""
drop_legacy=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --in-place)
      in_place=1
      shift
      ;;
    --keep-legacy)
      keep_legacy=1
      shift
      ;;
    --drop-legacy)
      drop_legacy=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Error: unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -lt 1 ]; then
  usage
  exit 1
fi

if [ -n "$keep_legacy" ] && [ -n "$drop_legacy" ]; then
  echo "Error: --keep-legacy and --drop-legacy are mutually exclusive." >&2
  exit 1
fi

# Safety default:
# - in-place keeps legacy fields unless explicitly dropped.
# - copy output drops legacy fields unless explicitly kept.
if [ "$in_place" -eq 1 ]; then
  [ -z "$keep_legacy" ] && [ -z "$drop_legacy" ] && keep_legacy=1
else
  [ -z "$keep_legacy" ] && [ -z "$drop_legacy" ] && drop_legacy=1
fi

for TASK_FILE in "$@"; do
  if [ ! -f "$TASK_FILE" ]; then
    echo "Error: file not found: ${TASK_FILE}" >&2
    exit 1
  fi

  out_file="$TASK_FILE"
  if [ "$in_place" -ne 1 ]; then
    case "$TASK_FILE" in
      *.json) out_file="${TASK_FILE%.json}.v51.json" ;;
      *) out_file="${TASK_FILE}.v51.json" ;;
    esac
  fi

  python3 - "$TASK_FILE" "$out_file" "${keep_legacy:-0}" "${drop_legacy:-0}" <<'PYEOF'
import json
import os
import sys

src, dst = sys.argv[1], sys.argv[2]
keep_legacy = sys.argv[3] == "1"
drop_legacy = sys.argv[4] == "1"

with open(src, encoding="utf-8") as f:
    data = json.load(f)

if not isinstance(data, dict):
    raise SystemExit(f"Error: {src} must be a JSON object")

changed = False

def norm_str(v):
    return str(v or "").strip()

def fail(msg):
    raise SystemExit(f"Error: {src}: {msg}")

valid_task_types = {"copywriting", "solo", "multi_agent"}
task_type = norm_str(data.get("task_type"))

task_from_executor = {
    "api_call": "copywriting",
    "solo_agent": "solo",
    "multi_agent": "multi_agent",
}.get(norm_str(data.get("executor_type")))

task_from_workflow = {
    "single": "copywriting",
    "solo": "solo",
    "collab": "multi_agent",
}.get(norm_str(data.get("workflow_mode")))

if task_type not in valid_task_types:
    candidates = []
    if task_from_executor:
        candidates.append(("executor_type", task_from_executor))
    if task_from_workflow:
        candidates.append(("workflow_mode", task_from_workflow))

    if len(candidates) == 2 and candidates[0][1] != candidates[1][1]:
        fail(
            "ambiguous task_type mapping: "
            f"executor_type->{candidates[0][1]} but workflow_mode->{candidates[1][1]}. "
            "Set task_type explicitly to one of copywriting|solo|multi_agent."
        )
    if candidates:
        task_type = candidates[0][1]
    else:
        fail(
            "cannot derive task_type from legacy fields. "
            "Provide task_type directly or set executor_type/workflow_mode to a supported value."
        )

if data.get("task_type") != task_type:
    data["task_type"] = task_type
    changed = True

valid_launch_modes = {"ccb", "bridge"}
launch_mode = norm_str(data.get("launch_mode")).lower()
if launch_mode not in valid_launch_modes:
    mode_from_surface = {
        "visual_ccb": "ccb",
        "bridge": "bridge",
    }.get(norm_str(data.get("run_surface")).lower())
    mode_from_exec = {
        "semi-auto": "ccb",
        "auto": "bridge",
    }.get(norm_str(data.get("execution_mode")).lower())

    candidates = []
    if mode_from_surface:
        candidates.append(("run_surface", mode_from_surface))
    if mode_from_exec:
        candidates.append(("execution_mode", mode_from_exec))
    if len(candidates) == 2 and candidates[0][1] != candidates[1][1]:
        fail(
            "ambiguous launch_mode mapping: "
            f"run_surface->{candidates[0][1]} but execution_mode->{candidates[1][1]}. "
            "Set launch_mode explicitly to ccb or bridge."
        )
    if candidates:
        launch_mode = candidates[0][1]
    else:
        fail(
            "cannot derive launch_mode from legacy fields. "
            "Provide launch_mode directly or set run_surface/execution_mode to a supported value."
        )

if data.get("launch_mode") != launch_mode:
    data["launch_mode"] = launch_mode
    changed = True

if "launch_mode_locked" not in data:
    data["launch_mode_locked"] = False
    changed = True
elif not isinstance(data.get("launch_mode_locked"), bool):
    # Keep migration deterministic by normalizing common legacy string/integer forms.
    raw_locked = data.get("launch_mode_locked")
    if isinstance(raw_locked, str) and raw_locked.strip().lower() in {"true", "false"}:
        data["launch_mode_locked"] = raw_locked.strip().lower() == "true"
    elif isinstance(raw_locked, int) and raw_locked in {0, 1}:
        data["launch_mode_locked"] = bool(raw_locked)
    else:
        fail("launch_mode_locked must be boolean (or convertible true/false).")
    changed = True

roles_in = data.get("collab_roles") if isinstance(data.get("collab_roles"), dict) else {}
provider = ""
agent_cfg = data.get("agent_config")
if isinstance(agent_cfg, dict):
    provider = norm_str(agent_cfg.get("provider"))
if not provider:
    for value in roles_in.values():
        provider = norm_str(value)
        if provider:
            break
if not provider:
    provider = "claude"

roles_out = dict(roles_in)
if task_type == "copywriting":
    roles_out = {
        "executor": norm_str(roles_in.get("executor")) or provider,
        "reviewer": norm_str(roles_in.get("reviewer")) or provider,
    }
elif task_type == "solo":
    # Solo must share a single provider for all roles.
    solo_provider = provider
    roles_out = {
        "pm": solo_provider,
        "designer": solo_provider,
        "executor": solo_provider,
        "reviewer": solo_provider,
    }
elif task_type == "multi_agent":
    roles_out = {
        "pm": norm_str(roles_in.get("pm")) or provider,
        "designer": norm_str(roles_in.get("designer")) or provider,
        "executor": norm_str(roles_in.get("executor")) or provider,
        "reviewer": norm_str(roles_in.get("reviewer")) or provider,
    }

if roles_out != roles_in:
    data["collab_roles"] = roles_out
    changed = True

if data.get("schema_version") != "v51":
    data["schema_version"] = "v51"
    changed = True

if drop_legacy and not keep_legacy:
    for key in ("executor_type", "session_mode", "run_surface", "workflow_mode"):
        if key in data:
            del data[key]
            changed = True

serialized = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
prev = None
if os.path.exists(dst):
    with open(dst, encoding="utf-8") as f:
        prev = f.read()

if prev == serialized:
    print(f"No changes needed: {src} -> {dst}")
else:
    tmp = dst + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(serialized)
    os.replace(tmp, dst)
    if changed or src != dst:
        print(f"Migrated: {src} -> {dst}")
    else:
        print(f"No changes needed: {src} -> {dst}")
PYEOF
done
