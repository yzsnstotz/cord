# file_ops.md v1.6.0
# Trigger: reading or writing any file
# DISCARD after operation

## Read

```
solo:
  if index.json summary sufficient → use summary, do NOT load file
  if summary insufficient → read file directly
  NEVER load file content unrelated to current task

collab:
  PM never reads project files directly (see Collab Mode section below)
  PM delegates all reads to executor via /ask
  if index.json summary sufficient → pass summary in task package, skip file read entirely
```

## Write — 6 steps, no skipping

```
1. write file to <dev_root>/...
2. bash $TOOLS_ROOT/hash.sh <filepath>                                → <hash>
3. generate one-sentence summary (type rules below)                   → <summary>
4. bash $TOOLS_ROOT/index_upsert.sh $project_path '<entry_json>'
5. bash $TOOLS_ROOT/audit_append.sh $project_path <action> <actor> <filepath> <task_id> "<reason>"
6. report to PM: path + summary + hash
```

## index.json entry_json

```json
{
  "path": "src/auth/login.py",       ← relative to dev_root
  "type": "code|config|doc|data",
  "summary": "<one sentence>",
  "exports": ["fn_a"],
  "dependencies": ["dep_x"],
  "hash": "<hash.sh output>",
  "last_modified": "<iso>",
  "last_modified_by": "<model-id or role>"
}
```

| type   | summary must cover            |
|--------|-------------------------------|
| code   | function + exports + deps     |
| config | scope + key params            |
| doc    | topic + key points            |
| data   | structure + record scale      |

## audit actions

| action         | when              | mode        |
|----------------|-------------------|-------------|
| file_created   | new file          | any         |
| file_modified  | existing updated  | any         |
| file_deleted   | file removed      | any         |
| task_started   | → in_progress     | any         |
| task_completed | → done            | any         |
| task_blocked   | → blocked         | any         |
| task_degraded  | degradation taken | collab      |
| judge_passed   | verdict pass      | collab      |
| judge_failed   | verdict fail      | collab      |

actor: solo → model-id | collab → "role|model-id"

---

## Collab Mode: PM File Access Rules

### PM reads session_state.json directly (task-level, PM's file)

```bash
cat $project_path/.context/session_state.json
```

PM owns this file. No delegation needed.

### PM reads .ccb/state.json via executor delegation (step-level, CCB's file)

```
PM -> /ask <executor> "Execute FileOpsREQ autoflow_state_preflight on .ccb/state.json ..."
```

PM never reads .ccb/state.json directly.

### PM reads project source files via executor delegation

```
PM -> /ask <executor> "Read [filepath]. Return content or parsed JSON summary."
```

If index.json summary is sufficient, pass it in the task package without requesting a full file read.

### PM writes session_state.json directly via state_update.sh

```bash
bash $TOOLS_ROOT/state_update.sh $project_path <task_id> <status> [json_patch]
```

Only state_update.sh. Never via /ask. Never direct JSON edit.

### PM writes project source files via executor task package

PM composes a task package (filepath, content/patch, acceptance criteria, forbidden list).
Executor writes the file, runs hash.sh, index_upsert.sh, audit_append.sh, then reports.
PM verifies report; PM alone calls state_update.sh to advance task status.

### Executor writes .ccb/state.json via FileOpsREQ only

Executor never calls state_update.sh.
PM never writes .ccb/state.json.
No cross-writes between the two state files.

