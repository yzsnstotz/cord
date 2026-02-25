# task_mgmt.md v1.6.0
# Trigger: PM assigning task OR Coder/Judge reporting
# DISCARD after exchange

## Status Flow

```
solo:    pending -> in_progress -> done
                       |
                    blocked (reason required)

collab:  pending -> in_progress -> review -> done
                       |
                    blocked | skipped (non-critical only)
```

PM only updates status -- Coder/Judge never write session_state.json directly:
```bash
bash $TOOLS_ROOT/state_update.sh $project_path <task_id> <status> [json_patch]
```

## PM -> Coder assignment

```json
{
  "task_id": "T01",
  "title": "",
  "requirement_ref": "B2-1",
  "instruction": "<what/how/boundaries -- no vague instructions>",
  "input_files": [{ "path": "", "summary": "" }],
  "output_files_expected": [""],
  "acceptance_criteria": "",
  "forbidden": ""
}
```

Bad: "fix login"
Good: "modify $dev_root/run_task.sh line 42 to pre-create coder/judge/test/ dirs"

## Coder -> PM report

```json
{
  "task_id": "T01",
  "status": "completed|blocked",
  "output_files": [{ "path": "", "summary": "", "hash": "" }],
  "blockers_encountered": [],
  "notes": ""
}
```

## Judge verdict (collab only)

```json
{
  "task_id": "T01",
  "verdict": "pass|fail",
  "criteria_results": [{ "criterion": "", "met": true, "note": "" }],
  "blocking_issues": [],
  "recommendation": "approve|rework"
}
```

Incomplete report -> PM must NOT mark task done.

---

## Collab: State Read Rules

State is split across two files with different owners. Read accordingly.

### Task-level state (session_state.json) -- PM reads directly

PM owns session_state.json and may read it directly via bash:

```bash
cat $project_path/.context/session_state.json
```

PM extracts: in_progress task_id, title, acceptance_criteria, status of all tasks.
No /ask delegation needed for this file -- it is PM's file.

### Step-level state (.ccb/state.json) -- PM delegates to executor

PM never reads .ccb/state.json directly. Delegate via /ask:

```
/ask <executor> "
[WORKER CONTEXT -- read before acting]
You are operating as: executor
... (full base block from collab_context.md)
[END WORKER CONTEXT]

[TASK]
Execute FileOpsREQ: read current step state

{
  'proto': 'autoflow.fileops.v1',
  'id': 'READ-STATE',
  'purpose': 'read_state',
  'ops': [{ 'op': 'autoflow_state_preflight', 'path': '.ccb/state.json', 'maxAttempts': 2 }]
}

Return FileOpsRES JSON only.
[END TASK]
"
```

### Write rules

PM writes session_state.json exclusively via state_update.sh (bash, never via /ask):
```bash
bash $TOOLS_ROOT/state_update.sh $project_path <task_id> <status> [json_patch]
```

Executor writes .ccb/state.json exclusively via FileOpsREQ ops (never calls state_update.sh).

No cross-writes. No sync. Each layer owns its file.
