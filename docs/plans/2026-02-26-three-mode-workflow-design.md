# Three-Mode Workflow Redesign + Knowledge Shards + Agent Start Fix

**Date:** 2026-02-26
**Scope:** Rdloop GUI (server.js + app.js), Coordinator (run_task.sh + new adapters), Agent tools (write_knowledge_cache.py), CCB integration
**Architecture ref:** Arch/integrated_architecture_v3.md

---

## 1. Knowledge Shard System

### 1.1 Current state

Single `<project>/.context/knowledge_cache.json` with all entries in one flat object. Knowledge reader must load entire cache regardless of which module it needs.

### 1.2 Shard directory layout

```
<project>/.context/knowledge/
  _meta.json           # shard registry
  auth.json            # shard: auth module
  api.json             # shard: API layer
  frontend.json        # shard: frontend
  ...                  # one file per system module
```

**_meta.json:**
```json
{
  "version": "1.0",
  "project": "<name>",
  "shards": {
    "auth": {
      "description": "Authentication and authorization module",
      "entry_count": 5,
      "last_updated": "2026-02-26T10:00:00Z"
    }
  }
}
```

**Each shard file:**
```json
{
  "version": "1.0",
  "shard": "auth",
  "description": "Authentication and authorization module",
  "last_updated": "2026-02-26T10:00:00Z",
  "entries": {
    "src/auth.py": {
      "type": "file",
      "owner_task": "T01",
      "summary": "JWT auth module. Public: verify_token, issue_token.",
      "interface_hash": "abc123",
      "last_modified_by": "T01",
      "last_modified_at": "2026-02-26T09:00:00Z",
      "written_by": "executor"
    },
    "task:T01": {
      "type": "task",
      "title": "Implement JWT auth",
      "decision": "PASS",
      "written_by": "PM"
    }
  }
}
```

### 1.3 Write path changes

**write_knowledge_cache.py** gains `--shard <name>` (required):

```bash
# PM writes task entry to a shard
python3 $TOOLS_ROOT/write_knowledge_cache.py \
  --project-path <path> --writer pm --task-id T01 \
  --shard auth --entry-json '{"type":"task","title":"..."}'

# Executor writes file entries (can target multiple shards)
python3 $TOOLS_ROOT/write_knowledge_cache.py \
  --project-path <path> --writer executor --task-id T01 \
  --shard auth --final-summary <path>
```

On write:
1. Acquire fcntl LOCK_EX on `<shard>.json.lock`
2. Read shard, merge entries, atomic write (temp -> fsync -> rename)
3. Update `_meta.json` entry_count and last_updated

If shard file doesn't exist, create it and register in `_meta.json`.

### 1.4 Read path changes

Knowledge reader (agent, init_knowledge_agent.sh) loads `_meta.json` as index, then loads only relevant shard(s) by filename. The reader can determine module scope from the shard filename without loading contents.

### 1.5 Migration

One-time script `migrate_knowledge_cache.py`:
- Reads existing `knowledge_cache.json`
- Groups entries by a heuristic (file path prefix -> module name) or puts all in a `default` shard
- Writes shard files + `_meta.json`
- Renames original to `knowledge_cache.json.bak`

Fallback: if `knowledge/` dir doesn't exist but `knowledge_cache.json` does, tools read the old file.

### 1.6 New API endpoints (server.js)

```
GET    /api/knowledge/shards                      # list _meta.json
GET    /api/knowledge/shards/:shard               # entries for one shard
POST   /api/knowledge/shards                      # create new shard { name, description }
PUT    /api/knowledge/shards/:shard               # update shard metadata { description }
PUT    /api/knowledge/shards/:shard/entries/:key   # create/update entry
DELETE /api/knowledge/shards/:shard/entries/:key   # delete entry
DELETE /api/knowledge/shards/:shard               # delete entire shard
```

All write endpoints use atomic write + fcntl lock, same pattern as existing knowledge_cache.json reader in server.js.

Path validation: shard name must be `[a-z0-9_-]+`, key is URL-encoded entry key (e.g. `src%2Fauth.py` or `task%3AT01`).

### 1.7 GUI: Knowledge Agent settings (in Settings panel)

New collapsible section in `openSettingsPanel()`:

```
Knowledge Agent
  ☑ Enable knowledge agent
  Provider: [codex ▼]
  Project path: [/path/to/project]     (validated on blur)
  [View Knowledge] button → opens Knowledge Viewer modal
```

