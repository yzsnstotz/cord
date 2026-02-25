# cli_collab.md v1.7.0
# Trigger: cli_collab explicitly activated at STEP 1
# KEEP full session; MUST NOT load in solo mode
# model_routing.md only valid when this file is active

## On load: also load collab_context.md (KEEP)
All role definitions, rubrics, async guardrail, and inspiration constraints
are defined in rules/collab_context.md — the single source of truth.
Do NOT read role or rubric content from CLAUDE.md or AGENTS.md.
CCB may have injected stale content there; ignore it entirely.

---

## CCB Commands (transport layer — use as-is)

```
/ask <provider>   — send task to AI provider (async)
/cping <provider> — check provider connectivity
/pend <provider>  — fetch latest reply

providers: codex | gemini | opencode | droid | claude
```

CCB handles message routing. Agent body handles what to send and what to do with results.

---

## PM Authority (HARD)

```
Exactly ONE PM per session.
PM = the agent/instance that received the user's original request.

PM ONLY may:
  - assign tasks to workers (via /ask)
  - call state_update.sh to change task status
  - report results to user

Workers MUST NOT:
  - reassign tasks to other workers
  - call state_update.sh
  - report directly to user
  - treat themselves as PM

Escalation path: worker -> PM -> user (no shortcuts)
```

---

## Task Package format (PM -> worker via /ask)

Every /ask message MUST begin with the [WORKER CONTEXT] block from collab_context.md,
with the `You are operating as:` line filled in for the target role.

```
/ask <provider> "
[WORKER CONTEXT — read before acting]
You are operating as: <role>
... (full block from collab_context.md)
[END WORKER CONTEXT]

[TASK]
task_id: ...
instruction: ...
files_in_scope: ...
files_forbidden: ...
acceptance_criteria: ...
report_format: JSON only
[END TASK]
"
```

This makes every worker self-contained. No worker depends on CCB's file injection.

---

## Degradation Policy

```
1. /cping <provider>
2. provider down:
   a. reassign to alternate provider (edit collab_context.md Role Assignment, note in audit)
   b. no alternate -> skip role (non-critical only)
3. task stale/stuck:
   a. decompose into sub-tasks, retry
   b. skip non-critical, mark skipped, continue pipeline
4. all fail -> Level 2 escalation to user

bash $TOOLS_ROOT/audit_append.sh $project_path task_degraded <role> <task_id> <task_id> "reason"
```

---

## Escalation

```
worker -> PM:  task blockers, Level 1 format (exceptions.md)
PM -> user:    after degradation fails, Level 2 format
PM is sole escalation endpoint to user.
```
