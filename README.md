# dsh-better-sidebar

> DeepSeek Harness Web GUI 的 **VSCode 风格右侧侧边栏**插件：文件管理、编辑预览、真实终端、Git 面板、Subagent 页面，一个面板全部搞定。

<img width="4632" height="2720" alt="image" src="https://github.com/user-attachments/assets/39d86636-7654-412f-86ea-c60a2d5f20f0" />

## ✨ 功能一览

- **🗂️ 资源管理器**：懒加载目录树（根 = 会话 cwd）、点击在侧边栏打开、行尾 `@文件` 按钮引用到输入框、右键复制相对/绝对路径
- **📝 编辑与预览**：CodeMirror 6 多语言高亮 + Ctrl/Cmd+S 原子保存；图片 / Markdown（预览/编辑切换）/ PDF / Word / Excel / PPT 内联预览，切换 Tab 不丢草稿
- **💻 终端**：xterm.js + node-pty 真实 shell（每会话 3 个 UI 上限），Tab 保活重连并回放转录；可选为模型注入 8 个 `terminal_*` 工具（agent 终端自动同步为 tab）
- **🌿 Git 面板**：真 diff 显示、VSCode 式 diff tab（首次自动下分栏）、懒加载历史、右键暂存/放弃/提交/还原/捡取
- **🧩 Subagent 页面**：主会话完整 agent 拓扑（分层树）、点击直达执行记录、运行中节点实时工具调用轮询、检测到新子代理自动展开
- **🧩 分栏工作台**：拖 Tab 到边缘拆分/中间合并、分隔线调比例、宽度拖拽、折叠 + 全屏
- **🔁 会话隔离**：布局/分栏/Tab 按会话持久化（localStorage），陈旧状态自动净化；拦截对话"产出文件"行改为在侧边栏打开
- **🎨 原生观感**：完全复用 DSH 主题 token 与官方组件，明暗自适应
- **⚙️ 声明式设置**：设置页「侧边卡片」分区按注册表实时渲染功能清单——小卡片网格（高亮 = 启用，勾选徽标钉在最右端），每项可独立开/关（tab 从 `+` 菜单消失、viewer 预览落到下一个匹配）；子代理/终端等二级设置经卡片齿轮按钮在原生弹窗中编辑；另有新会话默认打开、默认宽度占比
- **🔌 服务化**：暴露 `ctx.betterSidebar` 服务，其他插件可注册侧边栏 tab 与文件预览器（详见 [AGENTS.md](./AGENTS.md)）

## ⌨️ 快捷键

| 操作 | 按键 |
|---|---|
| 保存编辑 | `Ctrl/Cmd + S` |
| Git 提交 | `Ctrl + Enter` |
| 关闭 Tab | 鼠标中键 |
| 拆分/合并分栏 | 拖 Tab 到分栏边缘 / 中间 |
| 引用文件到输入框 | 悬浮行尾 `@文件` 按钮 |
| 复制文件路径 | 右键行 → 复制相对/绝对地址 |

## 🚀 安装（推荐：官方 profile）

前置：已安装 DSH（`dsh web` 可运行），Node.js ≥ 20、pnpm ≥ 10。

把下面提示词**整段**发给 DSH 即可自动完成克隆、构建、注册与安装：

```text
请帮我把 dsh-better-sidebar 插件安装到我的 web profile（插件 = VSCode 风格右侧侧边栏，仓库 https://github.com/dsh-external/DSH-better-sidebar）：

1. 克隆并构建：
   git clone https://github.com/dsh-external/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
   （@deepseek-ai/* 从 npm 解析（0.0.1-rc.? 预发布版）；若 401/404，用安装者自己的只读令牌配置 ~/.npmrc，或把 devDependencies 改回指向自己 ~/.dsh/source/current 的 link:，不要继续）
2. 注册到 web profile：
   a. ~/.dsh/profiles/web/package.json 的 dependencies 加 "dsh-better-sidebar": "link:<第 1 步克隆目录的绝对路径>"
   b. ~/.dsh/profiles/web/cordis.patch.yml 追加：
      - insert:
          - id: better-sidebar
            name: 'dsh-better-sidebar'
3. 在 ~/.dsh/profiles/web 执行 pnpm install
4. 重启 DSH 并硬刷新（Cmd/Ctrl+Shift+R）验证
```

> 安装 = 依赖登记（等价 `dsh plugin --profile web add link:<路径>`）+ 一行挂载行，与面板的渲染方式无关。**DSH 以 npm 包启动（如 `npx -p @deepseek-ai/dsh@0.0.1-rc.1 dsh web`）同样可用**（v0.4.3 起实测验证）。

### 更新

