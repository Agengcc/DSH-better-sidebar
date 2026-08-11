/**
 * The 8 built-in file viewer descriptors: every preview surface is a
 * registered viewer (image / pdf / docx / xlsx / pptx / markdown / code /
 * binary-download), exactly like external plugins register theirs. The
 * `binary-download` viewer sniffs NUL bytes via `detect` for unknown
 * binaries and serves doc/xls/ppt by extension; `code` is the catch-all
 * (`exts: []`, lowest priority) that claims any file no other viewer did.
 */
import { DocxView, XlsxView } from '../office-view.tsx'
import { PdfView } from '../PdfView.tsx'
import { PptxView } from '../PptxView.tsx'
import { TextEditor } from '../TextEditor.tsx'
import { BinaryDownload } from '../binary-download.tsx'
import type { FileViewerDescriptor } from '../service.ts'
import css from '../sidebar.module.css'

/** The 8 built-in file viewer descriptors. */
export function builtinViewers(): readonly FileViewerDescriptor[] {
  return [
    {
      id: 'image',
      exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
      fetchStrategy: 'mediaUrl',
      component: ({ mediaUrl: url, title }) => (
        <div className={css.editorImageWrap}>
          <img className={css.editorImage} src={url} alt={title} />
        </div>
      ),
    },
    {
      id: 'pdf',
      exts: ['pdf'],
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title }) => (
        <PdfView scope={scope} path={path} title={title} />
      ),
    },
    {
      id: 'docx',
      exts: ['docx'],
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title }) => (
        <DocxView scope={scope} path={path} title={title} />
      ),
    },
    {
      id: 'xlsx',
      exts: ['xlsx'],
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title }) => (
        <XlsxView scope={scope} path={path} title={title} />
      ),
    },
    {
      id: 'pptx',
      exts: ['pptx'],
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title }) => (
        <PptxView scope={scope} path={path} title={title} />
      ),
    },
    {
      id: 'markdown',
      exts: ['md', 'markdown'],
      fetchStrategy: 'fsRead',
      component: (props) => <TextEditor {...props} />,
    },
    {
      id: 'code',
      exts: [],
      priority: -100,
      fetchStrategy: 'fsRead',
      component: (props) => <TextEditor {...props} />,
    },
    {
      id: 'binary-download',
      exts: ['doc', 'xls', 'ppt'],
      priority: -50,
      fetchStrategy: 'binary-download',
      // NUL probe: a file whose head bytes contain a NUL is binary — claimed
      // before the catch-all code viewer on the head re-match.
      detect: (_path, head) => head.includes(0),
      component: ({ scope, path }) => <BinaryDownload scope={scope} path={path} />,
    },
  ]
}
