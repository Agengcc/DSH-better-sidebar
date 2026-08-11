/**
 * The 8 built-in file viewer descriptors: every preview surface is a
 * registered viewer (image / pdf / docx / xlsx / pptx / markdown / code /
 * binary-download), exactly like external plugins register theirs. The
 * `binary-download` viewer sniffs NUL bytes via `detect` for unknown
 * binaries and serves doc/xls/ppt by extension; `code` is the catch-all
 * (`exts: []`, lowest priority) that claims any file no other viewer did.
 *
 * Every viewer carries the declarative settings-surface fields — `title`
 * and `icon` — so the Side card settings page can render the enable/disable
 * inventory without hardcoding (eating our own dogfood).
 */
import { IconCodeOutline16, IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { DocxView, XlsxView } from '../office-view.tsx'
import { PdfView } from '../PdfView.tsx'
import { PptxView } from '../PptxView.tsx'
import { TextEditor } from '../TextEditor.tsx'
import { BinaryDownload } from '../binary-download.tsx'
import {
  IconImageOutline16,
  IconMarkdownOutline16,
  IconPdfOutline16,
  IconDocxOutline16,
  IconXlsxOutline16,
  IconPptxOutline16,
} from '../icons.tsx'
import type { FileViewerDescriptor } from '../service.ts'
import { t } from '../locales.ts'
import css from '../sidebar.module.css'

/** The 8 built-in file viewer descriptors. */
export function builtinViewers(): readonly FileViewerDescriptor[] {
  return [
    {
      id: 'image',
      title: () => t('viewerImage'),
      icon: (size: number) => <IconImageOutline16 size={size} />,
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
      title: () => t('viewerPdf'),
      icon: (size: number) => <IconPdfOutline16 size={size} />,
      exts: ['pdf'],
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title }) => (
        <PdfView scope={scope} path={path} title={title} />
      ),
    },
    {
      id: 'docx',
      title: () => t('viewerDocx'),
      icon: (size: number) => <IconDocxOutline16 size={size} />,
      exts: ['docx'],
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title }) => (
        <DocxView scope={scope} path={path} title={title} />
      ),
    },
    {
      id: 'xlsx',
      title: () => t('viewerXlsx'),
      icon: (size: number) => <IconXlsxOutline16 size={size} />,
      exts: ['xlsx'],
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title }) => (
        <XlsxView scope={scope} path={path} title={title} />
      ),
    },
    {
      id: 'pptx',
      title: () => t('viewerPptx'),
      icon: (size: number) => <IconPptxOutline16 size={size} />,
      exts: ['pptx'],
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title }) => (
        <PptxView scope={scope} path={path} title={title} />
      ),
    },
    {
      id: 'markdown',
      title: () => t('viewerMarkdown'),
      icon: (size: number) => <IconMarkdownOutline16 size={size} />,
      exts: ['md', 'markdown'],
      fetchStrategy: 'fsRead',
      component: (props) => <TextEditor {...props} />,
    },
    {
      id: 'code',
      title: () => t('viewerCode'),
      icon: (size: number) => <IconCodeOutline16 size={size} />,
      exts: [],
      priority: -100,
      fetchStrategy: 'fsRead',
      component: (props) => <TextEditor {...props} />,
    },
    {
      id: 'binary-download',
      title: () => t('viewerBinary'),
      icon: (size: number) => <IconDownloadOutline16 size={size} />,
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
