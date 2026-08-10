/**
 * tsdown build for dsh-better-sidebar: the host-half lib (lib/index.js and
 * the lib/invariant.js companion, ESM node) plus the two browser client
 * bundles (lib/client.js and lib/client-registry.js, CJS closure factory) —
 * one per install channel:
 *
 * - `lib/client.js` serves the official profile channel, registering with
 *   the package-name id `dsh-better-sidebar` (the client-modules compose
 *   keys on the package name; keep it in sync with package.json `name`),
 * - `lib/client-registry.js` serves the plugin-registry channel
 *   (dsh.plugin.json), registering with the manifest id
 *   `dsh-external/dsh-better-sidebar` (the registry browser-side `arrive()`
 *   check requires bundle id === plugin id).
 *
 * Both bundles replicate the official DSH client-bundle preset
 * (packages/client/tsdown.client.ts) and are compiled from the same
 * src/client/index.tsx source — only the registered id and the output file
 * name differ, so they cannot drift:
 * - externals resolve through the loader module table at runtime (the
 *   PLATFORM_MODULES seed list from apps/web's platform.ts, plus the
 *   runtime/client exemption),
 * - everything else is inlined into the bundle (xterm, clsx, ...),
 * - the purity gate rejects any other @deepseek-ai value import: cross-plugin
 *   collaboration goes through cordis services, never value imports,
 * - CSS Modules compile to hashed class maps and inject <style data-plugin>
 *   tags at factory execution,
 * - each artifact registers itself via window.__ModuleLoader__.load({id,
 *   factory}) with the (require) => exports CJS closure shape.
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const require = createRequire(import.meta.url)

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/**
 * Browser-only standalone entries for dependencies whose package `browser`
 * remaps Rolldown does not currently honor after CJS lowering. Without these
 * aliases nanoid/SheetJS/JSZip leave Node builtin require() calls in the
 * client factory, which the DSH module table correctly refuses.
 */
const DOCX_PREVIEW_ENTRY = require.resolve('docx-preview')
const JSZIP_BROWSER_ENTRY = resolvePath(
  dirname(require.resolve('jszip/package.json', { paths: [dirname(DOCX_PREVIEW_ENTRY)] })),
  'dist/jszip.min.js',
)
const XLSX_BROWSER_ENTRY = resolvePath(
  dirname(require.resolve('xlsx/package.json')),
  'dist/xlsx.full.min.js',
)

/** Module specifiers the web shell shares into the frozen module table (the official PLATFORM_MODULES list, plus the runtime/client exemption). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Wire/type layers a client bundle may inline (mirror of the official
 * INLINE_SAFE list): browser-safe contract surfaces with no runtime identity
 * to share. Everything else under @deepseek-ai/* is either a module-table
 * entry (external) or a leak the purity gate rejects.
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** The style-injection prologue shared by module css and plain css loads. */
function injectTag(pluginId: string, fileId: string, cssText: string): string {
  const tagId = `${pluginId}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

/**
 * One client bundle build for a plugin id. The same src/client/index.tsx is
 * compiled twice with only the registered id and the output file name
 * differing: the official channel uses the package name (`dsh-better-sidebar`)
 * and the registry channel uses the manifest id
 * (`dsh-external/dsh-better-sidebar`).
 * @param pluginId - the `__ModuleLoader__.load({ id })` value and the
 *   data-plugin style-tag prefix of this bundle.
 * @param entryFile - the output file name under lib/.
 */
function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      // pptx-renderer only uses this to auto-discover its optional PDF.js
      // fallback. PptxView passes pdfjs:false, so browser CJS has no resolver.
      'import.meta.resolve': 'undefined',
    },
    alias: {
      jszip: JSZIP_BROWSER_ENTRY,
      xlsx: XLSX_BROWSER_ENTRY,
    },
    // CJS output otherwise makes some transitive packages (notably nanoid
    // through Univer Core) resolve their Node entry even though this bundle
    // runs in the browser. Keep browser conditional exports authoritative for
    // both source import() and generated require() edges.
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    // External wins for module-table entries; every other dependency inlines.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [{
      // Bundle purity gate (mirror of the official preset): platform seed
      // entries stay external, inline-safe wire layers inline, and every
      // other @deepseek-ai value import is a build error — a cross-plugin
      // value import either inlines a duplicate runtime instance or requires
      // a specifier the frozen module table cannot answer. Cross-plugin
      // collaboration goes through cordis services instead. Type-only
      // imports are erased and never reach this gate.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (NODE_BUILTINS.has(source)) {
          throw new Error(
            `client bundle purity: Node builtin "${source}" cannot run in the browser module table — `
            + 'select the dependency browser export or add an explicit browser implementation',
          )
        }
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
        if (INLINE_SAFE.test(source)) return null // wire/type layer: inline is the point
        throw new Error(
          `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) and not an inline-safe wire layer — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
        )
      },
    }, {
      name: 'dsh-css-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css')) return null
        // Relative/absolute paths resolve against the importer; bare
        // specifiers (e.g. 'xterm/css/xterm.css') resolve from the package.
        let abs: string
        if (source.startsWith('.') || source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) {
          abs = importer === undefined ? source : resolvePath(dirname(importer), source)
        } else {
          abs = require.resolve(source)
        }
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        // CSS Modules (x.module.css) become hashed class maps; plain css
        // (xterm's stylesheet) is inlined verbatim.
        if (fileId.endsWith('.module.css')) {
          const { code, exports: cssExports } = transform({
            filename: fileId,
            code: source,
            cssModules: { pattern: `[hash]_[local]` },
            minify: true,
          })
          const classMap: Record<string, string> = {}
          for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
          return [
            injectTag(pluginId, fileId, code.toString()),
            `export default ${JSON.stringify(classMap)};`,
          ].join('\n')
        }
        return [
          injectTag(pluginId, fileId, source.toString('utf8')),
          'export default "";',
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: entryFile,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      // The CJS wrapper factory's `require` only resolves module-table entries
      // (react, cordis, ...); it cannot load relative chunk URLs in the browser.
      // Disable code splitting so dynamic import() inlines into the single
      // factory chunk (Office preview libs — docx-preview, Univer — pull in
      // several MB but only when first opened, the trade-off for wrapper safety).
      codeSplitting: false,
    },
  }
}

export default [
  {
    entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    // clean stays off: the build script removes lib/ wholesale before tsc, so
    // a tsdown clean here would wipe the lib/types declarations tsc just
    // emitted (and `watch` must never touch them).
    clean: false,
  },
  // Official profile channel: bundle id = package name (package.json `name`).
  clientBundle('dsh-better-sidebar', 'client.js'),
  // Plugin-registry channel: bundle id = manifest id (dsh.plugin.json `id`).
  clientBundle('dsh-external/dsh-better-sidebar', 'client-registry.js'),
] satisfies UserConfig[]
