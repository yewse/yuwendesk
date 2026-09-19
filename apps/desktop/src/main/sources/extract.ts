// 原始文件解析：把 txt/md/csv/pdf/docx 抽取为“段（segment）+ 结构化定位（locator）”，
// 并给出可拼接的全文与字符偏移。扫描件（无可提取文字）标记为不可靠，可预览但不参与可靠检索。
// 不做 OCR：无文字的扫描页不会被伪造成文字，也不以摘要冒充原文。
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export type LocatorKind =
  | 'text_line'
  | 'csv_row'
  | 'pdf_page'
  | 'docx_paragraph'
  | 'docx_table_cell'
  | 'xlsx_cell'
  | 'pptx_slide';

export interface ExtractedSegment {
  ordinal: number;
  locatorKind: LocatorKind;
  locator: Record<string, number | string>;
  text: string;
  char_start: number;
  char_end: number;
  reliable: boolean;
}
export interface ExtractResult {
  format: string;
  fullText: string;
  segments: ExtractedSegment[];
  scanned: boolean; // 疑似扫描件（存在页/段但无可提取文字）
  reliableText: boolean; // 是否含可靠文字（可用于检索/核对）
}

export const SUPPORTED_IMPORT_FORMATS = ['txt', 'md', 'csv', 'pdf', 'docx'] as const;
export type SupportedFormat = (typeof SUPPORTED_IMPORT_FORMATS)[number];

// 将“原始段落列表（含 locator 与是否可靠）”拼接为全文并计算字符偏移。
function assemble(
  raw: { text: string; locatorKind: LocatorKind; locator: Record<string, number | string>; reliable: boolean }[],
  sep = '\n'
): { fullText: string; segments: ExtractedSegment[] } {
  const segments: ExtractedSegment[] = [];
  let cursor = 0;
  const parts: string[] = [];
  raw.forEach((r, i) => {
    const start = cursor;
    parts.push(r.text);
    cursor += r.text.length;
    segments.push({
      ordinal: i,
      locatorKind: r.locatorKind,
      locator: r.locator,
      text: r.text,
      char_start: start,
      char_end: cursor,
      reliable: r.reliable
    });
    if (i < raw.length - 1) cursor += sep.length; // 分隔符占位，保持偏移与 fullText 对齐
  });
  return { fullText: parts.join(sep), segments };
}

export function extractText(content: string, format: string): ExtractResult {
  const kind: LocatorKind = format === 'csv' ? 'csv_row' : 'text_line';
  const lines = content.split('\n');
  const raw = lines.map((t, i) => ({
    text: t,
    locatorKind: kind,
    locator: (kind === 'csv_row' ? { row: i + 1 } : { line: i + 1 }) as Record<string, number | string>,
    reliable: true
  }));
  const { fullText, segments } = assemble(raw, '\n');
  return { format, fullText, segments, scanned: false, reliableText: content.trim().length > 0 };
}

interface PdfjsLike {
  getDocument(opts: { data: Uint8Array; isEvalSupported?: boolean }): { promise: Promise<PdfDoc> };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string }> }> }>;
}

export async function extractPdf(buf: Buffer): Promise<ExtractResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js') as PdfjsLike;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const raw: { text: string; locatorKind: LocatorKind; locator: Record<string, number>; reliable: boolean }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items
      .map((it) => it.str ?? '')
      .join('')
      .trim();
    raw.push({ text, locatorKind: 'pdf_page', locator: { page: i }, reliable: text.length > 0 });
  }
  const { fullText, segments } = assemble(raw, '\n\n');
  const anyText = raw.some((r) => r.text.length > 0);
  return { format: 'pdf', fullText, segments, scanned: raw.length > 0 && !anyText, reliableText: anyText };
}

// ---- DOCX：unzip word/document.xml，按文档顺序抽取段落与表格单元格 ----
type OrderedNode = Record<string, unknown>;
// 收集子树内所有 #text（w:t 文本）。
function collectText(nodes: unknown): string {
  if (!Array.isArray(nodes)) return '';
  let s = '';
  for (const n of nodes as OrderedNode[]) {
    for (const k of Object.keys(n)) {
      if (k === '#text') s += String(n[k] ?? '');
      else if (Array.isArray(n[k])) s += collectText(n[k]);
    }
  }
  return s;
}
function childArray(node: OrderedNode, tag: string): OrderedNode[] {
  const v = node[tag];
  return Array.isArray(v) ? (v as OrderedNode[]) : [];
}
function findFirst(nodes: OrderedNode[], tag: string): OrderedNode[] | null {
  for (const n of nodes) {
    if (Array.isArray(n[tag])) return n[tag] as OrderedNode[];
    for (const k of Object.keys(n)) {
      if (k === ':@' || k === '#text') continue;
      if (Array.isArray(n[k])) {
        const deep = findFirst(n[k] as OrderedNode[], tag);
        if (deep) return deep;
      }
    }
  }
  return null;
}

export async function extractDocx(buf: Buffer): Promise<ExtractResult> {
  const zip = await JSZip.loadAsync(buf);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return { format: 'docx', fullText: '', segments: [], scanned: false, reliableText: false };
  const xml = await docFile.async('string');
  const parser = new XMLParser({ ignoreAttributes: true, preserveOrder: true });
  const tree = parser.parse(xml) as OrderedNode[];
  const docChildren = findFirst(tree, 'w:document');
  const body = docChildren ? findFirst(docChildren, 'w:body') : null;
  const raw: { text: string; locatorKind: LocatorKind; locator: Record<string, number>; reliable: boolean }[] = [];
  let paraNo = 0;
  let tableNo = 0;
  if (body) {
    for (const child of body) {
      if (Array.isArray(child['w:p'])) {
        paraNo += 1;
        const text = collectText(child['w:p']).trim();
        if (text.length) raw.push({ text, locatorKind: 'docx_paragraph', locator: { paragraph: paraNo }, reliable: true });
      } else if (Array.isArray(child['w:tbl'])) {
        tableNo += 1;
        const rows = childArray(child, 'w:tbl').filter((n) => Array.isArray(n['w:tr']));
        let rowNo = 0;
        for (const tr of rows) {
          rowNo += 1;
          const cells = childArray(tr, 'w:tr').filter((n) => Array.isArray(n['w:tc']));
          let colNo = 0;
          for (const tc of cells) {
            colNo += 1;
            const text = collectText(tc['w:tc']).trim();
            if (text.length)
              raw.push({ text, locatorKind: 'docx_table_cell', locator: { table: tableNo, row: rowNo, col: colNo }, reliable: true });
          }
        }
      }
    }
  }
  const { fullText, segments } = assemble(raw, '\n');
  const anyText = raw.length > 0;
  return { format: 'docx', fullText, segments, scanned: false, reliableText: anyText };
}

// 按格式分派解析原始文件字节。
export async function extractBuffer(buf: Buffer, format: string): Promise<ExtractResult> {
  const f = format.toLowerCase();
  if (f === 'pdf') return extractPdf(buf);
  if (f === 'docx') return extractDocx(buf);
  if (f === 'txt' || f === 'md' || f === 'markdown' || f === 'csv') return extractText(buf.toString('utf8'), f === 'markdown' ? 'md' : f);
  throw new Error('unsupported_format:' + format);
}
