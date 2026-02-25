# 闭环AI自主研发体系 — 整合架构方案 v3.0

**三套体系**：Agent体系（v1.8.0→v1.9.0）+ CCB + rdloop coordinator  
**v3修正**：  
- adapter映射修正（auto↔semi-auto与信道本质对齐）  
- knowledge agent（摘要由executor/PM写入，agent只检索；外部持久化cache解决session中断问题）  
- 状态统一视图（coordinator GUI只读聚合三个粒度，各体系保留所有权）

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
│  └── autoflow-run（精简版）   生成TaskSpec，读取结果           │
│                                                               │
│  ↓ PM写入 knowledge_cache.json（任务规划时写需求摘要）         │
│  ↓ executor写入 knowledge_cache.json（task完成时写文件摘要）   │
└───────────────────────────┬──────────────────────────────────┘
                            │ TaskSpec JSON
┌───────────────────────────▼──────────────────────────────────┐
│               rdloop coordinator（工程可靠性层）               │
│                                                               │
│  run_task.sh                                                  │
│  ├── 状态机 RUNNING/PAUSED/FAILED/READY_FOR_REVIEW            │
│  ├── worktree隔离（每次attempt独立git分支）                    │
│  ├── atomic_write + lock + trap                               │
│  ├── test_cmd执行（客观rc，不可绕过）                          │
│  ├── decision_table（确定性状态转移）                          │
│  └── events.jsonl（完整审计链）                               │
│                                                               │
│  GUI（只读聚合视图）                                           │
│  ├── 项目层  ← session_state.json（task列表/进度）            │
│  ├── step层  ← .ccb/state.json（当前step/attempts）           │
│  ├── attempt层 ← out/<task_id>/（执行细节/评分/日志）         │
│  └── knowledge层 ← knowledge_cache.json（摘要索引）           │
└──────────┬─────────────────────┬────────────────────────────┘
           │                     │
      call_coder            call_judge
           │                     │
┌──────────▼─────────────────────▼──────────────────────────┐
│                    执行模式路由层                            │
│                                                             │
│  auto模式（程序主导）           semi-auto模式（人在回路）   │
│  coordinator spawn子进程        人类tmux session持续运行    │
│  程序控制生命周期               /ask是附加信道               │
│  tool call全自动通过            人可随时看到/介入/接管       │
│                                                             │
│  call_coder_bridge.sh          call_coder_ccb.sh           │
│  call_judge_bridge.sh          call_judge_ccb.sh           │
│         │                              │                   │
│   claude_bridge IPC               CCB cask/gask            │
└──────────┬─────────────────────────────┬──────────────────┘
           │                             │
           └──────────────┬──────────────┘
                          ↓ 查询
┌─────────────────────────────────────────────────────────────┐
│              knowledge agent（项目知识底座）                  │
│                                                              │
│  每个项目一个实例，常驻CCB session（默认codex，可配置）        │
│  启动时加载 knowledge_cache.json，之后只响应检索查询           │
│                                                              │
│  能回答：                                                     │
│  ├── 文件查询："src/auth.py的公开接口是什么"                  │
│  ├── 依赖查询："哪些task修改过这个文件"                       │
│  ├── 历史查询："T01到T05各做了什么变更"                       │
│  └── 测试查询："auth模块有哪些测试覆盖"                       │
│                                                              │
│  不做的事：                                                   │
│  ├── 不写摘要（由executor/PM在task完成时写入cache）           │
│  ├── 不读原始文件（只读cache，原始文件由coder操作）            │
│  ├── 不编写代码                                               │
│  └── 不评审质量                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、auto vs semi-auto — 修正后的信道映射

### 2.1 v2的错误与修正

v2把CCB映射到auto、claude_bridge映射到semi-auto，这和两者的本质完全相反。

**正确对应**基于"谁是session的主人"：

| | auto模式 | semi-auto模式 |
|---|---|---|
| **信道** | claude_bridge（IPC） | CCB（tmux /ask） |
| **session主人** | coordinator（程序spawn子进程） | 人类（tmux pane持续运行） |
| **session生命周期** | coordinator控制：spawn→执行→kill | 人类控制：pane一直存在，/ask是插入的信道 |
| **tool call处理** | 全自动（--dangerously-skip-permissions） | 人可随时直接在pane里介入/接管 |
| **适用场景** | 明确任务、验收清晰、测试环境 | 风险操作、首次探索、生产环境 |
| **rdloop adapter** | call_coder_bridge.sh / call_judge_bridge.sh | call_coder_ccb.sh / call_judge_ccb.sh |

