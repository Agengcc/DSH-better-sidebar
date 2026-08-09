# dsh-better-sidebar

> DeepSeek Harness Web GUI 的 **VSCode 风格右侧侧边栏**插件 —— 文件管理、编辑预览、真实终端、Git 面板，一个面板全部搞定。

<img width="4632" height="2720" alt="image" src="https://github.com/user-attachments/assets/39d86636-7654-412f-86ea-c60a2d5f20f0" />
<img width="1000" height="1186" alt="image" src="https://github.com/user-attachments/assets/9dadffe0-0738-4b6d-b929-f452f51768a2" />

## 🚀 通过 plugin-registry 安装（标准）

前置条件：DSH 已集成 [plugin-registry](https://github.com/dsh-external/plugin-registry)（`dsh registry` 命令可用；集成步骤见其 README）。

```sh
git clone https://github.com/dsh-external/DSH-better-sidebar.git
cd DSH-better-sidebar
pnpm install && pnpm build          # 产物: lib/index.js + lib/invariant.js (host) + lib/client.js + lib/client-registry.js (client) + lib/types
node scripts/package-registry.mjs   # 组装 registry/ 暂存目录（只含清单 + 构建产物 + README，不入库）
dsh registry install ./registry     # 安装（默认禁用——信任边界）
dsh registry enable dsh-external/dsh-better-sidebar   # 启用
```

> **通道互斥**：registry 安装与下方「不依赖 plugin-registry 的官方 profile 安装」是同一插件的两种安装方式，**每个部署二选一**——同时启用会双挂载（Node 半挂两次、页面渲染两个侧边栏）。已用官方方式装过时，先移除 `~/.dsh/profiles/web/cordis.patch.yml` 里的 better-sidebar 挂载行与 `package.json` 的 `link:` 依赖，再走 registry。

### 更新（registry 通道）

```sh
cd DSH-better-sidebar && git pull && pnpm install && pnpm build
node scripts/package-registry.mjs
dsh registry uninstall dsh-external/dsh-better-sidebar
dsh registry install ./registry
dsh registry enable dsh-external/dsh-better-sidebar
```

## 🚀 一键安装（把提示词发给 DSH）

把下面提示词**整段**发给 DSH，它会自动完成克隆、构建、注册与安装（前置条件：已安装 DSH 且 `dsh web` 可运行，Node.js ≥ 20、pnpm ≥ 10）：

```text
请帮我把 dsh-better-sidebar 插件安装到我的 web profile（插件 = VSCode 风格右侧侧边栏，仓库 https://github.com/dsh-external/DSH-better-sidebar）：

1. 克隆并构建：
   git clone https://github.com/dsh-external/DSH-better-sidebar.git ~/Code/DSH-better-sidebar
   cd ~/Code/DSH-better-sidebar && pnpm install && pnpm build
   （若 pnpm install 因 @deepseek-ai/* 的 link: 依赖解析失败，说明 DSH 源码 checkout 不在 ~/.dsh/source/current —— 停下来告诉我，不要继续）
2. 注册到 web profile：
   a. 编辑 ~/.dsh/profiles/web/package.json，在 dependencies 中加入 "dsh-better-sidebar": "link:<第 1 步克隆目录的绝对路径>"
   b. 编辑 ~/.dsh/profiles/web/cordis.patch.yml，追加挂载行：
      - insert:
          - id: better-sidebar
            name: 'dsh-better-sidebar'
3. 在 ~/.dsh/profiles/web 目录执行 pnpm install
4. 全部完成后告诉我，我重启 DSH 并硬刷新（Cmd/Ctrl+Shift+R）验证
```

> 安装 = 把插件登记进 web profile 的依赖清单（等价于 `dsh plugin --profile web add link:<路径>`）+ 一行 cordis 挂载行，**与 portal 无关**——portal 只指侧边栏面板在页面上的渲染方式（见下文[规范符合性](#规范符合性)）。

### 更新（同样把提示词发给 DSH）

已安装过（`link:` 引用）时，把下面提示词**整段**发给 DSH 即可更新到最新版：

```text
请帮我更新 dsh-better-sidebar 插件（仓库在 ~/Code/DSH-better-sidebar，已通过 link: 安装到我的 web profile）：

1. 拉取最新代码并重新构建：
   cd ~/Code/DSH-better-sidebar && git pull && pnpm install && pnpm build
   （若 pnpm install 因 @deepseek-ai/* 的 link: 依赖解析失败，说明 DSH 源码 checkout 不在 ~/.dsh/source/current —— 停下来告诉我，不要继续）
2. 核对注册仍然有效（缺失才需要补）：
   a. ~/.dsh/profiles/web/package.json 的 dependencies 中含 "dsh-better-sidebar": "link:<仓库目录的绝对路径>"
   b. ~/.dsh/profiles/web/cordis.patch.yml 中含挂载行（id: better-sidebar, name: 'dsh-better-sidebar'）
   c. 若有缺失，补齐后在该 profile 目录执行 pnpm install
3. 完成后告诉我本次改动涉及 client 还是 host：
   - 仅 client（src/client/*）→ 我硬刷新（Cmd/Ctrl+Shift+R）即可
   - 含 host（src/index.ts、src/config.ts 等）→ 我需要重启 DSH 再硬刷新
```

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

- 完全对齐 DSH 原生 chrome：**无阴影**的扁平面板（`--dsw-specific-sidebar-fill` 表面 + hairline 边框）、原生 rail 圆形图标按钮、`interactive-bg-active` 选中填充、34px/14px 原生行规格
- 键盘焦点可见（focus-visible 环）、`prefers-reduced-motion` 下关闭全部动画

### ⚙️ Side card 设置（DSH 设置页）

- 设置页新增 **Side card（侧边卡片）** 分区，持久化到 DSH 用户设置文档：
  - **新会话默认打开**：新建会话是否自动展开侧边卡片（已存在的会话保持各自布局）
  - **默认宽度占比**：新建会话时侧边卡片占窗口宽度的百分比（20–60，默认 30）

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

## 🧰 手动安装与更新

不想用提示词时，也可以手动完成（等价于上面提示词的步骤）：

### 前置条件

- 已安装 DSH（`dsh web` 可运行），Node.js ≥ 20、pnpm ≥ 10
- **构建/类型检查**需要 DSH 源码 checkout 位于 `~/.dsh/source/current`（`devDependencies` 中的 `@deepseek-ai/*` 以 `link:` 指向它；若 checkout 在其他路径，修改 `package.json` 中对应的 `link:` 路径）。**运行期不依赖该 checkout**——`@deepseek-ai/*` 声明在 `peerDependencies`，由 web profile 提供

### 1. 克隆、安装、构建

```sh
git clone https://github.com/dsh-external/DSH-better-sidebar.git
cd DSH-better-sidebar
pnpm install
pnpm build        # 产物: lib/index.js + lib/invariant.js (host) + lib/client.js + lib/client-registry.js (client) + lib/types/*.d.ts
```

> 运行期依赖（cordis、react、`@deepseek-ai/dsh-client-*` 等）按官方插件清单规范声明在 `peerDependencies`——web profile 已内置全部 peer 依赖，安装本插件无需额外装包；`dependencies` 只保留插件自有的运行时依赖（node-pty、ws、xterm、CodeMirror、schemastery 等）。

### 2. 注册到 web profile

```sh
dsh plugin --profile web add link:/绝对路径/DSH-better-sidebar
```

（等价于手动把 `"dsh-better-sidebar": "link:<绝对路径>"` 写入 `~/.dsh/profiles/web/package.json` 的 `dependencies` 并 `pnpm install`。）

然后编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加插件挂载行（`dsh plugin` 只管理依赖清单，不写挂载行）：

```yaml
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
```

### 3. 重启 DSH 并刷新页面

重启 DSH（你的 `dsh web` 启动方式），浏览器**硬刷新**（Cmd/Ctrl+Shift+R）后，右侧出现侧边栏即安装成功。

### 更新

不想用提示词时手动更新（等价于[更新提示词](#更新同样把提示词发给-dsh)）：

```sh
git pull && pnpm install && pnpm build   # 在插件仓库目录执行
```

- 只改了 **client** 代码（`src/client/*`）→ 硬刷新页面即可（bundle 由服务器按请求读取）
- 改了 **host** 代码（`src/index.ts`、`src/config.ts` 等）→ 重启 DSH + 硬刷新

`link:` 引用无需重新 install。

### 通过 registry 安装（手动，与上面的官方方案二选一）

前置条件：`dsh registry` 命令可用（DSH 已集成 plugin-registry）。安装源是 `scripts/package-registry.mjs` 组装的 `registry/` 暂存目录——只含清单 + 构建产物 + README，避免把 `node_modules/`（本机 `link:` 符号链接、node-pty 二进制）与 `.git/` 一并装进 `<dshHome>/plugins`。

```sh
pnpm build                          # 先构建（产物见上）
node scripts/package-registry.mjs   # 组装 registry/（重新运行会整体重建）
dsh registry install ./registry     # 安装（默认禁用）
dsh registry enable dsh-external/dsh-better-sidebar
```

更新：

```sh
git pull && pnpm install && pnpm build
node scripts/package-registry.mjs
dsh registry uninstall dsh-external/dsh-better-sidebar
dsh registry install ./registry
dsh registry enable dsh-external/dsh-better-sidebar
```

- 只改了 **client** 代码 → 硬刷新页面即可（registry 通道的 bundle 由服务器按请求读取）
- 改了 **host** 代码 → 重启 DSH + 硬刷新
- 与官方方案的互斥见上文「通道互斥」说明

## 🛠️ 开发

```sh
pnpm typecheck   # tsc --noEmit
pnpm build       # rm -rf lib && tsc(声明) + tsdown → lib/index.js + lib/invariant.js + lib/client.js + lib/client-registry.js + lib/types
pnpm test        # vitest（单元 + 冒烟 + 插件形态 guard：真实 git/fs/node-pty 交互；manifest 一致性测试读取 lib/，需先 build）
pnpm watch       # tsdown --watch（client bundle 热重建）
```

### 规范符合性

插件按 DSH 官方插件规范组织（参考 [dsh-external/turtle-ui](https://github.com/dsh-external/turtle-ui) 与 mainline `packages/client/AGENTS.md`），并额外提供 plugin-registry 标准发布面（`dsh.plugin.json`）。**安装通道与渲染方式是两个独立概念**：安装走 profile 清单协议（`dsh plugin` / cordis.yml 行，见[一键安装](#一键安装把提示词发给-dsh)）**或** registry 通道（`dsh registry`，见[通过 plugin-registry 安装](#通过-plugin-registry-安装标准)），二者互斥；下面的 portal 条目只描述面板在页面上的渲染方式。

- **插件形态**：`export const name / inject / Config / apply`，无 default 导出；`tests/plugin-shape.spec.ts` 通过 `Loader.unwrapExports` 守卫该形态
- **清单**：`types` + `exports`（`.` / `./invariant` / `./client` / `./src/*` / `./package.json`）、`dshClient`（`platform: 'web'` + 信息性 `inject` 边）、peerDependencies、`engines`、`files` 产物明细、`prepare`（消费者侧 `tsdown`，git 安装可用）
- **client 契约**：仅导出 `apply`/`inject`（+ 类型）；store 为 `createSidebarStore()` 工厂，实例归 `apply` 所有；`src/invariant.ts` 伴生；client bundle 复刻官方 preset（externals = 平台模块表 + runtime/client 豁免、纯度门、CSS Modules 内联）
- **registry 形态（标准发布面）**：仓库根 `dsh.plugin.json`（原生清单：id `dsh-external/dsh-better-sidebar`、`main` = host 构建产物、`client.main` = registry client bundle、`contributes` 空声明）；`tests/manifest-consistency.spec.ts` 守卫清单与构建产物一致性（id 严格两段、version 与 package.json 同步、bundle id = 清单 id）
- **双 client bundle**：同一 `src/client/index.tsx` 构建出 `lib/client.js`（官方通道，id = 包名 `dsh-better-sidebar`）与 `lib/client-registry.js`（registry 通道，id = 清单 id）——两通道的 bundle-id 契约互不相同，各产出一份、同源不漂移；每个部署二选一（见安装章节「通道互斥」）
- **已知偏差**：侧边栏面板经 portal（`document.body` + `createRoot`）挂载而非 slot——官方 slot 系统的 `'root'` 由 ui-layout 独占声明，重复声明 fail loud，外部插件无整面板 slot 可用；与 shell 的集成点（`conversation.chat.turnTail`）走官方 chain-slot 机制

## 🏗️ 架构

一个 npm 包，host/client 双半结构（与 DSH monorepo 内 client 包同构）：

| 半 | 入口 | 职责 |
|---|---|---|
| host | `src/index.ts` → `lib/index.js` | cordis 插件（`Config` 为 schemastery schema，可调 readLimit/mediaLimit/listLimit/terminalsPerSession/reconnectGraceMs）：`/sidebar/api/*` JSON API、`/sidebar/file` 媒体路由、`/sidebar/ws/terminal` WebSocket；fs / git / pty 服务 |
| invariant | `src/invariant.ts` → `lib/invariant.js` | 包属 invariant 伴生（注册包名，无运行时断言） |
| client（官方通道） | `src/client/index.tsx` → `lib/client.js` | 浏览器 bundle（`__ModuleLoader__.load` 闭包工厂，id = 包名）：portal 侧边栏 + 各视图 + turnTail 拦截 |
| client（registry 通道） | `src/client/index.tsx` → `lib/client-registry.js` | 同一源码的 registry 版本（id = 清单 id `dsh-external/dsh-better-sidebar`，`dsh.plugin.json` 的 `client.main` 指向它） |
| manifest | `dsh.plugin.json`（仓库根；`scripts/package-registry.mjs` 组装 `registry/` 安装根） | registry 发布面：id / version / main / client.main；仅 registry 通道读取 |

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

## 🖥️ 平台支持

代码按 **Windows / Linux / macOS** 三平台适配（macOS 为日常验证平台；Windows/Linux 的平台分支经单元测试覆盖，建议真机冒烟）：

- 路径处理全部走 `node:path` 平台 API（列表拼接、`resolve`）；媒体路由的前缀检查与相对路径投影容忍混合分隔符，Windows 上大小写不敏感
- Windows 上终端 shell 为 `powershell.exe`；node-pty 的 spawn-helper 修复（pnpm 剥执行位）自动跳过 Windows
- `node-pty` 安装优先下载预编译二进制（`prebuild.js`，需网络），失败则源码编译——Windows 需 Visual Studio Build Tools，Linux 需 `make`/`g++`/`python3`，macOS 需 Xcode Command Line Tools；`pnpm-workspace.yaml` 已声明 `allowBuilds: node-pty: true`
- git 操作仅依赖 `git` 在 PATH（Windows 需 Git for Windows）
