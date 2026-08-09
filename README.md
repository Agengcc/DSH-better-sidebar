# dsh-better-sidebar

> DeepSeek Harness Web GUI 的 **VSCode 风格右侧侧边栏**插件 —— 文件管理、编辑预览、真实终端、Git 面板，一个面板全部搞定。

<img width="411" height="274" alt="sidebar screenshot 1" src="https://github.com/user-attachments/assets/d3914fa3-c3d8-4988-8500-af5a901c3cd9" />
<img width="257" height="259" alt="sidebar screenshot 2" src="https://github.com/user-attachments/assets/40f511c7-5542-468a-bdee-1572419df8ca" />

## 为什么用它

- **⚡ 工作流不断档**：编辑文件、跑终端、看 Git 状态、拖 Tab 分栏对比，全在对话旁边完成，无需切窗口
- **🧠 按会话记忆与隔离**：每个 conversation 拥有独立的布局、分栏、Tab 与目录展开状态，切换会话即切换整套工作台
- **🎨 与 GUI 浑然一体**：完全复用 DSH 主题变量与官方组件，明暗主题自适应，观感就是原生的

---

## ✨ 功能一览

### 🗂️ 文件资源管理器

- 懒加载目录树，根目录 = 当前会话工作目录（cwd）；目录优先、隐藏文件变暗、每层 1000 项上限
- 点击文件在侧边栏打开编辑器；刷新按钮重载
- **悬浮行尾 `@文件` 按钮**：一键把 `@相对路径` 追加到输入框草稿（如 `@src/main.ts`），引用文件不再手打路径
- **右键行 → 复制相对地址 / 复制绝对地址**，复制成功行内短暂显示"已复制"

### 📝 文件编辑与预览

- **CodeMirror 6**：自动换行 + 按扩展名语法高亮（js/ts/jsx/tsx、json、python、html、css、xml、yaml、sql、java、c/c++、rust、go、php、shell、toml、nginx、dockerfile、properties…）
- 脏点标记 + **Ctrl/Cmd+S 保存**（原子写入）；512KB 截断横幅、二进制文件提示
- 图片直接预览；**Markdown 预览/编辑切换**，预览实时渲染未保存草稿
- 切换 Tab 不卸载：编辑器保留草稿与撤销栈

### 💻 终端

- xterm.js + node-pty **真实 shell**，每会话最多 3 个
- **Tab 打开期间一直保活**：切换 Tab/分栏、切换会话（30 秒内返回）、刷新页面都重连到同一个 shell 进程并回放转录
- 真正关闭 Tab 立即释放配额；连续失败停止重连并显示原因与重试按钮

### 🌿 Git 面板

- status 暂存/未暂存分组、按文件 diff（HEAD vs 工作区/暂存区）、stage/unstage（单个与全部）、commit、分支切换、提交历史

### 🧩 VSCode 式分栏工作台

- **拖 Tab 到分栏边缘**（左/右/上/下）即拆分新分栏，拖到中间合并，拖到另一个 Tab 上插入其前
- 分隔线拖拽调整比例；面板宽度从左侧缘拖拽；折叠滑出隐藏 + 全屏展开

### 📑 Tab 栏

- **Tab 与 `+` 菜单均带类型图标**（文件夹 / 分支 / 终端 / 代码文件）
- `+` 菜单新建 Explorer / Git / 终端（终端受 3 个上限约束）；**中键点击关闭 Tab**
- 空分栏显示可打开类型卡片，点击即开

### 🔁 会话隔离与状态自愈

- 布局/分栏/Tab/目录展开按会话持久化（localStorage），切换会话即切换整套状态
- **陈旧状态自动净化**：结构校验、宽度钳制视口、损坏的重复 id 自动重新编号——刷新后分栏与新生成的 id 永不冲突，不会出现"文件开进两个分栏"
- 侧边栏**占用布局**（挤窄对话列而非悬浮遮挡，动画过渡）
- 拦截对话"产出文件"行：点击改为在侧边栏打开，而不是系统默认程序

### 🎨 界面风格

- 行/按钮/间距/动效对齐应用自身组件：34px 圆角树行、28px 圆形图标按钮、挂载淡入
- 键盘焦点可见（focus-visible 环）、`prefers-reduced-motion` 下关闭全部动画

## ⌨️ 快捷键速查

