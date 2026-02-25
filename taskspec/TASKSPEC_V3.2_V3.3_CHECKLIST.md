# Taskspec v3.2 / v3.3 完成情况检查

目标路径：Agent=./Agent，Rdloop=./Rdloop，CCB=./CCB。  
若 v3.3 中某功能在 v3.2 或后续 v3.4 已实现，则确认后跳过。

---

## v3.2 任务（taskspec_v3.2.json）

| Task ID | 标题 | 状态 | 说明 |
|---------|------|------|------|
| P07 | GUI — CCB 健康检测端点 + 状态指示 | ✅ 已完成 | GET /api/ccb/status 存在；banner 与 session-status 集成 |
| P08 | GUI — Agent 角色配置读写（collab_context.md） | ✅ 已完成 | GET/PUT /api/agent/roles 存在 |
| P09 | GUI — CCB Guard 状态检测与一键清理 | ✅ 已完成 | GET /api/ccb/guard-status、POST /api/ccb/guard-clean |
| P10 | rdloop.config.json — agent_root + GUI Settings | ✅ 已完成 | agent_root、default_execution_mode 等 |
| P11 | 文档 — CCB 启动与协作模式使用指南 | ✅ 已完成 | Agent/docs/ccb_collab_guide.md、Rdloop README 协作模式章节 |

**结论**：v3.2 全部任务已在代码/文档中实现，无需重复执行。

---

## v3.3 任务（taskspec_v3.3.json）

| Task ID | 标题 | 状态 | 说明 |
|---------|------|------|------|
| P12 | CCB Session 启动修复 — 使用 CCB 原生入口 | ✅ 已完成 | POST /api/ccb/session/start 已改为 spawn python3 ccb；strip TMUX env（P20）已做 |
| P13 | 任务创建表单 — execution_mode 与 collab 配置 | 需核对 | 表单是否有 execution_mode 下拉、collab_roles 写入 TaskSpec |
| P14 | Adapter 选择器重构 — 区分 Agent CLI 与 CLIProxyAPI | 需核对 | 是否两层选择器（信道类型 → 具体配置） |
| P15 | 任务创建表单 UX — 结构化控件替代 JSON 编辑 | 需核对 | 常用字段是否独立控件、JSON 是否在「高级」 |
| P16 | Coordinator — 读取 collab_roles 并路由 adapter | 需核对 | run_task.sh / call_coder_ccb.sh 是否读 collab_roles |
| P17 | TaskSpec Schema 升级 — execution_mode、collab_roles、channel_type | ✅ 已完成 | schemas/task_spec.json 含 execution_mode、collab_roles、channel_type |
| P18 | CCB Session 文件链路 — worktree 中 session 文件 | ✅ 已完成 | call_coder_ccb.sh / call_judge_ccb.sh 从 repo_path/.ccb/ 读 session（P18 注释在代码中） |
| P19 | Settings 面板优化 — 默认执行模式联动与 adapter 说明 | 需核对 | execution_mode 单选、semi-auto 时 CCB 检测提示 |

**结论**：P12 及 P20（strip TMUX、open-terminal 感知已有实例）已实现。P13–P19 需在代码中逐项确认；若已实现则标记完成，未实现则按 v3.3 规范补全。

---

## v3.4 已做且与「codex 打不开」相关的修复

- **P20**：session/start 的 spawn env 已 strip TMUX/TMUX_PANE/WEZTERM_PANE；open-terminal 已检测已有 CCB 实例并 attach。
- **CCB**：CCB_GUI_LAUNCH=1 时允许无 TTY 下自动创建 tmux 会话（execv 到 tmux new-session）。
- **GUI**：启动后多次轮询 session-status（2/4/6/8s）；自动打开终端改为按 session_name attach；CCB 面板增加「终端选项：tmux 与 WezTerm」说明与「在 WezTerm 中运行」按钮；故障排除提示（若启动无反应用「在终端中运行」、若已有实例则先 attach 或停止全部）。

---

## 建议的下一步

1. **WezTerm**：已在 CCB 面板增加说明与「在 WezTerm 中运行 Codex」按钮及 POST /api/ccb/session/open-wezterm。
2. **codex/agent 打不开**：若仍出现「类似信息就退出」，请提供具体报错或终端输出（例如是否为 "CCB must run inside tmux or WezTerm" 或 "Another ccb instance is already running"），便于针对性修。
3. **v3.3 未确认项**：在 Rdloop 与 Agent 代码库中 grep execution_mode、collab_roles、channel_type、call_coder_ccb 的 repo_path/.ccb/ 等，逐项确认 P13–P19 实现情况并更新本表。
