# 闭环AI自主研发体系 — 整合架构方案 v4.0

**三套体系**：Agent 体系（v1.9.0）+ CCB + rdloop coordinator  
**v4 新增**：  
- **Knowledge Memory Sharding**：单文件 `knowledge_cache.json` 拆分为按模块的 shard 文件（`.context/knowledge/`），按需加载、原子写入、fcntl 锁、迁移与回退兼容  
- **Three-Mode 工作流**：顶层 `workflow_mode`（single | solo | collab）决定信道类型与适配器路由，替代/兼容原 execution_mode  
- 保留 v3：adapter 映射修正、knowledge 只读检索、状态统一视图

---

## 一、整体分工

```
┌──────────────────────────────────────────────────────────────┐
│                        用户 / 人类                            │
│         需求输入 / semi-auto介入审批 / 最终验收               │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                    Agent 体系（认知层）                        │
│                                                               │
│  PM（Claude，当前会话）                                        │
│  ├── brainstorming-to-plan    需求 → 任务分解                  │
│  ├── session_state.json       项目状态（task粒度）             │
│  ├── shared_contracts         跨任务文件依赖图                 │
│  └── autoflow-run（精简版）   生成 TaskSpec，读取结果           │
│                                                               │
│  ↓ PM 写入 knowledge（按 shard）任务摘要                       │
│  ↓ executor 写入 knowledge（按 shard）文件摘要                 │
└───────────────────────────┬──────────────────────────────────┘
                            │ TaskSpec JSON (含 workflow_mode)
┌───────────────────────────▼──────────────────────────────────┐
│               rdloop coordinator（工程可靠性层）               │
│                                                               │
│  run_task.sh                                                  │
│  ├── workflow_mode 路由：single | solo | collab                │
│  ├── 状态机 RUNNING/PAUSED/FAILED/READY_FOR_REVIEW            │
│  ├── worktree 隔离（single 可无 repo_path）                    │
│  ├── atomic_write + lock + trap                               │
│  ├── test_cmd 执行（客观 rc，不可绕过）                        │
│  ├── decision_table / decision_solo（确定性状态转移）          │
│  └── events.jsonl（完整审计链）                               │
│                                                               │
│  GUI（只读聚合视图）                                           │
│  ├── 项目层  ← session_state.json（task 列表/进度）            │
│  ├── step 层  ← .ccb/state.json（当前 step/attempts）         │
│  ├── attempt 层 ← out/<task_id>/（执行细节/评分/日志/solo 步进）│
│  └── knowledge 层 ← .context/knowledge/（shard 索引+条目）     │
└──────────┬─────────────────────┬──────────────────────────────┘
           │                     │
      call_coder            call_judge
           │                     │
┌──────────▼─────────────────────▼──────────────────────────┐
│                    执行模式 / 信道路由层（v4）                 │
│                                                             │
│  workflow_mode: single   workflow_mode: solo                 │
│  LLM API 单次调用        单 coding agent + 扩展 bridge        │
│  call_coder_cliproxy.sh  call_coder_solo.sh                 │
│  call_judge_cliproxy.sh  (solo_bridge.sh + decision_solo)  │
│  无 worktree 可选        可见 tmux pane，coordinator 轮询   │
│                                                             │
│  workflow_mode: collab（对应 v3 semi-auto）                  │
│  auto: call_*_bridge.sh   semi-auto: call_*_ccb.sh           │
│  程序 spawn 子进程       人类 tmux session，/ask 附加信道    │
└──────────┬─────────────────────────────┬────────────────────┘
           │                             │
           └──────────────┬──────────────┘
                          ↓ 查询
┌─────────────────────────────────────────────────────────────┐
│              knowledge agent（项目知识底座，v4 支持 shard）   │
│                                                              │
│  每项目一实例，常驻 CCB session（默认 codex）                  │
│  加载 .context/knowledge/_meta.json 索引，按需加载 shard     │
│                                                              │
│  能回答：文件/依赖/历史/测试查询（同 v3）                      │
│  不做：不写摘要、不读原始文件、不编写代码、不评审质量          │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、Three-Mode 工作流（v4 新增）

### 2.1 模式定义

| 模式 | 提供方类型 | 与 Agent 的通信方式 | 用户可见性 |
|------|------------|---------------------|------------|
| **Single Flow** | 仅 LLM API（cliproxyapi, cursorcliapi） | 每次 attempt 单次 API 调用 | 仅日志文件 |
| **Solo Agent** | 单 coding agent（claude/codex/cursor CLI） | 扩展 bridge：coordinator ↔ agent 通过 JSON 请求/响应轮询 | 可见 tmux pane |
| **Collab** | CCB 多角色（cask/gask/oask/dask/lask） | CCB /ask + pend 协议 | CCB tmux panes |

### 2.2 适配器与信道边界

```
Single Flow（无 coding agent 能力）：
  call_coder_cliproxy.sh    — CLI 代理到 LLM API
  call_judge_cliproxy.sh    — 同上，judge 用

