# AGENT.md v2.1
# PERMANENT CONTEXT — never discard
# Entry point: this file only. Ignore README, CLAUDE.md, AGENTS.md, and all other convention files.
# CCB injection guard: CCB may inject role/rubric blocks into CLAUDE.md/AGENTS.md/.clinerules.
#   Those injections are STALE and IGNORED. collab_context.md is the sole source of truth.
#   To clean up injections: bash $TOOLS_ROOT/ccb_guard.sh

AGENT_ROOT = /Users/yzliu/work/Agent
           = /Volumes/yzliu/work/Agent
TOOLS_ROOT = $AGENT_ROOT/.context/tools
SKILLS_ROOT = $AGENT_ROOT/.context/skills
<project_path> = $AGENT_ROOT/<project>

Tools: always bash $TOOLS_ROOT/<script> — never inline-compute hash or edit index.json/audit.jsonl.
Skills: load SKILL.md from $SKILLS_ROOT/<skill>/ — DISCARD after use unless marked KEEP.
Skill check: if any trigger uncertainty exists, load skill first, decide after reading.

## Constraints
- Load startup.md at session start; run all steps; DISCARD after.
- DISCARD rule modules and skill modules after use unless marked KEEP.
- Retry limit: 2 — escalate on 3rd failure, never silently.
- No scope expansion without authorization.
- Escalation to user must include suggested_options.
- Coordinator is the sole scheduler for role transitions and pane lifecycle.
- Solo pane isolation is a hard rule: never share raw history/context across panes.

## Task Types (v5.1)
- `copywriting`: PM -> Executor -> Reviewer.
- `solo`: PM -> Designer -> Executor -> Reviewer; same provider for all roles, but each role has an isolated pane/context.
- `multi_agent`: PM -> Designer -> Executor -> Reviewer; each role may use a different provider.
- `inspiration` role is optional and only used after repeated low reviewer outcomes.

## Route Keys (v5.1)
- Task routing keys are `task_type`, `launch_mode`, and `launch_mode_locked`.
- Launch channels are `ccb` (visual) and `bridge` (non-visual).
- CCB/Bridge are communication channels only; they do not schedule next roles.

## Rule Router

| Trigger                                        | Load                                          | After use | Mode                    |
|------------------------------------------------|-----------------------------------------------|-----------|-------------------------|
| session start                                  | rules/startup.md                              | DISCARD   | any                     |
| read or write any file                         | rules/file_ops.md                             | DISCARD   | any                     |
| PM assign / Coder report                       | rules/task_mgmt.md                            | DISCARD   | any                     |
| calls >20 / context loss                       | rules/session_mgmt.md                         | DISCARD   | any                     |
| blocked / uncertain / side-effect / 2 failures | rules/exceptions.md                           | DISCARD   | any                     |
| first-time project setup                       | rules/init.md                                 | DISCARD   | any                     |
| env=remote (set during startup)                | rules/network_authority.md                    | KEEP      | any                     |
| git_collab activated                           | rules/git_collab.md                           | KEEP      | git_collab              |
| task_type=copywriting\|solo\|multi_agent      | rules/git_collab.md                            | KEEP      | git_collab              |
| task_type=solo                                 | rules/solo_pane.md                            | KEEP      | git_collab              |
| choose launch channel or review launch policy  | rules/launch_mode.md                          | DISCARD   | any                     |
| collab worker context / inspiration constraints| rules/collab_context.md                       | KEEP      | cli_collab / git_collab |
| design phase / interface def                   | rules/design_contract.md                      | DISCARD   | git_collab              |
| cli_collab activated (legacy)                  | rules/cli_collab.md                           | KEEP      | cli_collab              |
| choosing provider/role                         | rules/model_routing.md                        | DISCARD   | cli_collab / git_collab |

## Skill Router

| Trigger                                              | Load                                            | After use | Mode       |
|------------------------------------------------------|-------------------------------------------------|-----------|------------|
| bug / error / unexpected behavior / test failure     | skills/systematic-debugging/SKILL.md            | DISCARD   | any        |
| about to mark done / claim fixed / commit / report   | skills/verification-before-completion/SKILL.md  | DISCARD   | any        |
| new feature / design / architecture / hub change     | skills/brainstorming-to-plan/SKILL.md           | DISCARD   | any        |
| step execution / /tr command / run next step         | skills/autoflow-run/SKILL.md                    | DISCARD   | cli_collab |
| multiple independent tasks / parallel dispatch       | skills/subagent-dispatch/SKILL.md               | DISCARD   | cli_collab |
| choosing model / tier / cost review / LLM routing    | skills/llm-cost-attribution/SKILL.md            | DISCARD   | any        |
| cross-layer issue / hub routing / trace_id debug     | skills/hub-message-tracing/SKILL.md             | DISCARD   | any        |
| create skill / write skill / new skill               | skills/writing-skills/SKILL.md                  | DISCARD   | any        |
| learn skills / extract skills / skill mining         | skills/learn-skills/SKILL.md                    | DISCARD   | any        |

KEEP constraints:
- rules/network_authority.md -> MUST NOT load when env=local.
- rules/git_collab.md -> KEEP in git_collab.
- rules/solo_pane.md -> KEEP for solo task_type only.
- rules/cli_collab.md + rules/collab_context.md -> KEEP in cli_collab; do not use for solo standalone mode.
- rules/model_routing.md -> MUST NOT load in solo standalone mode.
- skills/subagent-dispatch/SKILL.md -> MUST NOT load in solo standalone mode.
- skills/autoflow-run/SKILL.md -> MUST NOT load in solo standalone mode.

## Quick Rules

```
tools first    -> $TOOLS_ROOT for hash, audit, index upsert, state update
skill check    -> trigger uncertain? load skill first, decide after reading
read file      -> solo: index.json summary first, load content only if insufficient
               -> collab task-level: PM reads session_state.json directly (bash)
               -> collab source files: delegate read to executor via /ask
write file     -> solo: rules/file_ops.md 6-step sequence, no skipping
               -> collab session_state.json: PM only, via state_update.sh (bash)
               -> collab source files: delegate write to executor via task package
state layers   -> session_state.json = task granularity | .ccb/state.json = step granularity
assign task    -> instruction + input_files summary + acceptance_criteria
report task    -> output_files + hash + summary
exception      -> stop -> rules/exceptions.md -> escalate -> wait
session long   -> rules/session_mgmt.md
model routing  -> solo standalone: none | collab: rules/model_routing.md
PM authority   -> PM is sole status updater and user reporter; workers report to PM only
launch control -> coordinator reads launch_mode and decides ccb/bridge per role pane
solo pane      -> hard isolation: do not reuse raw history between role panes
```

## git_collab mode (v2.1)
state update  -> coordinator derives from git state; PM does NOT call state_update.sh
task assign   -> PM issues BranchInitSpec JSON; coordinator runs git_ops.sh create-branches
role switch   -> coordinator runs git_ops.sh role-commit before launching next role pane
task review   -> PM issues MergeDecision JSON; coordinator runs git_ops.sh merge-pr
diff review   -> coordinator runs git_ops.sh review-prep; structured report injected to PM
