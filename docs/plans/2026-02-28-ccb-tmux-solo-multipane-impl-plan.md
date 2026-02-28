# CCB Tmux Auto-Bootstrap + Solo Multi-Pane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable visual mode (CCB) to auto-bootstrap a dedicated tmux session with all role panes, and enable solo mode to create independent contexts per role via separate panes/bridges.

**Architecture:** Two coordinator-level functions (`setup_task_tmux_session` and `setup_solo_panes`) are added to `run_task.sh`. CCB adapter scripts gain `--tmux-target` and `--ccb-session-dir` flags. Bridge adapter gains `--bridge-dir` override. GUI gets `tmux_session` in task detail + pane status panel in frontend.

**Tech Stack:** Bash (coordinator), tmux CLI, Node.js/Express (GUI server), vanilla JS (GUI frontend)

---

### Task 1: Add `setup_task_tmux_session()` to run_task.sh

**Files:**
- Modify: `Rdloop/coordinator/run_task.sh:2883-2901` (after `resolve_launch_mode_v51`, before `ccb_launch_pane`)

**Step 1: Add the function after `resolve_launch_mode_v51()` (line ~2882)**

Insert before `ccb_launch_pane()` at line 2884:

```bash
##############################################################################
# 10c. CCB tmux session setup (v5.1 visual mode)
##############################################################################
setup_task_tmux_session() {
  local task_id="$1" task_type="$2" provider="$3"
  local tmux_session="rdloop-${task_id}"
  provider=$(normalize_provider_v51 "$provider")

  # Determine roles based on task_type
  local roles=()
  case "$task_type" in
    copywriting) roles=(pm executor reviewer) ;;
    solo|multi_agent) roles=(pm designer executor reviewer) ;;
  esac
  local num_roles=${#roles[@]}

  # Kill existing session if stale
  if tmux has-session -t "$tmux_session" 2>/dev/null; then
    log_info "Tmux session '${tmux_session}' already exists, reusing"
    echo "$tmux_session"
    return 0
  fi

  # Create tmux session with first pane
  if ! tmux new-session -d -s "$tmux_session" -n "roles" -x 220 -y 50 2>/dev/null; then
    log_info "Failed to create tmux session '${tmux_session}', falling back to per-call bootstrap"
    echo ""
    return 0
  fi

  # Build 2x2 grid (or 1x3 for copywriting)
  if [ "$num_roles" -ge 2 ]; then
    tmux split-window -t "${tmux_session}:roles" -h 2>/dev/null || true
  fi
  if [ "$num_roles" -ge 3 ]; then
    tmux split-window -t "${tmux_session}:roles.0" -v 2>/dev/null || true
  fi
  if [ "$num_roles" -ge 4 ]; then
    tmux split-window -t "${tmux_session}:roles.1" -v 2>/dev/null || true
  fi

  # Resolve CCB launcher
  local ccb_launcher_cmd=""
  local ccb_path_cfg=""
  ccb_path_cfg=$(json_read "${RDLOOP_ROOT}/rdloop.config.json" "ccb_path" "" 2>/dev/null || echo "")
  if [ -n "$ccb_path_cfg" ] && [ -x "${ccb_path_cfg}/ccb" ]; then
    ccb_launcher_cmd="${ccb_path_cfg}/ccb"
  elif [ -n "$ccb_path_cfg" ] && [ -x "${ccb_path_cfg}/bin/ccb" ]; then
    ccb_launcher_cmd="${ccb_path_cfg}/bin/ccb"
  else
    ccb_launcher_cmd="$(command -v ccb 2>/dev/null || echo "")"
  fi

  # Resolve provider name for CCB
  local ccb_provider_name=""
  case "$provider" in
    claude) ccb_provider_name="claude" ;;
    codex) ccb_provider_name="codex" ;;
    gemini) ccb_provider_name="gemini" ;;
    opencode) ccb_provider_name="opencode" ;;
    droid) ccb_provider_name="droid" ;;
    *) ccb_provider_name="codex" ;;
  esac

  local ccb_session_suffix=""
  case "$ccb_provider_name" in
    claude) ccb_session_suffix="claude" ;;
    codex) ccb_session_suffix="codex" ;;
    gemini) ccb_session_suffix="gemini" ;;
    opencode) ccb_session_suffix="opencode" ;;
    droid) ccb_session_suffix="droid" ;;
    *) ccb_session_suffix="codex" ;;
  esac

  # Label and bootstrap each pane
  for i in "${!roles[@]}"; do
    local role="${roles[$i]}"
    local pane_ccb_dir="${TASK_DIR}/ccb_sessions/${role}"
    mkdir -p "${pane_ccb_dir}/.ccb/run" 2>/dev/null || true

    # Label the pane
    tmux send-keys -t "${tmux_session}:roles.${i}" \
      "printf '\\033]2;${role}\\033\\\\'; echo '=== ${role} pane (${tmux_session}) ==='" C-m 2>/dev/null || true

    # Bootstrap CCB provider in this pane if launcher available
    if [ -n "$ccb_launcher_cmd" ]; then
      tmux send-keys -t "${tmux_session}:roles.${i}" \
        "CCB_SESSION_FILE='${pane_ccb_dir}/.ccb/.${ccb_session_suffix}-session' CCB_RUN_DIR='${pane_ccb_dir}/.ccb/run' CCB_TERMINAL=tmux CCB_GUI_LAUNCH=1 '${ccb_launcher_cmd}' -a '${ccb_provider_name}'" C-m 2>/dev/null || true
    fi
  done

  # Store tmux session name in task_state.json
  python3 - "$TASK_DIR" "$tmux_session" <<'PY'
import json, os, sys
task_dir, tmux_session = sys.argv[1:3]
state_path = os.path.join(task_dir, "task_state.json")
data = {}
if os.path.exists(state_path):
    try:
        with open(state_path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
data["tmux_session"] = tmux_session
tmp = state_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, state_path)
PY

  write_event_ext "tmux_session_created" "{\"tmux_session\":\"${tmux_session}\",\"num_panes\":${num_roles},\"provider\":\"${ccb_provider_name}\"}"
  log_info "Created tmux session '${tmux_session}' with ${num_roles} panes"
  echo "$tmux_session"
}
```

