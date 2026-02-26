# 闭环AI自主研发体系 — v4 → v5 升级设计
# 状态：设计草案 rev.2
# 日期：2026-02-26

---

## 核心升级动机

v4 解决了「单 loop 内怎么可靠执行」的问题。
v5 要解决两件事：

**一、多 loop 之间可靠传递**

根本驱动是：用户以前需要亲自担任 coordinator 角色，反复参与调度 LLM 来逐渐贴近需求。多 loop 的目标是让 coordinator + agent 协同替代这部分人工时间。多 loop 的来源有两种：用户带来新需求（最主要），以及 designer/PM 刻意控制单 loop 工作量——把同质任务压进一个 loop，然后清空 session 进入下一个 loop，以防止 LLM 漂移和 context 溢出。

**二、三种执行模式统一到单一工作流**

v4 的 single / solo / collab 是三个并列的 workflow_mode，底层状态管理、任务分发信道、产出汇报格式各不相同，维护成本高。v5 把这三个模式归一为一个工作流，差异变成两个正交参数。Git 作为唯一状态管理器，对三种执行方式统一适用。

**设计原则不变**：确定性的事交给 coordinator 程序化执行；低复杂度任务用便宜模型；高级模型只做低频但需要深度判断的任务。

---

## 一、核心模型变化：workflow_mode 废弃，两参数正交

### 1.1 v4 模式对比 v5 参数

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

| 值 | 含义 |
|----|------|
| `fresh` | 每次 attempt 清空上下文，从 seed instruction 重新开始。适合内容发散（文案多版本、头脑风暴） |
| `iterative` | 每次 attempt 携带前次 attempt 的输出作为输入，逐步精进。适合内容改稿 |
| `continuous` | agent 持续运行，coordinator 多轮 step 驱动。适合代码任务 |

两个字段独立正交，coordinator 的路由从「三个并列分支」变成「两个维度的组合路由」。

### 1.2 task.json 字段变更

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

---

## 二、Single 模式修复（api_call executor_type）

### 2.1 问题描述

v4 引入 `workflow_mode: single` 时引入了两个 bug，以实际任务 `task_claude_openclaw_notify_20260219_040857` 为例可以直接观察到：

**Bug 1：judge feedback 未传递给下一次 attempt 的 coder**

attempt_001 的 judge 输出了详细的 `next_instructions`（FAIL，含明确的修复指引：哪些文件缺失、哪些测试需要补充、哪些行为需要验证）。但 attempt_002 的 `coder/instruction.txt` 里只有 git diff.stat + goal + acceptance，**judge 的 next_instructions 没有出现**。coder 不知道上一次哪里不够好、要往哪个方向改，等于每次 attempt 都在从零重新猜。

**Bug 2：worktree 初始化时序问题导致 coder 空转**

events.jsonl 显示两次 attempt 都触发了 `STATE_CHANGED: PAUSED_NOT_GIT_REPO`，`worktree_path` 为空，coder elapsed=0 秒，实际没有执行任何工作。attempt_002 的 judge 因此收不到任何新内容，只能输出 `NEED_USER_INPUT`——不是 judge 的问题，是 coder 根本没跑。

这两个 bug 组合起来的效果是：attempt loop 在形式上存在，但每次 attempt 实质上是空的，judge feedback 没有驱动任何改进，循环完全失去意义。

这个循环是 single 模式的核心价值：通过 fresh mode 实现多版本内容发散，通过 iterative mode 实现内容逐步精进，judge 的 next_instructions 作为每轮的改进方向。

### 2.2 修复内容（coordinator run_task.sh）

**修复 Bug 1：judge feedback 注入**

coordinator 在进入下一次 attempt 前，从上一次 attempt 的 `judge/verdict.json` 提取 `next_instructions` 字段，写入 attempt N+1 的 instruction 中。这是确定性的 JSON 读取操作，无 LLM 参与：

```bash
# call_coder_cliproxy.sh 在 attempt > 1 时的 instruction 构成（iterative 模式）
prev_output=$(git show HEAD:<output_file> 2>/dev/null || echo "")
judge_feedback=$(python3 -c "
import json
with open('attempt_$(( N-1 ))/judge/verdict.json') as f:
    v = json.load(f)
print(v.get('next_instructions', ''))
" 2>/dev/null || echo "")

prompt = goal + "

=== 上一版本 ===
" + prev_output        + "

=== Judge 修改指引 ===
" + judge_feedback        + "

=== 验收标准 ===
" + acceptance
```