Solo Agent（单 coding agent，完整工具使用）：
  call_coder_solo.sh        — 扩展 bridge，可见 tmux，coordinator 轮询 step
  （无独立 judge — agent 自评，decision_solo.py 判定）

Collab（多角色 CCB）：
  call_coder_ccb.sh         — /ask 到 CCB executor
  call_judge_ccb.sh         — /ask 到 CCB reviewer
  auto 时：call_coder_bridge.sh / call_judge_bridge.sh（v3 不变）
```

原有 adapter（call_coder_claude_bridge.sh、call_coder_codex.sh、call_coder_mock.sh）保留，可通过 Advanced JSON 使用，不在三模式 UI 中默认暴露。

### 2.3 task.json 与 workflow_mode 路由

**run_task.sh 路由逻辑（v4.0）**：`workflow_mode` 优先于 `execution_mode`。

```bash
workflow_mode=$(json_read "$TASK_JSON" "workflow_mode" "")
case "$workflow_mode" in
  single)
    coder_type="cliproxy"
    judge_type=$(judge_enabled ? "cliproxy" : "none")
    # 无 repo_path 时可跳过 worktree，worktree_dir=$TASK_DIR
    ;;
  solo)
    coder_type="solo"
    judge_type="none"   # agent 自评，由 decision_solo 决定 READY_FOR_REVIEW/PAUSED
    ;;
  collab)
    coder_type="ccb"
    judge_type="ccb"
    ;;
  *)
    # Legacy: execution_mode auto → bridge, semi-auto → ccb
    ;;
esac
```

**task.json 新增/扩展字段**：

```json
{
  "workflow_mode": "single|solo|collab",
  "type": "requirements_doc|engineering_impl|douyin_script|storyboard|paid_mini_drama|custom",
  "judge_enabled": true,
  "solo_config": {
    "max_iterations": 10,
    "approval_mode": "agent_decides|step2step",
    "session_strategy": "continuous|fresh_per_step",
    "auto_pass_threshold": 0.85,
    "knowledge_shards": ["auth", "api"],
    "open_terminal": true
  },
  "collab_roles": { "executor": "claude", "reviewer": "codex", "designer": "claude", "inspiration": "gemini" },
  "knowledge_enabled": true,
  "knowledge_project_path": "/path/to/project"
}
```

### 2.4 Solo 模式：扩展 bridge 与决策

- **solo_bridge.sh**：在可见 tmux pane 中运行，按 `request.json` → agent CLI → `response.json` 与 coordinator 交互；支持 `--fresh-per-step` 每步新 session。
- **call_coder_solo.sh**：根据 `solo_config` 启动 bridge、注入 knowledge shard 内容（若启用）、执行 coordinator-agent 循环；每步后调用 **decision_solo.py**（无 LLM）决定 `CONTINUE | READY_FOR_REVIEW | PAUSED_*`。
- **GUI**：Solo Agent Progress 面板展示 `solo/step_*/response.json`；step2step 时可「Proceed」或填入反馈。数据来自 `GET /api/task/:taskId/attempt/:n/solo-steps`。

### 2.5 模式与 Agent 体系映射

| 组件 | Single Flow | Solo Agent | Collab |
|------|-------------|------------|--------|
| PM 角色 | Coordinator 充当（无 Agent PM session） | Coordinator 充当；agent 为 executor | Agent PM（Claude session） |
| Knowledge 写入 | 无 | READY_FOR_REVIEW 时 write_knowledge_cache.py --shard | run_rdloop_task.sh 触发 write_knowledge_cache.py --shard |
| Knowledge 读取 | 无 | 步进时在 meta-instruction 中注入 shard 内容 | Worker 通过 CCB 查 knowledge agent |
| session_state.json | Coordinator 更新 | Coordinator 更新 | PM 更新 |
| 追踪 | attempt_dir | attempt_dir + solo/step_* | attempt_dir + .ccb/state.json |

---

## 三、Knowledge Memory Sharding 机制（v4 新增）

### 3.1 设计目标

- 原状：单一 `knowledge_cache.json`，读者必须整文件加载。  
- 目标：按模块分 shard，按需加载；写路径原子化、锁互斥；兼容旧单文件与迁移脚本。

### 3.2 Shard 目录布局

```
<project>/.context/knowledge/
  _meta.json           # shard 注册表
  auth.json            # shard: auth 模块
  api.json             # shard: API 层
  frontend.json
  tasks.json           # task:T* 条目可集中或按业务 shard
  ...
