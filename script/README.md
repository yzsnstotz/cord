# Cord scripts

## CCB 启动流程（当前启动路径说明）

### 能否完全靠 GUI 启动？是否需要命令行？

- **可以完全靠 GUI 启动**，前提是：
  - 已安装 **tmux**（如 `brew install tmux`）；
  - 在 Rdloop 设置里配置好 **CCB 目录（ccb_path）**，指向含 `ccb` 脚本的 CCB 根目录；
  - **工作目录**（CCB 工作目录 / 项目路径）正确，且该目录下会有或已创建 `.ccb/`（及可选 `ccb.config`）。
- **不强制要求**先开命令行再点 GUI；但若希望 CCB 的 tmux 窗口**长期存在**且便于“打开终端”附加，推荐**先进入 tmux，再在 tmux 里用 GUI 或命令行启动 CCB**（见下）。

### 启动路径一：仅用 GUI（Rdloop CCB 面板）

1. 打开 Rdloop GUI，进入 **CCB** 视图（CCB 会话面板）。
2. 确认 **设置** 里：
   - **CCB directory (ccb_path)** 已填并保存（例如 `/path/to/Cord/CCB`）；
   - 可选：**CCB 工作目录** 与 **项目路径** 一致或按需设置。
3. 在 CCB 面板中：
   - 选择要启用的 provider（或勾选「使用当前配置启动」用的 `ccb.config` 里的 providers）；
   - 点击 **「启动」**（单个 provider）或 **「启动 Codex + Gemini」/「启动全套」** 或 **「使用当前配置启动」**。
4. 后端行为：
   - GUI 调用 `POST /api/ccb/session/start`，在**无 TMUX 环境**下执行：  
     `python3 <ccb_path>/ccb <providers...>`，并设置 **CCB_GUI_LAUNCH=1**。
   - CCB 检测到不在 tmux 内且 `CCB_GUI_LAUNCH=1`，会**自动新建一个 tmux session**（名如 `ccb_<pid>`），在该 session 里跑 CCB；因此会弹出一个**新 tmux 窗口**（或先起 tmux 再跑 ccb）。
   - 若 2 秒内能列出 `ccb_*` session 且 ping 成功，GUI 会显示各 provider 为「已启动」；否则可能提示「在终端中运行 ccb」。
5. 之后：
   - 点 **「Attach」/「打开终端」**：GUI 会尝试 `tmux attach -t <session_name>` 打开终端；若此时 CCB 已退出（例如你在 CCB 的 tmux 里按了 Enter 退出），session 已不存在，就会报 **「Session not running」/「未启动」**。
   - 因此：**仅用 GUI 启动时，CCB 进程和 tmux session 是同生命周期的**；退出 CCB 后 session 被关，再点「打开终端」就会失败。

### 启动路径二：先 tmux，再在 tmux 里启动（推荐，便于长期使用）

1. 在终端执行：`tmux`（进入 tmux）。
2. 在**该 tmux 里**任选一种方式启动 CCB：
   - **方式 A（命令行）**：  
     `cd <项目或工作目录>`，然后  
     `python3 /path/to/CCB/ccb codex gemini opencode claude`  
     或只起一个：`python3 /path/to/CCB/ccb codex`  
     或不写 provider、用配置：`python3 /path/to/CCB/ccb`（会读 `.ccb/ccb.config` 或 `~/.ccb/ccb.config` 的 `providers`）。
   - **方式 B（GUI）**：在 Rdloop CCB 面板点「在终端中启动」或「使用当前配置启动」等；若 GUI 调的是 **open-terminal**（打开系统终端并执行 ccb），则会在**新开的终端窗口**里执行 `cd <work_dir> && ccb <providers>`，该窗口通常**不在**你当前的 tmux 里。
3. 若用**方式 A**，CCB 的多个 pane（Codex、Gemini、Claude 等）都会出现在**当前 tmux session** 里；关闭 CCB（或退出 anchor pane）后，只要不关 tmux，session 仍在；但 **CCB 进程退出后，askd 也会随 CCB 退出**，所以「未启动」指的是 CCB 没在跑，不是 tmux 没了。
4. 若用 **GUI「在 WezTerm 中启动 CCB」**：会在 WezTerm 新窗口里执行 ccb，不依赖 tmux；CCB 在 WezTerm 内管理多 pane。

### 启动路径三：GUI「打开终端」/ Attach（不新起 CCB，只附加已有会话）

1. 当**已经**有一个在跑的 CCB 实例时（例如通过路径一或二启动过，且未退出）：
   - GUI 通过 `~/.ccb/run/ccb-<cwd_hash>.lock` 和 PID 检测到 `ccb_instance.running === true`，并尝试解析其 tmux session 名。