**Step 2: Commit**

```bash
git add Rdloop/coordinator/run_task.sh
git commit -m "feat(coordinator): add setup_task_tmux_session() for CCB visual mode"
```

---

### Task 2: Add `setup_solo_panes()` to run_task.sh

**Files:**
- Modify: `Rdloop/coordinator/run_task.sh` (insert after `setup_task_tmux_session`)

**Step 1: Add the function**

```bash
setup_solo_panes() {
  local task_id="$1" launch_mode="$2" provider="$3" task_type="$4"
  local roles=()
  case "$task_type" in
    copywriting) roles=(pm executor reviewer) ;;
    solo|multi_agent) roles=(pm designer executor reviewer) ;;
  esac

  for i in "${!roles[@]}"; do
    local role="${roles[$i]}"
    local sid="$("$SESSION_ID_GEN" "$task_id" "$role" "$i")"

    case "$launch_mode" in
      ccb)
        ccb_launch_pane "$role" "$i" "$provider" "$sid" ""
        ;;
      bridge)
        local bridge_dir="${TASK_DIR}/roles/${role}-$(printf '%02d' "$i")/bridge_ipc"
        mkdir -p "$bridge_dir"
        bridge_launch_pane "$role" "$i" "$provider" "$sid" ""
        ;;
    esac

    # First role starts as running, rest as waiting
    if [ "$i" -eq 0 ]; then
      upsert_task_state_pane "$role" "$i" "running" "$sid" "$launch_mode"
    else
      upsert_task_state_pane "$role" "$i" "waiting" "$sid" "$launch_mode"
    fi
  done

  write_event_ext "solo_panes_created" "{\"task_type\":\"${task_type}\",\"launch_mode\":\"${launch_mode}\",\"num_panes\":${#roles[@]},\"provider\":\"${provider}\"}"
}
```