```

**_meta.json**：

```json
{
  "version": "1.0",
  "project": "<name>",
  "shards": {
    "auth": {
      "description": "Authentication and authorization module",
      "entry_count": 5,
      "last_updated": "2026-02-26T10:00:00Z"
    }
  }
}
```

**单个 shard 文件（如 auth.json）**：

```json
{
  "version": "1.0",
  "shard": "auth",
  "description": "Authentication and authorization module",
  "last_updated": "2026-02-26T10:00:00Z",
  "entries": {
    "src/auth.py": {
      "type": "file",
      "owner_task": "T01",
      "summary": "JWT auth module. Public: verify_token, issue_token.",
      "interface_hash": "abc123",
      "last_modified_by": "T01",
      "last_modified_at": "2026-02-26T09:00:00Z",
      "written_by": "executor"
    },
    "task:T01": {
      "type": "task",
      "title": "Implement JWT auth",
      "decision": "PASS",
      "written_by": "PM"
    }
  }
}
```

### 3.3 写路径（write_knowledge_cache.py）

- **参数**：`--shard <name>` 可选；若项目存在 `.context/knowledge/` 则鼓励使用 shard；未传时写回退到单文件 `knowledge_cache.json`。
- **PM 模式**：`--writer pm --task-id T01 --shard auth --entry-json '...'` → 写入 `auth.json` 的 `entries["task:T01"]`，并更新 `_meta.json`。
- **Executor 模式**：`--writer executor --task-id T01 --shard auth --final-summary <path>` → 从 final_summary 的 `knowledge_entries` 合并进 `auth.json`，并更新 `_meta.json`。
- **并发**：对 `<shard>.json.lock` 使用 fcntl LOCK_EX；写操作为 temp → fsync → rename，与 rdloop 其他 JSON 一致。

### 3.4 读路径

- **Knowledge agent / init_knowledge_agent.sh**：先读 `_meta.json` 作为索引，再按需加载指定 shard 文件（如按 scope 或 `solo_config.knowledge_shards`）。
- **GUI / server.js**：`GET /api/knowledge/shards` 返回 _meta；`GET /api/knowledge/shards/:shard` 返回该 shard 的 entries。写端点（POST/PUT/DELETE shard 或 entry）同样原子写 + fcntl 锁。

### 3.5 迁移与回退

- **migrate_knowledge_cache.py**：读取现有 `knowledge_cache.json`，按 key 启发式分组（如 `task:*` → tasks，文件路径首段 → 模块名），写出各 shard 与 `_meta.json`，原文件重命名为 `knowledge_cache.json.bak`。
- **回退**：若不存在 `.context/knowledge/` 而存在 `knowledge_cache.json`，工具与 reader 仍读单文件。

### 3.6 与 v3 的衔接

- 摘要生产者仍是 **executor** 与 **PM**；knowledge agent 仍只做检索。  
- 仅存储从「单文件」变为「可选 shard 目录」；条目结构与 v3 一致（file/task 类型、owner_task、summary、interface_hash、written_by 等）。

---

## 四、auto vs semi-auto — Collab 内部（v3 保留）

在 **workflow_mode: collab** 下，仍用 execution_mode 区分信道：

| | auto 模式 | semi-auto 模式 |
|---|---|---|
| **信道** | claude_bridge（IPC） | CCB（tmux /ask） |
| **session 主人** | coordinator（spawn 子进程） | 人类（tmux pane 持续） |
| **adapter** | call_coder_bridge.sh / call_judge_bridge.sh | call_coder_ccb.sh / call_judge_ccb.sh |

逻辑与 v3 一致：bridge 为程序控制、全自动；CCB 为人在回路、可随时接管。

---

## 五、Knowledge agent — 项目知识底座（v4 更新）

### 5.1 原则（同 v3）

摘要由 **executor** 和 **PM** 写入；knowledge agent 只检索，不写摘要、不读原始文件、不编写代码、不评审质量。

### 5.2 存储：单文件与 Shard 并存

- 若存在 `.context/knowledge/`：使用 `_meta.json` + 各 shard 文件；write_knowledge_cache.py 支持 `--shard`。
- 否则：使用 `.context/knowledge_cache.json`（v3 行为），write 不传 `--shard`。

### 5.3 加载与查询

- **初始化**：加载 `_meta.json` 作为索引；可按 shard 名或 scope 加载部分 shard 内容进 session，避免一次性加载全部。
- **查询**：与 v3 相同（文件/依赖/历史/测试类问题），仅数据来源从单文件变为「一个或多个 shard」。

### 5.4 配置（可扩展）

```json
// rdloop.config.json 或项目配置
{
  "knowledge_enabled": true,
  "knowledge_provider": "codex",
  "knowledge_project_path": "/path/to/project"
}
```

GUI Settings 中「Knowledge Agent」区可配置上述项，并打开 Knowledge Viewer（shard 列表 + 条目浏览/编辑）。

---

## 六、状态统一视图 — Coordinator GUI 只读聚合（v4 更新）

### 6.1 四层视图（同 v3，knowledge 层改为 shard）

- **项目视图**：session_state.json（task 列表、shared_contracts、进度）。
- **step 视图**：.ccb/state.json（当前 step、attempts）。
- **attempt 视图**：out/<task_id>/（coder/judge/test 日志、评分、events.jsonl、**solo 时** step_* 步进）。
- **knowledge 视图**：从 `GET /api/knowledge/shards` 与 `GET /api/knowledge/shards/:shard` 聚合；左侧 shard 列表，右侧条目列表/详情；支持按 shard 过滤与最近变更高亮。

### 6.2 只读原则

GUI 不写 session_state、.ccb/state、rdloop status；knowledge 的写通过 server 的 CRUD 端点（原子写 + 锁）完成，GUI 仅调用 API。

---

## 七、完整工作流（v4.0）

```
1. 项目启动（一次性）
   → init_knowledge_agent.sh <project_path>
     若存在 .context/knowledge/：加载 _meta + 按需 shard；否则加载 knowledge_cache.json
   → session 中断后可重新 init，数据在磁盘不丢失

