# 闭环AI自主研发体系 — 整合架构方案 v5.1

**三套体系**：Agent 体系（v2.1）+ CCB（统一 Session ID）+ rdloop coordinator  
**状态**：正式版  
**日期**：2026-02-28  
**基于**：integrated_architecture_v5.0.md

**v5.1 核心升级**：
- **任务类型重新定义**：废弃 auto/semi-auto 模式概念，三种任务类型重整为 `copywriting`（纯文案）、`solo`（单 agent 多角色）、`multi_agent`（多 agent 多角色）
- **全面 Coding Agent 化**：废弃 cliproxyapi / cursorproxyapi 单一 API 服务调用，三种类型全部使用 coding agent 执行
- **双启动通道统一**：CCB（visual mode）与 Bridge（non-visual mode / solo-bridge）统一为任务启动时的可选通道，均支持三种任务类型
- **Coordinator 绝对调度权**：所有操作必须从 coordinator 触发，CCB 降级为纯通信通道，不具备自调度能力
- **统一 Session 标识体系**：CCB REQ CODE 与 Bridge Session ID 统一设计，形成跨通道可追溯的 Session 标识
- **角色工作流完整化**：PM → Designer → Executor → Reviewer → Inspiration 各角色独立工作流，coordinator 在角色切换时负责 git 操作与 knowledge agent 调用
- **启动模式 Checkbox**：任务启动时支持 checkbox 决定是否使用 settings 预设启动模式

---

## 一、整体分工

