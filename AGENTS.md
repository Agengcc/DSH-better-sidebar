# dsh-better-sidebar 插件接入文档

> 面向**消费插件开发者**：如何让你的插件向 better-sidebar 注册新的侧边栏页面（tab）和文件类型预览器。

better-sidebar 从 v0.4.0 起暴露 `ctx.betterSidebar` 服务（Cordis context 属性），其他插件通过 `registerTab` / `registerFileViewer` 注册扩展点，返回 disposer 由 Cordis fiber 自动管理生命周期（HMR-safe）。

---

## 1. 服务定位

- **服务名**：`betterSidebar`（即 `ctx.betterSidebar`）
- **发布侧**：better-sidebar 的 client half（`src/client/index.tsx`，通过 `ctx.provide('betterSidebar', service)` 发布）
- **消费侧**：你的插件的 client half（`inject = ['betterSidebar', ...]`，然后 `ctx.betterSidebar.registerTab(...)`）
- **类型合并**：`declare module 'cordis' { interface Context { betterSidebar: BetterSidebarService } }` 由 `dsh-better-sidebar` 包导出；消费插件 `import type {} from 'dsh-better-sidebar'` 即触发类型合并

> ⚠️ **host 半不发布此服务**：`ctx.betterSidebar` 只在 client 侧存在。如果你的插件 host 半需要读 better-sidebar 状态，走 better-sidebar 自己的 HTTP/WS 路由（`/sidebar/api/*`），不走服务。

---

## 2. 消费插件的最小骨架

### 2.1 `package.json`

```jsonc
{
  "name": "my-plugin",
  "peerDependencies": {
    "cordis": "^4.0.0-rc.7",
    "dsh-better-sidebar": "workspace:*"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

- `dsh-better-sidebar` 必须声明为 **peerDependency**（不是 dependency，避免重复实例化）
- 标记 `optional: true` 让你的插件在 better-sidebar 未安装时也能加载（注册代码会因为 `ctx.betterSidebar` 为 undefined 而跳过）

### 2.2 client half 入口

```ts
// my-plugin/src/client/index.ts
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并

export const inject = ['betterSidebar', 'slots']  // 声明服务依赖

export function apply(ctx: Context): void {
  // 注册一个 sidebar tab
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      icon: <DbIcon />,
      order: 50,
      component: ({ ctx, scope, tab }) => <DbView sessionId={scope.sessionId} />,
    })
  )

  // 注册一个文件预览器
  ctx.effect(() =>
    ctx.betterSidebar.registerFileViewer({
      id: 'my-plugin:csv',
      exts: ['csv'],
      fetchStrategy: 'custom',
      load: async (path, scope) => parseCsv(await fetchCsvBytes(scope, path)),
      component: ({ customData, path }) => <CsvGrid data={customData} path={path} />,
    })
  )
}
```

> ⚠️ **构建期纯度门**：client bundle 禁止 value-import 别的插件代码（`tsdown.config.ts` 的纯度门会挡）。`import type {}` 会被擦除，**不触发门禁**——所以类型可以自由共享，运行时符号不行。所有运行时交互必须走 `ctx.betterSidebar` 的方法调用。

### 2.3 类型导入

```ts
import type { TabDescriptor, FileViewerDescriptor, BetterSidebarService } from 'dsh-better-sidebar'
```

类型定义在 `lib/types/client/service.d.ts`，通过 `package.json` 的 `./client/service` exports 子路径暴露。

---

## 3. Tab 注册 API

### 3.1 `TabDescriptor` 完整字段

```ts
interface TabDescriptor {
  /** 唯一 id；也是 SidebarTab.type 的值。建议带包前缀：'my-plugin:db'。 */
  id: string
  /** 标题（i18n 友好：传字符串或返回字符串的函数） */
  title: string | (() => string)
  /** 图标：ReactNode 或 (size: number) => ReactNode */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** + 菜单排序（升序）；默认 100。内置：explorer=10, git=20, subagent=30, terminal=40 */
  order?: number
  /** 从 + 菜单隐藏（editor/diff 用：由其他流程触发打开，不在菜单里） */
  hidden?: boolean
  /** + 菜单禁用判定（如 terminal 配额满） */
  available?: (state: SidebarState) => boolean
  /**
   * 去重键：openTab 时若已存在 dedupeKey 相同的 tab，则聚焦而非新开。
   * 返回 undefined 表示不去重（每次都新开）。
   * 内置策略：explorer/git/subagent 用 () => id（单实例）；editor 用 tab => tab.path；diff 用 tab => tab.id。
   */
  dedupeKey?: (tab: SidebarTab) => string | undefined
  /**
   * 自定义 tab 创建（minting SidebarTab + 状态 patch）。
   * 返回 null 拒绝创建。terminal 用它生成 terminal:<n> id 并递增 nextTerminal。
   * 省略时用默认 { id, type, title } + seed 里的 path/diff。
   */
  createTab?: (state: SidebarState) => { tab: SidebarTab; patch?: Partial<SidebarState> } | null
  /** 渲染函数 */
  component: (props: TabComponentProps) => ReactNode
}
```

### 3.2 `TabComponentProps`

```ts
interface TabComponentProps {
  ctx: Context                 // client cordis context
  store: SidebarStore          // better-sidebar 的状态 store（可调 reduce/openTab 等）
  scope: SessionScope          // { sessionId, cwd? }
  tab: SidebarTab              // 当前 tab 实例（含 id/type/title/path?/diff?）
  visible: boolean             // 是否是当前激活 tab 且面板打开（不可见时暂停轮询等）
  // 以下由内置 tab 使用，外部 tab 可忽略：
  expanded?: string[]          // explorer 的展开目录集
  onToggleDir?: (path: string) => void
  onReferenceFile?: (path: string) => void
  onOpenFile?: (path: string) => void
  onOpenDiff?: (tab: SidebarTab) => void
  onSubagentJump?: (childSessionId: string) => void
}
```

### 3.3 注册示例

**最简 tab**（单实例、+ 菜单可见）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:notes',
    title: 'Notes',
    icon: <NoteIcon />,
    order: 50,
    dedupeKey: () => 'my-plugin:notes',  // 单实例
    component: ({ scope }) => <NotesView sessionId={scope.sessionId} />,
  })
)
```

