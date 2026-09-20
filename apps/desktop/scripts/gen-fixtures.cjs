// 生成真实样例文件（PDF/DOCX/扫描件PDF），供 G03 真实文件导入演示。自拟非敏感内容。
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const JSZip = require('jszip');

const OUT = process.env.FIX_OUT || '/tmp/yuwendesk-samples2';
const FONT = '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf';
const hasFont = fs.existsSync(FONT);

function pdf(pages, file) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      fs.writeFileSync(file, Buffer.concat(chunks));
      resolve();
    });
    if (hasFont) doc.registerFont('cjk', FONT);
    for (const p of pages) {
      const page = doc.addPage();
      if (p === null) {
        page.rect(72, 72, 300, 160).fill('#cccccc'); // 扫描件模拟：无文字
      } else {
        if (hasFont) page.font('cjk');
        page.fontSize(16).fillColor('#000').text(p, 72, 90, { width: 450 });
      }
    }
    doc.end();
  });
}

async function docx(paragraphs, table, file) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.folder('_rels').file(
    '.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  const paras = paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
  const rows = table.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('');
  const body = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:tbl>${rows}</w:tbl></w:body></w:document>`;
  zip.folder('word').file('document.xml', body);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'a'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'b'), { recursive: true });
  await pdf(['《春》 朱自清\n\n盼望着，盼望着，东风来了，春天的脚步近了。', '一切都像刚睡醒的样子，欣欣然张开了眼。'], path.join(OUT, 'a', '春-课文.pdf'));
  // 同名不同内容（修订版）：用于版本关系确认
  await pdf(['《春》 朱自清（课堂修订版）\n\n盼望着，盼望着，东风来了，春天的脚步近了。', '【修订新增】坐着，躺着，打两个滚，踢几脚球。'], path.join(OUT, 'b', '春-课文.pdf'));
  await docx(
    ['教学目标：朗读课文，把握重音与停连。', '课堂活动：分组朗读春草图、春花图、春风图。'],
    [['单元', '课时'], ['第一单元', '春 第一课时']],
    path.join(OUT, '任务单.docx')
  );
  await pdf([null, null], path.join(OUT, '扫描件样例.pdf')); // 无文字扫描件
  console.log('FIXTURES OK at', OUT, 'font=', hasFont);
})();