**Step 2: Commit**

```bash
git add Rdloop/coordinator/run_task.sh
git commit -m "feat(coordinator): add setup_solo_panes() for upfront pane creation"
```

---

### Task 3: Modify `run_v51_flow()` to use new setup functions

**Files:**
- Modify: `Rdloop/coordinator/run_task.sh:3137-3216` (`run_v51_flow`)

**Step 1: Insert tmux setup and solo pane creation after launch_mode resolution**

Replace lines 3152-3177 (from `launch_mode=$(resolve_launch_mode_v51)` through the solo validation block) with:

```bash
  launch_mode=$(resolve_launch_mode_v51)
  max_att="${EFFECTIVE_MAX_ATTEMPTS:-$(json_read "$TASK_JSON" "max_attempts" "1")}"
  write_status "RUNNING" "0" "$max_att" "false" "" "v5.1 role flow started" "[]" "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"

  local roles=()
  case "$task_type" in
    copywriting) roles=(pm executor reviewer) ;;
    solo|multi_agent) roles=(pm designer executor reviewer) ;;
  esac

  # Solo mode: validate single provider
  local solo_provider=""
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
    solo_provider=$(normalize_provider_v51 "$(resolve_provider_for_role "pm" "$task_type")")
    [ -z "$solo_provider" ] && solo_provider="claude"
  fi

  # v5.1 Feature 1: Setup dedicated tmux session for CCB mode
  local tmux_session=""
  if [ "$launch_mode" = "ccb" ]; then
    local setup_provider="${solo_provider:-}"
    [ -z "$setup_provider" ] && setup_provider=$(normalize_provider_v51 "$(resolve_provider_for_role "pm" "$task_type")")
    [ -z "$setup_provider" ] && setup_provider="claude"
    tmux_session=$(setup_task_tmux_session "$TASK_ID" "$task_type" "$setup_provider")
  fi

  # v5.1 Feature 2: Solo mode upfront pane creation
  if [ "$task_type" = "solo" ]; then
    setup_solo_panes "$TASK_ID" "$launch_mode" "$solo_provider" "$task_type"
  fi
```

**Step 2: Pass `tmux_session` context to `run_role_action_v51` calls**

After `run_v51_flow` sets up `tmux_session`, the existing role execution calls need to know the tmux session. Export it so `run_role_action_v51` can access it:

Add after the tmux_session assignment:

```bash
  # Export for role action functions
  export RDLOOP_TMUX_SESSION="${tmux_session:-}"
```

**Step 3: Commit**

```bash
git add Rdloop/coordinator/run_task.sh
git commit -m "feat(coordinator): integrate tmux setup and solo panes into run_v51_flow"
```

---

### Task 4: Modify `run_role_action_v51()` to pass tmux target and CCB session dir

**Files:**
- Modify: `Rdloop/coordinator/run_task.sh:2973-3067` (`run_role_action_v51`)

**Step 1: Add tmux target and CCB session dir resolution**

In `run_role_action_v51`, after line 3015 (`role_rc=1`), before the CCB execution block at line 3016, insert logic to build extra flags:

```bash
  # v5.1: resolve tmux target and CCB session dir for pre-created panes
  local extra_ccb_flags=""
  if [ "$role_script_suffix" = "ccb" ] && [ -n "${RDLOOP_TMUX_SESSION:-}" ]; then
    local tmux_target="${RDLOOP_TMUX_SESSION}:roles.${pane_idx}"
    local ccb_session_dir="${TASK_DIR}/ccb_sessions/${role}"
    if tmux has-session -t "${RDLOOP_TMUX_SESSION}" 2>/dev/null && [ -d "$ccb_session_dir" ]; then
      extra_ccb_flags="--tmux-target ${tmux_target} --ccb-session-dir ${ccb_session_dir}"
    fi
  fi
```

