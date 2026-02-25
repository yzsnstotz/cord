---
name: learn-skills
description: Use when performing periodic skill extraction from conversation history across Codex, Cursor, Antigravity, and Claude — analyzes logs, identifies reusable patterns, proposes new SKILL.md candidates for user review.
trigger: learn skills / extract skills / review conversation history / skill mining / weekly review
lifecycle: DISCARD
mode: any
---

# Learn Skills — Conversation History Mining

**Invoke:** "learn skills" | "extract skills from history" | "skill mining"

## What This Skill Does

Reads conversation history from all coding agents, identifies recurring patterns
(repeated questions, repeated errors, repeated manual solutions), and proposes
SKILL.md candidates for your review. You approve → skill enters Bible via GitOps.

---

## Part 1 — Conversation Log Paths

### Claude

| Surface | Device | User | Path |
|---|---|---|---|
| Claude.ai GUI | Air | leo | Browser only — export via Settings → Export Data → conversations.json |
| Claude.ai GUI | mini | yzliu | Browser only — same export path |
| Claude.ai GUI | mini | other users | Each user exports own account separately |
| Claude Code CLI | Air | leo | `~/.claude/projects/` — per-project `.jsonl` files |
| Claude Code CLI | mini | yzliu | `~/.claude/projects/` — per-project `.jsonl` files |
| Claude Code CLI | mini | other users | `/Users/<user>/.claude/projects/` |

### Codex

| Surface | Device | User | Path |
|---|---|---|---|
| Codex GUI (web) | Air | leo | No local path — export via openai.com account → Settings → Export |
| Codex GUI (web) | mini | yzliu | Same — web export only |
| Codex CLI | Air | leo | `~/.codex/` — check `history.jsonl` or `sessions/` |
| Codex CLI | mini | yzliu | `~/.codex/` same structure |

### Cursor

| Surface | Device | User | Path |
|---|---|---|---|
| Cursor GUI | Air | leo | `~/Library/Application Support/Cursor/User/globalStorage/cursor.storage` (SQLite) |
| Cursor GUI | mini | yzliu | Same path under yzliu home |
| Cursor GUI | mini | other users | `/Users/<user>/Library/Application Support/Cursor/User/globalStorage/cursor.storage` |
| Cursor (no CLI) | — | — | GUI only; no separate CLI log |

### Antigravity

| Surface | Device | User | Path |
|---|---|---|---|
| Antigravity GUI | Air | leo | TBD — check `~/Library/Application Support/Antigravity/` |
| Antigravity GUI | mini | yzliu | Same path |
| Antigravity GUI | mini | other users | `/Users/<user>/Library/Application Support/Antigravity/` |
| Antigravity CLI | Air | leo | TBD — check `~/.antigravity/` or app-specific dir |
| Antigravity CLI | mini | yzliu | Same |

> **Note on Antigravity paths:** confirm actual paths on first run with:
> `find ~/Library/Application\ Support/ -name "*.jsonl" -o -name "*.db" 2>/dev/null | grep -i antigrav`

---

## Part 2 — Extraction Process

### Step 1 — Collect

```bash
# Claude Code CLI logs (run as each user or with sudo on mini)
find /Users/yzliu/.claude/projects -name "*.jsonl" -newer ~/.last_skill_review

# Cursor SQLite (read-only)
sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/cursor.storage \
  "SELECT value FROM ItemTable WHERE key LIKE '%chat%'" 2>/dev/null

# Export files (Claude.ai, Codex web) — place in:
$AGENT_ROOT/.context/skill-mining/inbox/
```

All collected logs → `$AGENT_ROOT/.context/skill-mining/raw/YYYY-MM-DD/`

### Step 2 — Analyze (L1 LLM call)

Feed collected text to L1 with this prompt:

```
You are analyzing conversation history between a developer and AI coding assistants.

Identify patterns that appear 2+ times across different sessions:
1. Questions the developer had to ask repeatedly (knowledge gap)
2. Errors that recurred (process gap)  
3. Manual corrections the developer made to AI output (quality gap)
4. Multi-step workflows the developer had to re-explain each time (skill gap)

For each pattern, output:
{
  "pattern_type": "knowledge|process|quality|skill",
  "description": "one sentence",
  "frequency": N,
  "example_trigger": "what the developer said to invoke this",
  "proposed_skill_name": "verb-noun format",
  "skill_value": "high|medium|low"
}

Output JSON array only. No prose.
```

Save output → `$AGENT_ROOT/.context/skill-mining/candidates/YYYY-MM-DD.json`

### Step 3 — Filter

Auto-discard candidates where:
- `skill_value` = low
- `frequency` < 2
- Pattern is already covered by existing skill in `.context/skills/`

### Step 4 — Draft SKILL.md for each candidate

For each surviving candidate, generate a draft SKILL.md using `writing-skills` skill format.
Save to `$AGENT_ROOT/.context/skill-mining/drafts/<proposed-skill-name>/SKILL.md`

### Step 5 — Present to user for review

```
Skill Mining Report — YYYY-MM-DD
Found N candidates → M after filtering → presenting for review:

1. [proposed-skill-name] (frequency: N, type: skill_gap)
   Description: ...
   Draft: .context/skill-mining/drafts/<name>/SKILL.md
   → approve / reject / modify

[repeat per candidate]
```

### Step 6 — Approved skills → Bible

For each approved skill:
1. Move draft → `.context/skills/<name>/SKILL.md`
2. Add trigger row to AGENT.md Skill Router
3. `bash $TOOLS_ROOT/audit_append.sh $project_path skill_added skill-mining <name> - "approved from YYYY-MM-DD mining run"`
4. Git commit: `feat(skills): add <name> from learn-skills mining YYYY-MM-DD`

---

## Part 3 — Schedule

Run this skill:
- Weekly (Sunday) for active development periods
- After any major project phase completes
- When you notice yourself re-explaining something to an agent for the 3rd time

Last run timestamp → `$AGENT_ROOT/.context/skill-mining/last-run.txt`

---

## Audit Actions (add to audit_append.sh registry)

```
skill_mining_started   — learn-skills run initiated
skill_candidate_found  — pattern identified
skill_added            — approved skill entered Bible
skill_rejected         — candidate rejected by user
```
