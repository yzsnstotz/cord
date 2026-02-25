# startup.md v1.4.9
# Trigger: session start — load immediately after AGENT.md
# DISCARD after all steps complete; results persist in session context

## STEP 0 — Environment Probe

```
run: whoami && hostname   ← MUST execute; do not infer from filenames or context

if hostname contains "mini" → env=local  (on mini, execute directly)
if hostname contains "Air"  → env=remote (on Air, SSH to mini for all execution)
else                        → STOP: Level 2 escalation, do not proceed

# both hostnames end in ".local" — match on "mini"/"Air" only, never on ".local" alone

if env=remote → load network_authority.md, KEEP full session
if env=local  → do NOT load network_authority.md

session context: { env, host, user }
```

Known: yzliu@YZ-Mac-mini.local = mini | leo@MacBook-Air-2.local = Air

## STEP 1 — Operating Mode

```
if cli_collab explicitly requested → load cli_collab.md, KEEP full session; mode=cli_collab
else                               → mode=solo
mode is FIXED for session

session context: { mode }
```

## STEP 2 — Project Context

```
a. resolve <project> and <dev_root>:
     1. explicit in user message
     2. open workspace / cwd
     3. ask user (only if 1+2 fail)

b. check $AGENT_ROOT/<project>/.context/session_state.json:
     tracking dir missing → mkdir -p $AGENT_ROOT/<project>/.context/ → init.md
     file missing         → init.md
     file exists:
       missing current_actor → solo: write current model id, continue
                               collab: resolve from cli_collab.md
       missing dev_root      → ask user, write back

c. check $AGENT_ROOT/<project>/.context/index.json:
     missing → init.md

session context: { project, dev_root, project_path=$AGENT_ROOT/<project> }
```

## STEP 3 — Self-Check

```
Q1 goal?      → session_state.json → goal field
Q2 next task? → tasks: status = pending | in_progress
                if in_progress and stale → session_mgmt.md stale policy
Q3 my role?   → solo: current_actor | cli_collab: collab_context.md Role Assignment table

index_verify  → bash $TOOLS_ROOT/index_verify.sh $project_path
                ONLY on existing projects; SKIP if init.md just ran

any failure → STOP, ask user
```

DISCARD after completion. Session context: { env, host, user, mode, project, dev_root, project_path }
