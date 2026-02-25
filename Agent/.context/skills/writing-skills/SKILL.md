---
name: writing-skills
description: Use when creating a new skill, refining an existing skill, or deciding whether something should be a skill vs a rule vs a tool script.
trigger: create skill / write skill / new skill / refine skill
lifecycle: DISCARD
mode: any
---

# Writing Skills

## Should This Be a Skill?

**Make it a skill when:**
- The technique wasn't intuitively obvious
- You'd reference it again across different projects
- Pattern applies broadly (not project-specific)
- It's a judgment call, not a mechanical constraint

**Don't make it a skill — use instead:**
- rule module in `rules/` → session-level behavioral constraints (DISCARD/KEEP lifecycle)
- tool script in `tools/` → deterministic, automatable operations
- AGENT.md quick rule → single-line always-on constraint

## SKILL.md Required Structure

```markdown
---
name: verb-noun or gerund-noun (e.g., systematic-debugging, hub-message-tracing)
description: Use when [specific trigger condition] — [what it does]. Third person. Max 1024 chars.
trigger: comma-separated keywords for rule router
lifecycle: DISCARD | KEEP
mode: any | solo | cli_collab
---

# [Skill Name]

## [Core principle or Iron Law if rigid]

## Checklist or Process (numbered, in order)

## [Reference tables, patterns, examples]

## Integration with other modules (if relevant)
```

## Description Writing Rules

- Third person always ("Use when X" not "I will help you with X")
- Include both trigger condition AND what it does
- Include key terms that will appear in natural language requests
- Keep under 1024 chars — Claude uses this for selection from full skill set

## Skill Types and Degree of Freedom

**Rigid** (Iron Law) → use when violations are costly and rationalizations are tempting.
Format: state the law first, then the process, then anti-patterns with rebuttals.
Examples: systematic-debugging, verification-before-completion

**Flexible** (Pattern) → use when context determines best approach.
Format: decision tree or "when to use X vs Y", then principles, then examples.
Examples: brainstorming-to-plan, subagent-dispatch

## Token Economy Rules (from Anthropic best practices)

- SKILL.md body < 500 lines
- Heavy reference (100+ lines) → separate file, one level deep from SKILL.md
- Only add what Claude doesn't already know
- One recommended approach, not multiple options (unless choice genuinely matters)
- No time-sensitive information in skill body

## Progressive Disclosure Pattern

```
SKILL.md → overview + core rules + quick reference
  ↓ (Claude reads when needed)
reference.md → heavy API docs, comprehensive examples
scripts/     → executable tools Claude runs, not reads
```

Never nest: SKILL.md → file-A.md → file-B.md. Keep references one level deep.

## Adding to Rule Router (AGENT.md)

After creating skill, add trigger row to AGENT.md rule router table:

```
| <trigger keywords>  | skills/<name>/SKILL.md  | DISCARD  | <mode>  |
```
