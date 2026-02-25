# CCB 协作模式使用指南

本文档面向使用 CCB（Cursor Codex Bridge）与 rdloop 进行 semi-auto 协作的用户，说明如何启动 CCB、配置角色、处理注入冲突，以及完成一次完整的 semi-auto 工作流。

---

## 1. CCB 启动

在 semi-auto 模式下，rdloop 不会自动启动 Coder/Judge，而是连接到你在本机已启动的 CCB 进程（cask/gask）。因此需要先在终端里启动 CCB，并确认各 AI 提供方在线。

### 1.1 使用 tmux 保持会话（推荐）

在终端中执行：

```bash
# 新建一个名为 ccp 的 tmux 会话（便于以后重新连回）
tmux new -s ccp

# 进入你的项目目录（替换为实际路径）
cd /path/to/your/project

# 启动 CCB，并指定要使用的 AI 提供方（例如 codex 与 gemini）
ccb codex gemini
```

说明：
- `tmux new -s ccp`：创建一个名为 `ccp` 的 tmux 会话，即使关闭终端窗口，CCB 仍在后台运行。
- `ccb codex gemini`：启动 CCB，并启用 codex 与 gemini 两个 provider；可按需改为其他组合（如只写 `ccb codex`）。

### 1.2 验证各 provider 是否在线

在**同一台机器**上另开一个终端（或 tmux 的另一个 pane），执行：

```bash
# 验证 codex 是否在线（约 3 秒内应有响应）
cask --timeout 3 ping

# 验证 gemini 是否在线（若已安装 gask）
gask --timeout 3 ping
```

预期输出示例（codex 正常时）：

```
pong
```

若长时间无输出或报错，说明该 provider 的 daemon 未就绪，需回到运行 `ccb codex gemini` 的终端检查是否有错误，或重新执行 `ccb codex gemini`。

### 1.3 小结

- 先在一个终端（建议 tmux）里执行 `ccb codex gemini`（或你需要的 provider 组合）。
- 用 `cask ping` / `gask ping` 在本地确认各 provider 在线后，再在 rdloop GUI 中运行 execution_mode 为 **semi-auto** 的任务。

---

## 2. 角色配置

在协作模式下，每个“角色”（如 executor、reviewer、designer、inspiration）会由不同的 AI provider 负责。角色与 provider 的对应关系写在 Agent 目录下的 **collab_context.md** 中。

### 2.1 角色表在哪里

文件路径（在 Agent 项目下）：

```
Agent/.context/rules/collab_context.md
```

其中有一段 **Role Assignment (canonical)** 表格，例如：

```markdown
| role        | provider | scope                                                         |
|-------------|----------|---------------------------------------------------------------|
| PM          | claude   | sole authority: task assignment, status updates, user reports |
| designer    | claude   | plan/architecture — PM may hold this role concurrently        |
| inspiration | gemini   | brainstorming only — output is reference, never inserted      |
| reviewer    | codex    | scored quality gate via Rubrics below                         |
| executor    | claude   | code implementation                                           |
```

- **PM** 固定为 claude，不可修改。
- 其他角色（designer、inspiration、reviewer、executor）的 **provider** 列可以按需修改。

### 2.2 如何修改角色对应的 provider

只改 **provider** 列，其他列和表格格式不要动。例如把 reviewer 从 codex 改为 gemini：

**修改前：**

```markdown
| reviewer    | codex    | scored quality gate via Rubrics below                         |
```

**修改后：**

```markdown
| reviewer    | gemini   | scored quality gate via Rubrics below                         |
```

保存文件后，下次 PM 通过 /ask 分配任务时就会按新配置选用 provider。若 rdloop GUI 已提供「角色配置」面板（Settings 内），也可在界面中选择 provider 并保存，效果与直接编辑该表格一致。

### 2.3 允许的 provider 取值

通常可使用：`claude`、`codex`、`gemini`、`opencode`、`droid`（具体以 collab_context.md 与当前环境为准）。

---

## 3. 注入冲突处理

CCB 安装或升级后，可能会在以下文件中插入配置块：

- `~/.claude/CLAUDE.md`
- `~/.local/share/codex-dual/AGENTS.md`
- `~/.local/share/codex-dual/.clinerules`

这些注入内容会与 Agent 体系通过 **collab_context.md** 下发的角色与规则冲突。Agent 提供脚本 **ccb_guard.sh** 用于检测并清理这些注入。

### 3.1 检测是否已有注入

