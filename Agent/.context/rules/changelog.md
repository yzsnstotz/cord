# Changelog

## v1.8.0 -- State Layer Separation (eliminate double-write)

### Problem solved
Two state files (session_state.json and .ccb/state.json) previously tracked overlapping
information at step granularity, causing potential double-writes and redundant LLM calls.

### Architecture decision
Each file now owns a distinct granularity with no overlap:

| File | Granularity | Owner | Written via |
|------|-------------|-------|-------------|
| session_state.json | task level | PM (agent body) | state_update.sh (bash) |
| .ccb/state.json | step level | CCB / executor | FileOpsREQ protocol |

### Changes

**rules/init.md**
- session_state.json schema: removed steps[] field (step tracking belongs to .ccb/state.json)
- Added acceptance_criteria field to task object (was missing, needed for review)
- Added "State ownership in collab mode" table explaining the two-layer model
- Version: 1.8.0

**skills/autoflow-run/SKILL.md**
- Full rewrite to enforce layer separation
- Pre-condition: PM reads session_state.json directly (bash) -- no /ask needed for task-level
- Step 1: reads .ccb/state.json via executor FileOpsREQ preflight (CCB step-level)
- Step 3b: executor design prompt uses stepContext from CCB preflight, not session_state steps
- Step 4: split uses autoflow_state_split FileOpsREQ op (CCB layer only)
- Step 8a: executor finalizes .ccb/state.json via autoflow_state_finalize + autoloop trigger
- Step 8b: PM only writes session_state.json (via state_update.sh) when ALL steps done
- Step 9c: PM marks task done in session_state.json after final review passes
- Result: zero double-writes, zero redundant LLM calls for state sync

**rules/task_mgmt.md**
- Collab section rewritten: "State Read Rules" replaces "State Read Delegation"
- PM reads session_state.json directly (bash) -- clarified this is correct and intended
- Step-level reads (.ccb/state.json) still delegated to executor via FileOpsREQ
- Write rules: each file has exactly one writer

**rules/file_ops.md**
- Collab section rewritten to match new layer model
- PM reads session_state.json directly (bash) -- no longer "delegate everything"
- Source file reads still delegated
- .ccb/state.json read/write: executor only via FileOpsREQ

**AGENT.md**
- Version: 1.8.0
- Quick Rules: state layers entry added, read/write entries split by layer

# Changelog

## v1.7.0 — CCB Injection Guard + Collab Context Centralization

### Architecture Shift
Agent body is now the single source of truth for all collab cognition.
CCB is transport only. CCB file injection (CLAUDE.md / AGENTS.md / .clinerules) is
actively blocked and cleaned. Workers receive all context via task package, not via
CCB-installed global files.

### New: rules/collab_context.md
- Owns: Role Assignment table, Async Guardrail, Inspiration Constraint, Rubric A (plan), Rubric B (code)
- Contains a [WORKER CONTEXT] template block that PM embeds at the top of every /ask message
- All future role/rubric changes are made here only
- cli_collab.md and autoflow-run skill reference this file; they no longer duplicate content

### Modified: rules/cli_collab.md
- On load: instructs PM to also load collab_context.md (KEEP)
- Explicit statement: ignore CLAUDE.md / AGENTS.md CCB-injected role content
- Removed: inline role table, rubrics, async guardrail (moved to collab_context.md)
- Retained: PM Authority, CCB command reference, task package format, degradation policy

### Modified: skills/autoflow-run/SKILL.md
- Every /ask call now uses <<WORKER_CTX:role>> shorthand
- Expanded to full [WORKER CONTEXT] block from collab_context.md at send time
- Workers are self-contained; no dependency on CCB file injection
- Rubric references point to worker context block, not to external file

### New: tools/ccb_guard.sh
- Strips CCB injection markers from: ~/.claude/CLAUDE.md, AGENTS.md, .clinerules
- --check mode: report only without modifying
- Run once after CCB install; re-run after CCB upgrade
- Documented in tools/TOOLS.md

### Modified: AGENT.md
- Version: v1.7.0
- Header: CCB injection guard notice with pointer to ccb_guard.sh
- Rule Router: cli_collab row now loads cli_collab.md + collab_context.md together
- KEEP constraints: updated to reflect cli_collab.md + collab_context.md pair

# Changelog

## v1.6.0

