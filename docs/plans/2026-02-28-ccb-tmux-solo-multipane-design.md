# Design: CCB Tmux Auto-Bootstrap + Solo Multi-Pane

**Date:** 2026-02-28
**Status:** Pending implementation
**Scope:** Two features for v5.1 coordinator

---

## Problem

1. **Visual mode (CCB) lacks proactive tmux setup.** When `launch_mode=ccb`, the coordinator relies on `call_coder_ccb.sh` to reactively bootstrap the CCB daemon if ping fails. There is no dedicated tmux session for the task — panes are created ad-hoc.

2. **Solo mode shares context across roles.** Although `run_v51_flow()` generates distinct session IDs per role, there is no mechanism to ensure each role pane has fully independent context (separate CCB session files or separate bridge IPC directories).

---

## Feature 1: Visual Mode CCB Auto-Bootstrap with Dedicated Tmux Session

### Design

When `launch_mode=ccb`, the coordinator creates a dedicated tmux session before any role execution begins.

**New function:** `setup_task_tmux_session()` in `run_task.sh`

```
Lifecycle:
  resolve_launch_mode_v51()
      │
      ├── launch_mode = ccb
      │       └── setup_task_tmux_session(task_id, task_type, provider)
      │             1. tmux new-session -d -s "rdloop-{task_id}" -n "roles"
      │             2. Split into 2x2 grid (4 panes for solo/multi_agent, 3 for copywriting)
      │             3. Per pane: create isolated CCB session dir at {TASK_DIR}/ccb_sessions/{role}/
      │             4. Per pane: bootstrap CCB provider daemon in that tmux pane
      │             5. Store tmux_session name in task_state.json
      │
      └── launch_mode = bridge
              └── (no tmux setup needed)
```

**Tmux layout (2x2 grid):**

```
┌──────────────┬──────────────┐
│ pane 0: PM   │ pane 1: Dsgn │
│              │              │
├──────────────┼──────────────┤
│ pane 2: Exec │ pane 3: Revw │
│              │              │
└──────────────┴──────────────┘
```

For `copywriting` (3 roles): pane 0=PM, pane 1=Executor, pane 2=Reviewer (no pane 3).

**Per-pane CCB isolation:**

Each role pane gets its own CCB session directory:
```
{TASK_DIR}/ccb_sessions/
  pm/.ccb/.{provider}-session
  pm/.ccb/run/
  designer/.ccb/.{provider}-session
  designer/.ccb/run/
  executor/.ccb/.{provider}-session
  executor/.ccb/run/
  reviewer/.ccb/.{provider}-session
  reviewer/.ccb/run/
```

This ensures no session state contamination between roles.

**Modified `call_coder_ccb.sh` interface:**

New flags:
- `--tmux-target <session:window.pane>` — send prompt to a specific pre-created tmux pane
- `--ccb-session-dir <dir>` — use this directory for CCB session file discovery (overrides auto-discovery)

When `--tmux-target` is provided:
1. Skip the bootstrap_ccb_provider() call (pane already exists)
2. Use the specified CCB session dir for ping and dispatch
3. Send the prompt to the existing pane's daemon

When `--tmux-target` is NOT provided (backward compatible):
- Existing behavior unchanged — auto-discover or bootstrap

Same changes apply to `call_judge_ccb.sh`.

---

## Feature 2: Solo Mode Multi-Pane/Bridge with Independent Contexts

### Design

In solo mode, all role panes are created upfront at task start. Each pane has a fully independent context — separate session, separate CCB session file (or bridge IPC dir), and separate instruction.

**New function:** `setup_solo_panes()` in `run_task.sh`

```
setup_solo_panes(task_id, launch_mode, provider, task_type)
    │
    ├── For each role in (pm, designer, executor, reviewer):
    │     1. Generate session_id via session_id_gen.sh
    │     2. ccb mode: ccb_launch_pane() → maps to tmux pane index
    │     3. bridge mode: create {TASK_DIR}/roles/{role}-{idx}/bridge_ipc/
    │                     bridge_launch_pane() → register in task_state
    │
    └── All 4 sessions registered in task_state.json upfront
        (status: "waiting" for all except pm which starts as "running")
```