```
┌──────────────────────────────────────────────────────────────┐
│                        用户 / 人类                            │
│         需求输入 / 审批 Hard Gate / 最终验收                   │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                    Agent 体系（认知层）v2.1                    │
│                                                               │
│  角色体系（五角色）：                                          │
│  ├── PM          需求理解、任务分解、决策记录、BranchInitSpec   │
│  ├── Designer    接口设计、架构设计、design_contract 输出       │
│  ├── Executor    代码实现、内容生成（coding agent 执行）        │
│  ├── Reviewer    质量评审、verdict 输出                        │
│  └── Inspiration 灵感激发、创意扩展（可选角色）                │
│                                                               │
│  任务类型（三种）：                                            │
│  ├── copywriting  纯文案：PM → Executor（文案）→ Reviewer      │
│  ├── solo         同一 coding agent 扮演全部角色（多 pane）    │
│  └── multi_agent  多 coding agent 各司其职                    │
│                                                               │
│  PM 行为约束（git_collab 模式，HARD）：                        │
│  ├── 不执行任何 git 命令                                       │
│  ├── 通过 BranchInitSpec JSON 发起分支创建                     │
│  ├── 通过 MergeDecision JSON 发起 merge                        │
│  └── 不读 raw diff，只读 coordinator 结构化报告                │
└───────────────────────────┬──────────────────────────────────┘
                            │ TaskSpec JSON
                            │ (task_type + launch_mode)
┌───────────────────────────▼──────────────────────────────────┐
│               rdloop coordinator（工程可靠性层）               │
│                                                               │
│  run_task.sh                                                  │
│  ├── task_type 路由：copywriting | solo | multi_agent         │
│  ├── launch_mode 选择：ccb（visual）| bridge（non-visual）     │
│  ├── 状态机 RUNNING/PAUSED/FAILED/READY_FOR_REVIEW            │
│  ├── 角色切换控制：git 操作 + knowledge agent 调用             │
│  ├── worktree 由 git_ops.sh 前置初始化                        │
│  ├── atomic_write + lock + trap                               │
│  ├── test_cmd 执行（客观 rc，不可绕过）                        │
│  └── events.jsonl（完整审计链）                               │
│                                                               │
│  调度原则（HARD）：                                            │
│  ├── 所有 coding agent 调用必须由 coordinator 发起            │
│  ├── CCB 不具备自调度能力，仅作通信通道                        │
│  ├── Bridge 不具备自调度能力，仅作通信通道                     │
│  └── 角色切换 = coordinator 挂起当前 pane + 触发下一个        │
│                                                               │
│  git_ops.sh                                                   │
│  ├── create-branches  BranchInitSpec → 分支 + worktree        │
│  ├── merge-pr         MergeDecision → merge                   │
│  ├── review-prep      核对 contract，生成结构化报告             │
│  └── role-commit      角色切换时提交当前阶段产出               │
│                                                               │
│  loop_lifecycle.sh                                            │
│  ├── regression gate（test_cmd，不可绕过）                    │
│  ├── knowledge 写入（从 PR description 自动提取）              │
│  ├── loop_stats.jsonl 更新                                    │
│  ├── session_state.json 派生                                  │
│  └── events.jsonl loop_complete 事件                          │
│                                                               │
│  GUI（只读聚合视图）                                           │
│  ├── 项目层  ← session_state.json                             │
│  ├── step 层  ← unified session state                         │
│  ├── attempt 层 ← out/<task_id>/                              │
│  ├── knowledge 层 ← .context/knowledge/（shard）              │
│  ├── Git Status 层 ← GET /api/task/:id/git-status             │
│  ├── Knowledge Debt 层 ← GET /api/knowledge/shards/debt       │
│  └── Loop Stats 层 ← loop_stats.jsonl                         │
└──────────┬─────────────────────┬──────────────────────────────┘
           │                     │
     launch_mode=ccb       launch_mode=bridge
     （visual mode）        （non-visual mode）
           │                     │
┌──────────▼─────────────────────▼──────────────────────────────┐
│              启动通道层（v5.1 统一双通道）                      │
│                                                               │
│  CCB（Claude Code Bridge，visual mode）                        │
│  ├── 由 coordinator 在任务启动时拉起 coding agent 可视化界面    │
│  ├── 在 GUI 中展示可视化操作流程                               │
│  ├── 仅作通信通道，不具备自调度能力                            │
│  ├── 每个角色/pane 拥有独立的 CCB Session（含 REQ CODE）       │
│  └── coordinator 通过 CCB REQ CODE 定位和解析产出              │
│                                                               │
│  Bridge（solo-bridge，non-visual mode）                        │
│  ├── coordinator 通过 bridge 直接调用 coding agent（暗箱操作）  │
│  ├── GUI 仍可展示对应流程状态（非可视化 agent 界面）            │
│  ├── 每个角色/pane 拥有独立的 Bridge Session ID                │
│  └── coordinator 通过 Session ID 追踪状态                     │
│                                                               │
│  统一 Session 标识（v5.1 新增）：                              │
│  ├── 格式：{task_id}-{role}-{pane_index}-{timestamp}          │
│  ├── CCB 使用：REQ_CODE = hash(session_id) 前缀定位产出        │
│  ├── Bridge 使用：session_id 直接作为跟踪键                    │
│  └── 两通道在 GUI 和 events.jsonl 使用同一 session_id 体系     │
└──────────┬────────────────────────────────────────────────────┘
           ↓ 查询
┌─────────────────────────────────────────────────────────────┐
│           knowledge agent（项目知识底座，v4 shard 不变）      │
│                                                              │
│  每项目一实例，常驻 CCB/Bridge session                        │
│  加载 _meta.json 索引，按需加载 shard                         │
│  查询场景：exports / 未偿技术债 / 历史决策背景                 │
│  原则不变：不写摘要、不读原始文件、不编写代码、不评审质量       │
│  角色切换时由 coordinator 主动调用，注入下一角色上下文          │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、任务类型重新定义（v5.1）

### 2.1 三种任务类型

v5.1 废弃 v5.0 的 `executor_type`（api_call / solo_agent / multi_agent）与 auto/semi-auto 模式概念，重新定义为三种任务类型：

| task_type | 含义 | 角色分配 | Pane 数量 |
|-----------|------|----------|-----------|
| `copywriting` | 纯文案任务。Executor 由 coding agent 执行（非 API 调用），输出文本内容 | PM / Executor（文案）/ Reviewer | 各角色各一个 pane |
| `solo` | 所有角色（PM、Designer、Executor、Reviewer）由**同一个** coding agent 扮演，但**每个角色单独占用一个独立 pane**，拥有独立上下文。coordinator 在每次角色切换时负责控制和 git 操作 | 同一 agent，多 pane | 每个角色一个 pane，上下文独立 |
| `multi_agent` | 每个角色由独立的 coding agent 实例承担，各自独立 pane 和独立上下文 | 不同 agent，多 pane | 每个角色一个 pane |

**关键设计约束（solo 模式）**：

尽管 solo 模式中所有角色是同一个 coding agent，结构上依然遵循 multi_agent 的调度模型：
- 每个角色（PM / Designer / Executor / Reviewer）都必须单独开启一个 pane
- 每个 pane 拥有完全独立的上下文，不共享历史对话
- coordinator 在每次角色切换时发起：①当前 pane 的阶段 commit（git_ops.sh role-commit）②knowledge agent 查询以构建下一角色的启动上下文③下一个 pane 的启动指令
- 这保证了 solo 模式与 multi_agent 模式的流程一致性，便于将来平滑迁移

### 2.2 task.json 字段变更

废弃：`executor_type`、`session_mode`（及其 api_call/fresh/iterative 相关概念）  
新增：`task_type`、`launch_mode`、`launch_mode_locked`  
保留：`agent_config`、`collab_roles`、`judge_enabled`、`test_cmd`

```json
{
  "task_id": "T01",
  "task_type": "copywriting | solo | multi_agent",
  "launch_mode": "ccb | bridge",
  "launch_mode_locked": false,
  "judge_enabled": true,
  "agent_config": {
    "max_attempts": 5,
    "auto_pass_threshold": 0.85,
    "knowledge_shards": ["auth", "api"],
    "provider": "claude | codex | gemini"
  },
  "collab_roles": {
    "pm":       "claude",
    "designer": "claude",
    "executor": "claude",
    "reviewer": "codex"
  },
  "repo_path": "/path/to/project",
  "goal": "...",
  "acceptance": "...",
  "test_cmd": "..."
}
```

**字段说明**：

- `launch_mode`：当前任务的启动通道（ccb 或 bridge），在任务启动 run 时由用户选择或由 settings 预设决定
- `launch_mode_locked`：是否锁定使用 settings 里的预设启动模式（对应 GUI checkbox 状态）。`false` 表示每次 run 时弹出选择；`true` 表示直接使用 settings 预设
- `collab_roles`：solo 模式下所有角色填同一 agent，multi_agent 模式下可填不同 agent，copywriting 模式只需填 executor 和 reviewer
- `agent_config.provider`：执行该任务使用的 coding agent 类型

### 2.3 v5.0 → v5.1 映射关系

| v5.0 executor_type + session_mode | v5.1 task_type | 说明 |
|-----------------------------------|----------------|------|
| `api_call` + `fresh/iterative` | `copywriting` | 纯文案，现改为 coding agent 执行而非 API 调用 |
| `solo_agent` + `continuous` | `solo` | 单 agent 多角色，结构更明确 |
| `multi_agent` + `continuous` | `multi_agent` | 多 agent 多角色，不变 |

### 2.4 迁移脚本

```bash
migrate_task_json_v51.sh <task.json>
# executor_type: api_call   → task_type: copywriting
# executor_type: solo_agent → task_type: solo
# executor_type: multi_agent→ task_type: multi_agent
# session_mode              → 删除
# solo_config               → 已在 v5.0 迁移为 agent_config，不变
# executor_type / session_mode 字段删除
# 新增 launch_mode: ccb（默认），launch_mode_locked: false
```

---

## 三、启动通道：CCB（visual）与 Bridge（non-visual）

### 3.1 两种启动通道定义

所有三种任务类型（copywriting / solo / multi_agent）都支持两种启动通道：

**CCB（visual mode）**：
- coordinator 在任务 run 时拉起对应的 coding agent 可视化界面（如 Claude Code UI）
- 用户可以在 GUI 中看到 coding agent 的可视化操作过程
- 适合需要人工观察或干预的场景

**Bridge / solo-bridge（non-visual mode）**：
- coordinator 通过 bridge 机制直接与 coding agent 通信，暗箱操作
- coding agent 不弹出可视化界面
- GUI 中仍然展示对应的流程状态（任务进度、角色状态、commit 记录等），只是看不到 agent 的逐步操作
- 适合全自动批量执行场景

两种通道的核心逻辑完全相同，区别仅在于是否拉起可视化 agent 界面。

### 3.2 启动模式选择机制

任务启动（run）时触发启动模式选择，流程如下：

```
用户点击 Run
    │
    ├── launch_mode_locked = true（checkbox 勾选）
    │       └── 直接使用 Settings → Launch Mode 预设
    │               ├── ccb  → 拉起可视化 agent
    │               └── bridge → 暗箱执行，GUI 展示状态
    │
    └── launch_mode_locked = false（checkbox 未勾选）
            └── 弹出启动模式选择对话框
                    ├── [CCB] 可视化模式
                    └── [Bridge] 后台模式
                            └── 用户选择后写入 task.json launch_mode
                                    再执行对应通道启动流程