| 操作 | 按键 |
|---|---|
| 保存编辑 | `Ctrl/Cmd + S` |
| Git 提交 | `Ctrl + Enter` |
| 关闭 Tab | 鼠标中键 |
| 拆分分栏 | 拖 Tab 到分栏边缘 |
| 合并分栏 | 拖 Tab 到分栏中间 |
| 引用文件到输入框 | 悬浮行尾 `@文件` 按钮 |
| 复制文件路径 | 右键行 → 复制相对/绝对地址 |

---

## 🚀 快速开始

### 前置条件

- 已安装 DSH（`dsh web` 可运行），Node.js ≥ 20、pnpm ≥ 10
- DSH 源码 checkout 位于 `~/.dsh/source/current`（`@deepseek-ai/*` 类型依赖以 `link:` 指向它；若 checkout 在其他路径，修改 `package.json` 中对应的 `link:` 路径）

### 1. 克隆、安装、构建

```sh
git clone https://github.com/dsh-external/DSH-better-sidebar.git
cd DSH-better-sidebar
pnpm install
pnpm build        # 产物: lib/index.js (host) + lib/client.js (client)
```

### 2. 注册到 web profile

编辑 `~/.dsh/profiles/web/package.json`，在 `dependencies` 加入：

```json
"dsh-better-sidebar": "link:/绝对路径/DSH-better-sidebar"
```

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加插件行：

```yaml
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
```

然后安装依赖：

```sh
(cd ~/.dsh/profiles/web && pnpm install)
```

### 3. 重启 GUI 并刷新页面

```sh
pm2 restart dsh-web   # 或你自己的 dsh web 启动方式
```

浏览器**硬刷新**（Cmd/Ctrl+Shift+R）后，右侧出现侧边栏即安装成功。

### 更新

重新 `pnpm build`（host/client 双产物）→ `pm2 restart dsh-web` → 刷新页面；`link:` 引用无需重新 install。

## 🛠️ 开发

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest（单元 + 冒烟：真实 git/fs/node-pty 交互）
pnpm build       # tsc + tsdown → lib/index.js + lib/client.js
pnpm watch       # tsdown --watch（client bundle 热重建）
```

## 🏗️ 架构

一个 npm 包，host/client 双半结构（与 DSH monorepo 内 client 包同构）：

| 半 | 入口 | 职责 |
|---|---|---|
| host | `src/index.ts` → `lib/index.js` | cordis 插件：`/sidebar/api/*` JSON API、`/sidebar/file` 媒体路由、`/sidebar/ws/terminal` WebSocket；fs / git / pty 服务 |
| client | `src/client/index.tsx` → `lib/client.js` | 浏览器 bundle（`__ModuleLoader__.load` 闭包工厂）：portal 侧边栏 + 各视图 + turnTail 拦截 |

- 所有 API 携带 `sessionId`；cwd 权威值取自会话 header，会话未附加（页面加载竞态）时回退客户端摘要 cwd，再回退进程 cwd；终端按 `${sessionId}:${tabId}` 键控，重连时若权威 cwd 变化则重启 shell 到正确目录
- 路由与 `/api` 同款信任围栏（Host 头 loopback / `connection.trustedHosts`，`src/trust-fence.ts`，拷贝自 `@deepseek-ai/dsh-client-connection`，BSD-3-Clause）
- client 状态按会话持久化到 `localStorage`（`dsh-sidebar:v1:<sessionId>`），读取时结构校验 + 宽度钳制视口 + 重复 id 重新编号
- client bundle externals 仅模块表词条（react/cordis/ui-primitives 等），xterm/CodeMirror 等全部内联

## 🔐 安全边界

- 路由受 Host 头信任围栏保护（与 `/api` 一致；`0.0.0.0` 部署时由 `dsh web` 启动器动态派生的 LAN IP 列表生效）
- `fs.write` 仅文本写入、原子替换（临时文件 + rename）；`/sidebar/file` 仅限会话 cwd 内的媒体文件
- 提交/分支操作仅调用 git CLI，绝不设置 git 身份

## ⚠️ 已知限制（v1 非目标）

- Git 无 push/pull/fetch；无文件 watcher（手动刷新）
- 工具行内的文件打开按钮（核心代码）不可拦截，仅"产出文件"行被接管
- 终端 Tab **拖拽到另一分栏**时会重挂载（shell 重开）；切换 Tab / 切换会话（30 秒内返回）/ 刷新页面不会
- 仅验证 macOS（node-pty 预编译二进制平台相关）