Stored in `rdloop.config.json`:
```json
{
  "knowledge_enabled": true,
  "knowledge_provider": "codex",
  "knowledge_project_path": "/path/to/project"
}
```

### 1.8 GUI: Knowledge Viewer modal

Opened from Settings or a nav element. Layout:

```
┌─ Knowledge Viewer ──────────────────────────────────────┐
│                                                         │
│  ┌─ Shards ──────┐  ┌─ Entries ───────────────────────┐ │
│  │                │  │                                 │ │
│  │  auth     (5)  │  │  Key          Summary     Type │ │
│  │  api      (3)  │  │  src/auth.py  JWT auth..  file │ │
│  │  frontend (2)  │  │  task:T01     Impl JWT..  task │ │
│  │  ─────────     │  │  [click row to edit inline]    │ │
│  │  + New Shard   │  │                                 │ │
│  │                │  │  [+ Add Entry]                  │ │
│  └────────────────┘  └─────────────────────────────────┘ │
│                                                         │
│  [Close]                                                │
└─────────────────────────────────────────────────────────┘
```

- Left sidebar: shard list from `GET /api/knowledge/shards`
- Click shard: loads entries from `GET /api/knowledge/shards/:shard`
- Click entry row: inline edit (summary, type fields). Save → `PUT .../entries/:key`
- "+ Add Entry": form for key + type + summary → `PUT .../entries/:key`
- Delete entry: trash icon per row → `DELETE .../entries/:key`
- "+ New Shard": form for name + description → `POST /api/knowledge/shards`
- Delete shard: trash icon per shard → `DELETE /api/knowledge/shards/:shard`

---

## 2. CCB Agent Start Button Fix

### 2.1 Root cause

GUI spawns `python3 ccb <providers>` with `CCB_GUI_LAUNCH=1` detached. CCB detects no TTY, creates a new tmux session named `ccb_<pid>` via `os.execv`. The `os.execv` replaces the process, so the original child PID that Node.js tracks is gone.

Server then checks `tmux list-sessions` for sessions matching `isCcbNativeSessionName()` which looks for `ccb-<hex>` pattern (dash + hex). The GUI-launched session is `ccb_<pid>` (underscore + decimal). **Pattern mismatch** → session not found → all providers show "off".

### 2.2 Fix: server.js session name detection

**isCcbNativeSessionName()** — extend to also match `ccb_<digits>`:

```javascript
function isCcbNativeSessionName(name) {
  // existing: ccb-<hex> (CCB native)
  if (/^ccb-[0-9a-f]+$/.test(name)) return true;
  // new: ccb_<pid> (GUI-launched via CCB_GUI_LAUNCH execv)
  if (/^ccb_\d+$/.test(name)) return true;
  return false;
}
```

### 2.3 Fix: post-spawn detection with retry

Current: wait 2s, check once.

New: poll at 1s, 3s, 6s, 10s with early exit on first success:

```javascript
// In POST /api/ccb/session/start handler
let foundSession = null;
for (const delay of [1000, 2000, 3000, 4000]) {
  await new Promise(r => setTimeout(r, delay));
  const listResult = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
  const allNames = (listResult.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  foundSession = allNames.find(n => isCcbNativeSessionName(n));
  if (foundSession) break;
}
```

### 2.4 Fix: always surface stderr

Current: stderr only shown when ALL providers fail. Change to always include in response:

```javascript
res.json({
  ok: true,
  sessions,
  session_ids: [...],
  errors,
  ccb_stderr: stderrSnippet || undefined  // always include
});
```

### 2.5 Fix: individual provider start into existing session

Current: each `ccbStartProviders(['codex'])` spawns a new CCB process, potentially creating multiple sessions.

New: before spawning, check if a CCB session already exists. If so, skip spawn (the existing session already has all providers, since `ccb` starts all requested providers in one session).

```javascript
// Before spawning, check for existing session
const existingList = await runTmux(['list-sessions', '-F', '#{session_name}'], env, 2000);
const existingCcb = (existingList.stdout || '').split('\n')
  .map(s => s.trim()).filter(isCcbNativeSessionName);
if (existingCcb.length > 0) {
  // Session exists — just ping providers and return status
  // Don't spawn another CCB process
}
```

### 2.6 Fix: frontend polling extension