fresh 模式不注入 prev_output 和 judge_feedback，每次从零开始。

**修复 Bug 2：worktree 前置初始化**

v5 里 worktree 由 `git_ops.sh create-branches` 在任务开始前创建完毕，不在 attempt 内部初始化。coordinator 在收到 BranchInitSpec 后立即建好 worktree，coder 启动时 worktree 必然存在。`PAUSED_NOT_GIT_REPO` 状态在 v5 的 git_collab 模式下不会出现。

**api_call attempt 状态机（完整，不得提前退出）：**

```
attempt N:
  1. call_coder_cliproxy.sh（按 session_mode 组装 prompt）
     fresh:      prompt = goal + acceptance
     iterative:  prompt = goal + prev_output + judge.next_instructions + acceptance
  2. commit 产出到 worker 分支（commit message: "attempt N"）
     同时将 verdict.json 写入 .rdloop/attempt_N/verdict.json 并 commit
  3. if judge_enabled: call_judge_cliproxy.sh → verdict.json
  4. if test_cmd: 执行，rc 不可绕过
  5. decision_table:
     score >= threshold AND rc == 0  → READY_FOR_REVIEW
     score < threshold AND n < max   → n++, continue（feedback 已在 git，下轮自动读取）
     n >= max                        → PAUSED
```

### 2.3 Git 化对 api_call 的价值

api_call 任务同样走 git 分支流程，每次 attempt 的产出和 judge verdict 一起 commit 进 worker 分支。

以 `task_claude_openclaw_notify` 为例，git 化后 worker 分支的 commit history 会是：

```
a3f1c2e  attempt 3: score=82  requirements.md + verdict.json  ← READY_FOR_REVIEW
b8d4e91  attempt 2: score=71  requirements.md + verdict.json  ← iterative 改进
1ff2caf  attempt 1: score=55  requirements.md + verdict.json  ← 初版
```

这带来的价值：
- **verdict.json 在 git 里**：下一次 attempt 的 coder instruction 直接 `git show HEAD:.rdloop/attempt_N/verdict.json` 读取 next_instructions，不依赖文件系统路径，不会出现 attempt 目录找不到的情况
- **fresh mode 多版本**：git history 里完整保留，`git diff attempt_1..attempt_3` 可以直接看发散方向
- **iterative 精进过程**：commit 链清晰，`git show HEAD:<output_file>` 读上一版本，零额外机制
- **`PAUSED_NOT_GIT_REPO` 永久消失**：worktree 在 BranchInitSpec 阶段就已建好，coder 启动时 repo 必然存在

---

## 三、统一 Git 工作流（适用三种 executor_type）

### 3.1 分支结构（统一）

所有 executor_type 使用相同的分支命名规范：

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
- 分支存在 = 任务已分配
- PR open = 任务进行中
- PR changes_requested = 任务 blocked，等待修复
- PR merged = 任务 done

### 3.2 PM 行为（三种类型统一）

PM 在任何 executor_type 下遵循相同约束：

1. PM 不执行任何 git 命令
2. Design 获批后发出 `BranchInitSpec` JSON → coordinator 创建分支
3. 等待 coordinator 注入的结构化 review 报告
4. 发出 `MergeDecision` JSON → coordinator 执行 merge

```json
{
  "type": "BranchInitSpec",
  "task_slug": "homepage-copy",
  "date": "20260226",
  "workers": [
    { "task_id": "T01", "executor_type": "api_call", "label": "content" }
  ]
}
```

```json
{
  "type": "MergeDecision",
  "task_id": "T01",
  "verdict": "approve | request_changes",
  "blocking_issues": [],
  "merge_after": []
}
```

### 3.3 PR description 模板（统一，各类型扩展）

```markdown
## Task
task_id: T01 | executor_type: api_call | session_mode: iterative

## 产出摘要
[api_call: 最终版本内容摘要 + 迭代轮次 + 最终 judge 评分]
[solo_agent / multi_agent: 实现了什么]

## 质量评分（api_call / solo_agent judge 启用时填写）
- judge overall: 8.2 / 10
- 关键维度: clarity=8, completeness=9, ...

## 接口实现情况（multi_agent 填写）
- [x] verifyToken(token: string) => Promise<{userId, role}>

## 偏离契约说明（multi_agent，如有）
- 无 / [原因]

## 已知欠债（如有）
- [描述临时实现、设计上的不完整之处]

## 验证
- [x] test_cmd 通过 / 手动验证场景: [描述]
```

---