**逻辑**：claude_bridge是`child_process.spawn`，coordinator是进程父级，session生命周期完全在程序控制下，天然是auto。CCB的tmux pane是人开的、人在用的，/ask只是"插"进去的附加信道，人随时可以直接在pane里接管，天然是semi-auto。

### 2.2 auto模式 — call_coder_bridge.sh

```bash
#!/usr/bin/env bash
# call_coder_bridge.sh — auto模式
# coordinator程序化spawn子进程，全自动，无需人工介入

task_json="$1"; attempt_dir="$2"; worktree_dir="$3"; instruction_path="$4"
mkdir -p "${attempt_dir}/coder"

RDLOOP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRIDGE_INDEX="${RDLOOP_ROOT}/claude_bridge/index.js"
BRIDGE_DIR="${attempt_dir}/bridge_ipc"  # 每次attempt独立IPC目录
ATTEMPT_ID=$(basename "$attempt_dir")

run_log="${attempt_dir}/coder/run.log"
instruction=$(cat "$instruction_path" 2>/dev/null || echo "")

timeout_s=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('coder_timeout_seconds',600))
except: print(600)
" 2>/dev/null || echo "600")

project_path=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('repo_path',''))
except: print('')
" 2>/dev/null || echo "")

knowledge_cache="${project_path}/.context/knowledge_cache.json"

full_instruction="[WORKING DIRECTORY: ${worktree_dir}]
[KNOWLEDGE CACHE: ${knowledge_cache}]
${instruction}"

{
  echo "[CODER][auto/bridge] $(date -u +%Y-%m-%dT%H:%M:%SZ) coordinator-spawned session"
  echo "[CODER][auto/bridge] worktree: ${worktree_dir}"
  echo "[CODER][auto/bridge] timeout: ${timeout_s}s"

  timeout "$timeout_s" \
    node "$BRIDGE_INDEX" \
      --bridge-dir "$BRIDGE_DIR" \
      --session-id "$ATTEMPT_ID" \
      -- -p "$full_instruction" \
         --cwd "$worktree_dir" \
         --dangerously-skip-permissions 2>&1

  echo "[CODER][auto/bridge] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
} > "$run_log" 2>&1

rc=$?
[ "$rc" = "124" ] && echo "TIMEOUT" >> "$run_log"
echo "$rc" > "${attempt_dir}/coder/rc.txt"
exit "$rc"
```

### 2.3 semi-auto模式 — call_coder_ccb.sh

```bash
#!/usr/bin/env bash
# call_coder_ccb.sh — semi-auto模式
# 通过/ask附加到人类正在使用的tmux session
# 人可直接在pane里看到执行过程、随时介入

task_json="$1"; attempt_dir="$2"; worktree_dir="$3"; instruction_path="$4"
mkdir -p "${attempt_dir}/coder"

run_log="${attempt_dir}/coder/run.log"
output_file="${attempt_dir}/coder/stdout.log"

timeout_s=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('coder_timeout_seconds',600))
except: print(600)
" 2>/dev/null || echo "600")

coder_model=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('coder_model',''))
except: print('')
" 2>/dev/null || echo "")

project_path=$(python3 -c "
import json
try: print(json.load(open('$task_json')).get('repo_path',''))
except: print('')
" 2>/dev/null || echo "")

ccb_bin="cask"
[[ "$coder_model" == gemini* ]] && ccb_bin="gask"

knowledge_cache="${project_path}/.context/knowledge_cache.json"
instruction=$(cat "$instruction_path" 2>/dev/null || echo "")

full_prompt="[WORKING DIRECTORY: ${worktree_dir}]
[KNOWLEDGE CACHE: ${knowledge_cache}]
[NOTE: semi-auto mode — human may observe and intervene via tmux]
${instruction}"

{
  echo "[CODER][semi-auto/ccb] $(date -u +%Y-%m-%dT%H:%M:%SZ) attached to human tmux session"
  echo "[CODER][semi-auto/ccb] provider=${ccb_bin} timeout=${timeout_s}s"

  if ! "$ccb_bin" --timeout 5 "ping" > /dev/null 2>&1; then
    echo "[CODER][semi-auto/ccb] CCB daemon unavailable"
    echo "127" > "${attempt_dir}/coder/rc.txt"
    exit 127
  fi

  CCB_SESSION_FILE="${worktree_dir}/.codex-session" \
    "$ccb_bin" \
      --output "$output_file" \
      --timeout "$timeout_s" \
      "$full_prompt" 2>&1

  echo "[CODER][semi-auto/ccb] $(date -u +%Y-%m-%dT%H:%M:%SZ) finished"
} > "$run_log" 2>&1

rc=$?
echo "$rc" > "${attempt_dir}/coder/rc.txt"
exit "$rc"
```