```

**GUI checkbox 实现**（当前已有代码基础，v5.1 在文档中补充说明）：
- 任务卡片或任务详情页 Run 按钮旁有 checkbox："使用默认启动模式"
- 勾选 = `launch_mode_locked: true`，不再弹出选择框
- 未勾选 = `launch_mode_locked: false`，每次 run 时弹出
- Settings 页面可设置全局默认启动模式（ccb 或 bridge）

### 3.3 每个角色/Pane 的启动

无论哪种任务类型，coordinator 为每个角色创建独立 pane 时，都通过当前 launch_mode 选择通道：

```bash
# coordinator 内部伪代码（run_task.sh）
for role in pm designer executor reviewer; do
  session_id=$(generate_session_id "$task_id" "$role" "$pane_index")
  
  if [ "$launch_mode" = "ccb" ]; then
    ccb_launch_pane --session-id "$session_id" --role "$role" --agent "$provider"
  else
    bridge_launch_pane --session-id "$session_id" --role "$role" --agent "$provider"
  fi
done
```

---

## 四、统一 Session 标识体系（v5.1 新增）

### 4.1 背景与问题

v5.0 中，CCB 体系有自己的 CCB REQ CODE（用于定位 agent 输出的开头和结尾），solo-bridge 体系有自己的 Session ID，两套标识体系并行存在，难以在同一任务中混用或追溯。

v5.1 设计统一的 Session 标识体系，在 CCB 和 Bridge 两个通道中使用一致的标识逻辑，同时保留 CCB REQ CODE 的特有语义（开头/结尾对齐定位产出）。

### 4.2 统一 Session ID 格式

```
session_id = {task_id}-{role}-{pane_idx:02d}-{unix_ts}

示例：
  T01-executor-01-1740700800
  T01-reviewer-02-1740700900
  T02-pm-00-1740701000
```

- `task_id`：任务 ID，如 T01
- `role`：角色名，pm / designer / executor / reviewer / inspiration
- `pane_idx`：该角色在任务中的 pane 序号（多 executor 并行时用 01/02 区分）
- `unix_ts`：pane 启动时的 Unix 时间戳（秒），保证唯一性

该 session_id 在任务启动时由 coordinator 生成，写入 task state，在整个任务生命周期内不变。

### 4.3 CCB REQ CODE 与 Session ID 的关系

CCB REQ CODE 是 CCB 通道中用于在 agent 输出流中定位产出边界的标记，其格式要求：

- 开头标记：`[RDLOOP_REQ:{req_code}:START]`
- 结尾标记：`[RDLOOP_REQ:{req_code}:END]`
- coordinator 解析时截取 START 和 END 之间的内容作为有效产出

v5.1 中 REQ CODE 由 session_id 派生：

```bash
req_code = "RC-" + sha256(session_id)[:8].upper()

示例：
  session_id = T01-executor-01-1740700800
  req_code   = RC-A3F8B21C