Current: polls at 2s, 4s, 6s, 8s. Extend:

```javascript
// In ccbStartProviders()
[2000, 4000, 6000, 8000, 12000, 16000].forEach(ms =>
  setTimeout(refreshCcbPanelContent, ms));
```

Show "Starting... (waiting for session)" in the notice until first successful status.

---

## 3. Three-Mode Workflow Redesign

### 3.1 Mode definitions

| Mode | Provider Type | Agent Communication | User Visibility |
|------|--------------|-------------------|-----------------|
| **Single Flow** | LLM API only (cliproxyapi, cursorcliapi) | One-shot API call per attempt | Log files only |
| **Solo Agent** | Coding agent (claude CLI, codex CLI, cursor CLI) | Extended bridge: coordinator ↔ agent via JSON request/response | Visible tmux pane |
| **Collab** | CCB multi-agent (cask/gask/oask/dask/lask) | CCB /ask + pend protocol | CCB tmux panes |

### 3.2 Provider boundary enforcement

```
Single Flow adapters (LLM API, no coding agent capabilities):
  call_coder_cliproxy.sh    — CLI proxy to LLM API
  call_coder_cursorapi.sh   — Cursor CLI API wrapper
  (future: any direct LLM API adapter)

Solo Agent adapters (coding agent, full tool use):
  call_coder_solo.sh        — extended bridge in visible tmux (NEW)

Collab adapters (CCB multi-agent):
  call_coder_ccb.sh         — /ask to CCB provider
  call_judge_ccb.sh         — /ask to CCB reviewer
```

Existing adapters (call_coder_claude_bridge.sh, call_coder_codex.sh, call_coder_mock.sh) remain available as-is but are not exposed in the new mode UI. They can still be used via the Advanced JSON editor.

### 3.3 New/Edit modal restructure

**Top-level mode selector** replaces execution_mode + separate template/type dropdowns:

```
Workflow Mode:  [ Single Flow | Solo Agent | Collab ]    ← top-level toggle

Type:           [ requirements_doc ▼ ]                   ← merged template + task_type
                  requirements_doc
                  engineering_impl
                  douyin_script
                  storyboard
                  paid_mini_drama
                  custom (blank)
```

Type determines: rubric dimensions, instruction field labels/placeholders, default constraints, pre-fill values.

### 3.4 Single Flow mode — UI sections

```
┌─ Type ───────────────────────────────────────┐
│  [requirements_doc ▼]                        │
├─ Provider ───────────────────────────────────┤
│  LLM API: [cliproxyapi ▼]  Model: [gpt-4 ▼] │
├─ Instruction ────────────────────────────────┤
│  (label varies by type: "Goal" / "Script     │
│   requirements" / "Document brief")           │
│  [textarea]                                  │
├─ Acceptance & Scoring ───────────────────────┤
│  acceptance_criteria [textarea]              │
│  ☐ Enable judge review                      │
│    → if checked: judge API adapter,          │
│      max_attempts, rubric thresholds (by     │
│      type), judge_timeout                    │
├─ Timeouts ───────────────────────────────────┤
│  coder_timeout_seconds                       │
├─ Attempt Context Mode ───────────────────────┤
│  [fresh_each ▼ | iterative]                  │
├─ Advanced (JSON) ────────────────────────────┤
│  [collapsible raw editor]                    │
└──────────────────────────────────────────────┘
```

**Hidden:** repo/git, collab roles, execution channel, CCB config, knowledge settings.

### 3.5 Solo Agent mode — UI sections

```
┌─ Type ───────────────────────────────────────┐
│  [engineering_impl ▼]                        │
├─ Coding Agent ───────────────────────────────┤
│  Agent: [claude_cli ▼]  Model: [opus ▼]     │
├─ Instruction ────────────────────────────────┤
│  Goal: [textarea]                            │
│  Constraints: [textarea]                     │
├─ Repo & Git ─────────────────────────────────┤
│  repo_path, base_ref,                        │
│  allowed_paths, forbidden_globs              │
├─ Agent Loop Config ──────────────────────────┤
│  max_iterations: [10]                        │
│  test_cmd: [bash run_tests.sh]               │
│                                              │
│  Approval mode:                              │
│    ○ Agent decides when to exit              │
│    ○ Step-by-step approval                   │
│                                              │
│  Session strategy:                           │
│    ○ Continuous session                      │
│    ○ Fresh session per step                  │
│                                              │
│  Auto-pass threshold: [0.85]                 │
├─ Knowledge ──────────────────────────────────┤
│  ☑ Enable knowledge read/write               │
│  Project path: [/path/to/project]            │
│  Relevant shards: [auth, api] (multi-select) │
├─ Observation ────────────────────────────────┤
│  ☑ Open agent terminal on start              │
├─ Advanced (JSON) ────────────────────────────┤
│  [collapsible raw editor]                    │
└──────────────────────────────────────────────┘
```

