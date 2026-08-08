# dsh-better-sidebar

A DeepSeek Harness web plugin providing a **VSCode-like right sidebar** with a
file explorer, file editor/preview, an interactive terminal, and a source
control panel — **isolated per conversation session**.

- 右侧侧边栏（文件夹预览 / 文件编辑与预览 / 终端 / Git）——按会话记忆与隔离
- Explorer: 懒加载目录树，根目录 = 当前会话工作目录
- Editor: 文本编辑（脏点 + Ctrl/Cmd+S 保存）、图片查看、Markdown 预览
- Terminal: xterm.js + node-pty（每会话最多 3 个，进程跨刷新存活）
- Git: status / diff / stage / commit / branch / history（基础集）
- 分栏工作台: VSCode 式拖拽分栏（拖 Tab 到分栏边缘即左右/上下拆分，拖到中间合并）、
  分隔线拖拽、面板宽度拖拽；折叠后右缘展开按钮常驻
- Tab 栏: 最大宽度 160px、横向滚动、`+` 菜单新建 Tab
- 拦截: 对话"产出文件"行点击改为在侧边栏打开
- 样式完全复用 `--dsw-*` 主题变量与 `@deepseek-ai/dsh-client-ui-primitives`

## 架构

一个 npm 包，双半结构（与 DSH monorepo 内 client 包同构）：

| 半 | 入口 | 职责 |
|---|---|---|
| host | `src/index.ts` → `lib/index.js` | cordis 插件：`/sidebar/api/*` JSON API、`/sidebar/file` 媒体路由、`/sidebar/ws/terminal` WebSocket；fs / git / pty 服务 |
| client | `src/client/index.tsx` → `lib/client.js` | 浏览器 bundle（`__ModuleLoader__.load` 闭包工厂）：portal 侧边栏 + 各视图 + turnTail 拦截 |

- 所有 API 携带 `sessionId`；cwd 从会话存储取权威值；终端按 `${sessionId}:${tabId}` 键控。
- 路由与 `/api` 同款信任围栏（Host 头 loopback / `connection.trustedHosts`，`src/trust-fence.ts`，拷贝自 `@deepseek-ai/dsh-client-connection`，BSD-3-Clause）。
- client 状态按会话持久化到 `localStorage`（`dsh-sidebar:v1:<sessionId>`）：面板几何、分栏树、Tabs、树展开。
- client bundle externals 仅模块表词条（react/cordis/ui-primitives 等），xterm 等全部内联。

## 安装（web profile）

```sh
# 1. 构建
pnpm install && pnpm build

# 2. 全局 web profile 引用
#    ~/.dsh/profiles/web/package.json  dependencies:
#      "dsh-better-sidebar": "link:/Users/menghuan/Code/DSH-better-sidebar"
#    ~/.dsh/profiles/web/cordis.patch.yml  追加:
#      - id: better-sidebar
#        name: 'dsh-better-sidebar'

# 3. 安装依赖并重启 GUI
(cd ~/.dsh/profiles/web && pnpm install)
pm2 restart dsh-web   # 或你的 dsh web 启动方式
```

## 开发

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest（单元 + 冒烟：真实 git/fs 交互）
pnpm build       # tsc + tsdown → lib/index.js + lib/client.js
pnpm watch       # tsdown --watch（client bundle 热重建）
```

改完 host/client 后重新 `pnpm build`，再重启 `dsh-web` 生效。

## 依赖说明

- `node-pty` / `ws` / `xterm` / `@xterm/addon-fit` / `clsx`：npm 常规依赖（node-pty 使用随包预编译二进制，无源码编译）。
- pnpm 会剥离 node-pty 预编译 `spawn-helper` 的可执行位（`posix_spawnp failed`）；插件启动时自动恢复（
  `ensureSpawnHelper`，与 `@deepseek-ai/dsh-pty-local` 的 postinstall 同思路，对 link 安装也生效）。
- `@deepseek-ai/*` 包仅以 `link:` 指向 `~/.dsh/source/current`（DSH 源码 checkout，构建产物已存在），仅用于类型；运行时只经模块表消费 `dsh-client-ui-primitives`。

## 安全边界

- 路由受 Host 头信任围栏保护（与 `/api` 一致；`0.0.0.0` 部署时由 `dsh web` 启动器动态派生的 LAN IP 列表生效）。
- `fs.write` 仅文本写入、原子替换（临时文件 + rename）；`/sidebar/file` 仅限会话 cwd 内的媒体文件。
- 提交/分支操作仅调用 git CLI，绝不设置 git 身份。

## 已知限制（v1 非目标）

- 文本编辑无语法高亮；Git 无 push/pull/fetch；无文件 watcher（手动刷新）。
- 工具行内的文件打开按钮（核心代码）不可拦截，仅"产出文件"行被接管。
- 侧边栏为悬浮面板（核心 AppFrame 无右侧插件位），不修改核心布局。