# 指令模板中植入 REQ CODE
instruction = f"""
请完成以下任务：...

完成后，请将产出包裹在以下标记中输出：
[RDLOOP_REQ:{req_code}:START]
（你的产出内容）
[RDLOOP_REQ:{req_code}:END]
"""
```

**Bridge 通道**：不需要 REQ CODE 边界定位（bridge 协议有自己的消息边界），直接使用 session_id 作为请求跟踪键，coordinator 收到 bridge 响应时以 session_id 对应存储。

### 4.4 Session 标识在系统中的流转

```
coordinator 生成 session_id
    │
    ├── 写入 task state（task_state.json）
    │     sessions: { "executor-01": "T01-executor-01-1740700800" }
    │
    ├── 派生 req_code（CCB 通道）
    │     req_code: { "T01-executor-01-1740700800": "RC-A3F8B21C" }
    │
    ├── events.jsonl 中每条事件携带 session_id
    │     { "event": "role_start", "session_id": "T01-executor-01-...", ... }
    │
    └── GUI 展示时以 session_id 聚合该 pane 的所有事件和状态
```

---

## 五、Coordinator 绝对调度权（v5.1 核心原则）

### 5.1 调度权归属

v5.1 明确：**所有对 coding agent 的调用，必须且只能由 coordinator 发起。**

CCB 和 Bridge 都是通信通道，不是调度器：
- CCB 不能自发触发新的指令发送
- CCB 不能自发切换角色
- Bridge 不能自发触发下一步骤
- 任何看起来像"自动"的行为，其调度逻辑都在 coordinator 内部

这意味着：

| 操作 | 正确发起方 | 错误发起方 |
|------|-----------|-----------|
| 给 executor pane 发送指令 | coordinator | CCB 自身 / Bridge 自身 |
| 切换到 reviewer 角色 | coordinator | executor agent / CCB |
| 触发下一个 attempt | coordinator | judge/reviewer agent |
| 调用 knowledge agent | coordinator | 各角色 agent 直接调用 |
| 执行 git commit | coordinator（git_ops.sh）| 各角色 agent |

### 5.2 角色切换由 Coordinator 控制

角色切换是 coordinator 的核心调度动作，每次切换包含：

```bash
role_transition() {
  from_role=$1
  to_role=$2
  task_id=$3

  # 1. 结束当前角色 pane（挂起或关闭）
  coordinator_pause_pane "$task_id" "$from_role"

  # 2. 提交当前角色的阶段产出
  git_ops.sh role-commit \
    --task "$task_id" \
    --role "$from_role" \
    --message "role/$from_role: phase complete"

  # 3. 调用 knowledge agent 构建下一角色上下文
  next_context=$(knowledge_agent_query \
    --task "$task_id" \
    --for-role "$to_role" \
    --shards "decision_log,debt,relevant_modules")

  # 4. 启动下一角色 pane（注入上下文 + session_id）
  session_id=$(generate_session_id "$task_id" "$to_role" "$pane_idx")
  coordinator_launch_pane \
    --task "$task_id" \
    --role "$to_role" \
    --session-id "$session_id" \
    --context "$next_context" \
    --launch-mode "$launch_mode"

  # 5. 写入角色切换事件
  append_event "role_transition" \
    "{from: $from_role, to: $to_role, session_id: $session_id}"
}
```

### 5.3 knowledge agent 调用时机

coordinator 在以下时机主动调用 knowledge agent：

| 时机 | 调用目的 | 注入目标 |
|------|----------|---------|
| PM pane 启动 | 加载 decision_log / debt shard + 上一 loop PR summary | PM 的初始上下文 |
| Designer pane 启动 | 加载相关 module shard（接口列表、文件结构） | Designer 的设计参考 |
| Executor pane 启动 | 加载 design_contract + 相关 module shard | Executor 的实现依据 |
| Reviewer pane 启动 | 加载 design_contract + acceptance criteria | Reviewer 的评审标准 |
| 角色切换时（通用） | 将前一角色产出摘要注入下一角色 | 保持上下文连贯性 |

---

## 六、各角色工作体系与流程（v5.1 完整化）

### 6.1 角色流转总图

```
[Loop N 开始]
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ PM pane                                             │
│ ├── 读：decision_log shard + debt shard + git log   │
│ ├── 产：需求拆解、任务列表、BranchInitSpec JSON       │
│ └── coordinator 介入：写 decision_log shard → 触发   │
│     Hard Gate（用户审批）→ git create-branches       │
└──────────────────────┬──────────────────────────────┘
                       │（copywriting 直接跳 Executor）
                       ▼（solo / multi_agent）
┌─────────────────────────────────────────────────────┐
│ Designer pane                                       │
│ ├── 读：knowledge module shard（接口列表）           │
│ ├── 产：design_contract.md（multi_agent 必须）       │
│ └── coordinator 介入：role-commit → Hard Gate        │
│     → 启动 Executor pane（注入 design_contract）    │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Executor pane（可多个，并行）                        │
│ ├── 读：design_contract + 相关 module shard          │
│ ├── 产：代码实现 / 文案内容（多轮 attempt）           │
│ └── coordinator 介入：阶段 commit → 触发 Reviewer    │
│     pane（judge_enabled=true 时）                   │
└──────────────────────┬──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│ Reviewer pane                                       │
│ ├── 读：acceptance criteria + design_contract       │
│ ├── 产：verdict.json（score + next_instructions）   │
│ └── coordinator 介入：verdict amend commit          │
│     → decision_table 判断：达标开 PR / 不达标回 Executor│
└──────────────────────┬──────────────────────────────┘
                       ▼（可选）