**judge同理**：auto用`call_judge_bridge.sh`（coordinator spawn，Claude CLI主动读文件验证，全自动），semi-auto用`call_judge_ccb.sh`（附加到人类session，人可直接看到judge的判断过程）。

---

## 三、knowledge agent — 项目知识底座

### 3.1 核心设计原则

**摘要的生产者是executor和PM，knowledge agent只负责检索。**

```
写摘要（两个写入者，职责不同）：
  executor → task完成后写：
    "修改了哪些文件"、"每个文件改了什么"、"新增/变更了哪些接口"
    时机：run_rdloop_task.sh检测到state=READY_FOR_REVIEW时触发

  PM → 任务规划时写：
    "这个task的需求背景"、"设计决策"、"acceptance criteria"
    时机：autoflow-run Step3（生成TaskSpec后）

读摘要（所有人都只问knowledge agent）：
  knowledge agent → 从knowledge_cache.json检索，秒回
  coder / judge / PM → 不再自己全文搜索，直接查询knowledge agent
```

这样knowledge agent永远不需要"理解"文件本身，只需要检索已有摘要。职责边界极其清晰，不会出现"理解是否准确"的歧义——内容的准确性由写入者（executor/PM）保证。

### 3.2 knowledge_cache.json 结构

存储位置：`<project>/.context/knowledge_cache.json`

```json
{
  "version": "1.0",
  "project": "my-project",
  "last_updated": "2026-02-24T10:00:00Z",
  "entries": {
    "src/auth.py": {
      "type": "file",
      "owner_task": "T01",
      "summary": "JWT认证模块。公开接口：verify_token(token:str)->UserContext，issue_token(user_id:str)->str。依赖config.SECRET_KEY。无副作用。",
      "interface_hash": "abc123",
      "last_modified_by": "T01",
      "last_modified_at": "2026-02-24T09:00:00Z",
      "written_by": "executor"
    },
    "api/schema.json": {
      "type": "file",
      "owner_task": "T02",
      "summary": "REST API schema。/auth/login POST→{token,expires_at}，/user/profile GET→UserProfile（需Bearer token）。",
      "interface_hash": "def456",
      "last_modified_by": "T02",
      "last_modified_at": "2026-02-24T09:30:00Z",
      "written_by": "executor"
    },
    "task:T03": {
      "type": "task",
      "title": "实现用户Profile API",
      "decision": "PASS",
      "acceptance_criteria": ["GET /user/profile返回完整profile", "需鉴权"],
      "design_rationale": "使用auth.py的verify_token做鉴权，profile数据从PostgreSQL的users表读取",
      "files_modified": ["src/profile.py", "api/schema.json"],
      "written_by": "PM"
    }
  }
}
```

### 3.3 写入机制

**executor写入**（task完成后，通过write_knowledge_cache.py）：

executor在输出final_summary.json时额外携带knowledge_entries字段：

```json
{
  "state": "READY_FOR_REVIEW",
  "decision": "PASS",
  "files_modified": ["src/auth.py", "src/auth_test.py"],
  "knowledge_entries": {
    "src/auth.py": "JWT认证模块。公开接口：verify_token(token:str)->UserContext...",
    "src/auth_test.py": "auth.py的单元测试。覆盖verify_token的有效token/过期token/无效签名三种情况。"
  }
}
```

run_rdloop_task.sh在state=READY_FOR_REVIEW时调用：

```bash
python3 $TOOLS_ROOT/write_knowledge_cache.py \
  --project-path "$project_path" \
  --task-id "$task_id" \
  --final-summary "$final_summary_path" \
  --writer "executor"
```

**PM写入**（autoflow-run Step3，生成TaskSpec后）：

```python
# write_knowledge_cache.py被PM直接调用
write_entry(project_path, f"task:{task_id}", {
    "type": "task",
    "title": task_title,
    "design_rationale": merged_design_summary,
    "acceptance_criteria": acceptance_criteria,
    "written_by": "PM"
})
```

write_knowledge_cache.py使用原子写入（temp→fsync→rename），和rdloop其他JSON文件保持一致。

### 3.4 knowledge agent查询

knowledge agent是以`--session-file`持久化的CCB session，启动时加载knowledge_cache.json：

