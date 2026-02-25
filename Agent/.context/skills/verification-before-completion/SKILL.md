---
name: verification-before-completion
description: Use before claiming any task is done, fixed, passing, or complete — requires running actual verification and showing evidence. No exceptions.
trigger: about to mark task done / claim fixed / claim passing / commit / report complete
lifecycle: DISCARD
mode: any
---

# Verification Before Completion

## Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH EVIDENCE
```

## The Gate

Before ANY completion claim (including task status update via state_update.sh):

```
1. IDENTIFY — what command proves this is done?
2. RUN — execute it now, in this turn
3. READ — full output, check exit code
4. VERIFY — does it confirm the claim?
   YES → state claim WITH evidence pasted
   NO  → state actual status, return to work
5. ONLY THEN → report / update task status
```

Skip any step = lying, not verifying.

## Evidence Requirements by Claim Type

| Claim | Required evidence |
|---|---|
| Tests pass | Command output showing N/N pass, 0 failures |
| Bug fixed | Original trigger reproduced → no longer occurs |
| Build succeeds | Build command exit 0 |
| Task complete | All acceptance_criteria checked line by line |
| Agent completed | VCS diff shows actual changes |
| Hash correct | bash $TOOLS_ROOT/hash.sh output matches |

## Red Flags — STOP

- "should work now" → RUN the verification
- "I'm confident" → confidence ≠ evidence  
- About to call state_update.sh without running verification
- Trusting subagent success report without independent check
- Partial check ("tests in module X pass" ≠ "all tests pass")

## Integration with task_mgmt.md

Coder → PM report requires `output_files` with hashes.
Hash must come from `bash $TOOLS_ROOT/hash.sh <file>` not inline computation.
PM must NOT mark done without evidence in report.

In cli_collab mode: reviewer rubric `correctness` and `completeness` scores must be based on verified evidence, not agent claims.