┌─────────────────────────────────────────────────────┐
│ Inspiration pane                                    │
│ ├── 触发时机：Reviewer 评分低 + 多次未达标时         │
│ ├── 产：创意方向建议（不直接产出代码/文案）           │
│ └── coordinator 介入：将 inspiration 输出注入下一次  │
│     Executor attempt 的上下文                       │
└──────────────────────┬──────────────────────────────┘
                       ▼
              PR open → PM review
              → MergeDecision → merge
              → loop_lifecycle.sh on-loop-complete
```

### 6.2 PM 工作流

**职责**：需求理解、任务分解、审批决策、版本管理决策

**启动上下文**（coordinator 注入）：
- `AGENT.md`（PM 规则，自加载）
- `_meta.json` + decision_log shard + debt shard
- 上一 loop PR summary（`git log --oneline task/<prev-slug>`）

**产出物**：
- 任务拆解列表（写入 task.json 文件集）
- `decision_log shard` 条目（本次决策、原因、约束）
- `BranchInitSpec JSON`（发给 coordinator，触发分支创建）
- `MergeDecision JSON`（在 review 阶段，发给 coordinator，触发 merge）

**行为约束（HARD）**：
- 不执行任何 git 命令
- 不读 raw diff，只读 coordinator 生成的结构化报告
- 发出 BranchInitSpec 前必须获得用户 Hard Gate 审批
- session_state.json 不由 PM 维护

### 6.3 Designer（Planner）工作流

**职责**：接口设计、模块划分、design_contract 输出

**适用任务类型**：solo / multi_agent（copywriting 任务跳过 Designer 阶段）

**启动上下文**（coordinator 注入）：
- `AGENT.md`（Designer 规则）
- 相关 module shard（现有接口列表，来自 knowledge agent 查询）
- PM 产出的任务目标和约束

**产出物**：
- `design_contract.md`（multi_agent 必须，精确到函数签名和文件路径）
- 接口依赖关系声明（`depends_on` 字段）

**行为约束**：
- design_contract 必须精确到函数签名，不允许模糊描述
- 并行 task 间不允许未声明的文件依赖
- 产出经 Hard Gate 审批后，coordinator 才发出 BranchInitSpec

**coordinator 介入**：
- 收到 Designer 产出后执行 role-commit（保存 design_contract）
- 检查 design_contract 格式合规性
- 等待用户 Hard Gate 审批
- 批准后调用 git_ops.sh create-branches，启动 Executor pane

### 6.4 Executor（Coder）工作流

**职责**：代码实现或文案生成，在各自 worker 分支工作

**启动上下文**（coordinator 注入）：
- `AGENT.md`（Executor 规则）
- design_contract.md（如有）
- 相关 module shard
- 任务 goal + acceptance criteria
- 上一次 attempt 产出 + Reviewer next_instructions（attempt > 1 时）

**产出物**：
- 代码文件 / 文案内容
- PR description（按模板，含产出摘要 / 接口实现 / 已知欠债）

**多轮 attempt 流程**：

```
attempt 1:
  coordinator → 注入初始上下文 → Executor pane
  Executor 产出 → coordinator 触发 Reviewer pane
  Reviewer verdict.json（score < threshold）
  coordinator 决策：继续 attempt

attempt N（N > 1）:
  coordinator → 注入（上一次产出 + Reviewer next_instructions）→ Executor pane
  Executor 改进 → coordinator 触发 Reviewer pane
  Reviewer verdict.json（score >= threshold）
  coordinator 决策：READY_FOR_REVIEW → 开 PR
```

**行为约束（HARD）**：
- 只在自己的 worker 分支工作
- 不修改其他 worker 分支或 task 主分支
- push 前确认本地测试通过
- 偏离 design_contract 必须在 PR description 说明

### 6.5 Reviewer（Judge）工作流

**职责**：质量评审，产出 verdict.json

**启动上下文**（coordinator 注入）：
- `AGENT.md`（Reviewer 规则）
- acceptance criteria
- design_contract.md（如有）
- Executor 本次产出（从 git 读取）

**产出物**：

```json
{
  "overall_score": 8.2,
  "dimensions": {
    "correctness": 9,
    "completeness": 8,
    "style": 7
  },
  "pass": true,
  "next_instructions": "建议将 token 刷新逻辑移至独立函数，当前实现与登录逻辑耦合",
  "blocking_issues": []
}
```

**coordinator 介入**：
- 收到 Reviewer 产出后执行 amend commit（将 verdict.json 附加到当前 attempt commit）
- 执行 test_cmd（客观测试，不可绕过）
- 执行 decision_table：`score >= threshold AND rc == 0` → READY_FOR_REVIEW；否则回 Executor

**行为约束**：
- Reviewer 不能自行决定是否继续 attempt，只产出 verdict
- 继续 / 停止的决策权在 coordinator 的 decision_table

### 6.6 Inspiration 工作流（可选角色）

**职责**：在 Executor 多次 attempt 未达标时提供创意灵感，打破思维定式

**触发条件**（coordinator 判断）：
- attempt 轮次 >= `inspiration_trigger_attempts`（默认 3，可在 agent_config 配置）
- Reviewer 评分持续无明显提升
- PM 手动触发

**启动上下文**（coordinator 注入）：
- 当前任务 goal + acceptance criteria
- 历次 attempt 产出摘要（不含完整代码）
- Reviewer 历次 next_instructions 汇总

**产出物**：
- 创意方向建议列表（纯文字，不包含代码或直接可用的文案）
- inspiration 输出不直接提交 git，由 coordinator 将其注入下一次 Executor attempt 的上下文

**行为约束**：
- Inspiration 只产出方向，不产出实现
- Inspiration pane 完成后由 coordinator 关闭，不持续存在

---

## 七、统一 Git 工作流

### 7.1 分支结构（三种 task_type 统一）

```
main
 └── task/<YYYYMMDD>-<slug>               ← loop 主分支，coordinator 创建
      ├── worker/<slug>-pm                ← PM 阶段产出（BranchInitSpec / 任务文件）
      ├── worker/<slug>-design            ← Designer 产出（design_contract）
      ├── worker/<slug>-executor-A        ← Executor A 的实现分支
      ├── worker/<slug>-executor-B        ← Executor B（并行时）
      └── worker/<slug>-reviewer          ← Reviewer 评审产出（verdict.json）