2. 用户输入需求
   → PM 写入 knowledge（按 shard，written_by: PM）
   → 产出 session_state.json（tasks + shared_contracts）

3. 新建/编辑任务
   → 选择 workflow_mode：Single Flow | Solo Agent | Collab
   → 按模式展示 Type、Provider、Instruction、Repo、Knowledge、Acceptance 等
   → task.json 落盘含 workflow_mode、solo_config/collab_roles 等

4. PM 选择 in_progress task，调用 rdloop
   → run_rdloop_task.sh → run_task.sh

5. run_task.sh 按 workflow_mode 路由
   ├── single:  worktree 可选；call_coder_cliproxy +（可选）call_judge_cliproxy
   ├── solo:    worktree 必选；call_coder_solo（solo_bridge + decision_solo 循环）；无独立 judge
   └── collab:  worktree 必选；call_coder_ccb/call_judge_ccb 或 bridge；execution_mode 决定信道

6. Coder / Judge 执行
   ├── single:  单次 API 调用，结果写 attempt_dir
   ├── solo:    coordinator 与 agent 多轮 step，每轮 request/response，decision_solo 判定 READY_FOR_REVIEW/PAUSED/CONTINUE
   └── collab:  与 v3 相同（test_cmd → decision_table，PASS/FAIL/PAUSED）

