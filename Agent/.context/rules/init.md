# init.md v1.9.0
# Trigger: first-time project setup
# DISCARD after completion

## Steps

```
1. <project> and <dev_root> already resolved by STEP 2 -- do not re-ask if known
   if still unknown -> ask user

2. mkdir -p $AGENT_ROOT/<project>/.context/   (if not already created by STEP 2)

3. receive requirements from user

4. decompose -> write $AGENT_ROOT/<project>/.context/session_state.json

5. write $AGENT_ROOT/<project>/.context/index.json:
   { "files": [], "last_updated": "<ts>" }

6. bash $TOOLS_ROOT/audit_append.sh $project_path project_initialized <actor> - - "agent_version=1.9.0"

7. do NOT load raw requirements again -- details live in tasks[].requirement_ref

8. PM begins work -- STEP 3 will now pass
```

Rules only in $AGENT_ROOT/.context/rules/ -- never create rules/ inside project .context/

## session_state.json

Tracks at **task granularity only**. Step-level execution state lives in `.ccb/state.json`
(managed by CCB/executor in collab mode) and is never duplicated here.

```json
{
  "project": "<name>",
  "dev_root": "/absolute/path/to/code",
  "goal": "<one sentence>",
  "current_actor": "<model-id | role-name>",
  "tasks": [{
    "task_id": "T01",
    "title": "",
    "requirement_ref": "",
    "status": "pending",
    "assigned_to": null,
    "acceptance_criteria": "",
    "output_files": [],
    "completed_at": null,
    "notes": ""
  }],
  "session_history": [],
  "shared_contracts": {},
  "last_updated": "<iso>"
}
```

### shared_contracts (v1.9.0)

**shared_contracts** records the cross-task file dependency graph and interface hashes. Each key is a file path (or logical contract id). Value shape:

- **owner_task**: task that last modified or owns the interface (e.g. `"T01"`).
- **interface_hash**: hash of the public interface (signatures, exported symbols, or schema). When this changes, dependents may need to re-validate.
- **dependents**: array of task ids that depend on this file (e.g. `["T02","T03"]`).

**Conflict detection**: When starting or updating a task, if the task touches a file that appears in `shared_contracts` and the current `interface_hash` for that file (from `knowledge_cache.json` or from a fresh hash) differs from the value stored in `shared_contracts`, treat it as a potential conflict: dependent tasks may have been designed against the old interface. PM should either re-check dependents or record the new hash after the change. The same `interface_hash` semantics are used in `knowledge_cache.json` for file entries; keep `shared_contracts.interface_hash` in sync with `knowledge_cache.json` for files that have an `interface_hash` there.

**Example** (at least two file dependencies):

```json
{
  "shared_contracts": {
    "src/auth.py": {
      "owner_task": "T01",
      "interface_hash": "abc123",
      "dependents": ["T02", "T03"]
    },
    "api/schema.json": {
      "owner_task": "T02",
      "interface_hash": "def456",
      "dependents": ["T03"]
    }
  }
}
```

current_actor: solo -> model id (fixed); collab -> active role name (changes per task)
status: pending | in_progress | done | blocked | review (collab) | skipped (collab)

## State ownership in collab mode

| Granularity | File | Managed by | Written via |
|-------------|------|------------|-------------|
| task level  | `.context/session_state.json` | PM (agent body) | `state_update.sh` (bash) |
| step level  | `.ccb/state.json` | CCB / executor | FileOpsREQ protocol |

These two files own different granularities and are never synced.
PM reads task status from session_state.json.
PM reads step status from .ccb/state.json via executor delegation (/ask).
No double-write. No cross-reference needed.
