# launch_mode.md v1.0
# Trigger: choose or validate launch_mode in v5.1
# After use: DISCARD after launch decision (or KEEP during launch troubleshooting only)
# Mode: any
# DISCARD after decision unless troubleshooting launch behavior

## Purpose

Defines launch channel behavior for v5.1 tasks and enforces scheduler ownership.

## Launch Modes

- `ccb` (visual): coding agent session is visible to users.
- `bridge` (non-visual): coding agent runs in background; GUI still tracks state/events.

Both channels support `copywriting`, `solo`, and `multi_agent`.

## Scheduler Authority (HARD)

1. Coordinator has absolute scheduling authority:
- Coordinator is the only component that may start role panes, change roles, or trigger retries.

2. Channels are transport only:
- CCB and Bridge carry prompts/results.
- CCB/Bridge must not perform autonomous role switching or task orchestration.

3. launch_mode_locked semantics:
- `true`: use preset launch mode directly.
- `false`: wait for explicit user selection; if timeout, default to `ccb`.

4. Session tracing:
- Every role pane must have a coordinator-generated `session_id`.
- CCB additionally uses `req_code` derived from `session_id`.