Then modify the CCB execution blocks (lines 3016-3024) to include these flags. Replace:

```bash
  if [ "$role_script_suffix" = "ccb" ]; then
    if [ -n "$tout" ]; then
      set +e; $tout "$timeout_s" bash "$role_script" --session-id "$session_id" --req-code "$req_code" "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path" "$provider"; role_rc=$?; set -e
    else
      set +e; bash "$role_script" --session-id "$session_id" --req-code "$req_code" "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path" "$provider"; role_rc=$?; set -e
    fi
```

With:

```bash
  if [ "$role_script_suffix" = "ccb" ]; then
    if [ -n "$tout" ]; then
      set +e; $tout "$timeout_s" bash "$role_script" --session-id "$session_id" --req-code "$req_code" $extra_ccb_flags "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path" "$provider"; role_rc=$?; set -e
    else
      set +e; bash "$role_script" --session-id "$session_id" --req-code "$req_code" $extra_ccb_flags "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path" "$provider"; role_rc=$?; set -e
    fi
```

Note: `$extra_ccb_flags` is intentionally unquoted so it expands to multiple arguments (or nothing if empty).

**Step 2: Add bridge-dir override for bridge mode**

Similarly for bridge execution (lines 3025-3030), add bridge IPC dir override:

```bash
  elif [ "$role_script_suffix" = "bridge" ]; then
    local extra_bridge_flags=""
    local pre_bridge_dir="${role_dir}/bridge_ipc"
    if [ -d "$pre_bridge_dir" ]; then
      extra_bridge_flags="--bridge-dir ${pre_bridge_dir}"
    fi
    if [ -n "$tout" ]; then
      set +e; $tout "$timeout_s" bash "$role_script" --session-id "$session_id" $extra_bridge_flags "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path"; role_rc=$?; set -e
    else
      set +e; bash "$role_script" --session-id "$session_id" $extra_bridge_flags "$TASK_JSON" "$role_dir" "$(json_read "$TASK_JSON" "repo_path" "")" "$prompt_path"; role_rc=$?; set -e
    fi
```

**Step 3: Commit**

```bash
git add Rdloop/coordinator/run_task.sh
git commit -m "feat(coordinator): pass tmux target and ccb-session-dir to adapter scripts"
```

---

### Task 5: Add `--tmux-target` and `--ccb-session-dir` flags to `call_coder_ccb.sh`

**Files:**
- Modify: `Rdloop/coordinator/lib/call_coder_ccb.sh:9-19` (arg parsing) and `:149-192` (bootstrap), `:272-340` (ping loop)

**Step 1: Extend argument parsing (lines 9-19)**

Replace the existing arg parsing block:

```bash
session_id=""
req_code=""
tmux_target=""
ccb_session_dir_override=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) session_id="${2:-}"; shift 2 ;;
    --req-code) req_code="${2:-}"; shift 2 ;;
    --tmux-target) tmux_target="${2:-}"; shift 2 ;;
    --ccb-session-dir) ccb_session_dir_override="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
```

**Step 2: Apply `--ccb-session-dir` override**

After the session_root/ccb_run_dir setup (after line 93), add:

```bash
# v5.1: Override session root if --ccb-session-dir provided (per-role isolation)
if [ -n "$ccb_session_dir_override" ] && [ -d "$ccb_session_dir_override" ]; then
  session_root="$ccb_session_dir_override"
  ccb_run_dir="${ccb_session_dir_override}/.ccb/run"
  mkdir -p "$ccb_run_dir" 2>/dev/null || true
fi
```

**Step 3: Skip bootstrap when `--tmux-target` is provided**

In the ping retry loop (around line 279 `bootstrap_attempted=0`), change the bootstrap_attempted default when tmux_target is set:

```bash
  bootstrap_attempted=0
  # v5.1: If tmux-target provided, skip bootstrap (pane already created by coordinator)
  if [ -n "$tmux_target" ]; then
    bootstrap_attempted=1
  fi
```

**Step 4: Commit**

```bash
git add Rdloop/coordinator/lib/call_coder_ccb.sh
git commit -m "feat(ccb-coder): add --tmux-target and --ccb-session-dir flags"
```

---

### Task 6: Add same flags to `call_judge_ccb.sh`

**Files:**
- Modify: `Rdloop/coordinator/lib/call_judge_ccb.sh` (same pattern as Task 5)

**Step 1: Apply identical changes as Task 5**

The judge CCB script has the same structure. Apply:
1. Extend arg parsing with `--tmux-target` and `--ccb-session-dir`
2. Apply `--ccb-session-dir` override after session_root setup
3. Skip bootstrap when `--tmux-target` is provided

**Step 2: Commit**

```bash
git add Rdloop/coordinator/lib/call_judge_ccb.sh
git commit -m "feat(ccb-judge): add --tmux-target and --ccb-session-dir flags"
```

---

### Task 7: Add `--bridge-dir` override to `call_coder_bridge.sh`

**Files:**
- Modify: `Rdloop/coordinator/lib/call_coder_bridge.sh:9-17` (arg parsing) and `:37` (BRIDGE_DIR)

**Step 1: Extend argument parsing**

Replace the arg parsing block:

```bash
session_id=""
bridge_dir_override=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) session_id="${2:-}"; shift 2 ;;
    --bridge-dir) bridge_dir_override="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
```

**Step 2: Apply override at BRIDGE_DIR assignment (line 37)**

Replace:
```bash
BRIDGE_DIR="${attempt_dir}/bridge_ipc"
```

With:
```bash
if [ -n "$bridge_dir_override" ] && [ -d "$bridge_dir_override" ]; then
  BRIDGE_DIR="$bridge_dir_override"
else
  BRIDGE_DIR="${attempt_dir}/bridge_ipc"
fi
```

**Step 3: Commit**

```bash
git add Rdloop/coordinator/lib/call_coder_bridge.sh
git commit -m "feat(bridge-coder): add --bridge-dir override for per-role IPC isolation"
```

---

### Task 8: Add `--bridge-dir` override to `call_judge_bridge.sh`

**Files:**
- Modify: `Rdloop/coordinator/lib/call_judge_bridge.sh` (same pattern as Task 7)

**Step 1: Extend argument parsing with `--bridge-dir`**

Same pattern as Task 7.

**Step 2: Apply override at BRIDGE_DIR assignment**

Same pattern as Task 7.

**Step 3: Commit**

```bash
git add Rdloop/coordinator/lib/call_judge_bridge.sh
git commit -m "feat(bridge-judge): add --bridge-dir override for per-role IPC isolation"
```

---

### Task 9: Add `tmux_session` to GUI task detail response

**Files:**
- Modify: `Rdloop/gui/server.js:611-660` (`GET /api/task/:taskId`)

**Step 1: Read task_state.json and include tmux_session**

After line 625 (`const finalSummary = ...`), add:

```javascript
  const taskState = readJSON(path.join(taskDir, 'task_state.json'));
```

Then in the response at line 653, add `tmux_session`:

```javascript
  res.json({
    task: taskJson,
    status,
    final_summary: finalSummary,
    attempts,
    timeline: events,
    tmux_session: (taskState && taskState.tmux_session) || null,
    panes: (taskState && Array.isArray(taskState.panes)) ? taskState.panes : []
  });
```

**Step 2: Commit**

```bash
git add Rdloop/gui/server.js
git commit -m "feat(gui-server): include tmux_session and panes in task detail response"
```

---

### Task 10: Add tmux attach button and pane status panel to GUI frontend