**Bridge mode isolation:**

Each role gets its own bridge IPC directory:
```
{TASK_DIR}/roles/
  pm-00/bridge_ipc/         ← request.json / response.json
  designer-01/bridge_ipc/   ← request.json / response.json
  executor-01/bridge_ipc/   ← request.json / response.json
  reviewer-02/bridge_ipc/   ← request.json / response.json
```

**Modified `run_v51_flow()` for solo mode:**

```
run_v51_flow():
  resolve_launch_mode_v51()

  if task_type == "solo":
    if launch_mode == "ccb":
      setup_task_tmux_session()   ← Feature 1
    setup_solo_panes()            ← Feature 2 (upfront creation)

  # Then sequential execution proceeds as before:
  # PM → Designer → Executor → Reviewer
  # But now each run_role_action_v51() targets its pre-created pane
```

**Modified `run_role_action_v51()` for pre-created panes:**

When the tmux session exists (solo + ccb), pass tmux target and CCB session dir:
```bash
if [ "$role_script_suffix" = "ccb" ] && [ -n "$tmux_session" ]; then
  tmux_target="${tmux_session}:roles.${pane_idx}"
  ccb_session_dir="${TASK_DIR}/ccb_sessions/${role}"
  # Add: --tmux-target "$tmux_target" --ccb-session-dir "$ccb_session_dir"
fi
```

When bridge mode with pre-created IPC dir:
```bash
if [ "$role_script_suffix" = "bridge" ] && [ -d "${role_dir}/bridge_ipc" ]; then
  # Add: --bridge-dir "${role_dir}/bridge_ipc"
fi
```

---

## GUI Adaptability

### Already compatible (no changes):

| Component | Why it works |
|-----------|-------------|
| `GET /api/task/:taskId/panes` | Reads `task_state.json` panes array — our `upsert_task_state_pane()` writes this exact format |
| `openV51RunDialog()` | Already presents ccb/bridge selection |
| `POST /api/run/create` | Already resolves launch_mode and passes to coordinator |
| Timeline events | Our events use `write_event_ext()` which feeds `events.jsonl` and `task_lifecycle.jsonl` |
| Launch mode indicators | Frontend already shows ccb/bridge icons and lock status |

### Small additions:

| Change | File | Description |
|--------|------|-------------|
| `tmux_session` in task detail | `server.js` `GET /api/task/:taskId` | Read `tmux_session` from `task_state.json`, include in response |
| Tmux attach button | `app.js` meta section | When `tmux_session` present: show copyable `tmux attach -t rdloop-{task_id}` |
| Pane role icons | `app.js` pane status panel | Add role-specific icons/labels (PM/Designer/Executor/Reviewer) with status colors |

---

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `Rdloop/coordinator/run_task.sh` | Modify | Add `setup_task_tmux_session()`, `setup_solo_panes()`, modify `run_v51_flow()` and `run_role_action_v51()` |
| `Rdloop/coordinator/lib/call_coder_ccb.sh` | Modify | Add `--tmux-target`, `--ccb-session-dir` flags |
| `Rdloop/coordinator/lib/call_judge_ccb.sh` | Modify | Same new flags as coder |
| `Rdloop/coordinator/lib/call_coder_bridge.sh` | Modify | Accept `--bridge-dir` for per-role IPC directory |
| `Rdloop/coordinator/lib/call_judge_bridge.sh` | Modify | Same `--bridge-dir` flag |
| `Rdloop/gui/server.js` | Modify | Include `tmux_session` in task detail response |
| `Rdloop/gui/public/app.js` | Modify | Tmux attach button + pane role icons |

---

## Backward Compatibility

- All new flags are optional — existing callers without `--tmux-target` or `--ccb-session-dir` work unchanged
- `multi_agent` and `copywriting` task types: no behavioral change unless `launch_mode=ccb`
- GUI: new UI elements only appear when `tmux_session` is present in task state
- `setup_task_tmux_session()` is only called for `launch_mode=ccb`; bridge mode unchanged