在终端执行（需在 Agent 目录下，或设置好 `TOOLS_ROOT` / `AGENT_ROOT`）：

```bash
bash Agent/.context/tools/ccb_guard.sh --check
```

- 若输出 **OK: No CCB injection blocks found.**，表示当前没有注入，无需清理。
- 若输出 **FOUND: CCB ... block in &lt;文件路径&gt;**，表示存在注入，需要执行清理。

示例（发现注入时）：

```
FOUND: CCB config block in /Users/you/.claude/CLAUDE.md
FOUND: CCB roles block in /Users/you/.local/share/codex-dual/AGENTS.md

Run without --check to remove the above blocks.
```

### 3.2 一键清理注入

确认需要清理后，执行（不加 `--check`）：

```bash
bash Agent/.context/tools/ccb_guard.sh
```

脚本会删除上述文件中的 CCB 注入块，并输出类似：

```
REMOVED: CCB config block from /Users/you/.claude/CLAUDE.md
REMOVED: CCB roles block from /Users/you/.local/share/codex-dual/AGENTS.md

Done. Agent body (collab_context.md) is now the sole source of role/rubric content.
```

之后 Agent 体系以 **collab_context.md** 为唯一来源，不再受 CCB 文件注入影响。若 rdloop GUI 的 Settings 中提供「CCB 注入检测」与「一键清理」，也可在界面中完成检测与清理。

---

## 4. semi-auto 工作流

semi-auto 表示：任务由 rdloop 协调，但 Coder/Judge 实际由你本机已启动的 CCB（cask/gask）执行，你可以在同一台机器上观察或干预。

### 4.1 前置条件

1. **CCB 已启动**：在 tmux（或前台终端）中已执行 `ccb codex gemini`（或你需要的 provider），且 `cask ping` / `gask ping` 正常。
2. **rdloop 配置**：在 rdloop 的 Settings 中已设置 **Agent 目录**（agent_root）和 **默认执行模式** 为 semi-auto（或该任务单独设为 semi-auto）。
3. **任务定义**：任务规格（TaskSpec）中 `execution_mode` 为 `semi-auto`。

### 4.2 典型操作顺序

1. **启动 CCB**（见第 1 节）  
   ```bash
   tmux new -s ccp
   cd /path/to/project
   ccb codex gemini
   ```

2. **（可选）在 Agent/PM 中分配任务**  
   若使用 Agent 体系，由 PM 分配任务、状态与 /ask 发送。

3. **在 rdloop 中创建并运行任务**  
   - 在 rdloop GUI 的 Task Specs 中选择或创建 `execution_mode: semi-auto` 的任务。  
   - 或使用脚本触发一次运行，例如（具体脚本名以项目为准）：  
     ```bash
     bash run_rdloop_task.sh <task_id>
     ```
   - 任务会通过 coordinator 调用本机的 cask/gask，而不是由 rdloop 自建 bridge。

4. **（semi-auto 下）获取待处理结果**  
   若流程中有“等待人工确认”的步骤，可通过 Agent/CCB 的 **/pend** 或等价方式获取待处理项，处理后再继续。

5. **任务完成**  
   当 Judge 通过或达到结束条件后，任务在 rdloop 中会变为 READY_FOR_REVIEW 或 FAILED，可在 GUI 中查看 attempts、timeline 与日志。

### 4.3 TaskSpec 中 execution_mode 示例

在任务 JSON 中显式指定 semi-auto：

```json
{
  "task_id": "my_semi_auto_task",
  "execution_mode": "semi-auto",
  "goal": "Implement feature X",
  "coder": "codex-cli",
  "judge": "codex-cli",
  ...
}
```

这样该任务会使用本机已启动的 CCB，而不是全自动模式下的 bridge。

---

## 附录：命令速查

| 目的           | 命令 |
|----------------|------|
| 启动 CCB       | `ccb codex gemini`（在项目目录下） |
| 验证 codex     | `cask --timeout 3 ping` |
| 验证 gemini    | `gask --timeout 3 ping` |
| 检测注入       | `bash Agent/.context/tools/ccb_guard.sh --check` |
| 清理注入       | `bash Agent/.context/tools/ccb_guard.sh` |
| 角色配置编辑   | 编辑 `Agent/.context/rules/collab_context.md` 中 Role Assignment 的 provider 列 |

以上命令均可在 mac-mini 环境中执行；路径请按实际安装位置调整（如 Agent 目录、项目目录）。
