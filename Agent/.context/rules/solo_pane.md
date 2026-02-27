# solo_pane.md v1.0
# Trigger: task_type=solo
# After use: KEEP while active task_type is solo
# Mode: git_collab
# KEEP while the active task is solo

## Purpose

Defines the non-negotiable execution model for solo tasks in v5.1.
Solo uses one provider across roles, but the workflow is still role-based and pane-based.

## Rules (HARD)

1. Every role must use an independent pane:
- `pm`, `designer`, `executor`, `reviewer` each run in a separate pane identity.

2. Context is isolated per pane:
- Do not carry raw chat history from one role pane to another.
- Only coordinator-provided transition context is allowed.

3. Coordinator controls all transitions:
- Role switch is coordinator-owned, not agent-owned.
- Coordinator performs: pause/finish current pane -> `git_ops.sh role-commit` -> knowledge query -> launch next pane.

4. Provider consistency:
- All roles in solo must use the same provider value.
- If roles differ, treat as invalid solo config and escalate.

## Prohibited

- A role pane launching another role pane directly.
- Reusing executor pane history as reviewer context.
- Direct agent scheduling logic inside CCB/Bridge.