### Problem 1 — PM Role Ambiguity (Fixed)
- `cli_collab.md`: Added explicit `PM` row to Role Assignment table
- `cli_collab.md`: Added `## PM Authority (HARD)` block — PM is sole status updater and user reporter; workers report to PM only and cannot self-promote
- `cli_collab.md`: Updated Escalation section to state PM is sole escalation endpoint to user
- `AGENT.md`: Added `PM authority` entry to Quick Rules

### Problem 2 — brainstorming-to-plan Upgraded (all-plan integrated)
- `skills/brainstorming-to-plan/SKILL.md`: Full rewrite absorbing CCB `all-plan` flow
  - Phase 1: 5-Dimension Planning Readiness Model (30+25+20+15+10 = 100pt scoring, 2-round clarification, quick-start override)
  - Phase 2 (collab only): inspiration provider consultation with hard constraint (designer must filter, never blindly adopt)
  - Phase 3: structured Implementation Plan draft
  - Phase 4: solo = self-review; collab = scored reviewer loop (5 dimensions, pass >=7.0 AND no dim <=3, max 3 auto-correction rounds)
  - Phase 5: plan saved to docs/plans/, user approval required before task creation

### Problem 3 — autoflow-run Skill Added
- `skills/autoflow-run/SKILL.md`: New skill (collab only)
  - Step 1: PM reads state via executor delegation (no direct file access)
  - Step 2: role resolution from cli_collab.md + optional .autoflow/roles.json override
  - Step 3: dual independent step design (PM + executor) merged by PM
  - Step 4: split check — if step too large, split into 3–7 substeps
  - Step 5: PM builds execution task package with scope/forbidden/criteria
  - Step 6: executor executes, handles ok/ask/fail
  - Step 7: reviewer scores code (6 dimensions), PM makes final PASS/FIX/FAIL call
  - Step 8: PM calls state_update.sh to advance; executor writes step_log.md
  - Step 9: final task review when all steps done; PM marks task done via state_update.sh
- `AGENT.md` Skill Router: added `step execution / /tr command / run next step → autoflow-run`
- `AGENT.md` KEEP constraints: added autoflow-run MUST NOT load in solo mode

### Problem 4 — Collab State Delegation Clarified
- `rules/task_mgmt.md`: Added `## Collab: State Read Delegation` section
  - PM reads session_state.json via /ask executor delegation
  - PM reads project files via /ask executor delegation
  - PM writes state ONLY via state_update.sh (bash, not delegated)
  - Executor never calls state_update.sh

### Problem 5 — File Access Delegation in Collab
- `rules/file_ops.md`: Added `## Collab Mode: PM File Access Rules` section
  - PM reads via executor task, never directly
  - PM writes via executor task package
  - session_state.json is the only file PM touches directly (via state_update.sh)


---

# changelog.md v1.4.8
# Trigger: need to review version history
# After use: DISCARD

| Version | Change |
|---------|--------|
| 1.4.8   | AGENT.md refactored: Startup Sequence → startup.md (DISCARD after exec); Workspace Layout → layout.md; Roles → roles.md; Version History → changelog.md; Rule Router updated with new files |
| 1.4.7   | STEP 3 + TOOLS.md: index_verify.sh must NOT run during initialization; clarified trigger as "existing projects only" |
| 1.4.6   | tools/: replaced bash flock with Python fcntl — macOS compatible; TOOLS.md: noted env=remote execution context |
| 1.4.5   | Finalized two-machine architecture: mini=local, Air=remote; Cursor Remote SSH retired; network_authority.md rewritten with env-aware SSH patterns |
| 1.4.4   | STEP 0: fixed hostname priority bug — "mini" check first, ".local" removed as standalone condition |
| 1.4.3   | STEP 0: explicit identity table (leo@Air, yzliu@mini); hostname substring match; whoami logged only |
| 1.4.2   | STEP 0: must-execute reminder; STEP 2: tracking dir auto-created; project/dev_root inferred from context |
| 1.4.1   | Separated \<project\> (tracking) from \<dev_root\> (code); TOOLS_ROOT absolute; current_actor missing edge case |
| 1.4.0   | Added tools/; current_actor semantics; two-level escalation; stale detection; cli_collab inspiration constraint |
| 1.3.0   | env probe STEP 0; mode determination STEP 1; cli_collab as session-mode |
| 1.2.x   | cli_collab.md added |
| 1.0.0   | Initial |