**多实例 tab**（每次新开、带自定义 id）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:doc',
    title: 'Doc',
    icon: <DocIcon />,
    order: 60,
    // 不设 dedupeKey：每次 openTab 都新开
    component: ({ tab, scope }) => <DocView docId={tab.id} sessionId={scope.sessionId} />,
  })
)
// 外部触发打开：
ctx.betterSidebar.openTab({ type: 'my-plugin:doc', title: 'Spec.md', id: 'doc:spec' })
```

**条件可见**（仅 git 仓库时显示）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:commits',
    title: 'Commits',
    icon: <CommitIcon />,
    order: 70,
    available: (state) => hasGitRepo(state),  // 返回 false 时 + 菜单显示为 disabled
    dedupeKey: () => 'my-plugin:commits',
    component: ({ scope }) => <CommitsView sessionId={scope.sessionId} />,
  })
)
```

### 3.4 内置 tab（不可重复注册）

| id | order | single | hidden | 用途 |
|---|---|---|---|---|
| `editor` | -1 | 否（按 path 去重） | 是 | 文件编辑/预览（由 openSidebarFile 触发） |
| `explorer` | 10 | 是 | 否 | 文件资源管理器 |
| `git` | 20 | 是 | 否 | Git 面板 |
| `subagent` | 30 | 是 | 否 | 子代理拓扑 |
| `terminal` | 40 | 否 | 否 | 终端（nextTerminal 自增） |
| `diff` | -1 | 否（按 id 去重） | 是 | 差异查看（由 GitView 触发） |

你的 `id` 不可与上述重复，否则 `registerTab` 抛 `"tab type \"X\" already registered"`。

---

## 4. FileViewer 注册 API

### 4.1 `FileViewerDescriptor` 完整字段

```ts
interface FileViewerDescriptor {
  /** 唯一 id：'image' / 'pdf' / 'my-plugin:csv' */
  id: string
  /** 小写无点的扩展名数组：['png','jpg']。[] = catch-all（仅最低优先级有效） */
  exts: readonly string[]
  /** 优先级（高优先）；默认 0。内置默认 0；catch-all code 用 -100；binary-download 用 -50 */
  priority?: number
  /** 字节获取策略 */
  fetchStrategy: 'none' | 'fsRead' | 'mediaUrl' | 'custom' | 'binary-download'
  /** 内容嗅探（覆盖 exts）：head 字节可用时，第一个 detect 返回 true 的 viewer 命中 */
  detect?: (path: string, head: Uint8Array) => boolean
  /** fetchStrategy='custom' 时的加载函数 */
  load?: (path: string, scope: SessionScope) => Promise<unknown>
  /** 渲染函数 */
  component: (props: FileViewerProps) => ReactNode
}
```

### 4.2 `FileViewerProps`

