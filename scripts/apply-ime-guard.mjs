// 持久 IME 守卫补丁（2026-08-10，changelog 见 AGENTS.md）：
// Univer InputNumber 在 document capture 拦截全页 ↑/↓ 且无 isComposing 守卫，
// 会摧毁中文输入法组合（候选词导航被劫持）。每次 build 后自动重打。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'lib/client.js')
const src = readFileSync(target, 'utf8')

const pattern = /function handleKeyDown\(e\) \{(\s*)if \(disabled\) return;/
const guard = 'function handleKeyDown(e) {\n\t\t\t\t\tif (e.isComposing || e.keyCode === 229) return;\n\t\t\t\t\tif (disabled) return;'

if (src.includes('e.isComposing || e.keyCode === 229')) {
  console.log('[apply-ime-guard] guard already present, skip')
  process.exit(0)
}
const count = src.match(new RegExp(pattern.source, 'g'))?.length ?? 0
if (count === 0) {
  console.error('[apply-ime-guard] ERROR: pattern not found in lib/client.js — univer structure may have changed, inspect manually!')
  process.exit(1)
}
const next = src.replace(pattern, guard)
writeFileSync(target, next)
console.log(`[apply-ime-guard] injected IME guard (${count} site(s))`)