**Hidden:** collab roles, execution channel, judge adapter (agent self-reviews).

### 3.6 Collab mode — UI sections

```
┌─ Type ───────────────────────────────────────┐
│  [engineering_impl ▼]                        │
├─ Collab Roles ───────────────────────────────┤
│  PM:          [claude] (fixed)               │
│  executor:    [claude ▼]                     │
│  reviewer:    [codex ▼]                      │
│  designer:    [claude ▼]                     │
│  inspiration: [gemini ▼]                     │
├─ Instruction ────────────────────────────────┤
│  [textarea]                                  │
├─ Repo & Git ─────────────────────────────────┤
│  repo_path, base_ref,                        │
│  allowed_paths, forbidden_globs              │
├─ Acceptance & Scoring ───────────────────────┤
│  acceptance_criteria, test_cmd, max_attempts │
│  rubric thresholds (by type)                 │
│  coder_timeout, judge_timeout                │
├─ Knowledge ──────────────────────────────────┤
│  ☑ Enable knowledge read/write               │
│  Project path, relevant shards               │
├─ Advanced (JSON) ────────────────────────────┤
│  [collapsible raw editor]                    │
└──────────────────────────────────────────────┘
```

Per Arch/integrated_architecture_v3.md: `execution_mode: "semi-auto"`, CCB adapters, full attempt loop with judge scoring.

### 3.7 task.json schema additions

```json
{
  "schema_version": "v1",
  "task_id": "my_task",
  "workflow_mode": "single|solo|collab",
  "type": "requirements_doc|engineering_impl|douyin_script|storyboard|paid_mini_drama|custom",

  "goal": "...",
  "acceptance": "...",
  "constraints": [],

  "judge_enabled": true,

  "solo_config": {
    "max_iterations": 10,
    "approval_mode": "agent_decides|step2step",
    "session_strategy": "continuous|fresh_per_step",
    "auto_pass_threshold": 0.85,
    "knowledge_shards": ["auth", "api"],
    "open_terminal": true
  },

  "collab_roles": {
    "executor": "claude",
    "reviewer": "codex",
    "designer": "claude",
    "inspiration": "gemini"
  },

  "knowledge_enabled": true,
  "knowledge_project_path": "/path/to/project",

  "repo_path": "...",
  "base_ref": "main",
  "allowed_paths": [],
  "forbidden_globs": [],
  "test_cmd": "...",
  "max_attempts": 3,
  "coder": "cliproxy|solo|ccb",
  "coder_model": "...",
  "judge": "cliproxy|ccb",
  "judge_model": "...",
  "coder_timeout_seconds": 600,
  "judge_timeout_seconds": 300,
  "attempt_context_mode": "fresh_each|iterative"
}
```

Fields set automatically by mode selection:
- `single`: `coder` = cliproxy/cursorapi, `judge_enabled` toggleable, no `solo_config`, no `collab_roles`, no `repo_path` required
- `solo`: `coder` = solo, `judge_enabled` = false (agent self-reviews), `solo_config` required
- `collab`: `coder` = ccb, `judge` = ccb, `collab_roles` required, `execution_mode` = semi-auto

### 3.8 Extended bridge — solo_bridge.sh

New file: `coordinator/lib/solo_bridge.sh`

```bash
#!/usr/bin/env bash
# solo_bridge.sh — provider-agnostic bridge for solo agent mode
# Runs in visible tmux pane. Coordinator communicates via JSON files.
#
# Usage: solo_bridge.sh <provider> <session_dir> <attempt_dir> [--fresh-per-step]
#
# Protocol:
#   Coordinator writes: <session_dir>/request.json
#   Bridge detects new request, sends to agent, waits for completion
#   Bridge writes: <session_dir>/response.json
#   Coordinator reads response, decides next action, writes next request
#   Bridge exits when coordinator writes: <session_dir>/control.json { "action": "exit" }
```