```text
1. cd ~/Code/DSH-better-sidebar && git pull && pnpm install && pnpm build
   （401/404 处理同上）
2. 核对注册仍有效（缺失才补）：profile package.json 的 link: 依赖 + cordis.patch.yml 挂载行
3. 仅 client（src/client/*）→ 硬刷新即可；含 host（src/index.ts、src/config.ts 等）→ 重启 DSH + 硬刷新
```

`link:` 引用下 `pnpm install` 无需重复执行（仓库已装即可）。

## 📦 通过 plugin-registry 安装（可选）

前置：DSH 已集成 [plugin-registry](https://github.com/dsh-external/plugin-registry)（`dsh registry` 可用）。**与官方 profile 安装二选一**——同时启用会双挂载（Node 半挂两次、页面两个侧边栏）。

```sh
git clone https://github.com/dsh-external/DSH-better-sidebar.git && cd DSH-better-sidebar
pnpm install && pnpm build
node scripts/package-registry.mjs   # 组装 registry/ 暂存（只含清单 + 产物 + README，不入库）
dsh registry install ./registry     # 安装（默认禁用）
dsh registry enable dsh-external/dsh-better-sidebar
```

更新：`git pull && pnpm install && pnpm build` → `node scripts/package-registry.mjs` → `dsh registry uninstall/install/enable`（同上三步）。切换通道前先移除另一通道的挂载（profile 的 link: 依赖与挂载行，或 `dsh registry uninstall`）。

## 🔌 服务化：注册 tab 与文件预览器

从 v0.4.0 起暴露 `ctx.betterSidebar` 服务，其他插件可注册侧边栏页面与文件预览器（内置 6 tab + 8 viewer 也走同一服务，吃自己的狗粮）：

```ts
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
}
```

完整接入文档（`TabDescriptor` / `FileViewerDescriptor` 全字段、匹配算法、HMR 陷阱、声明式设置）：见 [`AGENTS.md`](./AGENTS.md)。

## 🛠️ 开发与构建

```sh
pnpm install      # @deepseek-ai/* 从 npm 解析（^0.0.1-rc.1），需安装者自己的只读令牌：
                  # ~/.npmrc 配 //registry.npmjs.org/:_authToken=<自己的令牌>（勿写进仓库），
                  # 或改 devDependencies 为 link: 指向自己的 ~/.dsh/source/current
pnpm typecheck    # tsc --noEmit
pnpm build        # → lib/index.js + lib/invariant.js + lib/client.js + lib/client-registry.js + lib/types
pnpm test         # vitest（含 manifest 一致性守卫，需先 build）
pnpm watch        # tsdown --watch
```

运行期不依赖 npm / checkout：`@deepseek-ai/*` 声明在 `peerDependencies`，由 web profile 提供。

**规范符合性**：插件按 DSH 官方插件规范组织（参考 turtle-ui），无 default 导出（`name/inject/Config/apply`）；双 client bundle（官方通道 id = 包名 / registry 通道 id = 清单 id，`tests/manifest-consistency.spec.ts` 守卫）；已知偏差：侧边栏面板经 portal 挂载（`'root'` slot 由 ui-layout 独占，外部插件无整面板 slot）。

**架构**：单 npm 包、host/client 双半结构——host（`src/index.ts`）：`/sidebar/api/*` JSON API、`/sidebar/file` 媒体路由、`/sidebar/ws/terminal` WebSocket（fs / git / pty，全部会话级 + 信任围栏）；client（`src/client/index.tsx`）：portal 侧边栏 + 各视图 + turnTail 拦截；client 状态按会话持久化 localStorage；client bundle externals 仅平台模块表词条，xterm/CodeMirror 等内联。

## 🔐 安全

- 路由受 Host 头信任围栏保护（与 `/api` 一致）
- `fs.write` 原子写入；媒体路由仅限会话 cwd 内文件
- git 操作仅调用 git CLI，绝不设置 git 身份

## ⚠️ 已知限制

- Git 无 push/pull/fetch；无文件 watcher（手动刷新）；工具行内文件打开按钮不可拦截
- 终端 Tab 拖到另一分栏会重挂载（shell 重开）；切换 Tab / 会话 / 刷新不会
- `.xlsx` 预览不保留单元格样式（SheetJS 社区版限制）
- Office/PPTX 预览内联进 client bundle（约 23MB），首次加载较慢

## 🖥️ 平台支持

Windows / Linux / macOS 三平台适配（macOS 日常验证；其余经单元测试覆盖）；`node-pty` 优先预编译二进制，失败需编译工具链（Windows VS Build Tools / Linux make+g+++python3 / macOS Xcode CLT）。
