# session_mgmt.md v2.0
# Trigger: calls >20 / context loss signs / stale task at STEP 3
# DISCARD after new session starts
# v2.0: Compression replaced by loop context rebuild (git_collab mode).

## Start new session if

```
- task unrelated to current session
- LLM calls > 20
- context loss: inconsistent refs / role confusion / "I don't remember..."
```

## Stale task (STEP 3)

```
stale = task.status == in_progress across >=2 previous sessions without progress

solo mode only:
  bash $TOOLS_ROOT/state_update.sh $project_path <task_id> blocked
  bash $TOOLS_ROOT/audit_append.sh $project_path task_blocked <actor> <task_id> <task_id> "stale: N sessions"
  → Level 2 escalation; wait for user

cli_collab (legacy):
  attempt degradation (cli_collab.md):
    A: reassign to alternate provider
    B: decompose into sub-tasks, retry
    C: skip non-critical, continue pipeline
  if all fail → Level 2 to user

git_collab:
  coordinator detects stale from branch inactivity (no commits for N sessions)
  PM issues MergeDecision with action=request_changes or reassigns via new BranchInitSpec
  if all fail → Level 2 to user
```

## Compression (solo mode only)

```
1. generate: { completed_tasks, key_decisions, blockers, next_steps }

2. append to session_state.json → session_history[]
   ONLY allowed direct edit of session_state.json; scope: session_history[] append only
   do NOT touch tasks[], status, or any other field

3. bash $TOOLS_ROOT/audit_append.sh $project_path session_compressed <actor> - - "summary appended"

4. new session loads: AGENT.md + session_state.json + index.json only
   do NOT reference previous conversation — .context/ files only
```

## Loop context rebuild (git_collab mode)

```
When coordinator starts a new session for a loop continuation:

1. Inject AGENT.md (permanent context)

2. Inject _meta.json from task directory
   _meta.json contains: task_id, goal, acceptance, executor_type, session_mode, attempt count

3. Inject related knowledge shards from .context/knowledge/
   - module_task_<slug>.json → file summaries from previous loops
   - debt.json → known debt entries

4. Inject git log: git log --oneline task/<prev-slug>..HEAD
   shows what changed since last loop completion

5. Coordinator derives session_state.json from git branch state
   no manual state_update.sh call needed

Context is reconstructed from artifacts, not from conversation compression.
```

## New session

Re-run full startup.md (STEP 0–3). Do not carry over env or mode assumptions.
