# .context/skills/ — Agent Bible Skill Layer
# v1.5.0

## Directory

| Skill | Trigger keywords | Mode | Source |
|---|---|---|---|
| systematic-debugging | bug, error, test failure, unexpected behavior | any | superpowers (adapted) |
| verification-before-completion | mark done, claim fixed, commit, report complete | any | superpowers (adapted) |
| brainstorming-to-plan | new feature, design, architecture, hub change | any | superpowers + arch V2 |
| subagent-dispatch | multiple independent tasks, parallel dispatch | cli_collab | superpowers (adapted) |
| llm-cost-attribution | choosing model, tier routing, cost review | any | arch V2 LLM layer |
| hub-message-tracing | cross-layer issue, hub routing, trace_id debug | any | arch V2 CallHub |
| writing-skills | create skill, write skill, new skill | any | superpowers + Anthropic spec |
| learn-skills | learn skills, extract skills, skill mining | any | original |

## Design Principles

1. Same lifecycle discipline as rules/ — every skill has trigger, DISCARD/KEEP, mode
2. Skill check: trigger uncertain → load skill first, decide after reading
3. SKILL.md < 500 lines; heavy reference → separate file one level deep
4. New skills enter via learn-skills mining → user approval → git commit

## skill-mining/ Working Directory

```
.context/skill-mining/
  inbox/       — place exported chat logs here (Claude.ai, Codex web exports)
  raw/         — collected logs by date
  candidates/  — L1 analysis output JSON
  drafts/      — proposed SKILL.md files pending review
  last-run.txt — timestamp of last mining run
```
