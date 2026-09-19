import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import { SqliteStore } from '../src/main/db/sqliteStore';
import { extractPdf, extractDocx, ExtractError, type ExtractResult } from '../src/main/sources/extract';

const open = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-bnd-'));
}
afterEach(() => {
  for (const s of open)
    try {
      s.close();
    } catch {
      /* ignore */
    }
  open.clear();
});

function makePdf(pages: string[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const ch: Buffer[] = [];
    doc.on('data', (c: Buffer) => ch.push(c));
    doc.on('end', () => resolve(Buffer.concat(ch)));
    for (const p of pages) doc.addPage().fontSize(14).text(p, 72, 100);
    doc.end();
  });
}
async function makeManyEntryDocx(entries: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>');
  for (let i = 0; i < entries; i++) zip.file(`extra/file${i}.bin`, 'x');
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('G03-A 处理边界：解析限额', () => {
  it('PDF 页数超限 → ExtractError(too_many_pages)', async () => {
    const pdf = await makePdf(['p1', 'p2', 'p3']);
    await expect(extractPdf(pdf, { limits: { maxPages: 2 } })).rejects.toMatchObject({ code: 'too_many_pages' });
  });

  it('PDF 抽取文本超上限 → ExtractError(too_large_text)', async () => {
    const pdf = await makePdf(['hello world text']);
    await expect(extractPdf(pdf, { limits: { maxTextChars: 3 } })).rejects.toMatchObject({ code: 'too_large_text' });
  });

  it('zip 条目数超限 → ExtractError(too_many_entries)', async () => {
    const docx = await makeManyEntryDocx(50);
    await expect(extractDocx(docx, { limits: { maxZipEntries: 10 } })).rejects.toMatchObject({ code: 'too_many_entries' });
  });

  it('取消信号在解析中 → ExtractError(cancelled)', async () => {
    const pdf = await makePdf(['p1', 'p2']);
    const signal = { cancelled: true };
    await expect(extractPdf(pdf, { signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

async function store(dir: string, parseFile: (b: Buffer, f: string, o: unknown) => Promise<ExtractResult>): Promise<SqliteStore> {
  const s = new SqliteStore(dir, { parseFile: parseFile as never });
  open.add(s);
  await s.load();
  return s;
}

describe('G03-A 处理边界：importFile 初步大小/取消/限额映射', () => {
  it('初步大小检查：超限在解析前即拒绝（不调用解析）', async () => {
    const spy = vi.fn(async () => ({ format: 'pdf', fullText: '', segments: [], scanned: false, reliableText: false }) as ExtractResult);
    const s = await store(tmp(), spy);
    // 构造超过 40MB 的 base64（约 41MB 字节）
    const big = 'A'.repeat(Math.ceil((41_000_000 * 4) / 3));
    const r = await s.importFile({ title: 'big.pdf', format: 'pdf', base64: big });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toBe('too_large');
    expect(spy).not.toHaveBeenCalled(); // 完整解析前即拒绝
  });

  it('解析抛限额错误 → rejected(limit_exceeded)，不落库', async () => {
    const s = await store(tmp(), async () => {
      throw new ExtractError('too_many_pages');
    });
    const r = await s.importFile({ title: 'x.pdf', format: 'pdf', base64: Buffer.from('data').toString('base64') });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.reason).toBe('limit_exceeded');
    expect(s.listSources().length).toBe(0);
  });

  it('解析中取消 → cancelled，不落库', async () => {
    const s = await store(tmp(), async () => {
      throw new ExtractError('cancelled');
    });
    const r = await s.importFile({ title: 'x.pdf', format: 'pdf', base64: Buffer.from('data').toString('base64'), jobId: 'j1' });
    expect(r.status).toBe('cancelled');
    expect(s.listSources().length).toBe(0);
  });

  it('取消传播到提交边界：解析成功但提交前已取消 → 不静默入库', async () => {
    const holder: { s?: SqliteStore } = {};
    // 解析器在解析“过程中”触发取消（模拟用户取消当前文件），随后正常返回解析结果
    const s = await store(tmp(), async () => {
      holder.s!.cancelImport('job-cancel');
      return { format: 'pdf', fullText: '正文', segments: [{ ordinal: 0, locatorKind: 'pdf_page', locator: { page: 1 }, text: '正文', char_start: 0, char_end: 2, reliable: true }], scanned: false, reliableText: true };
    });
    holder.s = s;
    const r = await s.importFile({ title: 'x.pdf', format: 'pdf', base64: Buffer.from('data').toString('base64'), jobId: 'job-cancel' });
    expect(r.status).toBe('cancelled');
    expect(s.listSources().length).toBe(0); // 已取消任务不入库
  });

  it('cancelImport 未命中在途任务 → false', async () => {
    const s = await store(tmp(), async () => ({ format: 'pdf', fullText: '', segments: [], scanned: false, reliableText: false }));
    expect(s.cancelImport('nope')).toBe(false);
  });
});