```ts
interface FileViewerProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  path: string
  title: string
  content?: string        // fetchStrategy='fsRead' 时
  truncated?: boolean     // fetchStrategy='fsRead' 时
  mediaUrl?: string       // fetchStrategy='mediaUrl' 时
  customData?: unknown    // fetchStrategy='custom' 时（load() 的返回值）
}
```

### 4.3 `fetchStrategy` 对照

| 策略 | 字节来源 | 传给 component 的字段 | 适用 |
|---|---|---|---|
| `none` | 不需要字节 | （无） | 自渲染（如纯 UI） |
| `fsRead` | `/sidebar/api` 的 `fs.read` | `content`, `truncated` | 文本类（CSV/JSON/XML） |
| `mediaUrl` | `/sidebar/file` 媒体路由 URL | `mediaUrl` | 图片/PDF/Office（viewer 自己 fetch 字节） |
| `custom` | viewer 的 `load()` 函数 | `customData` | 自定义协议（如远程拉取） |
| `binary-download` | 不预览，显示下载按钮 | （无） | 无客户端渲染器的二进制格式 |

### 4.4 匹配算法

`matchFileViewer(path, head?)` 按以下顺序解析：

1. **priority 降序**（稳定排序，相同 priority 按注册顺序）
2. **detect 嗅探**：若 `head` 字节可用，遍历 priority 降序的 viewer，第一个 `detect(path, head)` 返回 true 的命中（**覆盖 exts**）
3. **exts 匹配**：第一个 `exts` 含目标扩展名的 viewer 命中（`exts: []` 跳过此轮）
4. **catch-all**：第一个 `exts: []` 的 viewer 命中
5. **fallback**：返回 `undefined`，EditorView 走 CodeMirror 兜底（按扩展名选语法高亮）

> **内置 viewer**（不可重复注册）：image(0) / pdf(0) / docx(0) / xlsx(0) / pptx(0) / binary-download(-50)。
> code/markdown **没有**注册为 viewer，是 EditorView 的兜底逻辑（matchFileViewer 返回 undefined 时走 fsRead + CodeMirror/MarkdownText）。外部 viewer 注册同扩展名 + 更高 priority 即可覆盖。

### 4.5 注册示例

**CSV 预览器**（自定义加载 + 渲染）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:csv',
    exts: ['csv'],
    fetchStrategy: 'custom',
    load: async (path, scope) => {
      const text = await fetchText(scope, path)
      return parseCsv(text)
    },
    component: ({ customData, path }) => <CsvGrid rows={customData as string[][]} path={path} />,
  })
)
```

**覆盖内置 image viewer**（如想用自定义的 SVG 优化渲染）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:svg-pro',
    exts: ['svg'],
    priority: 10,  // 高于内置 image 的 0
    fetchStrategy: 'mediaUrl',
    component: ({ mediaUrl }) => <OptimizedSvg src={mediaUrl} />,
  })
)
```

