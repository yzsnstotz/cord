# design_contract.md v2.1
# Trigger: design phase / interface def (multi_agent tasks only)
# DISCARD after use

## Scope

This rule applies **only** to `task_type: multi_agent` tasks.
`task_type: solo` and `task_type: copywriting` do not require a multi-worker interface contract.
For `copywriting`, the role flow is PM -> Executor -> Reviewer (Designer is skipped).

## Purpose

When multiple agents work in parallel on separate worker branches, they must agree on shared interfaces before starting. The designer produces a `design_contract.md` that defines these interfaces with precision.

## Hard Gate

**Design must be approved by the user before PM issues BranchInitSpec.**

If the user has not explicitly approved the design → PM MUST NOT issue BranchInitSpec.

## Contract File Format

Save to: `$project_path/docs/contracts/<task-slug>-contract.md`

### Required Sections

```markdown
# Interface Contract: <task-slug>

## Overview
[Brief description of what is being built and why parallel workers are needed]

## Workers
| Worker | Branch Label | Responsibility |
|--------|-------------|----------------|
| A      | executor-a  | [what this worker implements] |
| B      | executor-b  | [what this worker implements] |

## Shared Interfaces

### <Interface Name>
- **File**: `<exact/path/to/file.ts>`
- **Exported by**: Worker <X>
- **Consumed by**: Worker <Y>

```typescript
export function verifyToken(token: string): Promise<{userId: string, role: string}>;
export function refreshToken(oldToken: string): Promise<string>;
```

### <Interface Name 2>
[Same format]

## File Ownership

Each worker MUST only modify files in their designated scope.
Cross-worker file modifications are forbidden unless explicitly declared below.

| File Path | Owner Worker | Shared? | Reason |
|-----------|-------------|---------|--------|
| `src/auth.ts` | A | no | |
| `src/api.ts` | B | no | |
| `src/types.ts` | A | yes | shared type definitions |

## Dependencies

| Worker | depends_on | Reason |
|--------|-----------|--------|
| B | A | B consumes verifyToken exported by A |

## Constraints

- [List non-negotiable constraints that apply to all workers]
- [e.g., "All functions must be async", "No direct DB access from API layer"]
```

### Precision Requirements

1. **Function signatures**: Exact parameter names, types, and return types. No "TBD" or "to be determined".
2. **File paths**: Exact relative paths from repo root. No wildcards or "somewhere in src/".
3. **Dependencies**: Every cross-worker dependency must have an explicit `depends_on` entry.
4. **No undeclared file dependencies**: If Worker A and Worker B both touch the same file, it must be declared in File Ownership with `Shared? = yes` and a reason.

## Example

```markdown
# Interface Contract: auth-service

## Overview
JWT-based auth system. Worker A implements token generation/verification.
Worker B implements API middleware that consumes Worker A's exports.

## Workers
| Worker | Branch Label | Responsibility |
|--------|-------------|----------------|
| A      | executor-a  | Token service: generate, verify, refresh |
| B      | executor-b  | API middleware: route protection, role checks |

## Shared Interfaces

### Token Service
- **File**: `src/auth/token.ts`
- **Exported by**: Worker A
- **Consumed by**: Worker B

\`\`\`typescript
export function generateToken(userId: string, role: string): Promise<string>;
export function verifyToken(token: string): Promise<{userId: string, role: string}>;
export function refreshToken(oldToken: string): Promise<string>;
\`\`\`

## File Ownership
| File Path | Owner Worker | Shared? | Reason |
|-----------|-------------|---------|--------|
| `src/auth/token.ts` | A | no | |
| `src/auth/token.test.ts` | A | no | |
| `src/middleware/auth.ts` | B | no | |
| `src/middleware/auth.test.ts` | B | no | |
| `src/types/auth.d.ts` | A | yes | shared type definitions used by B |

## Dependencies
| Worker | depends_on | Reason |
|--------|-----------|--------|
| B | A | B imports verifyToken from src/auth/token.ts |

## Constraints
- All functions async (Promise-based)
- JWT secret via env var AUTH_SECRET, never hardcoded
- Token expiry: 1 hour access, 7 days refresh
```

## Validation

`git_ops.sh review-prep` will automatically verify:
- All `required_exports` from the contract are found in the worker branches
- No cross-contamination (workers modifying files outside their ownership)
- `path_matches` — files are at the declared paths

If validation fails, PM receives a structured report with specific failures.