7. READY_FOR_REVIEW 时
   → 若有 knowledge_entries：按 shard 调用 write_knowledge_cache.py --shard（solo 用 solo_config.knowledge_shards 或路径推断）
   → 更新 shared_contracts（interface_hash 从 knowledge 读）
   → state_update.sh task done

8. GUI 展示
   → 项目/step/attempt 同 v3；solo 任务展示 Solo Agent Progress；knowledge 展示 shard 列表与条目
```

---

## 八、各体系调整关键点（v4.0）

### 8.1 Agent 体系

| 文件 | 修改内容 |
|------|----------|
| `tools/write_knowledge_cache.py` | 增加 `--shard`、shard 目录 I/O、_meta 更新、保留单文件回退 |
| `tools/init_knowledge_agent.sh` | 支持 _meta + 按需加载 shard |
| `tools/migrate_knowledge_cache.py` | 新增：单文件 → shard 一次性迁移 |
| `tools/run_rdloop_task.sh` | READY_FOR_REVIEW 时按 shard 调用 write_knowledge_cache.py（shard 由配置或路径推断） |

### 8.2 CCB

无变更（cask/gask 接口满足需求）。

### 8.3 rdloop coordinator

| 文件 | 修改内容 |
|------|----------|
| `run_task.sh` | workflow_mode 路由（single/solo/collab）；single 下可选无 worktree；coder/judge 脚本后缀按 mode 选择 |
| `lib/call_coder_solo.sh` | 新增：Solo 模式适配器，solo_bridge + coordinator 轮询 + knowledge shard 注入 |
| `lib/solo_bridge.sh` | 新增：可见 tmux 内 request/response 协议，支持 --fresh-per-step |
| `lib/decision_solo.py` | 新增：无 LLM 的 step 结束判定（READY_FOR_REVIEW/PAUSED/CONTINUE） |
| `lib/call_coder_cliproxy.sh` | 新增：Single Flow coder（LLM API） |
| `lib/call_judge_cliproxy.sh` | 新增：Single Flow judge |
| `gui/server.js` | knowledge shard CRUD（GET/POST/PUT/DELETE shards 与 entries）；solo-steps / solo-proceed / solo-abort；workflow_mode 校验；CCB session 检测增强（isCcbNativeSessionName、重试轮询） |
| `gui/public/app.js` | 三模式 New/Edit 模态（workflow_mode 切换）；Knowledge Viewer 模态；Solo Agent Progress 面板；Settings 中 Knowledge 配置 |

---

## 九、版本对照

| 体系 | v3.0 | v4.0 | 主要变化 |
|------|------|------|----------|
| Agent 体系 | v1.9.0 | v1.9.0+ | knowledge 支持 shard 写入/迁移；init 按需加载 shard |
| CCB | 当前 | 无需升级 | — |
| rdloop | p0-stability + 7 处 | p0-stability + three-mode + shard | workflow_mode 路由；call_coder_solo/cliproxy；decision_solo；knowledge shard API 与 GUI；Solo 进度面板；CCB 启动检测修复 |

---

## 十、v3 → v4 变更摘要

- **Three-Mode**：顶层 `workflow_mode`（single | solo | collab）决定 coder/judge 适配器与是否 worktree；solo 使用扩展 bridge 与 decision_solo，无独立 judge。
- **Knowledge Sharding**：`.context/knowledge/` 下 _meta.json + 多 shard 文件；写路径带 `--shard`、锁与原子写；读路径按索引按需加载；迁移脚本与单文件回退兼容。
- **保留**：v3 的 auto/semi-auto 映射（collab 内）、knowledge 只读检索原则、状态统一视图只读聚合、PM/executor 双写者模型。