Provider dispatch within bridge:
```
claude  → claude -p @<instruction_file> --cwd <dir> --dangerously-skip-permissions --output-format json
codex   → codex --prompt @<instruction_file> --cwd <dir> --auto-edit --json
cursor  → cursor-agent --prompt @<instruction_file> --cwd <dir>
```

For `--fresh-per-step`: bridge restarts the agent CLI process for each request (new session). For continuous: bridge sends follow-up prompts to the same running agent session.

### 3.9 New adapter — call_coder_solo.sh

New file: `coordinator/lib/call_coder_solo.sh`

```bash
#!/usr/bin/env bash
# call_coder_solo.sh — solo agent mode adapter
# Spawns extended bridge in visible tmux, runs coordinator-agent loop

task_json="$1"; attempt_dir="$2"; worktree_dir="$3"; instruction_path="$4"

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
tmux new-session -d -s "$tmux_session" -c "$worktree_dir"

# Start bridge in tmux
fresh_flag=""
[ "$session_strategy" = "fresh_per_step" ] && fresh_flag="--fresh-per-step"
tmux send-keys -t "$tmux_session" \
  "bash ${COORDINATOR_LIB}/solo_bridge.sh ${bridge_provider} ${session_dir} ${attempt_dir} ${fresh_flag}" Enter

# Open terminal for user if configured
if [ "$open_terminal" = "true" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    osascript -e "tell application \"Terminal\" to do script \"tmux attach -t ${tmux_session}\""
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
        [ "$(stat -f%m "${session_dir}/response.json" 2>/dev/null || echo 0)" -le \
          "$(stat -f%m "${session_dir}/request.json" 2>/dev/null || echo 999999999)" ]; do
    sleep 5
    elapsed=$((elapsed + 5))
    if [ "$elapsed" -ge "$timeout_s" ]; then
      echo '{"self_eval":"dead_loop","summary":"timeout"}' > "${step_dir}/response.json"
      break
    fi
  done

  # Copy response to step dir
  cp "${session_dir}/response.json" "${step_dir}/response.json"

  # Run coordinator decision (deterministic, no LLM)
  decision=$(python3 "${COORDINATOR_LIB}/decision_solo.py" \
    --response "${step_dir}/response.json" \
    --iteration "$iteration" \
    --max-iterations "$max_iterations" \
    --approval-mode "$approval_mode" \
    --auto-pass-threshold "$auto_pass_threshold" \
    --test-cmd "$test_cmd" 2>/dev/null)

  echo "$decision" > "${step_dir}/decision.json"

  action=$(echo "$decision" | python3 -c "import sys,json; print(json.load(sys.stdin).get('action','CONTINUE'))" 2>/dev/null || echo "CONTINUE")

  case "$action" in
    READY_FOR_REVIEW)
      # Write final summary from last response
      cp "${step_dir}/response.json" "${attempt_dir}/coder/stdout.log"
      echo "0" > "${attempt_dir}/coder/rc.txt"
      break
      ;;
    PAUSED_MANUAL|PAUSED_AGENT_STUCK|PAUSED_MAX_ITERATIONS|PAUSED_STEP_APPROVAL)
      echo "$action" > "${attempt_dir}/coder/pause_reason.txt"
      echo "2" > "${attempt_dir}/coder/rc.txt"
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
```

### 3.10 Coordinator decision logic — decision_solo.py

New file: `coordinator/lib/decision_solo.py`