```bash
# 初始化（项目首次启动或session中断后恢复）
cask --session-file "${ka_session}" \
     "你是这个项目的知识检索助手。
      加载以下项目知识库并建立索引：
      $(cat knowledge_cache.json)
      之后我会发送查询，请从知识库中检索并回答，不要读取任何原始文件。"
```

任何worker查询知识底座：

```bash
# coder查询：相关接口定义
cask --session-file "${ka_session}" \
     --output "$result_file" \
     "src/auth.py的公开接口有哪些？"
# → "verify_token(token:str)->UserContext 和 issue_token(user_id:str)->str"

# judge查询：历史变更
cask --session-file "${ka_session}" \
     --output "$result_file" \
     "T01到T03做了哪些变更，涉及哪些文件？"

# PM查询：依赖关系
cask --session-file "${ka_session}" \
     --output "$result_file" \
     "哪些task依赖了auth.py，它们的interface_hash是否还是最新的？"
```

**session中断恢复**：knowledge_cache.json是外部持久化文件，session中断后重新init只需把cache内容加载进新session，不需要重新读取任何原始文件。相比v2（session存活才有上下文）大幅提升了可靠性。

### 3.5 配置

```json
// <project>/.context/project_config.json
{
  "knowledge_agent": {
    "provider": "codex",
    "session_file": ".context/knowledge_agent/.ka-session",
    "cache_file": ".context/knowledge_cache.json",
    "auto_init": true
  }
}

// 全局默认（~/.config/ccb/rdloop_defaults.json）
{
  "knowledge_agent": {
    "provider": "codex"
  }
}
```

---

## 四、状态统一视图 — coordinator GUI只读聚合

### 4.1 现状

状态散落在三处，各体系独立维护，没有统一视图：

```
<project>/.context/session_state.json   owner: Agent体系 PM  （task粒度）
<project>/.ccb/state.json               owner: CCB           （step粒度）
rdloop/out/<task_id>/status.json        owner: rdloop        （attempt粒度）
<project>/.context/knowledge_cache.json owner: executor/PM   （知识摘要）
```

### 4.2 解决方案

**不迁移所有权**。session_state.json的写操作绑定在PM session里，迁移会改变PM工作方式，成本高、没必要。各体系继续维护自己的状态文件。

**coordinator GUI作为只读聚合器**：在一个界面展示四个粒度的状态，写操作严格禁止（GUI不写任何状态文件）。

```
coordinator GUI
│
├── 项目视图（只读，从session_state.json聚合）
│   ├── task列表：id / title / status / acceptance_criteria
│   ├── shared_contracts：文件依赖图，interface_hash变更高亮
│   └── 整体进度：N/M tasks done
│
├── step视图（只读，从.ccb/state.json聚合）
│   ├── 当前task的step列表
│   ├── 当前执行到哪个step
│   └── 每个step的attempts记录
│
├── attempt视图（原有功能，从rdloop/out/读）
│   ├── coder/judge/test的stdout/stderr/rc
│   ├── JudgeVerdict v2评分详情
│   ├── events.jsonl时间线
│   └── live log（带etag/304刷新，不闪烁）
│
└── knowledge视图（只读，从knowledge_cache.json读）
    ├── 文件摘要索引（按修改时间排序）
    ├── task摘要列表
    └── 最近变更高亮（interface_hash变化的文件）
```

### 4.3 新增API端点（只读）

```
GET /api/project/tasks
  → 读 <project>/.context/session_state.json
  → 返回 task列表 + shared_contracts

GET /api/project/steps/:task_id
  → 读 <project>/.ccb/state.json
  → 返回 step列表 + current step

GET /api/knowledge
  → 读 <project>/.context/knowledge_cache.json
  → 返回 entries（按last_modified_at倒序）

（原有attempt/events/live-log端点保留不变）
```

project路径从coordinator的配置或当前运行的task中获取，GUI启动时注册。

---

## 五、完整工作流（v3.0）