## 四、Agent 体系升级（v1.9.0 → v2.0）

### 4.1 AGENT.md 变更

Rule Router 替换：

```
废弃：cli_collab activated → rules/cli_collab.md + rules/collab_context.md

新增：
| git_collab activated         | rules/git_collab.md      | KEEP    | git_collab |
| design phase / interface def | rules/design_contract.md | DISCARD | git_collab |
```

Quick Rules 新增（git_collab 模式）：

```
state update  → coordinator 从 git 状态派生，PM 不调用 state_update.sh
task assign   → PM 发 BranchInitSpec JSON，coordinator 创建分支
task review   → PM 发 MergeDecision JSON，coordinator 执行 merge
diff review   → coordinator 执行 review-prep，结构化报告注入 PM，PM 不读 raw diff
```

### 4.2 废弃的工具（git_collab 模式）

| 工具 | 废弃原因 |
|------|----------|
| `tools/state_update.sh` | git 分支/PR 状态替代；session_state.json 改由 coordinator 派生 |
| `tools/audit_append.sh` | git log 是天然审计链 |
| `tools/index_upsert.sh` | git tree 替代 |
| `tools/index_verify.sh` | git tree 替代 |
| `tools/hash.sh` | commit hash 替代 |

solo 模式保留上述工具直到完成 git 化。

### 4.3 新增规则文件：rules/git_collab.md

**PM 行为约束（HARD）：**
- PM 不执行任何 git 命令
- PM 通过 BranchInitSpec 发起分支创建，通过 MergeDecision 发起 merge
- PM 收到的是 coordinator 准备的结构化报告，不读 raw diff
- session_state.json 由 coordinator 维护，PM 不调用 state_update.sh

**Executor 行为约束（HARD）：**
- 只在自己的 worker 分支工作
- 不得修改其他 worker 分支或 task 主分支
- push 前必须确认本地测试通过
- 偏离 design_contract 必须在 PR description 说明，不得静默偏离

### 4.4 新增规则文件：rules/design_contract.md

规范 designer 输出 `design_contract.md` 的格式，**仅 multi_agent 类型任务需要**：

- 精确到函数签名和文件路径，不允许模糊描述
- 依赖关系必须显式声明（`depends_on`）
- 并行 task 之间不允许未声明的文件依赖

api_call 和 solo_agent 任务是单一 worker，不需要 interface contract。

**Hard Gate（继承）**：设计未获用户批准 → PM 不得发出 BranchInitSpec。

保存路径：`$project_path/docs/contracts/<task-slug>-contract.md`

### 4.5 collab_context.md 简化

删除 State Read Delegation 部分（PM 委托 executor 读 `.ccb/state.json`）。

git_collab 模式下，coordinator 在需要时直接读状态并注入给 PM，不需要 LLM 中转。

保留：Role Assignment、Async Guardrail、Rubric A / B、Inspiration Constraint。

### 4.6 session_mgmt.md 简化

删除 session compression 流程。

新 loop 启动时，PM 从以下内容重建上下文（由 coordinator 注入）：
- `AGENT.md`（永久上下文，PM 自加载）
- knowledge `_meta.json`（shard 索引）
- 相关 shard 内容（debt / decision_log / 相关 module shard）
- 上一 loop 的 PR summary（`git log --oneline task/<prev-slug>`）

solo 模式保持原有 session compression 流程。

### 4.7 新增 knowledge shard：decision_log 和 debt

**decision_log shard**（PM 在每个 loop Design 获批后、BranchInitSpec 发出前写入）：

记录「为什么这样设计、什么被否决了、什么约束不能破」，供下一 loop 的 PM 理解历史决策背景。

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

记录各 loop executor 标记的技术债，供下一 loop PM 在任务分解时感知。

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

### 4.8 knowledge agent 新增查询场景（Design 阶段）

- 「现有接口有哪些 exports？」→ file shard，designer 用作 `depends_on` 契约基础
- 「这个模块有哪些未偿还技术债？」→ debt shard，PM 决策是否纳入本 loop
- 「这个设计决策是什么时候做的、原因是什么？」→ decision_log shard

knowledge agent「不写、不读原始文件、不编写代码」原则不变。

---

## 五、rdloop coordinator 升级

### 5.1 run_task.sh：两参数路由替代三模式路由

废弃 `workflow_mode` case 分支，替换为：

```bash
executor_type=$(json_read "$TASK_JSON" "executor_type" "")
session_mode=$(json_read  "$TASK_JSON" "session_mode"  "continuous")

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
```

