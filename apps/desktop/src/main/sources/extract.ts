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

export const SUPPORTED_IMPORT_FORMATS = ['txt', 'md', 'csv', 'pdf', 'docx', 'xlsx', 'pptx'] as const;
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

// ---- XLSX：unzip 工作表，按单元格（工作表/行/列）抽取 ----
function colToNum(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return { col: 0, row: 0 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: parseInt(m[2], 10) };
}
function siText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  const o = node as Record<string, unknown>;
  if (o.t !== undefined) return typeof o.t === 'object' ? String((o.t as Record<string, unknown>)['#text'] ?? '') : String(o.t);
  if (o.r !== undefined) {
    const runs = Array.isArray(o.r) ? o.r : [o.r];
    return runs.map((r) => siText(r)).join('');
  }
  if (o['#text'] !== undefined) return String(o['#text']);
  return '';
}
function attr(node: Record<string, unknown>, name: string): string {
  return String(node[`@_${name}`] ?? node[`@_r:${name}`] ?? '');
}
// 解析 OOXML 关系文件（.rels）：Relationship Id → Target。用于按“文档关系+显示顺序”而非文件名数字定位。
async function parseRels(zip: JSZip, relsPath: string, baseDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const f = zip.file(relsPath);
  if (!f) return map;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const tree = parser.parse(await f.async('string')) as { Relationships?: { Relationship?: unknown } };
  let rels = tree.Relationships?.Relationship as unknown;
  rels = Array.isArray(rels) ? rels : rels ? [rels] : [];
  for (const r of rels as Record<string, unknown>[]) {
    const id = attr(r, 'Id');
    let target = attr(r, 'Target');
    if (!id || !target) continue;
    target = target.startsWith('/') ? target.slice(1) : `${baseDir}${target}`;
    map.set(id, target.replace(/\/{2,}/g, '/'));
  }
  return map;
}

export async function extractXlsx(buf: Buffer): Promise<ExtractResult> {
  const zip = await JSZip.loadAsync(buf);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let shared: string[] = [];
  const sstFile = zip.file('xl/sharedStrings.xml');
  if (sstFile) {
    const sx = parser.parse(await sstFile.async('string')) as { sst?: { si?: unknown } };
    const si = sx.sst?.si;
    const arr = Array.isArray(si) ? si : si ? [si] : [];
    shared = arr.map((n) => siText(n));
  }
  // 依据 workbook.xml 的 sheet 显示顺序 + workbook.xml.rels 解析每个工作表的真实文件（不按文件名数字）。
  const rels = await parseRels(zip, 'xl/_rels/workbook.xml.rels', 'xl/');
  const ordered: { name: string; file: string }[] = [];
  const wbFile = zip.file('xl/workbook.xml');
  if (wbFile) {
    const wb = parser.parse(await wbFile.async('string')) as { workbook?: { sheets?: { sheet?: unknown } } };
    let sh = wb.workbook?.sheets?.sheet as unknown;
    sh = Array.isArray(sh) ? sh : sh ? [sh] : [];
    for (const s of sh as Record<string, unknown>[]) {
      const rid = String(s['@_r:id'] ?? s['@_id'] ?? '');
      const file = rels.get(rid);
      if (file) ordered.push({ name: String(s['@_name'] ?? ''), file });
    }
  }
  // 回退：无 workbook/rels 时按文件名排序（尽力而为，非首选）。
  if (ordered.length === 0) {
    Object.keys(zip.files)
      .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
      .sort()
      .forEach((f, i) => ordered.push({ name: `Sheet${i + 1}`, file: f }));
  }
  const raw: { text: string; locatorKind: LocatorKind; locator: Record<string, number | string>; reliable: boolean }[] = [];
  for (let sIdx = 0; sIdx < ordered.length; sIdx++) {
    const { name, file } = ordered[sIdx];
    const wf = zip.file(file);
    if (!wf) continue;
    const ws = parser.parse(await wf.async('string')) as { worksheet?: { sheetData?: { row?: unknown } } };
    let rows = ws.worksheet?.sheetData?.row as unknown;
    rows = Array.isArray(rows) ? rows : rows ? [rows] : [];
    for (const row of rows as Record<string, unknown>[]) {
      let cells = row.c as unknown;
      cells = Array.isArray(cells) ? cells : cells ? [cells] : [];
      for (const c of cells as Record<string, unknown>[]) {
        const ref = String(c['@_r'] ?? '');
        const { col, row: rn } = colToNum(ref);
        let val = '';
        if (c['@_t'] === 's') val = shared[parseInt(String(c.v ?? '0'), 10)] ?? '';
        else if (c['@_t'] === 'inlineStr') val = siText(c.is);
        else val = c.v !== undefined ? String(typeof c.v === 'object' ? siText(c.v) : c.v) : '';
        val = val.trim();
        if (val.length)
          raw.push({ text: val, locatorKind: 'xlsx_cell', locator: { sheet: name || `Sheet${sIdx + 1}`, sheetIndex: sIdx + 1, row: rn, col }, reliable: true });
      }
    }
  }
  const { fullText, segments } = assemble(raw, '\n');
  return { format: 'xlsx', fullText, segments, scanned: false, reliableText: raw.length > 0 };
}