```python
#!/usr/bin/env python3
"""Deterministic decision logic for solo agent mode. No LLM tokens."""

import json
import sys
import argparse
import subprocess

def decide(response, iteration, max_iterations, approval_mode, auto_pass_threshold, test_cmd):
    self_eval = response.get("self_eval", "")
    confidence = response.get("confidence", 0.0)
    test_result = response.get("test_result", {})
    next_action = response.get("next_action", "")

    # 1. Agent explicitly requests exit
    if self_eval == "goal_met":
        return {"action": "READY_FOR_REVIEW", "reason": "agent reports goal met"}
    if self_eval == "need_user_input":
        return {"action": "PAUSED_MANUAL", "reason": response.get("question_for_user", "agent needs user input")}
    if self_eval == "dead_loop":
        return {"action": "PAUSED_AGENT_STUCK", "reason": "agent reports dead loop"}

    # 2. Iteration limit
    if iteration >= max_iterations:
        return {"action": "PAUSED_MAX_ITERATIONS", "reason": f"reached max iterations ({max_iterations})"}

    # 3. Step-by-step approval
    if approval_mode == "step2step":
        return {"action": "PAUSED_STEP_APPROVAL", "reason": f"step {iteration} complete, awaiting user approval"}

    # 4. Tests all pass + high confidence → auto-complete
    if test_result:
        passed = test_result.get("passed", 0)
        total = test_result.get("total", 0)
        if total > 0 and passed == total and confidence >= auto_pass_threshold:
            return {"action": "READY_FOR_REVIEW", "reason": f"tests {passed}/{total} pass, confidence {confidence} >= {auto_pass_threshold}"}

    # 5. Default: continue
    return {"action": "CONTINUE", "reason": "continuing to next iteration"}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--response", required=True)
    parser.add_argument("--iteration", type=int, required=True)
    parser.add_argument("--max-iterations", type=int, default=10)
    parser.add_argument("--approval-mode", default="agent_decides")
    parser.add_argument("--auto-pass-threshold", type=float, default=0.85)
    parser.add_argument("--test-cmd", default="")
    args = parser.parse_args()

    with open(args.response) as f:
        response = json.load(f)

    result = decide(response, args.iteration, args.max_iterations,
                    args.approval_mode, args.auto_pass_threshold, args.test_cmd)
    print(json.dumps(result))
```

### 3.11 Coordinator routing (run_task.sh changes)

In the main attempt loop, add workflow_mode routing:

```bash
workflow_mode=$(json_read "$TASK_JSON" "workflow_mode" "collab")

case "$workflow_mode" in
  single)
    # LLM API only, no git worktree unless repo_path given
    [ -n "$repo_path" ] && setup_worktree || worktree_dir="$OUT_DIR/$task_id"
    call_coder="call_coder_cliproxy.sh"
    judge_enabled=$(json_read "$TASK_JSON" "judge_enabled" "true")
    if [ "$judge_enabled" = "false" ]; then
      # Skip judge, auto-PASS
      state="READY_FOR_REVIEW"
    else
      call_judge="call_judge_cliproxy.sh"
      # Normal attempt loop with judge
    fi
    ;;
  solo)
    setup_worktree
    call_coder="call_coder_solo.sh"
    # Solo mode: single attempt, agent self-loops internally
    # No external judge — agent self-reviews
    # Coordinator reads exit code from call_coder_solo.sh
    ;;
  collab)
    # Existing semi-auto flow per architecture doc
    execution_mode="semi-auto"
    setup_worktree
    call_coder="call_coder_ccb.sh"
    call_judge="call_judge_ccb.sh"
    ;;
esac
```

### 3.12 Solo step tracking in GUI

New attempt view sub-panel for solo mode tasks:

```
┌─ Solo Agent Progress ─────────────────────────────────┐
│  Step 1/10 — design      ✓ completed                  │
│    Summary: Analyzed codebase, created implementation  │
│    plan for JWT auth module.                           │
│                                                        │
│  Step 2/10 — execute     ✓ completed                  │
│    Summary: Implemented verify_token and issue_token.  │
│    Tests: 3/5 pass                                     │
│                                                        │
│  Step 3/10 — fix         ● in progress                │
│    ...                                                 │
│                                                        │
│  [Open Agent Terminal]  [Pause]  [Abort]               │
└────────────────────────────────────────────────────────┘
```

Data source: `GET /api/task/:taskId/attempt/:n/solo-steps` — reads `solo/step_*/response.json` files.

For step2step approval mode, a "Proceed" button appears after each paused step. User can also type feedback that gets included in the next request.

---

## 4. Agent System Integration

### 4.1 Mode ↔ Agent system mapping

| Component | Single Flow | Solo Agent | Collab |
|-----------|------------|------------|--------|
| AGENT.md rules | N/A (no Agent session) | startup.md, file_ops.md, task_mgmt.md, exceptions.md | Full: cli_collab.md, collab_context.md, model_routing.md |
| PM role | Coordinator acts as PM (no Agent PM session) | Coordinator acts as PM; agent is executor | Agent PM (Claude session) per collab_context.md |
| Knowledge write | No | call_coder_solo.sh triggers write_knowledge_cache.py --shard on READY_FOR_REVIEW | run_rdloop_task.sh triggers write_knowledge_cache.py --shard on READY_FOR_REVIEW |
| Knowledge read | No | Shard contents loaded in meta-instruction at step start | Workers query knowledge agent via CCB |
| state_update.sh | Coordinator calls directly | Coordinator calls directly | PM calls via bash (sole authority) |
| session_state.json | Updated by coordinator on task status change | Updated by coordinator on task status change | Updated by PM (Agent session) |
| Tracking | attempt_dir only | attempt_dir + solo/step_* tracking | attempt_dir + .ccb/state.json |