**api_call attempt 状态机**（包含 Bug 1/2 修复，见第二章）：

```
# 前置：worktree 已由 git_ops.sh create-branches 建好（不在 attempt 内部初始化）

loop attempt 1..max_attempts:
  1. call_coder_cliproxy.sh
     fresh:     prompt = goal + acceptance
     iterative: prompt = goal
                       + git show HEAD:<output_file>          # 上一版本产出
                       + git show HEAD:.rdloop/attempt_(N-1)/verdict.json → next_instructions
                       + acceptance
  2. commit 产出 + verdict placeholder 到 worker 分支
  3. if judge_enabled: call_judge_cliproxy.sh → verdict.json
     覆盖写入 .rdloop/attempt_N/verdict.json，amend commit
  4. if test_cmd: 执行，rc 不可绕过
  5. decision_table:
     score >= threshold AND rc == 0  → READY_FOR_REVIEW → 开 PR
     score < threshold AND n < max   → n++, continue
     n >= max                        → PAUSED
```

### 5.2 新增：git_ops.sh

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
    "found_exports": ["verifyToken", "refreshToken"],
    "missing": [],
    "path_matches": true,
    "cross_contamination": false
  },
  "diff_summary": "修改 src/auth.ts（+89/-12），新增 src/auth.test.ts（+45）",
  "judge_scores": null,
  "pr_description": "..."
}
```

api_call / solo_agent 类型中 `contract_check` 为 null，但会包含 `judge_scores`（最终 attempt 的评分摘要）。

### 5.3 新增：loop_lifecycle.sh

所有 worker PR merged 后，coordinator 自动触发，**全程无 LLM**：

```bash
loop_lifecycle.sh on-loop-complete <task_slug>
```

执行顺序：

1. **Regression gate**：运行 `test_cmd`。失败则阻断，等待人工介入后重试。（rdloop p0-stability 已有 `test_cmd` 能力，此处将其提升为跨 loop 守门机制）
2. **Knowledge 写入**：从各 PR description 提取 file-level summary → 写对应 module shard；提取 `已知欠债` → 写 debt shard
3. **Loop stats**：写 `loop_stats.jsonl` 条目（各 task 实际 attempt 轮次、总耗时）
4. **session_state.json 派生**：从 git 分支状态生成，task 全 done → loop 完成标记
5. **events.jsonl**：写 loop_complete 事件

### 5.4 session_state.json 维护方式变更

v4：PM 调用 `state_update.sh` 写入。
v5（git_collab 模式）：由 `loop_lifecycle.sh` 和 `git_ops.sh` 在关键 git 事件时自动派生，PM 不写。
GUI 读取方式不变（只读聚合）。

solo 模式：`state_update.sh` 仍由 PM 调用，不变。

---

## 六、GUI 升级

### 6.1 task 创建/编辑面板

废弃 `workflow_mode` 单选，替换为两个下拉：

- **Executor Type**：`API Call` / `Solo Agent` / `Multi Agent`
- **Session Mode**：`Fresh` / `Iterative` / `Continuous`

Session Mode 按 Executor Type 约束可选项：
- `API Call` → 只允许 Fresh 或 Iterative（Continuous 灰掉）
- `Solo Agent` / `Multi Agent` → 只允许 Continuous

### 6.2 新增：Git Status 视图

项目视图中新增 Git Status 面板：

- 当前活跃 task 分支和各 worker 分支状态（open / changes_requested / merged）
- 各 PR 的 contract_check 结果（pass/fail/pending）；api_call 类型显示 judge_scores
- 来源：`GET /api/task/:taskId/git-status`

### 6.3 新增：Knowledge Debt 视图

Knowledge Viewer 新增 Debt tab，显示 debt shard 所有条目，按 severity 和 loop_id 分组。
用途：PM 在下一 loop Design 阶段快速感知未偿还技术债。
来源：`GET /api/knowledge/shards/debt`

### 6.4 新增：Loop Stats 面板

attempt 视图新增 Loop Stats 入口，展示 `loop_stats.jsonl`：
各 loop 的执行时间、各 task 实际 attempt 轮次 vs max_attempts。
用于 PM/designer 规划下一 loop 任务量时参考历史数据。纯展示，无交互。

### 6.5 保持不变

Solo Agent Progress 面板、Knowledge Viewer shard 列表和条目浏览、项目/step/attempt 三层视图。

---

## 七、跨 loop 完整工作流（v5）

```
[Loop N 开始]

