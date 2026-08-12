# 子代理页后台命令区块（查看输出 + 强制终止）设计

> 2026-08-12 · v0.8.0

## 目标

Subagent 页面（当前树的主代理拓扑）在拓扑树下方同页显示**当前树全部会话**（主代理 + 子代理）的后台任务：

- 点击任务行展开输出面板，实时查看累积输出（运行中每 2s 轮询，页面不可见时暂停）；
- 运行中的任务行带两击确认的终止按钮；
- 不破坏模型契约：查看输出走**非消费 peek**，绝不推进 `task_output` 的读取游标、不置 `reported` 位。

## 数据流

```
bash/tool  run_in_background → ctx.tasks.start（owner = 执行 agent）
api-proxy  session/tasks 帧（TaskView[]，无输出）→ 客户端 tasksBySession 镜像
SubagentView 读镜像 → collectTreeTasks(树内会话) → 行渲染 / 展开面板
展开面板 → POST /sidebar/api/tasks.output（非消费 peek）→ ctx.tasks.peek
终止     → POST /sidebar/api/tasks.kill    → ctx.tasks.kill
```

## 关键决策

1. **非消费 peek 缝隙（harness 侧，跨仓库改动）**：现有 `TaskService.read()` 是单一消费游标——UI 读取会偷走模型 `task_output` 的字节（或读到空）。因此新增：
   - `BashProcess.peekOutput()`：非消费读自启动以来的全部缓冲（`readFrom(0)`，不推进 offset）；
   - `TaskHooks.peekOutput?()` + `TaskService.peek(id, caller)`：返回全量累积文本，**不消费、不标记 reported**；
   - tool-bash / tool-pwsh 在 background `TaskStart.run()` hooks 里接 `peekOutput`（复用 render 管线）。
   - 模型工具（tool-tasks 的 task_output/task_kill）零改动。
2. **列表不新增路由**：任务清单已由 harness 的 `session/tasks` 推送镜像提供，只加 `tasks.output` / `tasks.kill` 两个路由（信任围栏与其余路由一致）。
3. **访问围栏**：caller 由请求的 `sessionId` 现场解析 `ctx.agents.get(sessionId)`，注册表按 owner session id 拒绝 foreign 任务；未知/foreign 统一映射 404 `task-error`（不可区分存在性，与 api-proxy 的 view 保密一致）。
4. **展示范围 = 整棵树**：与页面作用域一致（拓扑即当前树）；树跨多会话时行尾显示属主标题。
5. **两击确认终止**：首次点击进入「再次点击确认」态（3s 自动解除），防止误杀长任务。
6. **输出上限**：路由按 `readLimit`（默认 512KB）截断并置 `truncated` 标记。

## 实施偏差

- 无。宿主不新增 `@deepseek-ai/*` 依赖（`ctx.tasks`/`ctx.agents` 走结构性镜像 + 运行时 `ctx.get`，可选服务降级 503）。

## 验证

- harness 单测：bash-local peek 不推进游标；tasks-local peek 幂等/不置 reported/围栏；tool-bash/pwsh 后台任务 peek 后 read 仍完整投递。
- 插件单测：tasks-routes（caller 解析、截断、404/503 降级）；subagent-tasks 纯函数；jsdom 视图（行渲染、展开取输出、两击终止、隐藏不轮询）。
- 集成（真实 dsh web）：启动 `run_in_background` bash → `/sidebar/api/tasks.output` 返回累积输出且模型 `task_output` 仍读到全部字节 → `/sidebar/api/tasks.kill` 后进程退出、任务结算 `killed (signal: SIGTERM)`、终态 peek 幂等。
