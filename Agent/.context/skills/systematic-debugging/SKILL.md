---
name: systematic-debugging
description: Use when encountering any bug, test failure, unexpected behavior, or system anomaly — before proposing any fix. Required in both solo and cli_collab mode.
trigger: bug / error / unexpected behavior / test failure / debug
lifecycle: DISCARD
mode: any
---

# Systematic Debugging

## Iron Law

```
NO FIXES WITHOUT ROOT CAUSE FIRST
```

If Phase 1 is not complete, fixes are prohibited.

## The Four Phases

### Phase 1 — Root Cause (MANDATORY, never skip)

1. **Read the error completely** — stack trace, line numbers, error codes, do not skim
2. **Reproduce consistently** — if not reproducible, gather more data, do not guess
3. **Check recent changes** — git diff, recent commits, config/env changes
4. **Trace component boundaries** — for multi-component systems (Hub → Agent → Service):
   - Log what enters each boundary
   - Log what exits each boundary
   - Identify where the signal breaks

**Gate:** Cannot proceed to Phase 2 until root cause is identified and stated explicitly.

### Phase 2 — Targeted Fix

- Fix the root cause only, not the symptom
- Minimal diff — no scope creep
- Document: what broke → why → what was changed

### Phase 3 — Verification

Run the actual verification command. Do not claim "should work."

```
Evidence required:
  test: run command → see N/N pass
  build: exit 0
  bug fixed: reproduce original trigger → no longer occurs
```

See `verification-before-completion.md` for full gate rules.

### Phase 4 — Prevention

- Write a regression test if none exists
- Add defensive logging at the component boundary where break occurred
- Note in audit if pattern is systemic

## When to Escalate (exceptions.md)

- Root cause not found after 2 full Phase 1 cycles → escalate with evidence
- Fix requires scope expansion → escalate with options
- System-level (Hub routing, Credential Layer, MemoryHub) → always escalate before touching

## Anti-Patterns (stop immediately if you catch yourself doing these)

| Thought | Reality |
|---|---|
| "I'll just try this fix" | No root cause = guaranteed rework |
| "It's obviously X" | Verify. Obvious is often wrong. |
| "Tests pass so it's fixed" | Run the original trigger, not just tests |
| "This is urgent" | Urgency makes guessing more tempting and more costly |
| "The agent reported success" | Verify independently |
