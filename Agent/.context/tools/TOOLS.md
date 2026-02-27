# TOOLS.md v1.4.9
# TOOLS_ROOT = /Users/yzliu/work/Agent/.context/tools
# <project_path> = $AGENT_ROOT/<project>
# Call: bash $TOOLS_ROOT/<script> — always absolute path
# env=remote: scripts run on Air via mount (/Volumes/yzliu/...); python3+bash must exist on Air
#             tracking files accessed transparently through mount — no SSH needed for tools
#             SSH only for dev_root commands and ao-user operations (network_authority.md)

## Registry

### hash.sh
```
bash $TOOLS_ROOT/hash.sh <filepath>
→ sha256 hex string (stdout)
```
Use for: every file write before index_upsert. Never LLM-computed hashes.

### audit_append.sh
```
bash $TOOLS_ROOT/audit_append.sh <project_path> <action> <actor> <target> <task_id> <note>
→ confirmation (stdout) | error (stderr)
```
solo actions:   file_created | file_modified | file_deleted | task_started | task_completed |
                task_blocked | task_degraded | session_started | session_compressed | project_initialized
collab actions: judge_passed | judge_failed

actor: solo → model-id | collab → "role|model-id"
Never hand-write audit.jsonl.

### index_upsert.sh
```
bash $TOOLS_ROOT/index_upsert.sh <project_path> '<entry_json>'
→ confirmation (stdout) | error (stderr)
```
fields: path, type, summary, exports, dependencies, hash, last_modified, last_modified_by
Never hand-edit index.json.

### state_update.sh
```
bash $TOOLS_ROOT/state_update.sh <project_path> <task_id> <status> [json_patch]
→ confirmation (stdout) | error (stderr)
```
valid status: pending | in_progress | review | done | blocked | skipped
PM only. json_patch e.g. '{"completed_at":"<iso>","notes":"..."}'

### index_verify.sh
```
bash $TOOLS_ROOT/index_verify.sh <project_path> [--files f1 f2 ...]
→ JSON array of mismatches: [{"path","expected_hash","actual_hash"}] | [] = clean
```
Call ONLY on existing projects at STEP 3, or before a task requiring specific file content.
SKIP if init.md just ran (index.json is empty).
On mismatch → STOP, report to user, do not proceed.

### ensure_git_repo.sh
```bash
bash $TOOLS_ROOT/ensure_git_repo.sh <repo_path> [base_ref]
```
Ensures `<repo_path>` exists, is initialized as a git repo, has an initial commit, and contains `base_ref`.
Use for automatic task activation when user chooses a new/non-git folder.

### list_git_refs.sh
```bash
bash $TOOLS_ROOT/list_git_refs.sh <repo_path>
```
Prints branch/tag refs for repo selection UIs and quick git diagnostics.

## Notes
- Scripts idempotent where possible
- Non-zero exit → exception; load exceptions.md

## ccb_guard.sh

Detect and remove CCB-injected blocks from CLAUDE.md / AGENTS.md / .clinerules.

```bash
bash $TOOLS_ROOT/ccb_guard.sh           # remove injections
bash $TOOLS_ROOT/ccb_guard.sh --check   # report only, no changes
```

Run once after CCB install. Re-run if CCB is upgraded and re-injects.
CCB injection is redundant: collab_context.md is the sole source of truth.