```

**solo 模式**：分支结构与 multi_agent 完全相同，只是所有 worker 分支的提交都来自同一个 coding agent。

**copywriting 模式**：通常只有 `executor` 和 `reviewer` 两个 worker 分支，无 `design` 分支。

### 7.2 git_ops.sh role-commit（新增子命令）

角色切换时，coordinator 调用 `git_ops.sh role-commit` 将当前角色的阶段产出提交到对应 worker 分支：

```bash
git_ops.sh role-commit \
  --task-id   T01 \
  --role      executor \
  --pane-idx  01 \
  --message   "executor[attempt_2]: impl auth token refresh"

# 内部执行：
# cd <worktree_path>
# git add -A
# git commit -m "role/executor[attempt_2]: impl auth token refresh"
# git push origin worker/<slug>-executor-A
```

commit message 格式：`role/{role}[{phase}]: {description}`

### 7.3 BranchInitSpec / MergeDecision 协议

与 v5.0 保持一致，PM 通过 JSON 意图声明触发 coordinator 执行（不变）。

```json
{
  "type": "BranchInitSpec",
  "task_slug": "auth-service",
  "date": "20260228",
  "workers": [
    { "task_id": "T01", "task_type": "solo",        "label": "executor-01" },
    { "task_id": "T02", "task_type": "multi_agent", "label": "executor-A"  }
  ]
}
```

```json
{
  "type": "MergeDecision",
  "task_id": "T01",
  "verdict": "approve | request_changes",
  "blocking_issues": [],
  "merge_after": ["T02"]
}
```

### 7.4 PR description 模板（三种 task_type 统一）

```markdown
## Task
task_id: T01 | task_type: solo | launch_mode: ccb

## 产出摘要
[solo / multi_agent: 实现了什么，关键决策]
[copywriting: 最终版本内容摘要 + 迭代轮次 + 最终 reviewer 评分]

## 质量评分（judge 启用时填写）
- reviewer overall: 8.2 / 10
- 关键维度: correctness=9, completeness=8, style=7

## 接口实现情况（multi_agent 填写）
- [x] verifyToken(token: string) => Promise<{userId, role}>

## 偏离契约说明（如有）
- 无 / [原因]

## 已知欠债（如有）
- [描述临时实现、设计上的不完整之处]

## 验证
- [x] test_cmd 通过 / 手动验证场景: [描述]
```

---

## 八、run_task.sh：task_type 路由逻辑

```bash
task_type=$(json_read "$TASK_JSON" "task_type" "")
launch_mode=$(json_read "$TASK_JSON" "launch_mode" "ccb")
launch_mode_locked=$(json_read "$TASK_JSON" "launch_mode_locked" "false")

# task_type 为空时报错退出
[ -z "$task_type" ] && { echo "ERROR: task_type required"; exit 1; }

# launch_mode 选择（locked 时跳过交互）
if [ "$launch_mode_locked" = "false" ]; then
  launch_mode=$(prompt_launch_mode_selection)  # GUI 弹出选择
  json_write "$TASK_JSON" "launch_mode" "$launch_mode"
fi

# task_type 路由
case "$task_type" in
  copywriting)
    roles=("pm" "executor" "reviewer")
    ;;
  solo)
    roles=("pm" "designer" "executor" "reviewer")
    # solo 模式：所有角色使用同一 agent provider，但各自独立 pane
    provider=$(json_read "$TASK_JSON" "agent_config.provider" "claude")
    for role in "${roles[@]}"; do
      collab_roles[$role]="$provider"
    done
    ;;
  multi_agent)
    roles=("pm" "designer" "executor" "reviewer")
    # multi_agent：从 collab_roles 读取各角色 provider
    ;;
esac

# 通道选择
case "$launch_mode" in
  ccb)    pane_launcher="ccb_launch_pane"    ;;
  bridge) pane_launcher="bridge_launch_pane" ;;
esac

# 前置：worktree 已由 git_ops.sh create-branches 建好
[ ! -d "$worktree_path" ] && { echo "ERROR: worktree not found"; exit 1; }

