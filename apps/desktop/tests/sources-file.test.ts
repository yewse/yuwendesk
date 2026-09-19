import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import { SqliteStore } from '../src/main/db/sqliteStore';

const CJK_FONT = '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf';
const hasCjkFont = existsSync(CJK_FONT);

const open = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-file-'));
}
async function makeStore(dir: string): Promise<SqliteStore> {
  const s = new SqliteStore(dir);
  open.add(s);
  await s.load();
  return s;
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

function makePdf(pages: (string | null)[], useFont = false): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    if (useFont && hasCjkFont) doc.registerFont('cjk', CJK_FONT);
    for (const p of pages) {
      const page = doc.addPage();
      if (p === null) {
        // 扫描件模拟：只画矩形，无文字 → 无可提取文本
        page.rect(72, 72, 200, 100).fill('#cccccc');
      } else {
        if (useFont && hasCjkFont) page.font('cjk');
        page.fontSize(16).fillColor('#000000').text(p, 72, 100);
      }
    }
    doc.end();
  });
}

async function makeDocx(paragraphs: string[], table: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip
    .folder('_rels')!
    .file(
      '.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    );
  const paras = paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
  const rows = table
    .map((row) => `<w:tr>${row.map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`)
    .join('');
  const body = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:tbl>${rows}</w:tbl></w:body></w:document>`;
  zip.folder('word')!.file('document.xml', body);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('G03 真实文件导入：PDF', () => {
  it('多页 PDF → 逐页段与 pdf_page 定位；原件哈希≠文本哈希', async () => {
    const s = await makeStore(tmp());
    const pdf = await makePdf(['Alpha spring lesson one', 'Beta summer lesson two']);
    const r = await s.importFile({ title: 'lesson.pdf', format: 'pdf', base64: pdf.toString('base64') });
    expect(r.status).toBe('imported');
    if (r.status !== 'imported') throw new Error('import failed');
    const versions = s.getSourceVersions(r.documentId);
    expect(versions[0].format).toBe('pdf');
    expect(versions[0].scanned).toBe(false);
    expect(versions[0].originalHash).not.toBe(versions[0].textHash); // 原件哈希与文本哈希分开
    const hits = s.searchSources('summer lesson');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].locator?.kind).toBe('pdf_page');
    expect(hits[0].locator?.page).toBe(2);
    expect(hits[0].locatorLabel).toContain('第 2 页');
  });

  it('相同 PDF 再次导入 → duplicate（按原件哈希）', async () => {
    const s = await makeStore(tmp());
    const pdf = await makePdf(['same content here']);
    await s.importFile({ title: 'a.pdf', format: 'pdf', base64: pdf.toString('base64') });
    const dup = await s.importFile({ title: 'a.pdf', format: 'pdf', base64: pdf.toString('base64') });
    expect(dup.status).toBe('duplicate');
  });

  it('扫描件（无文字页）→ scanned，可保留但可靠文字检索不命中', async () => {
    const s = await makeStore(tmp());
    const pdf = await makePdf([null, null]); // 两页无文字
    const r = await s.importFile({ title: 'scan.pdf', format: 'pdf', base64: pdf.toString('base64') });
    expect(r.status).toBe('imported');
    if (r.status !== 'imported') throw new Error('import failed');
    const v = s.getSourceVersions(r.documentId)[0];
    expect(v.scanned).toBe(true);
    expect(v.reliableText).toBe(false);
    expect(s.listSources().length).toBe(1); // 保留
    expect(s.searchSources('anything').length).toBe(0); // 无可靠文字，不命中，不伪造识别
  });

  it.skipIf(!hasCjkFont)('中文 PDF（嵌入 CJK 字体）→ 中文检索命中并定位到页', async () => {
    const s = await makeStore(tmp());
    const pdf = await makePdf(['第一页：春天来了', '第二页：春天的脚步近了，万物复苏。'], true);
    const r = await s.importFile({ title: '春.pdf', format: 'pdf', base64: pdf.toString('base64') });
    expect(r.status).toBe('imported');
    const hits = s.searchSources('春天的脚步');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].locator?.kind).toBe('pdf_page');
    expect(hits[0].locator?.page).toBe(2);
  });
});

describe('G03 真实文件导入：DOCX', () => {
  it('段落与表格 → docx_paragraph / docx_table_cell 定位', async () => {
    const s = await makeStore(tmp());
    const docx = await makeDocx(['教学目标：把握重音与停连', '课堂活动：分组朗读春草图'], [
      ['单元', '课时'],
      ['第一单元', '春 第一课时']
    ]);
    const r = await s.importFile({ title: '任务单.docx', format: 'docx', base64: docx.toString('base64') });
    expect(r.status).toBe('imported');

    const paraHit = s.searchSources('分组朗读');
    expect(paraHit.length).toBeGreaterThan(0);
    expect(paraHit[0].locator?.kind).toBe('docx_paragraph');
    expect(paraHit[0].locatorLabel).toContain('段');

    const cellHit = s.searchSources('第一单元');
    expect(cellHit.length).toBeGreaterThan(0);
    expect(cellHit[0].locator?.kind).toBe('docx_table_cell');
    expect(cellHit[0].locator?.row).toBe(2);
    expect(cellHit[0].locator?.col).toBe(1);
  });

  it('不支持的格式 → rejected（不落库）', async () => {
    const s = await makeStore(tmp());
    const r = await s.importFile({ title: 'x.bin', format: 'bin', base64: Buffer.from('rawbytes').toString('base64') });
    expect(r.status).toBe('rejected');
    expect(s.listSources().length).toBe(0);
  });
});

async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'xl/sharedStrings.xml',
    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>单元</t></si><si><t>课时</t></si><si><t>第一单元</t></si><si><t>春 第一课时</t></si></sst>'
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="教学计划" sheetId="1" r:id="rId1"/></sheets></workbook>'
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>' +
      '</sheetData></worksheet>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function makePptx(slides: string[]): Promise<Buffer> {
  const zip = new JSZip();
  slides.forEach((t, i) => {
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    );
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('G03 真实文件导入：XLSX / PPTX', () => {
  it('XLSX → 工作表/行/列(xlsx_cell)定位', async () => {
    const s = await makeStore(tmp());
    const xlsx = await makeXlsx();
    const r = await s.importFile({ title: '计划.xlsx', format: 'xlsx', base64: xlsx.toString('base64') });
    expect(r.status).toBe('imported');
    const hit = s.searchSources('第一单元');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].locator?.kind).toBe('xlsx_cell');
    expect(hit[0].locator?.sheet).toBe('教学计划');
    expect(hit[0].locator?.row).toBe(2);
    expect(hit[0].locator?.col).toBe(1);
  });

  it('PPTX → 幻灯片页(pptx_slide)定位', async () => {
    const s = await makeStore(tmp());
    const pptx = await makePptx(['第一张：课程导入', '第二张：春天的脚步近了']);
    const r = await s.importFile({ title: '课件.pptx', format: 'pptx', base64: pptx.toString('base64') });
    expect(r.status).toBe('imported');
    const hit = s.searchSources('春天的脚步');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0].locator?.kind).toBe('pptx_slide');
    expect(hit[0].locator?.slide).toBe(2);
    expect(hit[0].locatorLabel).toContain('幻灯片');
  });
});