2. 点击 **「Attach」** 或 **「打开终端」**：
   - 若有 session 名：会新开一个系统终端（如 Terminal.app），执行 `tmux attach -t <session_name>`，让你看到 CCB 的 tmux。
   - 若 CCB 已退出，lock 被清掉或 PID 已死，GUI 会显示「未运行」或「Session not running」。

### 小结表

| 方式           | 是否必须用命令行 | 说明 |
|----------------|------------------|------|
| 仅 GUI「启动」 | 否               | 需 tmux + ccb_path；CCB 会自建 `ccb_<pid>` session；退出 CCB 后 session 消失，再 Attach 会报 Session not running。 |
| 先 tmux 再 ccb | 推荐             | 在 tmux 里手敲 `ccb` 或由 GUI 在「当前终端」里跑 ccb，窗口稳定、便于 Attach。 |
| GUI「打开终端」| 否               | 仅附加已有 CCB 的 tmux session；若 CCB 已退出则无效。 |
| WezTerm 启动   | 否               | 不依赖 tmux，在 WezTerm 内多 pane。 |

用 `script/ccb-agent-status.sh` 可随时查看：askd 是否在跑、是否有 `ccb_*` session、当前目录下是否有 `.ccb` session 文件。

---

## ccb-agent-status.sh

检查 CCB（Claude Code Bridge）coding agent 与各后端的真实运行状态。

### 用法

```bash
./ccb-agent-status.sh              # 文本摘要
./ccb-agent-status.sh --json       # JSON 输出
./ccb-agent-status.sh --ping       # 同时 TCP ping askd（较慢）
./ccb-agent-status.sh /path/to/project   # 指定项目目录检查 .ccb 下的 session 文件
```

### 检查项

- **Unified askd**：单一进程，状态文件 `~/.cache/ccb/askd.json`，是否存活（PID）、可选 TCP ping。
- **Legacy 各后端 daemon**：caskd / gaskd / oaskd / laskd / daskd（若存在对应 state 文件）。
- **Tmux**：当前是否在 tmux 内、是否存在名为 `ccb_*` 的 session。
- **项目 session 文件**：当前目录（或指定目录）下 `.ccb/` 或 `.ccb_config/` 中的 provider session 文件。

### 你遇到的情况说明

1. **服务是否真的启动了？**  
   脚本会区分：
   - **Unified askd 在跑**：会看到 `askd` 的 state 文件存在、PID 存活，Summary 里写 “askd is running”。这时所有后端（codex/gemini/opencode/claude/droid）都由这一个 daemon 提供服务。
   - **Legacy 模式**：若存在 `caskd.json` 等并对应进程在跑，脚本会显示该 provider 的 `running=yes`。

2. **“Session not running” / “未启动”**  
   - CCB 若在**非 tmux 环境**下启动，会先自动起一个 **一次性** tmux session（名字如 `ccb_<pid>`），在里面跑 CCB；等你按 Enter 退出后，整个 CCB 进程退出，**该 session 会被关掉**，所以之后再点“打开终端/查看窗口”就会看到 session 已不存在、状态“未启动”。
   - **正确用法**：先在终端里执行 `tmux` 进入 tmux，再在**该 tmux 里**运行 `ccb [providers...]`，这样 CCB 的窗口都在当前 tmux 里，不会在退出时整 session 消失。  
   - 用本脚本可确认：`Inside tmux`、`CCB sessions` 以及 askd 是否在跑。

3. **为什么只选了某一个模型却所有模型都启动了？**  
   - 若启动命令或 `ccb.config` 里配置的 `providers` 是多个（例如 `codex, gemini, opencode, claude, droid`），CCB 会按配置**全部**启动这些后端（每个一个 tmux pane）。  
   - 若希望只起一个，需要**只传一个 provider**，例如：`ccb codex` 或 `ccb claude`，或在项目/全局的 ccb 配置里把 `providers` 改成只包含你要的那一个。

4. **`droid` 报 “command not found”**  
   - 启动 Droid 后端时，CCB 会去执行名为 `droid` 的命令；若 PATH 里没有该命令就会报错。  
   - 要么在 PATH 里安装/配置好 `droid`，要么不在 providers 里包含 `droid`（例如只配 `codex, gemini, opencode, claude`）。

### 查看 CCB 的 tmux 窗口

- 在**已经运行 CCB 的 tmux 里**：
  - `tmux list-windows` / `tmux list-panes` 可看当前 session 的窗口与 pane。
  - 用 `tmux switch-client -t ccb_xxx` 只能切换到**仍存在**的 `ccb_xxx` session；若 CCB 已退出，该 session 已不存在，就会报 “session not running”。
- 用本脚本的 `--json` 可看到当前存在的 `ccb_sessions` 列表，以及 askd 是否在跑，从而判断“未启动”是因为 session 已关，还是 daemon 没起。
