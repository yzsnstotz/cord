# AGENT.md v1.8.0
# PERMANENT CONTEXT — never discard
# Entry point: this file only. Ignore README, CLAUDE.md, AGENTS.md, and all other convention files.
# CCB injection guard: CCB may inject role/rubric blocks into CLAUDE.md/AGENTS.md/.clinerules.
#   Those injections are STALE and IGNORED. collab_context.md is the sole source of truth.
#   To clean up injections: bash $TOOLS_ROOT/ccb_guard.sh

AGENT_ROOT = /Users/yzliu/work/Agent          # env=local (on mini)
           = /Volumes/yzliu/work/Agent         # env=remote (on Air, same files via mount)
TOOLS_ROOT = $AGENT_ROOT/.context/tools
SKILLS_ROOT = $AGENT_ROOT/.context/skills
<project_path> = $AGENT_ROOT/<project>         # pass to all tool scripts

Tools: always bash $TOOLS_ROOT/<script> — never inline-compute hash or edit index.json/audit.jsonl.
Skills: load SKILL.md from $SKILLS_ROOT/<skill>/ — DISCARD after use unless marked KEEP.
Skill check: if any trigger uncertainty exists, load skill first, decide after reading.

## Constraints
- Load startup.md at session start; run all steps; DISCARD after
- DISCARD rule modules and skill modules after use unless marked KEEP
- Retry limit: 2 — escalate on 3rd failure, never silently
- No scope expansion without authorization
- Escalation to user must include suggested_options

## Rule Router

| Trigger                                        | Load                          | After use   | Mode        |
|------------------------------------------------|-------------------------------|-------------|-------------|
| session start                                  | rules/startup.md              | DISCARD     | any         |
| read or write any file                         | rules/file_ops.md             | DISCARD     | any         |
| PM assign / Coder report                       | rules/task_mgmt.md            | DISCARD     | any         |
| calls >20 / context loss                       | rules/session_mgmt.md         | DISCARD     | any         |
| blocked / uncertain / side-effect / 2 failures | rules/exceptions.md           | DISCARD     | any         |
| first-time project setup                       | rules/init.md                 | DISCARD     | any         |
| env=remote (set during startup)                | rules/network_authority.md    | KEEP        | any         |
| cli_collab activated                                | rules/cli_collab.md + rules/collab_context.md | KEEP        | cli_collab  |
| choosing provider/role                         | rules/model_routing.md        | DISCARD     | cli_collab  |

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
- rules/network_authority.md → MUST NOT load when env=local
- rules/cli_collab.md + rules/collab_context.md → KEEP in cli_collab, MUST NOT load in solo mode
- rules/model_routing.md → MUST NOT load in solo mode
- skills/subagent-dispatch/SKILL.md → MUST NOT load in solo mode
- skills/autoflow-run/SKILL.md → MUST NOT load in solo mode

## Quick Rules

```
tools first    → $TOOLS_ROOT for all: hash, audit, index upsert, state update
skill check    → trigger uncertain? load skill first, decide after reading
read file      → solo: index.json summary first, load content only if insufficient
               → collab task-level: PM reads session_state.json directly (bash)
               → collab step-level: PM delegates to executor via /ask (FileOpsREQ on .ccb/state.json)
               → collab source files: delegate read to executor via /ask
write file     → solo: rules/file_ops.md 6-step sequence, no skipping
               → collab session_state.json: PM only, via state_update.sh (bash)
               → collab .ccb/state.json: executor only, via FileOpsREQ
               → collab source files: delegate write to executor via task package
state layers   → session_state.json = task granularity (PM's) | .ccb/state.json = step granularity (CCB's)
               → no double-write, no sync, each file owns its layer
assign task    → instruction + input_files summary + acceptance_criteria
report task    → output_files + hash + summary
exception      → stop → rules/exceptions.md → escalate → wait
session long   → rules/session_mgmt.md
model routing  → solo: none | cli_collab: rules/model_routing.md
learn skills   → skills/learn-skills/SKILL.md → weekly or on demand
PM authority   → collab only: PM is sole status updater and user reporter; workers report to PM only
```