### 4.2 Provider type enforcement

The Agent system must distinguish LLM API calls from coding agent invocations:

```
rdloop.config.json additions:
{
  "provider_types": {
    "cliproxyapi": "llm_api",
    "cursorcliapi": "llm_api",
    "claude_cli": "coding_agent",
    "codex_cli": "coding_agent",
    "cursor_cli": "coding_agent",
    "ccb": "multi_agent"
  }
}
```

Coordinator validates on task start:
- `workflow_mode: "single"` → coder must be `llm_api` type
- `workflow_mode: "solo"` → coder must be `coding_agent` type
- `workflow_mode: "collab"` → coder must be `multi_agent` type (ccb)

Mismatch → PAUSED_POLICY with clear error message.

### 4.3 Knowledge shard integration with Agent tools

**write_knowledge_cache.py** changes:
- Add `--shard <name>` parameter (required when knowledge/ dir exists)
- Add `--create-shard` flag to auto-create shard if missing
- Keep backward compat: if knowledge/ dir doesn't exist, write to knowledge_cache.json

**init_knowledge_agent.sh** changes:
- Load `_meta.json` as shard index
- Knowledge agent session gets shard list in system prompt (not all contents — just names + descriptions)
- Agent queries specific shards on demand

**run_rdloop_task.sh** changes:
- On READY_FOR_REVIEW: extract `knowledge_entries` from final_summary.json, determine target shard(s), call write_knowledge_cache.py with --shard
- Shard determination: use `solo_config.knowledge_shards` if set, otherwise infer from file paths (e.g. `src/auth/*` → auth shard)

---

## 5. File Change Summary

### New files
| File | Purpose |
|------|---------|
| `coordinator/lib/call_coder_solo.sh` | Solo agent mode adapter — extended bridge + coordinator loop |
| `coordinator/lib/solo_bridge.sh` | Provider-agnostic bridge for solo mode — runs in visible tmux |
| `coordinator/lib/decision_solo.py` | Deterministic decision logic for solo coordinator loop |
| `coordinator/lib/call_coder_cliproxy.sh` | Single flow adapter — LLM API call |
| `coordinator/lib/call_judge_cliproxy.sh` | Single flow judge adapter — LLM API call |
| `Agent/.context/tools/migrate_knowledge_cache.py` | One-time migration: knowledge_cache.json → shards |

### Modified files
| File | Changes |
|------|---------|
| `gui/server.js` | Fix isCcbNativeSessionName(); add retry polling; add knowledge shard CRUD endpoints; add solo-steps endpoint; add provider_types validation |
| `gui/public/app.js` | Three-mode new/edit modal; knowledge viewer modal; settings knowledge section; solo progress panel; merged type/template dropdown; frontend polling extension |
| `gui/public/style.css` | Knowledge viewer styles; mode-toggle styles; solo progress panel styles |
| `coordinator/run_task.sh` | workflow_mode routing (single/solo/collab); provider type validation; knowledge shard write on completion |
| `Agent/.context/tools/write_knowledge_cache.py` | Add --shard parameter; shard file I/O; _meta.json updates |
| `Agent/.context/tools/init_knowledge_agent.sh` | Load shard index instead of single cache file |
| `rdloop.config.json` | Add knowledge_enabled, knowledge_provider, knowledge_project_path, provider_types |

### Unchanged
| File | Reason |
|------|--------|
| `CCB/*` | Zero changes per architecture doc |
| `coordinator/lib/call_coder_ccb.sh` | Collab mode adapter unchanged |
| `coordinator/lib/call_judge_ccb.sh` | Collab mode judge unchanged |
| `coordinator/lib/call_coder_claude_bridge.sh` | Legacy auto adapter, still works via Advanced JSON |
| `coordinator/lib/call_coder_codex.sh` | Legacy adapter, still works |
| `coordinator/lib/call_coder_mock.sh` | Test adapter, still works |
