# 移动端（窄视口 <1024px）侧边栏布局设计

**日期**：2026-08-12
**状态**：已实施（本文档含实施偏差记录）
**目标版本**：v0.7.0

## 1. 目标

按**视口宽度**（<1024px，与 DSH 宿主 `SIDEBAR_AUTO_COLLAPSE` 一致）切换移动端侧边栏体验：

1. 移动端**不提供底部面板按钮**（右上角按钮簇只剩一枚右侧面板开关）。
2. **底部面板与右侧面板合并显示**：右侧面板成为全屏抽屉，内部上下堆叠两个工作台——上 = 原右侧栏工作台（`state.splits`），下 = 原底部面板工作台（`state.bottomSplits`），中间可拖分隔条。底部面板浮层（关闭按钮 / 顶部拖动条 / 共享拐角）在移动端整体不渲染。
3. 附带移动端优化：新会话默认收起抽屉、文件/外链打开自动展开、宽度拖动条禁用、布局不挤压（抽屉悬浮）、窄屏标签收窄。

## 2. 非目标

- 不改持久化 schema：`bottomOpen` / `bottomHeight` / 两棵树字段原样保留，跨断点不迁移状态。
- 不改桌面行为：≥1024px 时双面板布局与之前完全一致（含布局挤压、拐角、底部首展自动终端）。
- 不改公开服务 API、PrefsSchema、host 半。
- 不处理 DSH 详情栏（宿主让步链在 <~996px 自动关闭详情栏，与本改动无交互）。

## 3. 现状回顾

- `Sidebar.tsx` 渲染两个独立浮层：右侧面板（全高、宽度可拖、布局挤压 `--dsh-sidebar-width`）与底部面板（只挤中间列、高度可拖、右上角按钮簇双按钮、共享拐角）。
- 底部面板状态字段：`bottomOpen` / `bottomHeight`（钳制 `[BOTTOM_MIN, innerHeight-PANEL_MIN]`）/ `bottomOpenedOnce` / `bottomSplits`。
- 首次展开底部面板自动开终端（`bottomPanelAutoTerminal` pref）。

## 4. 设计

### 4.1 断点模块（新 `src/client/breakpoints.ts`）

- `NARROW_MAX_WIDTH = 1024`；`isNarrowWidth(width)` 纯函数；`useNarrowViewport()` hook（初始读 `window.innerWidth`，resize + rAF 节流，`typeof window` 守卫；不用 matchMedia——jsdom 未实现）。
- CSS 侧配对 `@media (max-width: 1023px)`（1023 ≡ <1024），两端注释互指。

### 4.2 合并布局（`Sidebar.tsx` + `split-pane.tsx` `MobileWorkbench`）

- 窄屏下：面板宽度 `100vw`（全屏抽屉）；`--dsh-sidebar-*` 布局变量恒 0（抽屉悬浮覆盖，不挤压 AppFrame）；宽度拖动条、底部浮层、`bottomClose`、拐角、底部面板按钮全部不渲染。
- `MobileWorkbench`：column flex → 上区 `Workbench(state.splits)`（flex:1）→ 分隔条（复用 `.dividerCol` 命中区 + hairline）→ 下区 `Workbench(state.bottomSplits)`（高度 = `state.bottomHeight`，`flex:none`）。
- **下区高度复用 `bottomHeight`**：桌面底部面板高度语义延续到移动端；移动端拖分隔条写回同一字段并持久化，回桌面后一致。
- 分隔条拖动：镜像现有面板拖动模式（pointer capture + rAF 批处理 DOM 直写 + 松手一次 `setBottomHeight` commit），避免终端/编辑器逐帧重渲染。
- 两个工作台**始终渲染**（空底部树显示欢迎卡片）；跨工作台拖 Tab 由既有跨树 `moveTabToEdge` / `moveTab` 支持。
- 底部树 tab 的 `visible` 在窄屏 = `panelOpen && active`（抽屉开合决定），不再看 `bottomOpen`。

### 4.3 行为修正

- `state.ts` `loadState`：窄屏新会话默认 `panelOpen=false`（首开才生效；用户手动展开后照常持久化）。
- `service.ts` `openTab`：窄屏且 seed 带 `path`/`url` 且面板收起 → 自动展开抽屉（dedupe-focus 分支同样生效）；纯类型打开不展开；宽屏行为不变。
- 底部首展自动终端 effect 加 `narrow` 守卫（桌面专属行为）。
- 子代理自动展开 / jump-back 不动（展开 `panelOpen` = 展开抽屉，语义正确）。

### 4.4 样式（`sidebar.module.css`）

- `@media (max-width: 1023px)`：开放面板标签条预留宽度 72px → 40px（按钮簇只剩一枚）；`.tab` min/max 宽收窄（48/128px）。
- 新增 `.mobileWorkbench` / `.mobilePane` / `.mobilePaneBottom`；分隔条复用 `.dividerCol`。

### 4.5 测试

- `tests/breakpoints.spec.ts`：断点边界。
- `tests/service.spec.ts`：窄屏 auto-expand 5 例（path/url 展开、类型不展开、宽屏不展开、dedupe 聚焦仍展开）。
- `tests/unit.spec.ts`：窄屏新会话默认收起（stub `window.innerWidth=390`，try/finally 还原）。
- `tests/mobile-workbench.spec.tsx`：双树并显 + 分隔条 + 底部高度（renderToString 结构断言）。
- 分隔条拖动 = 指针捕获逻辑，人工验证（与桌面拖动同策略）；store 钳制由既有 `setBottomHeight` 测试覆盖。

## 5. 边界情况

- 跨断点往返：状态零迁移；桌面 `bottomOpen=false` 但底部树有标签的会话，移动端仍显示（合并语义），回桌面仍隐藏。
- 底部高度越界：渲染直接用 `state.bottomHeight`（store 写入已钳制）；拖动中按面板体高度钳制，松手再走 store 钳制。
- jsdom 兼容：hook 不用 matchMedia；既有测试 stub `innerWidth=1024` 自动走桌面路径，零行为变化。

## 6. 实施偏差记录

- 计划时考虑过「空底部树隐藏 + 拖 Tab 创建」方案，最终采用**始终渲染两工作台**（用户确认的选项语义：上下并显 + 可调分隔；空底部树显示欢迎卡片，发现性更好）。
- 计划时考虑过 matchMedia 方案，最终用 resize + rAF（jsdom 兼容，仓库既有拖动模式同款）。