# 启动 PM pane（第一个角色）
session_id=$(generate_session_id "$task_id" "pm" "00")
context=$(knowledge_agent_query --for-role "pm" --task "$task_id")
$pane_launcher --session-id "$session_id" --role "pm" --context "$context"
```

---

## 九、Agent 体系升级（v2.1）

### 9.1 规则文件变更

| 文件 | 变更内容 |
|------|----------|
| `AGENT.md` | Rule Router 新增 task_type 路由；Quick Rules 补充 solo 模式 pane 独立性约束；版本号 v2.1 |
| `rules/git_collab.md` | 新增 role-commit 时机说明；solo 模式约束补充 |
| `rules/design_contract.md` | 明确 copywriting 任务跳过 Designer 阶段 |
| `rules/collab_context.md` | 新增 Inspiration 角色约束；更新角色切换流程说明 |
| `rules/solo_pane.md` | **新增**：solo 模式下 pane 独立性规范，禁止跨 pane 共享上下文 |
| `rules/launch_mode.md` | **新增**：CCB / Bridge 通道规范，coordinator 绝对调度权声明 |
| `tools/write_knowledge_cache.py` | 新增 inspiration 输出存储支持（临时 shard，不持久化） |

### 9.2 废弃

| 文件/概念 | 废弃原因 |
|-----------|----------|
| `call_coder_cliproxy.sh` | copywriting 任务改用 coding agent，cliproxy API 调用废弃 |
| `call_judge_cliproxy.sh` | 同上，reviewer 改用 coding agent |
| `executor_type: api_call` | 重命名并重构为 task_type: copywriting + coding agent |
| `session_mode: fresh / iterative` | 由 attempt 机制 + reviewer next_instructions 替代，概念合并进 Executor 工作流 |
| CCB 自调度逻辑（如有） | 全部收归 coordinator，CCB 降级为纯通信通道 |

### 9.3 新增

| 文件 | 用途 |
|------|------|
| `rules/solo_pane.md` | solo 模式 pane 独立性规范 |
| `rules/launch_mode.md` | 启动通道规范（CCB / Bridge） |
| `tools/session_id_gen.sh` | 统一 Session ID 生成工具 |
| `tools/req_code_gen.sh` | 从 Session ID 派生 CCB REQ CODE |

### 9.4 不变

`rules/exceptions.md`、`rules/file_ops.md`、`rules/model_routing.md`、`rules/network_authority.md`、`rules/init.md`、`rules/startup.md`、所有 skills、knowledge shard 机制（v4/v5）、solo_bridge.sh（重命名 bridge.sh，逻辑不变）、decision_solo.py、migrate_knowledge_cache.py。

---

## 十、GUI 升级（v5.1）

### 10.1 任务创建/编辑面板

废弃 v5.0 的 `Executor Type / Session Mode` 联动下拉，替换为：

- **Task Type**：`Copywriting` / `Solo` / `Multi Agent`
- **Launch Mode**：`CCB (Visual)` / `Bridge (Non-Visual)`
- **Checkbox**："使用默认启动模式"（对应 `launch_mode_locked`）

Task Type 选择联动：
- Copywriting → collab_roles 只显示 executor / reviewer
- Solo → collab_roles 显示统一的 provider 选择（所有角色共用一个 agent）
- Multi Agent → collab_roles 显示各角色独立的 provider 选择

### 10.2 Pane 状态视图（新增）

任务详情页新增 Pane 状态面板，展示当前任务所有活跃 pane：

```
┌────────────────────────────────────────┐
│ Pane 状态                              │
├─────────────┬──────────┬──────────────┤
│ pane        │ 状态     │ session_id   │
├─────────────┼──────────┼──────────────┤
│ pm          │ done     │ T01-pm-00-.. │
│ designer    │ done     │ T01-de-00-.. │
│ executor-01 │ running  │ T01-ex-01-.. │
│ reviewer    │ waiting  │ T01-rv-00-.. │
└─────────────┴──────────┴──────────────┘
```

Launch Mode 图标区分：CCB pane 显示 👁 图标，Bridge pane 显示 ⚙ 图标。

### 10.3 Launch Mode 选择对话框

任务 Run 时（`launch_mode_locked=false`）弹出：

```
┌────────────────────────────────────────┐
│ 选择启动模式                            │
│                                        │
│ ○ CCB (Visual)    - 可视化 agent 界面  │
│ ● Bridge          - 后台执行，GUI 监控  │
│                                        │
│ □ 记住选择（使用 Settings 预设）        │
│                                        │
│              [取消]  [确认]             │
└────────────────────────────────────────┘
```

### 10.4 保持不变

Solo Agent Progress 面板、Knowledge Viewer（shard 列表/条目浏览/Debt tab）、项目/step/attempt 三层视图、Git Status 视图、Loop Stats 面板、Settings 中 Knowledge 配置区。

---

## 十一、完整工作流（v5.1）

```
[Loop N 开始]

1. 用户发起新任务 / 新 Loop
   coordinator 初始化：
   - 生成 task.json（含 task_type / launch_mode / launch_mode_locked）
   - 检查 launch_mode_locked：若 false，弹出启动模式选择

2. coordinator 启动 PM pane
   通道：launch_mode（ccb / bridge）
   注入：decision_log shard + debt shard + 上一 loop git log
   PM 产出：任务拆解 + BranchInitSpec JSON + decision_log 条目
   coordinator 介入：
   - 写入 decision_log shard
   - Hard Gate（用户审批，未批准不发 BranchInitSpec）
   - 批准后 git_ops.sh create-branches（一次性建好所有分支和 worktree）

