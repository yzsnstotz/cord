# 闭环AI自主研发体系 — 整合架构方案 v5 Beta

**三套体系**：Agent 体系（v1.9.0+）+ CCB + rdloop coordinator  
**v5 Beta 范围**：  
- **TaskSpec v5**：废弃顶层 `workflow_mode`，引入 **executor_type × session_mode** 两参数正交；任务表单与路由基于此实现。  
- **run_surface**：solo_agent / multi_agent 下可选 **bridge** 或 **visual_ccb**，决定信道（solo_bridge vs CCB /ask）。  
- **v4 保留**：Knowledge Memory Sharding（`.context/knowledge/`）、状态统一视图、PM/executor 双写者、只读 knowledge agent。

**v5.0 规划（本文档外）**：git_collab 统一工作流、git_ops.sh / loop_lifecycle.sh、api_call Bug1/Bug2 修复、Git Status / Knowledge Debt / Loop Stats 视图等，见 `Arch/v5/integrated_architecture_v4_to_v5_upgrade.md`。

---

## 一、整体分工

```
┌──────────────────────────────────────────────────────────────┐
│                        用户 / 人类                            │
│         需求输入 / semi-auto 介入审批 / 最终验收               │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                    Agent 体系（认知层）                         │
│  PM（Claude，当前会话）                                        │
│  ├── brainstorming-to-plan    需求 → 任务分解                 │
│  ├── session_state.json       项目状态（task 粒度）            │
│  ├── shared_contracts         跨任务文件依赖图                 │
│  └── autoflow-run（精简版）   生成 TaskSpec，读取结果          │
│  ↓ PM/executor 写入 knowledge（按 shard 或单文件）             │
└───────────────────────────┬──────────────────────────────────┘
                            │ TaskSpec JSON (executor_type, session_mode)
┌───────────────────────────▼──────────────────────────────────┐
│               rdloop coordinator（工程可靠性层）               │
│  run_task.sh                                                   │
│  ├── v5 路由：executor_type → coder 适配器                     │
│  │   api_call → cliproxy   solo_agent → solo/ccb   multi_agent → ccb
│  ├── session_mode → context_strategy (reset/carry/persist)     │
│  ├── run_surface → bridge | visual_ccb（solo/multi 时）       │
│  ├── 状态机 RUNNING/PAUSED/FAILED/READY_FOR_REVIEW             │
│  ├── worktree 隔离、atomic_write + lock + trap                 │
│  ├── test_cmd 执行（客观 rc，不可绕过）                        │
│  ├── decision_table / decision_solo（确定性状态转移）         │
│  └── events.jsonl（完整审计链）                                │
│  GUI（只读聚合）                                               │
│  ├── 项目层  ← session_state.json                             │
│  ├── step 层  ← .ccb/state.json                               │
│  ├── attempt 层 ← out/<task_id>/（含 solo step_*）             │
│  └── knowledge 层 ← .context/knowledge/（shard 索引+条目）      │
└──────────┬─────────────────────┬──────────────────────────────┘
           │                     │
      call_coder            call_judge
           │                     │
┌──────────▼─────────────────────▼──────────────────────────────┐
│                    执行层（v5 Beta）                            │
│  executor_type: api_call   → call_coder_cliproxy / call_judge_cliproxy
│  executor_type: solo_agent → run_surface=bridge  → call_coder_solo (solo_bridge)
│                            → run_surface=visual_ccb → call_coder_ccb / call_judge_ccb
│  executor_type: multi_agent → run_surface=visual_ccb → call_coder_ccb / call_judge_ccb
└──────────┬─────────────────────────────┬──────────────────────┘
           │                             │
           └──────────────┬──────────────┘
                          ↓ 查询
┌─────────────────────────────────────────────────────────────┐
│              knowledge agent（项目知识底座）                  │
│  每项目一实例，常驻 CCB session（默认 codex）                  │
│  加载 .context/knowledge/_meta.json + 按需 shard             │
│  只检索，不写摘要、不读原始文件、不编写代码、不评审质量        │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、TaskSpec v5：executor_type × session_mode（v5 Beta 已实现）

### 2.1 两参数定义

| 字段 | 取值 | 含义 |
|------|------|------|
| **executor_type** | `api_call` | 单次 LLM API 调用（cliproxy），无 agent 工具、无多轮内部循环 |
| | `solo_agent` | 单个 coding agent（claude/codex/cursor/gemini 等），多轮 step，solo_bridge 或 CCB |
| | `multi_agent` | 多角色（executor + reviewer），CCB /ask 或 bridge |
| **session_mode** | `fresh` | 每次 attempt 从零开始（仅 api_call 可用） |
| | `iterative` | 跨 attempt 携带上一轮输出与 judge 反馈（仅 api_call 可用） |
| | `continuous` | 持续 session，多轮 step（solo_agent / multi_agent 固定） |

**约束（v5 Beta 已校验）**：  
- `api_call` 不支持 `continuous`（前端与 server 均禁用）。  
- `solo_agent` / `multi_agent` 仅支持 `continuous`（fresh/iterative 禁用）。

### 2.2 run_surface（solo_agent / multi_agent）

| run_surface | 含义 | 适用 |
|-------------|------|------|
| `bridge` | 程序 spawn 子进程，solo_bridge 或 claude_bridge 等 | solo_agent（claude/codex/cursor/antigravity） |
| `visual_ccb` | 人类 tmux 中 CCB，/ask + pend 协议 | solo_agent（任意 provider）、multi_agent（仅此） |

- **multi_agent** 仅支持 `visual_ccb`。  
- **solo_agent** 可选 `bridge` 或 `visual_ccb`；未指定时由 `execution_mode` 推断（semi-auto → visual_ccb，auto → bridge），或由 `rdloop.config.json` 的 `default_run_surface` 提供默认值。

### 2.3 task.json 字段（v5 Beta）

```json
{
  "schema_version": "v5",
  "task_id": "my_task",
  "executor_type": "api_call | solo_agent | multi_agent",
  "session_mode": "fresh | iterative | continuous",
  "run_surface": "bridge | visual_ccb",
  "goal": "...",
  "acceptance": "...",
  "test_cmd": "true",
  "max_attempts": 3,
  "agent_config": {
    "max_attempts": 10,
    "auto_pass_threshold": 0.85,
    "knowledge_shards": [],
    "provider": "claude | codex | gemini | ..."
  },
  "collab_roles": { "executor": "codex", "reviewer": "codex" },
  "repo_path": "/path/to/project"
}
```

- `workflow_mode` 已废弃；存在时由 GUI/server 映射为 executor_type/session_mode 并保留向后兼容显示。  
- 迁移：`tools/migrate_task_json.sh <task.json>` 将 v4 的 `workflow_mode`（single/solo/collab）映射为上述两参数，并合并 `solo_config` → `agent_config`。

### 2.4 run_task.sh 路由（v5 Beta）

- 读取 `executor_type`、`session_mode`、`run_surface`（及可选 `execution_mode` 默认 run_surface）。  
- **executor_type**：  
  - `api_call` → coder_type=cliproxy，judge 可选 cliproxy/none。  
  - `solo_agent` → run_surface=visual_ccb 时 coder_type=ccb；否则 coder_type=solo（solo_bridge），judge 由 provider 决定（codex/claude/cursor/antigravity）。  
  - `multi_agent` → coder_type=ccb，judge_type=ccb。  
- **session_mode** → context_strategy：fresh→reset，iterative→carry，continuous→persist。  
- 适配器脚本：call_coder_cliproxy.sh、call_coder_solo.sh、call_coder_ccb.sh、call_judge_* 等，与 v4 一致。

---

## 三、Knowledge Memory Sharding（同 v4）

- 目录：`<project>/.context/knowledge/`，`_meta.json` + 各 shard（如 `auth.json`、`api.json`）。  
- 写：`write_knowledge_cache.py --writer pm|executor --shard <name> ...`，原子写 + fcntl 锁。  
- 读：knowledge agent 加载 `_meta.json` 后按需加载 shard；GUI/API：`GET /api/knowledge/shards`、`GET /api/knowledge/shards/:shard`，以及 CRUD（POST/PUT/DELETE）由 server 原子写+锁。  
- 单文件回退：无 `.context/knowledge/` 时使用 `.context/knowledge_cache.json`，write 不传 `--shard`。

---

## 四、CCB 与信道（v5 Beta 无变更）

- **cask / gask / oask / dask / lask**：向对应 provider 发 /ask，sync/async，支持 askd 与 fallback 直连 pane。  
- **FIFO + bridge**：tmux 下 FIFO 为请求信道，bridge 为唯一读者并注入 pane；与 rdloop 的 claude_bridge 非同一组件（见 CCB/docs/FIFO-and-bridge-explained.md）。  
- **collab**：executor_type=multi_agent 或 solo_agent + run_surface=visual_ccb 时，走 CCB /ask + pend；auto 时仍可为 bridge 子进程。

---

## 五、状态统一视图与 GUI（v5 Beta）

- **项目 / step / attempt 三层**：数据来源同 v4（session_state.json、.ccb/state.json、out/<task_id>/）。  
- **Solo Agent Progress**：当 `executor_type === 'solo_agent'` 或 `workflow_mode === 'solo'` 时展示 solo step_* 进度与 5s 刷新。  
- **Task 创建/编辑**：v5 使用 **Executor Type** + **Session Mode** 两下拉（TaskEditor.jsx）；legacy workflow_mode 仅作回显与兼容。  
- **Knowledge Viewer**：shard 列表与条目浏览、CRUD 通过 API，只读聚合。  
- **Settings**：default_run_surface（bridge / visual_ccb）、default_coder、knowledge 等配置与 v4 一致。

---

## 六、完整工作流（v5 Beta）

1. **项目启动**  
   - init_knowledge_agent.sh（若存在 `.context/knowledge/` 则加载 _meta + 按需 shard，否则单文件）。

2. **新建/编辑任务**  
   - 选择 Executor Type（API Call / Solo Agent / Multi Agent）与 Session Mode（Fresh / Iterative / Continuous），可选 run_surface；task.json 落盘含 executor_type、session_mode、agent_config、collab_roles 等。

3. **运行任务**  
   - run_rdloop_task.sh → run_task.sh；按 executor_type + run_surface 选择 call_coder_* / call_judge_*。

4. **执行**  
   - api_call：单次 cliproxy 调用，结果写 attempt_dir。  
   - solo_agent：solo_bridge 多轮 step 或 CCB /ask，decision_solo 判定 READY_FOR_REVIEW/PAUSED/CONTINUE。  
   - multi_agent：CCB executor + reviewer，test_cmd → decision_table。

5. **READY_FOR_REVIEW**  
   - 若有 knowledge_entries：按 shard 调用 write_knowledge_cache.py --shard；更新 shared_contracts；state_update.sh task done。

6. **GUI**  
   - 项目/step/attempt/knowledge 同 v4；solo 任务展示 Solo Agent Progress；task 表单为 v5 两参数 + run_surface。

---

## 七、各体系关键点（v5 Beta）

### 7.1 Agent 体系

| 文件 | 说明 |
|------|------|
| `tools/write_knowledge_cache.py` | 支持 --shard、_meta 更新、单文件回退（同 v4） |
| `tools/init_knowledge_agent.sh` | 支持 _meta + 按需 shard（同 v4） |
| `tools/run_rdloop_task.sh` | READY_FOR_REVIEW 时按 shard 调用 write_knowledge_cache（同 v4） |

### 7.2 CCB

无变更；cask/gask/oask/dask/lask、askd、FIFO/bridge 行为与 v4 一致。

### 7.3 rdloop coordinator

| 文件 | 说明 |
|------|------|
| `coordinator/run_task.sh` | v5 路由：executor_type、session_mode、run_surface；coder/judge 脚本后缀按上述选择 |
| `coordinator/lib/call_coder_solo.sh` | solo_agent + bridge 适配器 |
| `coordinator/lib/call_coder_cliproxy.sh` | api_call 适配器 |
| `coordinator/lib/call_coder_ccb.sh` | solo_agent(visual_ccb) / multi_agent 适配器 |
| `gui/server.js` | executor_type/session_mode/run_surface 校验；knowledge shard CRUD；solo-steps 等；workflow_mode 兼容 |
| `gui/public/app.js` | Executor Type × Session Mode 表单；Solo Agent Progress；run_surface 与 legacy workflow_mode 回显 |
| `gui/src/TaskEditor.jsx` | v5 任务表单：Executor Type、Session Mode、约束联动 |

### 7.4 迁移与兼容

- **migrate_task_json.sh**：v4 task.json → v5（workflow_mode → executor_type + session_mode，solo_config → agent_config，删除 workflow_mode）。  
- **向后兼容**：GUI 与 server 仍识别 workflow_mode，映射为 executor_type/session_mode 用于展示与路由，新任务以 v5 字段为准。

---

## 八、版本对照（v5 Beta）

| 体系 | v4.0 | v5 Beta | 说明 |
|------|------|---------|------|
| TaskSpec | workflow_mode: single/solo/collab | executor_type × session_mode；run_surface | 两参数正交；迁移脚本；schema v5 |
| rdloop 路由 | workflow_mode case | executor_type + session_mode + run_surface | 无 workflow_mode 分支 |
| GUI 任务表单 | 三模式单选 | Executor Type + Session Mode 两下拉 | TaskEditor.jsx |
| Knowledge | shard 目录 + _meta | 同 v4 | 无变更 |
| CCB | 当前 | 同 v4 | 无变更 |
| Agent 体系 | write_knowledge_cache --shard | 同 v4 | 无变更 |

---

## 九、v5 Beta 与 v5.0 规划边界

**v5 Beta 已实现**：  
- executor_type × session_mode 模型与路由、run_surface、迁移脚本、TaskEditor、server 校验、Solo Agent Progress 与 knowledge 视图、向后兼容 workflow_mode。

**v5.0 规划（见 upgrade 文档）**：  
- api_call 修复：judge feedback 注入（Bug1）、worktree 前置初始化（Bug2）。  
- 统一 Git 工作流：git_ops.sh（create-branches / merge-pr / review-prep）、loop_lifecycle.sh、BranchInitSpec/MergeDecision。  
- Agent v2.0：git_collab.md、design_contract.md、session_state 由 coordinator 派生等。  
- GUI：Git Status、Knowledge Debt、Loop Stats 等新视图。

当前功能实现以本文 v5 Beta 范围为准；v5.0 完成后可再发布完整 v5.0 架构说明。
