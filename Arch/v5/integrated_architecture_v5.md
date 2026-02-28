# 闭环AI自主研发体系 — 整合架构方案 v5.0

**三套体系**：Agent 体系（v2.0）+ CCB（无变更）+ rdloop coordinator  
**状态**：正式版  
**日期**：2026-02-26  
**基于**：integrated_architecture_v4.md + integrated_architecture_v4_to_v5_upgrade.md

**v5 核心升级**：
- **两参数正交路由**：废弃 `workflow_mode`，引入 `executor_type × session_mode` 正交参数，三模式归一为单一工作流
- **统一 Git 工作流**：Git 作为唯一状态管理器，新增 `git_ops.sh` 和 `loop_lifecycle.sh`，适用三种 executor_type
- **api_call 修复**：修复 v4 single 模式两个 Bug（judge feedback 未传递、worktree 时序问题）
- **Agent 体系 v2.0**：规则文件重构，废弃 cli_collab 路由，新增 git_collab 模式
- **GUI 扩展**：新增 Git Status / Knowledge Debt / Loop Stats 三个视图
- **保留 v4**：Knowledge Memory Sharding、adapter 映射、solo 模式 bridge 机制、knowledge only-read 原则

---

## 一、整体分工

```
┌──────────────────────────────────────────────────────────────┐
│                        用户 / 人类                            │
│         需求输入 / 审批 Hard Gate / 最终验收                   │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                    Agent 体系（认知层）v2.0                    │
│                                                               │
│  PM（Claude，当前会话）                                        │
│  ├── brainstorming-to-plan    需求 → 任务分解                  │
│  ├── session_state.json       由 coordinator 派生（git_collab）│
│  ├── shared_contracts         跨任务文件依赖图                 │
│  └── autoflow-run             生成 TaskSpec，读取结果          │
│                                                               │
│  PM 行为约束（git_collab 模式，HARD）：                        │
│  ├── 不执行任何 git 命令                                       │
│  ├── 通过 BranchInitSpec JSON 发起分支创建                     │
│  ├── 通过 MergeDecision JSON 发起 merge                        │
│  └── 不读 raw diff，只读 coordinator 结构化报告                │
│                                                               │
│  ↓ PM 写入 knowledge（decision_log shard）                     │
│  ↓ coordinator 自动从 PR description 提取写入 debt/module shard│
└───────────────────────────┬──────────────────────────────────┘
                            │ TaskSpec JSON
                            │ (executor_type + session_mode)
┌───────────────────────────▼──────────────────────────────────┐
│               rdloop coordinator（工程可靠性层）               │
│                                                               │
│  run_task.sh                                                  │
│  ├── executor_type 路由：api_call | solo_agent | multi_agent  │
│  ├── session_mode 策略：fresh | iterative | continuous        │
│  ├── 状态机 RUNNING/PAUSED/FAILED/READY_FOR_REVIEW            │
│  ├── worktree 由 git_ops.sh 前置初始化（不在 attempt 内部）    │
│  ├── atomic_write + lock + trap                               │
│  ├── test_cmd 执行（客观 rc，不可绕过）                        │
│  ├── decision_table / decision_solo（确定性状态转移）          │
│  └── events.jsonl（完整审计链）                               │
│                                                               │
│  git_ops.sh（新增）                                           │
│  ├── create-branches   BranchInitSpec → 分支 + worktree       │
│  ├── merge-pr          MergeDecision → merge                  │
│  └── review-prep       自动核对 contract，生成结构化报告        │
│                                                               │
│  loop_lifecycle.sh（新增）                                    │
│  ├── regression gate（test_cmd，不可绕过）                    │
│  ├── knowledge 写入（从 PR description 自动提取）              │
│  ├── loop_stats.jsonl 更新                                    │
│  ├── session_state.json 派生                                  │
│  └── events.jsonl loop_complete 事件                          │
│                                                               │
│  GUI（只读聚合视图）                                           │
│  ├── 项目层  ← session_state.json（coordinator 派生）          │
│  ├── step 层  ← .ccb/state.json                               │
│  ├── attempt 层 ← out/<task_id>/                              │
│  ├── knowledge 层 ← .context/knowledge/（shard）              │
│  ├── Git Status 层 ← GET /api/task/:id/git-status（新增）     │
│  ├── Knowledge Debt 层 ← GET /api/knowledge/shards/debt（新增）│
│  └── Loop Stats 层 ← loop_stats.jsonl（新增）                 │
└──────────┬─────────────────────┬──────────────────────────────┘
           │                     │
      call_coder            call_judge
           │                     │
┌──────────▼─────────────────────▼──────────────────────────────┐
│                  执行层 / 两参数路由（v5）                      │
│                                                               │
│  executor_type=api_call   session_mode=fresh|iterative        │
│  LLM API 单次调用，judge feedback git 化注入                   │
│  call_coder_cliproxy.sh / call_judge_cliproxy.sh              │
│                                                               │
│  executor_type=solo_agent  session_mode=continuous            │
│  单 coding agent + 扩展 bridge，coordinator 多轮 step 驱动     │
│  call_coder_solo.sh（solo_bridge + decision_solo）            │
│                                                               │
│  executor_type=multi_agent  session_mode=continuous           │
│  多角色（executor + reviewer），各自独立 worker 分支            │
│  call_coder_ccb.sh / call_judge_ccb.sh                        │
│  auto 时：call_coder_bridge.sh / call_judge_bridge.sh         │
└──────────┬────────────────────────────────────────────────────┘
           ↓ 查询
┌─────────────────────────────────────────────────────────────┐
│           knowledge agent（项目知识底座，v4 shard 不变）      │
│                                                              │
│  每项目一实例，常驻 CCB session（默认 codex）                  │
│  加载 _meta.json 索引，按需加载 shard                         │
│  新增查询场景：现有接口 exports / 未偿技术债 / 历史决策背景     │
│  原则不变：不写摘要、不读原始文件、不编写代码、不评审质量       │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、核心模型变化：两参数正交路由

### 2.1 v4 → v5 参数映射

v4 的三个 `workflow_mode` 废弃，替换为 task.json 里两个正交字段：

| v4 workflow_mode | v5 executor_type | v5 session_mode |
|-----------------|-----------------|----------------|
| `single` | `api_call` | `fresh` 或 `iterative` |
| `solo` | `solo_agent` | `continuous` |
| `collab` | `multi_agent` | `continuous` |

**executor_type**（谁来执行）：

| 值 | 含义 |
|----|------|
| `api_call` | 单次 LLM API 调用，无 agent tool call，无多轮内部循环 |
| `solo_agent` | 单个 coding agent（claude/codex CLI），有完整工具能力，多轮 step |
| `multi_agent` | 多角色（executor + reviewer，通过 CCB /ask 或 bridge），并行 worker 分支 |

**session_mode**（跨 attempt 如何处理上下文）：

| 值 | 含义 | 适用 executor_type |
|----|------|-------------------|
| `fresh` | 每次 attempt 清空上下文，从 seed instruction 重新开始。适合内容发散（文案多版本、头脑风暴） | api_call |
| `iterative` | 每次 attempt 携带前次 attempt 的输出和 judge feedback 作为输入，逐步精进。适合内容改稿 | api_call |
| `continuous` | agent 持续运行，coordinator 多轮 step 驱动。适合代码任务 | solo_agent, multi_agent |

两个字段独立正交，coordinator 的路由从「三个并列分支」变成「两个维度的组合路由」。

### 2.2 task.json 字段变更

废弃：`workflow_mode`  
新增：`executor_type`、`session_mode`  
保留并整合：`solo_config` 重命名为 `agent_config`，对 `api_call` 也生效

```json
{
  "task_id": "T01",
  "executor_type": "api_call | solo_agent | multi_agent",
  "session_mode": "fresh | iterative | continuous",
  "judge_enabled": true,
  "agent_config": {
    "max_attempts": 5,
    "auto_pass_threshold": 0.85,
    "knowledge_shards": ["auth", "api"],
    "provider": "claude | codex | gemini"
  },
  "collab_roles": {
    "executor": "claude",
    "reviewer": "codex"
  },
  "repo_path": "/path/to/project",
  "goal": "...",
  "acceptance": "...",
  "test_cmd": "..."
}
```

**合法组合约束**：`executor_type=api_call` 时 `session_mode` 只允许 `fresh` 或 `iterative`；`solo_agent` / `multi_agent` 只允许 `continuous`。

### 2.3 迁移脚本

```bash
migrate_task_json.sh <task.json>
# workflow_mode: collab  → executor_type: multi_agent, session_mode: continuous
# workflow_mode: solo    → executor_type: solo_agent,  session_mode: continuous
# workflow_mode: single  → executor_type: api_call,    session_mode: fresh
# solo_config            → 重命名为 agent_config
# workflow_mode 字段删除
```

已有项目在当前 loop 结束后、下一个 loop 开始前运行迁移脚本，平滑切换。

---

## 三、api_call 模式修复（Bug Fix）

### 3.1 v4 已知问题

v4 `workflow_mode: single` 存在两个 Bug，以实际任务 `task_claude_openclaw_notify_20260219_040857` 可直接观察：

**Bug 1：judge feedback 未传递给下一次 attempt 的 coder**

attempt_001 的 judge 输出了详细的 `next_instructions`，但 attempt_002 的 `coder/instruction.txt` 里只有 git diff.stat + goal + acceptance，judge 的 next_instructions 没有出现。coder 每次 attempt 都在从零重新猜，attempt loop 实质上失去意义。

**Bug 2：worktree 初始化时序问题导致 coder 空转**

events.jsonl 显示两次 attempt 都触发了 `STATE_CHANGED: PAUSED_NOT_GIT_REPO`，`worktree_path` 为空，coder elapsed=0 秒，实际没有执行任何工作。两个 bug 组合导致循环完全失效。

### 3.2 修复：worktree 前置初始化（Bug 2）

v5 里 worktree 由 `git_ops.sh create-branches` 在任务开始前创建完毕，不在 attempt 内部初始化。coordinator 在收到 BranchInitSpec 后立即建好 worktree，coder 启动时 worktree 必然存在。`PAUSED_NOT_GIT_REPO` 状态在 v5 的 git_collab 模式下不再出现。

### 3.3 修复：judge feedback git 化注入（Bug 1）

`call_coder_cliproxy.sh` 在 attempt > 1 时，按 session_mode 组装 prompt：

```bash
# iterative 模式（attempt > 1）
prev_output=$(git show HEAD:<output_file> 2>/dev/null || echo "")
judge_feedback=$(python3 -c "
import json
with open('.rdloop/attempt_$(( N-1 ))/verdict.json') as f:
    v = json.load(f)
print(v.get('next_instructions', ''))
" 2>/dev/null || echo "")

prompt = goal
       + "\n\n=== 上一版本 ===\n" + prev_output
       + "\n\n=== Judge 修改指引 ===\n" + judge_feedback
       + "\n\n=== 验收标准 ===\n" + acceptance

# fresh 模式：每次 attempt prompt = goal + acceptance（不注入任何历史）
```

next_instructions 提取是确定性 JSON 读取操作，无 LLM 参与。

### 3.4 api_call attempt 状态机（完整）

```
前置：worktree 已由 git_ops.sh create-branches 建好

loop attempt 1..max_attempts:
  1. call_coder_cliproxy.sh（按 session_mode 组装 prompt）
       fresh:     prompt = goal + acceptance
       iterative: prompt = goal
                         + git show HEAD:<output_file>
                         + git show HEAD:.rdloop/attempt_(N-1)/verdict.json → next_instructions
                         + acceptance
  2. commit 产出 + verdict placeholder 到 worker 分支
     commit message: "attempt N: score=XX"
  3. if judge_enabled: call_judge_cliproxy.sh → verdict.json
     amend commit 写入 .rdloop/attempt_N/verdict.json
  4. if test_cmd: 执行，rc 不可绕过
  5. decision_table:
       score >= threshold AND rc == 0  → READY_FOR_REVIEW → 开 PR
       score < threshold AND n < max   → n++, continue
       n >= max                        → PAUSED
```

### 3.5 Git 化对 api_call 的价值

api_call 任务同样走 git 分支流程，每次 attempt 的产出和 judge verdict 一起 commit 进 worker 分支：

```
a3f1c2e  attempt 3: score=82  output.md + verdict.json  ← READY_FOR_REVIEW
b8d4e91  attempt 2: score=71  output.md + verdict.json  ← iterative 改进
1ff2caf  attempt 1: score=55  output.md + verdict.json  ← 初版
```

- **verdict.json 在 git 里**：下一次 attempt 直接 `git show HEAD:.rdloop/attempt_N/verdict.json` 读取，不依赖文件系统路径
- **fresh mode 多版本**：git history 完整保留，`git diff attempt_1..attempt_3` 可直接看发散方向
- **iterative 精进过程**：commit 链清晰，`git show HEAD:<output_file>` 读上一版本，零额外机制

---

## 四、统一 Git 工作流

### 4.1 分支结构（三种 executor_type 统一）

```
main
 └── task/<YYYYMMDD>-<slug>                 ← loop 主分支，coordinator 创建
      └── worker/<slug>-content             ← api_call（单分支）
          worker/<slug>-agent               ← solo_agent（单分支）
          worker/<slug>-executor-A          ← multi_agent executor A
          worker/<slug>-executor-B          ← multi_agent executor B（并行时）
          worker/<slug>-reviewer            ← multi_agent 独立 review 分支（如需）
```

分支状态语义统一：

| 分支/PR 状态 | 语义 |
|---|---|
| 分支存在 | 任务已分配 |
| PR open | 任务进行中 |
| PR changes_requested | 任务 blocked，等待修复 |
| PR merged | 任务 done |

### 4.2 BranchInitSpec / MergeDecision 协议

PM 在任何 executor_type 下遵循相同约束：PM 不执行任何 git 命令，通过 JSON 意图声明触发 coordinator 执行。

**BranchInitSpec**（PM → coordinator，发起分支创建）：

```json
{
  "type": "BranchInitSpec",
  "task_slug": "homepage-copy",
  "date": "20260226",
  "workers": [
    { "task_id": "T01", "executor_type": "api_call",    "label": "content"    },
    { "task_id": "T02", "executor_type": "multi_agent", "label": "executor-A" }
  ]
}
```

**MergeDecision**（PM → coordinator，发起 merge）：

```json
{
  "type": "MergeDecision",
  "task_id": "T01",
  "verdict": "approve | request_changes",
  "blocking_issues": [],
  "merge_after": ["T02"]
}
```

### 4.3 PR description 模板（三种 executor_type 统一）

```markdown
## Task
task_id: T01 | executor_type: api_call | session_mode: iterative

## 产出摘要
[api_call: 最终版本内容摘要 + 迭代轮次 + 最终 judge 评分]
[solo_agent / multi_agent: 实现了什么]

## 质量评分（api_call / solo_agent judge 启用时填写）
- judge overall: 8.2 / 10
- 关键维度: clarity=8, completeness=9

## 接口实现情况（multi_agent 填写）
- [x] verifyToken(token: string) => Promise<{userId, role}>

## 偏离契约说明（multi_agent，如有）
- 无 / [原因]

## 已知欠债（如有）
- [描述临时实现、设计上的不完整之处]

## 验证
- [x] test_cmd 通过 / 手动验证场景: [描述]
```

`loop_lifecycle.sh` 在 merge 后从 `## 产出摘要` 节提取 module shard，从 `## 已知欠债` 节提取 debt shard，无 LLM 参与。

### 4.4 git_ops.sh（新增）

coordinator 的 git 操作层，接收来自 PM 的意图 JSON，执行确定性 git 命令（LLM 不直接跑 git）：

```bash
git_ops.sh create-branches <branch_init_spec.json>
git_ops.sh merge-pr         <merge_decision.json>
git_ops.sh review-prep      <task_slug> <contract_path>
```

`review-prep` 输出（结构化，注入 PM，替代 raw diff）：

```json
{
  "task_id": "T01",
  "executor_type": "multi_agent",
  "contract_check": {
    "required_exports": ["verifyToken", "refreshToken"],
    "found_exports":    ["verifyToken", "refreshToken"],
    "missing": [],
    "path_matches": true,
    "cross_contamination": false
  },
  "diff_summary": "修改 src/auth.ts（+89/-12），新增 src/auth.test.ts（+45）",
  "judge_scores": null,
  "pr_description": "..."
}
```

`api_call` / `solo_agent` 类型中 `contract_check` 为 null，但会包含 `judge_scores`。

### 4.5 loop_lifecycle.sh（新增）

所有 worker PR merged 后，coordinator 自动触发，**全程无 LLM**：

```bash
loop_lifecycle.sh on-loop-complete <task_slug>
```

执行顺序：

1. **Regression gate**：运行 `test_cmd`。失败则阻断，写入 `REGRESSION_FAILED` 事件，等待人工介入
2. **Knowledge 写入**：从各 PR description 提取 file-level summary → 写对应 module shard；提取 `## 已知欠债` → 写 debt shard（幂等）
3. **Loop stats**：追加写 `loop_stats.jsonl` 条目（各 task 实际 attempt 轮次、总耗时）
4. **session_state.json 派生**：从 git 分支状态生成，task 全 done → loop 完成标记
5. **events.jsonl**：写 `loop_complete` 事件

---

## 五、run_task.sh：两参数路由逻辑

废弃 `workflow_mode` case 分支，替换为：

```bash
executor_type=$(json_read "$TASK_JSON" "executor_type" "")
session_mode=$(json_read  "$TASK_JSON" "session_mode"  "continuous")

# executor_type 为空时报错退出
[ -z "$executor_type" ] && { echo "ERROR: executor_type required"; exit 1; }

case "$executor_type" in
  api_call)    coder_adapter="cliproxy" ;;
  solo_agent)  coder_adapter="solo"     ;;
  multi_agent) coder_adapter="ccb"      ;;
esac

case "$session_mode" in
  fresh)      context_strategy="reset"   ;;
  iterative)  context_strategy="carry"   ;;
  continuous) context_strategy="persist" ;;
esac

# 前置检查：worktree 已由 git_ops.sh create-branches 建好
[ ! -d "$worktree_path" ] && { echo "ERROR: worktree not found"; exit 1; }
```

原有 adapter（cursor/codex/mock）保留，可通过 `agent_config.provider` 指定，不删除现有逻辑。

---

## 六、Agent 体系升级（v2.0）

### 6.1 AGENT.md Rule Router 变更

废弃：

```
cli_collab activated → rules/cli_collab.md + rules/collab_context.md（State Read Delegation 部分）
```

新增：

| 触发条件 | 规则文件 | 加载模式 |
|----------|----------|----------|
| `git_collab activated` | `rules/git_collab.md` | KEEP |
| `design phase / interface def` | `rules/design_contract.md` | DISCARD |

**Quick Rules 新增（git_collab 模式）**：

| 操作 | 规则 |
|------|------|
| state update | coordinator 从 git 状态派生，PM 不调用 state_update.sh |
| task assign | PM 发 BranchInitSpec JSON，coordinator 创建分支 |
| task review | PM 发 MergeDecision JSON，coordinator 执行 merge |
| diff review | coordinator 执行 review-prep，结构化报告注入 PM，PM 不读 raw diff |

### 6.2 新增规则文件：rules/git_collab.md

**PM 行为约束（HARD）**：
- PM 不执行任何 git 命令
- PM 通过 BranchInitSpec 发起分支创建，通过 MergeDecision 发起 merge
- PM 收到的是 coordinator 准备的结构化报告，不读 raw diff
- session_state.json 由 coordinator 维护，PM 不调用 state_update.sh

**Executor 行为约束（HARD）**：
- 只在自己的 worker 分支工作
- 不得修改其他 worker 分支或 task 主分支
- push 前必须确认本地测试通过
- 偏离 design_contract 必须在 PR description 说明，不得静默偏离

### 6.3 新增规则文件：rules/design_contract.md

规范 designer 输出 `design_contract.md` 的格式，**仅 multi_agent executor_type 任务必须**：

- 精确到函数签名和文件路径，不允许模糊描述
- 依赖关系必须显式声明（`depends_on`）
- 并行 task 之间不允许未声明的文件依赖
- **Hard Gate（继承）**：设计未获用户批准 → PM 不得发出 BranchInitSpec

保存路径：`$project_path/docs/contracts/<task-slug>-contract.md`

`api_call` 和 `solo_agent` 任务是单一 worker，不需要 interface contract。

### 6.4 规则文件精简

**collab_context.md**：删除 State Read Delegation 部分（PM 委托 executor 读 `.ccb/state.json`）。git_collab 模式下 coordinator 直接读状态并注入给 PM。保留：Role Assignment、Async Guardrail、Rubric A / B、Inspiration Constraint。

**session_mgmt.md**：删除 session compression 流程。新 loop 启动时，PM 从以下内容重建上下文（由 coordinator 注入）：

- `AGENT.md`（永久上下文，PM 自加载）
- knowledge `_meta.json`（shard 索引）
- 相关 shard 内容（debt / decision_log / 相关 module shard）
- 上一 loop 的 PR summary（`git log --oneline task/<prev-slug>`）

**solo 模式**：`state_update.sh` 仍由 PM 调用，session compression 流程保留，标注"solo 模式专用"。

### 6.5 废弃工具（git_collab 模式下）

| 工具 | 废弃原因 |
|------|----------|
| `tools/state_update.sh`（git_collab 模式） | coordinator 从 git 分支/PR 状态派生，session_state.json 自动更新 |
| `tools/audit_append.sh` | git log 是天然审计链 |
| `tools/index_upsert.sh` | git tree 替代 |
| `tools/index_verify.sh` | git tree 替代 |
| `tools/hash.sh` | commit hash 替代 |

solo 模式下上述工具保留直到完成 git 化。

### 6.6 新增 knowledge shard：decision_log 和 debt

**decision_log shard**（PM 在每个 loop Design 获批后、BranchInitSpec 发出前手动写入）：

```json
{
  "entries": {
    "loop:20260226-auth": {
      "type": "decision",
      "decided": "使用 JWT 而非 session cookie",
      "rationale": "部署目标是无状态服务",
      "rejected_options": ["session + Redis"],
      "constraints": ["不得改变 auth 接口签名，下游已依赖"],
      "written_by": "PM",
      "loop_id": "task/20260226-auth-service"
    }
  }
}
```

**debt shard**（coordinator 在 merge 时自动从 PR description 提取，无 LLM 参与）：

```json
{
  "entries": {
    "debt:T01-20260226": {
      "type": "debt",
      "task_id": "T01",
      "file": "src/auth.ts",
      "description": "token 刷新逻辑未处理并发冲突",
      "severity": "medium",
      "loop_id": "task/20260226-auth-service",
      "written_by": "coordinator"
    }
  }
}
```

**knowledge agent 新增查询场景（Design 阶段）**：
- 「现有接口有哪些 exports？」→ file shard，designer 用作 `depends_on` 契约基础
- 「这个模块有哪些未偿还技术债？」→ debt shard，PM 决策是否纳入本 loop
- 「这个设计决策是什么时候做的、原因是什么？」→ decision_log shard

---

## 七、Knowledge Memory Sharding（继承 v4，新增 debt / decision_log shard）

### 7.1 Shard 目录布局（v5 扩展）

```
<project>/.context/knowledge/
  _meta.json           # shard 注册表
  auth.json            # module shard: auth 模块
  api.json             # module shard: API 层
  frontend.json
  tasks.json           # task:T* 条目（可集中或按业务 shard）
  debt.json            # 技术债 shard（v5 新增，coordinator 写）
  decision_log.json    # 决策日志 shard（v5 新增，PM 写）
```

**_meta.json**（不变）：

```json
{
  "version": "1.0",
  "project": "<name>",
  "shards": {
    "auth":         { "description": "...", "entry_count": 5, "last_updated": "..." },
    "debt":         { "description": "技术债记录", "entry_count": 3, "last_updated": "..." },
    "decision_log": { "description": "设计决策记录", "entry_count": 2, "last_updated": "..." }
  }
}
```

### 7.2 写路径

- **module shard**：executor 在 READY_FOR_REVIEW 时通过 `write_knowledge_cache.py --shard <module>` 写入文件摘要（v4 不变）
- **debt shard**：coordinator `loop_lifecycle.sh` 在 merge 后自动从 PR description `## 已知欠债` 节提取，无 LLM
- **decision_log shard**：PM 在 Design 阶段通过 `write_knowledge_cache.py --writer pm --shard decision_log` 手动写入

### 7.3 读路径

- **knowledge agent**：先读 `_meta.json` 作为索引，按需加载 shard（含 debt / decision_log）
- **GUI**：`GET /api/knowledge/shards` 返回 _meta；`GET /api/knowledge/shards/:shard` 返回该 shard 的 entries；`GET /api/knowledge/shards/debt` 按 severity 分组返回（v5 新增端点）

### 7.4 迁移与回退（同 v4）

- **migrate_knowledge_cache.py**：读取现有 `knowledge_cache.json`，按 key 启发式分组写出各 shard，原文件重命名为 `.bak`
- **回退**：若不存在 `.context/knowledge/` 而存在 `knowledge_cache.json`，工具仍读单文件

---

## 八、GUI 升级

### 8.1 task 创建/编辑面板

废弃 `workflow_mode` 单选，替换为两个联动下拉：

- **Executor Type**：`API Call` / `Solo Agent` / `Multi Agent`
- **Session Mode**：`Fresh` / `Iterative` / `Continuous`

Session Mode 按 Executor Type 约束可选项：

| Executor Type | 可选 Session Mode | 禁用 |
|---|---|---|
| API Call | Fresh, Iterative | Continuous |
| Solo Agent | Continuous | Fresh, Iterative |
| Multi Agent | Continuous | Fresh, Iterative |

server 端同样校验非法组合（`api_call + continuous` → HTTP 400）。

### 8.2 新增：Git Status 视图

项目视图中新增 Git Status 面板，来源：`GET /api/task/:taskId/git-status`：

- 当前活跃 task 分支和各 worker 分支状态（open / changes_requested / merged）
- 各 PR 的 contract_check 结果（pass/fail/pending）；api_call 类型显示 judge_scores

### 8.3 新增：Knowledge Debt 视图

Knowledge Viewer 新增 Debt tab，来源：`GET /api/knowledge/shards/debt`：

- 显示 debt shard 所有条目，按 severity（high / medium / low）和 loop_id 分组
- 用途：PM 在下一 loop Design 阶段快速感知未偿还技术债

### 8.4 新增：Loop Stats 面板

attempt 视图新增 Loop Stats 入口，展示 `loop_stats.jsonl`：

- 各 loop 的执行时间、各 task 实际 attempt 轮次 vs max_attempts
- 纯展示，无交互，供 PM/designer 规划下一 loop 任务量时参考

### 8.5 保持不变

Solo Agent Progress 面板、Knowledge Viewer shard 列表和条目浏览、项目/step/attempt 三层视图、Settings 中 Knowledge 配置区。

---

## 九、完整工作流（v5.0）

```
[Loop N 开始]

1. 新 PM instance 启动
   coordinator 注入：
   - AGENT.md（PM 自加载）
   - _meta.json + 相关 shard（debt / decision_log / 相关 module shard）
   - 上一 loop PR summary（git log --oneline task/<prev-slug>）
   无需手工 session 压缩

2. Designer/PM 设计
   可 query knowledge agent（file shard / debt shard / decision_log shard）
   产出：
   - design_contract.md（multi_agent 任务必须；api_call/solo_agent 不需要）
   PM 写入 decision_log shard（本次决策、原因、约束）
   用户审批 → Hard Gate（未获批不得发出 BranchInitSpec）

3. PM 发出 BranchInitSpec JSON
   coordinator → git_ops.sh create-branches
   → task 主分支 + worker 分支 + worktree 一次性建好
   分支创建完成 = 任务分配完成，PM 进入等待

4. Executor 执行

   api_call（fresh / iterative）：
     coordinator 驱动 attempt 循环
     每次 attempt：coder → commit → judge（amend commit）→ test_cmd → decision
     judge 评分达标 → READY_FOR_REVIEW → 开 PR

   solo_agent（continuous）：
     coordinator 通过 solo_bridge 驱动 agent 多轮 step
     阶段性 commit 进 worker 分支
     decision_solo 判定 READY_FOR_REVIEW → 开 PR

   multi_agent（continuous）：
     各 executor 在各自 worker 分支独立并行
     完成后各自开 PR

5. coordinator → git_ops.sh review-prep
   自动核对 interface contract（multi_agent）
   自动检查跨分支污染（cross_contamination）
   生成结构化报告注入 PM

6. PM review（低 token）
   读结构化报告，只做判断：
   - 跨 worker 接口对齐（multi_agent）
   - merge 顺序决策
   发出 MergeDecision JSON

7. coordinator → git_ops.sh merge-pr
   merge 完成 → loop_lifecycle.sh on-loop-complete：
   ① regression gate（test_cmd，不可绕过）
   ② 提取 PR description → 更新 module shard + debt shard
   ③ 追加 loop_stats.jsonl
   ④ 派生更新 session_state.json
   ⑤ 写 loop_complete 事件

[Loop N 结束 → Loop N+1，步骤 1 通过 knowledge shard + git log 完整恢复上下文]
```

---

## 十、各体系调整关键点

### 10.1 Agent 体系（v2.0）

| 文件 | 修改内容 |
|------|----------|
| `AGENT.md` | Rule Router 升级：废弃 cli_collab，新增 git_collab / design_contract；Quick Rules 新增四条 git_collab 规则；版本号 v2.0 |
| `rules/git_collab.md` | 新增：PM / Executor 行为约束（HARD），BranchInitSpec / MergeDecision JSON schema |
| `rules/design_contract.md` | 新增：multi_agent 专用 interface contract 格式规范，Hard Gate 说明 |
| `rules/collab_context.md` | 删除 State Read Delegation；保留 Role Assignment / Async Guardrail / Rubric A-B / Inspiration Constraint |
| `rules/session_mgmt.md` | 删除 session compression；新增新 loop 上下文重建说明；solo 模式压缩保留并标注 |
| `tools/write_knowledge_cache.py` | 新增 debt / decision_log shard 写入支持（继承 v4 shard 框架） |
| `tools/init_knowledge_agent.sh` | 新增 debt / decision_log shard 按需加载（继承 v4 逻辑） |

### 10.2 CCB

无变更（cask/gask 接口满足需求）。

### 10.3 rdloop coordinator

| 文件 | 修改内容 |
|------|----------|
| `coordinator/run_task.sh` | 废弃 workflow_mode case，替换为 executor_type × session_mode 两参数路由；worktree 前置检查；Bug2 修复（不在 attempt 内部 init worktree）；保留原有 adapter |
| `coordinator/lib/call_coder_cliproxy.sh` | Bug1 修复：iterative 模式注入 prev_output + judge.next_instructions；verdict.json amend commit 逻辑 |
| `tools/git_ops.sh` | 新增：create-branches / merge-pr / review-prep 三子命令 |
| `tools/loop_lifecycle.sh` | 新增：on-loop-complete 收尾流程（regression gate / knowledge 写入 / stats / session_state 派生） |
| `coordinator/gui/server.js` | 新增 GET /api/task/:id/git-status、GET /api/knowledge/shards/debt；联动约束校验；文件不存在返回 404 |
| `coordinator/gui/src/` | 废弃 workflow_mode 控件；新增 Executor Type / Session Mode 联动下拉；新增 GitStatusPanel / KnowledgeDebtPanel / LoopStatsPanel |
| `docs/schema/task_schema_v5.json` | 新增：executor_type / session_mode / agent_config schema，collab_roles 条件必填，合法组合约束 |
| `tools/migrate_task_json.sh` | 新增：v4 → v5 字段迁移，幂等 |

---

## 十一、session_state.json 维护方式变更

| 模式 | v4 | v5 |
|------|----|----|
| git_collab（multi_agent） | PM 调用 `state_update.sh` 写入 | `loop_lifecycle.sh` 和 `git_ops.sh` 在关键 git 事件时自动派生，PM 不写 |
| solo 模式 | PM 调用 `state_update.sh` | 同 v4，不变 |

GUI 读取方式不变（只读聚合）。

---

## 十二、规则文件变更对照

### 废弃

| 文件/内容 | 废弃原因 |
|-----------|----------|
| `rules/cli_collab.md`（状态写规则部分） | `git_collab.md` 替代 |
| `rules/collab_context.md`（State Read Delegation） | coordinator 直接读 git，PM 收结构化报告 |
| `rules/task_mgmt.md`（Coder→PM JSON report 格式） | PR description 模板替代（git_collab 模式） |
| `rules/session_mgmt.md`（session compression） | knowledge shard + git log 替代 |
| `tools/state_update.sh`（git_collab 模式） | coordinator 派生替代 |
| `tools/audit_append.sh` | git log 替代 |
| `tools/index_upsert.sh` / `index_verify.sh` / `hash.sh` | git tree + commit hash 替代 |

### 新增

| 文件 | 用途 |
|------|------|
| `rules/git_collab.md` | git_collab 模式核心规范 |
| `rules/design_contract.md` | multi_agent 专用 interface contract 格式规范 |
| `tools/git_ops.sh` | coordinator git 操作层 |
| `tools/loop_lifecycle.sh` | loop 结束收尾自动化 |
| `docs/schema/task_schema_v5.json` | v5 task.json schema 定义 |
| `tools/migrate_task_json.sh` | v4 → v5 迁移脚本 |

### 不变

`rules/exceptions.md`、`rules/file_ops.md`、`rules/model_routing.md`、`rules/network_authority.md`、`rules/init.md`、`rules/startup.md`、所有 skills、knowledge shard 机制（v4）、solo_bridge.sh / decision_solo.py / call_coder_solo.sh（solo_agent 路径）、migrate_knowledge_cache.py（v4 提供，v5 不变）。

---

## 十三、迁移路径

### 13.1 task.json 迁移

```bash
# 当前 loop 结束后、下一个 loop 开始前执行：
migrate_task_json.sh <task.json>
```

迁移脚本幂等，可对已迁移文件重复执行。

### 13.2 knowledge shard 迁移

```bash
# v4 已提供，v5 不变：
migrate_knowledge_cache.py <project_path>
```

### 13.3 迁移顺序建议

1. 当前 loop 正常以 v4 方式完成
2. loop 结束后运行 `migrate_task_json.sh` 批量迁移所有 task.json
3. 部署 v5 coordinator（含 git_ops.sh、loop_lifecycle.sh）
4. 下一个 loop 从步骤 1（PM 新实例启动）开始以 v5 方式运行

---

## 十四、token 效能收益汇总

| 节约点 | v4 | v5 | 估算 |
|--------|----|----|------|
| PM 读 diff | LLM 委托 executor，2 次往返 | coordinator review-prep 注入结构化报告 | 每次 PR review 节约 ~1000 token |
| PM 发任务 | /ask 携带完整 WORKER CONTEXT（~300 token/次） | worker 分支创建 = 任务分配，无 token | 每个 task 节约 300+ token |
| 状态同步 | PM 轮询 + state_update 调用 | coordinator 监听 git 事件，PM 不轮询 | 消除所有中间状态同步调用 |
| session compression | 每 session 末尾手工压缩 | knowledge shard + git log 自动持久化 | 消除 session 末尾的压缩开销 |
| 跨 loop 上下文重建 | PM 需大量提示重建项目状态 | coordinator 按需注入相关 shard | 每个新 loop 节约 500–2000 token |
| knowledge 写入触发 | READY_FOR_REVIEW 时 LLM 触发 | merge 时 coordinator 从 PR description 自动提取 | 消除一次 LLM 调用 |
| api_call 版本管理 | 无，每次 attempt 结果孤立 | git 分支 commit 历史，零额外成本 | 增加功能但不增加 token |

---

## 十五、版本对照

| 体系 | v4.0 | v5.0 | 主要变化 |
|------|------|------|----------|
| Agent 体系 | v1.9.0+ | v2.0 | git_collab 规则体系；PM 行为约束；decision_log / debt shard；session compression 废弃 |
| CCB | 当前 | 无需升级 | — |
| rdloop | three-mode + shard | 两参数正交 + 统一 Git 工作流 | workflow_mode 废弃；git_ops.sh；loop_lifecycle.sh；api_call Bug Fix；GUI 三新视图 |

---

*基于 integrated_architecture_v4.md + integrated_architecture_v4_to_v5_upgrade.md，整合于 2026-02-26*