1. 新 PM instance 启动
   coordinator 注入：
   - _meta.json + 相关 shard（debt / decision_log / 相关 module shard）
   - 上一 loop PR summary（git log --oneline task/<prev-slug>）
   无需手工 session 压缩

2. Designer/PM 设计
   可 query knowledge agent（file shard / debt shard / decision_log shard）
   产出：
   - design_contract.md（multi_agent 任务必须；api_call/solo_agent 不需要）
   PM 写入 decision_log shard（本次决策、原因、约束）
   用户审批 → Hard Gate

3. PM 发出 BranchInitSpec（JSON）
   coordinator → git_ops.sh create-branches → task 主分支 + worker 分支
   分支创建完成 = 任务分配完成，PM 进入等待

4. Executor 执行

   api_call：
     coordinator 驱动 attempt 循环（fresh / iterative）
     每次 attempt 产出 commit 进 worker 分支
     judge 评分达标 → READY_FOR_REVIEW → 开 PR

   solo_agent：
     coordinator 通过 solo_bridge 驱动 agent 多轮 step
     阶段性 commit 进 worker 分支
     decision_solo 判定 READY_FOR_REVIEW → 开 PR

   multi_agent：
     各 executor 在各自 worker 分支独立并行
     完成后各自开 PR

5. coordinator → git_ops.sh review-prep
   自动核对 interface contract（multi_agent）
   自动检查跨分支污染
   生成结构化报告注入 PM

6. PM review（低 token）
   读结构化报告，只做判断：
   - 跨 worker 接口对齐（multi_agent）
   - merge 顺序决策
   发出 MergeDecision（JSON）

7. coordinator → git_ops.sh merge-pr
   merge 完成 → loop_lifecycle.sh on-loop-complete：
   ① regression gate（test_cmd，不可绕过）
   ② 提取 PR description → 更新 module shard + debt shard
   ③ 更新 loop_stats.jsonl
   ④ 派生更新 session_state.json

[Loop N 结束 → Loop N+1，步骤 1 通过 knowledge shard + git log 完整恢复上下文]
```

---

## 八、规则文件变更对照

### 废弃

| 文件/内容 | 废弃原因 |
|-----------|----------|
| `rules/cli_collab.md`（状态写规则部分） | git_collab.md 替代 |
| `rules/collab_context.md`（State Read Delegation） | coordinator 直接读 git，PM 收结构化报告 |
| `rules/task_mgmt.md`（Coder→PM JSON report 格式） | PR description 模板替代（git_collab 模式） |
| `rules/session_mgmt.md`（session compression） | knowledge shard + git log 替代 |
| `tools/state_update.sh`（git_collab 模式） | coordinator 派生替代 |
| `tools/audit_append.sh` | git log 替代 |
| `tools/index_upsert.sh` / `index_verify.sh` / `hash.sh` | git tree + commit hash 替代 |

### 新增

| 文件 | 用途 |
|------|------|
| `rules/git_collab.md` | git_collab 模式核心规范：PM/executor 行为约束、BranchInitSpec/MergeDecision 格式 |
| `rules/design_contract.md` | designer 输出 interface contract 的格式规范（multi_agent 任务必须） |
| `tools/git_ops.sh` | coordinator git 操作层：create-branches、merge-pr、review-prep |
| `tools/loop_lifecycle.sh` | loop 结束收尾：regression gate、knowledge 写入、stats、session_state 派生 |

### 不变

`rules/exceptions.md`、`rules/file_ops.md`、`rules/model_routing.md`、`rules/network_authority.md`、`rules/init.md`、`rules/startup.md`、所有 skills（`brainstorming-to-plan` 扩展：Design 结束须写 decision_log shard + 可选 design_contract.md）

---

## 九、迁移路径

通过 `executor_type` 向后兼容，迁移脚本（coordinator 提供）：

```bash
migrate_task_json.sh <task.json>
# workflow_mode: collab  → executor_type: multi_agent, session_mode: continuous
# workflow_mode: solo    → executor_type: solo_agent,  session_mode: continuous
# workflow_mode: single  → executor_type: api_call,    session_mode: fresh
# 删除 workflow_mode 字段
```

已有项目在当前 loop 结束后，下一个 loop 开始前运行迁移脚本，平滑切换。knowledge shard 迁移脚本（`migrate_knowledge_cache.py`）v4 已提供，v5 不变。

---

## 十、token 效能收益汇总

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

*基于 integrated_architecture_v4.md + agent_v2_git_native_design.md + Agent v1.8.0 当前实现，设计于 2026-02-26*