```
1. 项目启动（一次性）
   → init_knowledge_agent.sh <project_path>
     加载knowledge_cache.json到ka-session
     （session中断后也可重新init，cache是外部文件不会丢失）

2. 用户输入需求
   → PM加载brainstorming-to-plan
   → PM写入knowledge_cache：每个task的需求摘要（written_by: PM）
   → 产出session_state.json（tasks列表 + shared_contracts）

3. PM选择in_progress task
   → 检查shared_contracts（文件冲突检测）
   → 查询knowledge agent："T01修改了auth.py的哪些接口？"（从cache检索，秒回）
   → 决定execution_mode（auto/semi-auto）

4. Dual设计（PM + executor，CCB信道）
   4a: PM本地设计（参考knowledge agent查询结果）
   4b: /ask executor 独立设计（executor可查询knowledge agent）
   4c: PM合并 → 生成TaskSpec JSON
       → PM写入knowledge_cache：task的设计决策摘要（written_by: PM）

5. PM调用rdloop
   bash $TOOLS_ROOT/run_rdloop_task.sh <task_spec.json>

6. rdloop coordinator接管
   ├── 创建worktree（git worktree add）
   │
   ├── [Coder阶段]
   │   auto:      call_coder_bridge.sh → coordinator spawn Claude CLI → 全自动执行
   │   semi-auto: call_coder_ccb.sh    → /ask附加到人类tmux session → 人可介入
   │   coder查询knowledge agent获取相关文件摘要（不全文搜索）
   │
   ├── test_cmd（bash执行，客观rc，不可绕过）
   │
   ├── [Judge阶段]
   │   auto:      call_judge_bridge.sh → coordinator spawn → 主动读worktree验证 → JudgeVerdict v2
   │   semi-auto: call_judge_ccb.sh    → /ask附加到人类session → 人可直接看到判断过程
   │
   ├── decision_table判定
   │   PASS → READY_FOR_REVIEW → final_summary.json（含knowledge_entries）
   │   FAIL + attempt<max → retry（带previous verdict + judge feedback）
   │   PAUSED → events.jsonl + questions_for_user
   │
   └── final_summary.json

7. run_rdloop_task.sh轮询 → 返回摘要给PM

8. PM处理结果
   READY_FOR_REVIEW:
     → write_knowledge_cache.py（从final_summary读knowledge_entries，written_by: executor）
     → 更新shared_contracts（interface_hash从knowledge_cache读取）
     → state_update.sh task done

   FAILED:
     → 标记task blocked
     → 报告用户（top_issues from verdict）

   PAUSED:
     auto模式 → coordinator自动重试或PAUSED_CRASH
     semi-auto模式 → GUI/Telegram展示pending状态
                  → 用户审批 → rdloop --continue
```

---

## 六、各体系调整关键点（v3.0）

### 6.1 Agent体系 — 5处修改

| 文件 | 修改内容 |
|------|----------|
| `rules/init.md` | session_state.json新增`shared_contracts`字段 |
| `skills/autoflow-run/SKILL.md` | FileOpsREQ→查询knowledge agent；Step5-9→rdloop调用；新增Step4c knowledge_cache写入；execution_mode决策 |
| `tools/run_rdloop_task.sh` | 新增：PM↔rdloop胶水脚本；READY_FOR_REVIEW时触发write_knowledge_cache.py |
| `tools/init_knowledge_agent.sh` | 新增：项目启动时初始化ka-session，从knowledge_cache.json加载知识 |
| `tools/write_knowledge_cache.py` | 新增：原子写入knowledge_cache.json；executor/PM两种writer模式 |

### 6.2 CCB — 零修改

`cask/gask --output --timeout --session-file`接口完全满足需求，不需要任何改动。

### 6.3 rdloop — 7处修改

| 文件 | 修改内容 |
|------|----------|
| `coordinator/lib/call_coder_bridge.sh` | 新增：auto模式（coordinator spawn，全自动） |
| `coordinator/lib/call_coder_ccb.sh` | 新增：semi-auto模式（附加到人类session） |
| `coordinator/lib/call_judge_bridge.sh` | 新增：auto模式（coordinator spawn，主动验证） |
| `coordinator/lib/call_judge_ccb.sh` | 新增：semi-auto模式（附加到人类session） |
| `coordinator/run_task.sh` | 按`execution_mode`路由adapter；新增`PAUSED_CODER_CCB_UNAVAILABLE` |
| `coordinator/gui/server.js` | 新增三个只读端点：`/api/project/tasks`、`/api/project/steps/:id`、`/api/knowledge` |
| `rdloop.config.json` | `default_execution_mode: "auto"`；`default_coder/judge: "bridge"` |

原有adapter（cursor/codex/mock）全部保留，不删除。

---

## 七、版本对照

| 体系 | 当前版本 | v3.0版本 | 主要变化 |
|------|----------|---------|----------|
| Agent体系 | v1.8.0 | v1.9.0 | shared_contracts + knowledge agent查询 + autoflow-run精简 + knowledge_cache写入 |
| CCB | 当前版本 | 无需升级 | — |
| rdloop | p0-stability | p0-stability + 7个新文件 | adapter对调修正 + GUI聚合视图 + knowledge_cache集成 |