**Files:**
- Modify: `Rdloop/gui/public/app.js:1748-1768` (meta info cards area)

**Step 1: Add tmux attach button after the launch mode info card**

After the "Run Config (v5.1)" info card (around line 1770), add:

```javascript
      ${data.tmux_session ? `
      <div class="info-card">
        <div class="label">Tmux Session</div>
        <div class="value" style="font-size:12px">
          <code id="tmux-session-name">${escapeHtml(data.tmux_session)}</code>
          <button class="btn btn-xs" style="margin-left:6px;font-size:10px;padding:2px 6px"
            onclick="navigator.clipboard.writeText('tmux attach -t ${escapeHtml(data.tmux_session)}').then(()=>this.textContent='Copied!').catch(()=>{})">
            Copy attach cmd
          </button>
        </div>
      </div>` : ''}
```

**Step 2: Add pane status panel**

After the meta info cards section, add a pane status panel:

```javascript
      ${(data.panes && data.panes.length > 0) ? `
      <div class="section" style="margin-top:12px">
        <h3 style="font-size:13px;margin:0 0 8px 0">Pane Status</h3>
        <table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:4px 8px">Pane</th>
              <th style="text-align:left;padding:4px 8px">Status</th>
              <th style="text-align:left;padding:4px 8px">Session ID</th>
              <th style="text-align:left;padding:4px 8px">Mode</th>
            </tr>
          </thead>
          <tbody>
            ${data.panes.map(p => `
              <tr style="border-bottom:1px solid var(--border-light,#30363d)">
                <td style="padding:4px 8px;font-weight:600">${escapeHtml(p.pane || p.role || '-')}</td>
                <td style="padding:4px 8px">
                  <span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:${
                    p.status === 'running' ? '#3fb950' :
                    p.status === 'done' ? '#8b949e' :
                    p.status === 'waiting' ? '#d29922' : '#f85149'
                  }"></span>${escapeHtml(p.status || '-')}
                </td>
                <td style="padding:4px 8px;font-size:11px;color:var(--text-muted);font-family:monospace">${escapeHtml((p.session_id || '-').slice(-20))}</td>
                <td style="padding:4px 8px">${p.launch_mode === 'ccb' ? '👁' : '⚙'} ${escapeHtml(p.launch_mode || '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>` : ''}
```

**Step 3: Commit**

```bash
git add Rdloop/gui/public/app.js
git commit -m "feat(gui-frontend): add tmux attach button and pane status panel"
```

---

### Task 11: Manual verification

**Step 1: Verify solo + ccb mode**

Create a test task with `task_type: "solo"` and `launch_mode: "ccb"`. Run it. Verify:
- A tmux session `rdloop-{task_id}` is created with 4 panes in 2x2 layout
- Each pane has an independent CCB session dir under `out/{task_id}/ccb_sessions/{role}/`
- Each role executes in its designated tmux pane
- The GUI shows pane status table with all 4 roles
- The tmux attach button appears with correct session name

```bash
tmux list-sessions | grep rdloop
ls out/{task_id}/ccb_sessions/
ls out/{task_id}/task_state.json
```

**Step 2: Verify solo + bridge mode**

Create a test task with `task_type: "solo"` and `launch_mode: "bridge"`. Run it. Verify:
- No tmux session is created
- Each role has its own bridge IPC directory under `out/{task_id}/roles/{role}-{idx}/bridge_ipc/`
- Roles execute sequentially with independent contexts

```bash
ls out/{task_id}/roles/*/bridge_ipc/
```

**Step 3: Verify backward compatibility**

Run an existing `multi_agent` task with `launch_mode: "bridge"`. Verify no behavior change — no tmux session created, existing flow works as before.

**Step 4: Verify GUI**

Open `http://localhost:17333`, navigate to the test task. Verify:
- Pane status table shows all roles with correct statuses
- Tmux attach button appears for ccb mode tasks
- No errors in browser console