// ---- PPTX：unzip 各幻灯片，按页抽取 a:t 文本 ----
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
export async function extractPptx(buf: Buffer): Promise<ExtractResult> {
  const zip = await JSZip.loadAsync(buf);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  // 依据 presentation.xml 的 sldIdLst 显示顺序 + presentation.xml.rels 解析每张幻灯片的真实文件（不按文件名数字）。
  const rels = await parseRels(zip, 'ppt/_rels/presentation.xml.rels', 'ppt/');
  const slideFiles: string[] = [];
  const presFile = zip.file('ppt/presentation.xml');
  if (presFile) {
    const pres = parser.parse(await presFile.async('string')) as { 'p:presentation'?: { 'p:sldIdLst'?: { 'p:sldId'?: unknown } } };
    let ids = pres['p:presentation']?.['p:sldIdLst']?.['p:sldId'] as unknown;
    ids = Array.isArray(ids) ? ids : ids ? [ids] : [];
    for (const s of ids as Record<string, unknown>[]) {
      const rid = String(s['@_r:id'] ?? '');
      const file = rels.get(rid);
      if (file) slideFiles.push(file);
    }
  }
  if (slideFiles.length === 0) {
    Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort()
      .forEach((f) => slideFiles.push(f));
  }
  const raw: { text: string; locatorKind: LocatorKind; locator: Record<string, number | string>; reliable: boolean }[] = [];
  let i = 0;
  for (const f of slideFiles) {
    i += 1;
    const sf = zip.file(f);
    if (!sf) continue;
    const xml = await sf.async('string');
    const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join('').trim();
    raw.push({ text, locatorKind: 'pptx_slide', locator: { slide: i }, reliable: text.length > 0 });
  }
  const { fullText, segments } = assemble(raw, '\n\n');
  const anyText = raw.some((r) => r.text.length > 0);
  return { format: 'pptx', fullText, segments, scanned: slideFiles.length > 0 && !anyText, reliableText: anyText };
}

// 按格式分派解析原始文件字节。
export async function extractBuffer(buf: Buffer, format: string): Promise<ExtractResult> {
  const f = format.toLowerCase();
  if (f === 'pdf') return extractPdf(buf);
  if (f === 'docx') return extractDocx(buf);
  if (f === 'xlsx') return extractXlsx(buf);
  if (f === 'pptx') return extractPptx(buf);
  if (f === 'txt' || f === 'md' || f === 'markdown' || f === 'csv') return extractText(buf.toString('utf8'), f === 'markdown' ? 'md' : f);
  throw new Error('unsupported_format:' + format);
}