**内容嗅探**（按 magic bytes 路由，忽略扩展名）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:magic-parquet',
    exts: [],  // catch-all，但 priority 高 + detect 精确命中
    priority: 100,
    fetchStrategy: 'custom',
    detect: (_path, head) => head.length >= 4
      && head[0] === 0x50 && head[1] === 0x41
      && head[2] === 0x52 && head[3] === 0x31,  // 'PAR1'
    load: async (path, scope) => parseParquet(await fetchBytes(scope, path)),
    component: ({ customData }) => <ParquetTable data={customData} />,
  })
)
```

---

## 5. 服务方法完整清单

```ts
interface BetterSidebarService {
  /** 注册 tab 类型；返回 disposer */
  registerTab(descriptor: TabDescriptor): () => void
  /** 注册文件预览器；返回 disposer */
  registerFileViewer(descriptor: FileViewerDescriptor): () => void
  /** 当前已注册的 tab 描述符快照（同步，供 useSyncExternalStore 用） */
  getTabs(): readonly TabDescriptor[]
  /** 当前已注册的 file viewer 描述符快照 */
  getFileViewers(): readonly FileViewerDescriptor[]
  /** 按 id 查 tab 描述符 */
  getTab(id: string): TabDescriptor | undefined
  /** 按 path 匹配 file viewer（priority desc → detect → exts） */
  matchFileViewer(path: string, head?: Uint8Array): FileViewerDescriptor | undefined
  /** 打开一个 tab（+ 菜单和外部触发都用它；走 descriptor.dedupeKey 去重） */
  openTab(seed: { type: string; title: string; path?: string; diff?: SidebarTab['diff']; id?: string }): void
  /** 关闭一个 tab */
  closeTab(tabId: string): void
  /** 订阅注册表变化（register/dispose 时触发） */
  subscribe(listener: () => void): () => void
}
```

---

## 6. 生命周期与 HMR

- **disposer 必须返回**：`registerTab` / `registerFileViewer` 返回 `() => void`，Cordis fiber 卸载时自动调用。**务必**用 `ctx.effect(() => register(...))` 包裹，否则 fiber 卸载（HMR / 插件禁用）时不会撤销注册，导致下次激活时 `"already registered"` 错误。
- **注册时机**：better-sidebar 在 `apply()` 开头 `ctx.provide('betterSidebar', service)`，所以你的插件 `inject = ['betterSidebar']` 时，better-sidebar 已经就绪。
- **顺序无关**：Cordis 的 `inject` 保证服务就绪后才激活你的插件；你的插件可在 `apply` 内任意时刻注册。
- **持久化降级**：localStorage 里持久化的 tab 若其 type 未注册（你的插件未加载），渲染为 `<OrphanedTab/>` 占位卡（显示 "插件未加载" + 关闭按钮）；你的插件加载后下次渲染自动恢复。

---

## 7. 平台约束与陷阱

| 陷阱 | 说明 |
|---|---|
| **构建纯度门** | client bundle 禁止 value-import `@dsh-external/*` 或非白名单的 `@deepseek-ai/*`；类型 `import type {}` 会被擦除，不触发门禁 |
| **双 cordis 实例** | 外部插件解析不到 DSH monorepo 的 cordis augmentation；better-sidebar 自己重述了 `interface Context { betterSidebar: ... }`，你 `import type {}` 即拿到类型 |
| **ModuleLoader 不跨插件** | 运行时 `require()` 虽支持跨 bundle，但被构建门挡；所有交互走 `ctx.betterSidebar` 方法调用 |
| **host 半无此服务** | `ctx.betterSidebar` 只在 client 侧存在；host 半需要 better-sidebar 数据走 `/sidebar/api/*` HTTP 路由 |
| **portal 限制** | 整面板 slot 由 ui-layout 独占，外部 tab 只能进入 better-sidebar 的 portal 内部，无法全屏替换 |
| **id 冲突** | `registerTab` / `registerFileViewer` 对重复 id 抛错；建议用包前缀（`my-plugin:xxx`） |

---

## 8. 完整最小示例

> 假设插件 `my-plugin` 要加一个"Database 浏览器" tab + `.csv` 文件预览器。

**`my-plugin/package.json`**：
```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "peerDependencies": {
    "cordis": "^4.0.0-rc.7",
    "dsh-better-sidebar": "workspace:*",
    "@deepseek-ai/dsh-client-runtime": "^0.0.1",
    "react": "^18.2.0"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

**`my-plugin/src/client/index.tsx`**：
```tsx
import { createElement } from 'react'
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
import type { Context } from 'cordis'

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  // Database tab
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      order: 50,
      dedupeKey: () => 'my-plugin:db',
      component: ({ scope }) => createElement(DbView, { sessionId: scope.sessionId }),
    })
  )

  // CSV viewer
  ctx.effect(() =>
    ctx.betterSidebar.registerFileViewer({
      id: 'my-plugin:csv',
      exts: ['csv'],
      fetchStrategy: 'custom',
      load: async (path, scope) => {
        const res = await fetch('/sidebar/api/fs.read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: scope.sessionId, path }),
        })
        const { value } = await res.json()
        return parseCsv(value.content)
      },
      component: ({ customData, path }) =>
        createElement(CsvGrid, { rows: customData as string[][], path }),
    })
  )
}

function DbView(props: { sessionId: string }): React.ReactNode { /* ... */ }
function CsvGrid(props: { rows: string[][]; path: string }): React.ReactNode { /* ... */ }
function parseCsv(text: string): string[][] { /* ... */ }
```

**注册到 profile**：在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 加 `"my-plugin": "link:<你的插件路径>"`，在 `cordis.patch.yml` 加挂载行，`pnpm install`，重启 `dsh web` + 浏览器硬刷新。

---

## 9. 参考实现

better-sidebar 自己的内置 tab 和 viewer 就是参考实现（"吃狗粮"）：

- **`src/client/builtins.tsx`**：6 个内置 tab（explorer/git/subagent/terminal/editor/diff）+ 6 个内置 viewer（image/pdf/docx/xlsx/pptx/binary-download）的注册代码
- **`src/client/service.ts`**：`BetterSidebarService` 接口 + `createBetterSidebarService` 工厂实现
- **`tests/service.spec.ts`**：12 个测试覆盖 register/dispose/matchFileViewer/dedupe/createTab
- **`docs/plans/2026-08-11-service-registry-design.md`**：设计文档

调试时直接读这些文件即可看到所有 API 的真实用法。
