# session_mgmt.md v1.4.9
# Trigger: calls >20 / context loss signs / stale task at STEP 3
# DISCARD after new session starts

## Start new session if

```
- task unrelated to current session
- LLM calls > 20
- context loss: inconsistent refs / role confusion / "I don't remember..."
```

## Stale task (STEP 3)

```
stale = task.status == in_progress across >=2 previous sessions without progress

solo:
  bash $TOOLS_ROOT/state_update.sh $project_path <task_id> blocked
  bash $TOOLS_ROOT/audit_append.sh $project_path task_blocked <actor> <task_id> <task_id> "stale: N sessions"
  → Level 2 escalation; wait for user

collab:
  attempt degradation (cli_collab.md):
    A: reassign to alternate provider
    B: decompose into sub-tasks, retry
    C: skip non-critical, continue pipeline
  if all fail → Level 2 to user
```

## Compression (PM executes before ending session)

```
1. generate: { completed_tasks, key_decisions, blockers, next_steps }

2. append to session_state.json → session_history[]
   ONLY allowed direct edit of session_state.json; scope: session_history[] append only
   do NOT touch tasks[], status, or any other field

3. bash $TOOLS_ROOT/audit_append.sh $project_path session_compressed <actor> - - "summary appended"

4. new session loads: AGENT.md + session_state.json + index.json only
   do NOT reference previous conversation — .context/ files only
```

## New session

Re-run full startup.md (STEP 0–3). Do not carry over env or mode assumptions.