3. coordinator 启动 Designer pane（solo / multi_agent 任务）
   注入：PM 任务目标 + knowledge module shard（现有接口）
   Designer 产出：design_contract.md
   coordinator 介入：
   - role-commit（保存 design_contract 到 worker/design 分支）
   - 格式合规性检查
   - Hard Gate（用户审批）

4. coordinator 启动 Executor pane
   注入：design_contract + module shard + goal + acceptance
   Executor 循环 attempt：
     attempt N:
       coordinator 注入 → Executor pane 执行
       → coordinator role-commit（阶段产出）
       → coordinator 启动 Reviewer pane（judge_enabled=true）
       → Reviewer 产出 verdict.json
       → coordinator amend commit（附加 verdict）
       → coordinator 执行 test_cmd（rc 不可绕过）
       → decision_table:
           score >= threshold AND rc == 0 → READY_FOR_REVIEW → 开 PR
           score < threshold AND n < max  → n++
           n >= max                       → PAUSED
           inspiration_trigger 触发       → 启动 Inspiration pane → 注入下次 attempt

5. coordinator → git_ops.sh review-prep
   auto 检查 contract / cross_contamination
   生成结构化报告 → 注入 PM pane

6. PM review（低 token）
   读结构化报告 → 发出 MergeDecision JSON

7. coordinator → git_ops.sh merge-pr
   merge 完成 → loop_lifecycle.sh on-loop-complete：
   ① regression gate（test_cmd）
   ② PR description → module shard + debt shard
   ③ 更新 loop_stats.jsonl
   ④ 派生 session_state.json
   ⑤ 写 loop_complete 事件

[Loop N 结束 → Loop N+1，coordinator 重建上下文，PM pane 重启]
```

---

## 十二、各体系调整关键点

### 12.1 Agent 体系（v2.1）

| 文件 | 修改内容 |
|------|----------|
| `AGENT.md` | v2.1；task_type 路由替代 executor_type；solo pane 独立性规则 |
| `rules/solo_pane.md` | 新增：solo 模式 pane 独立上下文约束 |
| `rules/launch_mode.md` | 新增：CCB / Bridge 通道规范，coordinator 绝对调度权 |
| `rules/git_collab.md` | 补充 role-commit 说明 |
| `rules/collab_context.md` | 补充 Inspiration 角色约束 |
| `tools/session_id_gen.sh` | 新增：统一 Session ID 生成 |
| `tools/req_code_gen.sh` | 新增：Session ID → CCB REQ CODE 派生 |

### 12.2 CCB

CCB 降级为纯通信通道，不具备自调度能力。CCB REQ CODE 由 coordinator 通过 `req_code_gen.sh` 从 session_id 派生后注入指令模板，CCB 本身不生成 REQ CODE。

### 12.3 rdloop coordinator

| 文件 | 修改内容 |
|------|----------|
| `coordinator/run_task.sh` | task_type 路由替代 executor_type；launch_mode 选择逻辑；pane 启动器抽象；role_transition() 函数 |
| `tools/git_ops.sh` | 新增 role-commit 子命令 |
| `tools/session_id_gen.sh` | 新增：统一 Session ID 生成 |
| `tools/req_code_gen.sh` | 新增：Session ID → REQ CODE |
| `coordinator/gui/server.js` | task_type 联动校验；pane 状态 API；launch_mode 选择接口 |
| `coordinator/gui/src/` | Task Type 下拉；Pane 状态面板；Launch Mode 对话框；Checkbox 实现 |
| `docs/schema/task_schema_v51.json` | task_type / launch_mode / launch_mode_locked schema |
| `tools/migrate_task_json_v51.sh` | 新增：v5.0 → v5.1 字段迁移 |

---

## 十三、迁移路径

### 13.1 task.json 迁移

```bash
# 当前 loop 结束后、下一个 loop 开始前执行：
migrate_task_json_v51.sh <task.json>
# 或批量：
find . -name "task.json" | xargs -I{} migrate_task_json_v51.sh {}
```

迁移脚本幂等，可对已迁移文件重复执行。

### 13.2 迁移顺序建议

1. 当前 loop 正常以 v5.0 方式完成
2. loop 结束后运行 `migrate_task_json_v51.sh` 批量迁移所有 task.json
3. 部署 v5.1 coordinator（含 session_id_gen.sh、req_code_gen.sh、role-commit 子命令）
4. 更新 GUI（task_type 控件、Pane 状态面板、Launch Mode 对话框）
5. 下一个 loop 以 v5.1 方式运行

### 13.3 knowledge shard 迁移

无变化，沿用 v5.0（即 v4 shard 框架 + debt / decision_log shard）。

---

## 十四、版本对照

| 体系 | v5.0 | v5.1 | 主要变化 |
|------|------|------|----------|
| Agent 体系 | v2.0 | v2.1 | solo_pane / launch_mode 规则；Inspiration 角色完整化；api_call 废弃 |
| CCB | 有自调度 | 纯通信通道 | 调度权全部归 coordinator |
| Bridge | solo-bridge 独立 | 统一双通道之一 | 与 CCB 并列，共享 session 标识体系 |
| rdloop coordinator | executor_type × session_mode 路由 | task_type + launch_mode 路由 | 角色切换机制完整化；Session ID 统一 |
| Session 标识 | CCB REQ CODE / Bridge Session ID 独立 | 统一 Session ID + REQ CODE 派生 | 跨通道可追溯 |

---

*基于 integrated_architecture_v5.0.md，整合于 2026-02-28*
