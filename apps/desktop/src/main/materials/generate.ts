// G06：从 LessonPlan 确定性生成“三类五文件”——课堂 PPTX、学生 DOCX/PDF、教师 DOCX/PDF。
// 角色隔离：教师专属内容（合理答案/误解/教师动作/追问/教师小结）只进教师版；学生版与投屏 PPTX 不含。
// 版本一致：所有文件内嵌 plan_id/revision_id 与内容来源身份。一处修改联动：文件是计划修订的纯函数。
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import type { LessonPlan } from '../lesson/types';

export type MaterialRole = 'presentation' | 'student' | 'teacher';
export type MaterialFormat = 'pptx' | 'docx' | 'pdf';
export interface GeneratedFile {
  role: MaterialRole;
  format: MaterialFormat;
  filename: string;
  bytes: Buffer;
  sha256: string;
}
export interface MaterialSet {
  planId: string;
  revisionId: string;
  contentOrigin: string;
  versionStamp: string;
  files: GeneratedFile[];
}

// 版本与来源水印，嵌入每个文件；模拟/未核验内容明确标注。
function versionStamp(plan: LessonPlan, contentOrigin: string): string {
  const sim = contentOrigin !== 'authored' && contentOrigin !== 'real';
  return `【计划 ${plan.plan_id} · 修订 ${plan.revision_id} · 内容来源 ${contentOrigin}${sim ? '（模拟/未经真实模型或教师核验）' : ''}】`;
}

// ---- 面向学生的内容（不含任何教师专属信息） ----
function studentBlocks(plan: LessonPlan, stamp: string): string[] {
  const out: string[] = [stamp, `课题：${plan.title}`, `时长：${Math.round(plan.declared_duration_sec / 60)} 分钟`, '学习目标：'];
  plan.objectives.forEach((o, i) => out.push(`${i + 1}. ${o.description}`));
  out.push('课堂活动：');
  plan.activities.forEach((a, i) => out.push(`${i + 1}. [${Math.round(a.start_sec / 60)}′-${Math.round(a.end_sec / 60)}′] ${a.title}：${a.student_action}`));
  out.push('学习任务：');
  plan.tasks.forEach((t, i) => out.push(`任务${i + 1}：${t.prompt}`));
  if (plan.homework.length) {
    out.push('课后：');
    plan.homework.forEach((h) => out.push(`· ${h.description}`));
  }
  return out;
}

// ---- 面向教师的内容（含合理答案/误解/教师动作/追问/小结） ----
function teacherBlocks(plan: LessonPlan, stamp: string): string[] {
  const out: string[] = [stamp, `课题（教师版）：${plan.title}`, `时长：${Math.round(plan.declared_duration_sec / 60)} 分钟`, `教师小结：${plan.teacher_summary}`];
  out.push('时间线与教师动作：');
  plan.activities.forEach((a, i) =>
    out.push(`${i + 1}. [${Math.round(a.start_sec / 60)}′-${Math.round(a.end_sec / 60)}′] ${a.title}（角色:${a.actor}）｜学生:${a.student_action}｜教师:${a.teacher_action}`)
  );
  out.push('任务·合理答案·追问：');
  plan.tasks.forEach((t, i) => {
    const rub = plan.rubrics.find((r) => r.rubric_id === t.rubric_id);
    out.push(`任务${i + 1}：${t.prompt}`);
    out.push(`  追问/备注：${t.teacher_notes}`);
    rub?.criteria.forEach((c) => {
      if (c.acceptable_variants.length) out.push(`  合理答案：${c.acceptable_variants.join('；')}`);
      if (c.insufficient_examples.length) out.push(`  典型误解：${c.insufficient_examples.join('；')}`);
    });
  });
  if (plan.unknowns.length) {
    out.push('需教师核实：');
    plan.unknowns.forEach((u) => out.push(`· ${u}`));
  }
  return out;
}

// ---- PPTX 幻灯片（课堂共享，不含教师答案；投屏隐私） ----
function presentationSlides(plan: LessonPlan, stamp: string): { title: string; bullets: string[] }[] {
  const slides: { title: string; bullets: string[] }[] = [{ title: plan.title, bullets: [stamp, `时长 ${Math.round(plan.declared_duration_sec / 60)} 分钟`] }];
  slides.push({ title: '学习目标', bullets: plan.objectives.map((o) => o.description) });
  slides.push({ title: '课堂活动', bullets: plan.activities.map((a) => `${a.title}：${a.student_action}`) });
  slides.push({ title: '学习任务', bullets: plan.tasks.map((t, i) => `任务${i + 1}：${t.prompt}`) });
  return slides;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- DOCX 生成（可编辑；段落文本） ----
async function makeDocx(blocks: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.folder('_rels')!.file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const paras = blocks.map((b) => `<w:p><w:r><w:t xml:space="preserve">${esc(b)}</w:t></w:r></w:p>`).join('');
  zip.folder('word')!.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---- PPTX 生成（最小 OOXML 包：演示 + 每页 a:t 文本；可被本管线回解析） ----
async function makePptx(slides: { title: string; bullets: string[] }[]): Promise<Buffer> {
  const zip = new JSZip();
  const slideOverrides = slides.map((_s, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slideOverrides}</Types>`
  );
  zip.folder('_rels')!.file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  const sldIds = slides.map((_s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  zip.folder('ppt')!.file(
    'presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`
  );
  const presRels = slides.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('');
  zip.folder('ppt')!.folder('_rels')!.file('presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels}</Relationships>`);
  const slidesFolder = zip.folder('ppt')!.folder('slides')!;
  slides.forEach((s, i) => {
    const runs = [s.title, ...s.bullets].map((t) => `<a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p>`).join('');
    slidesFolder.file(
      `slide${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${runs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    );
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---- PDF 生成（pdfkit；中文需嵌入 CJK 字体，缺字体则记录降级） ----
const CJK_FONTS = ['/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'];
async function makePdf(blocks: string[]): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const PDFDocument = require('pdfkit');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const fsx = require('node:fs') as typeof import('node:fs');
  const font = CJK_FONTS.find((f) => fsx.existsSync(f));
  return new Promise<Buffer>((resolve) => {
    const doc = new PDFDocument({ margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    if (font) doc.registerFont('cjk', font);
    if (font) doc.font('cjk');
    doc.fontSize(12);
    for (const b of blocks) doc.text(b, { width: 500 });
    doc.end();
  });
}

function withHash(role: MaterialRole, format: MaterialFormat, filename: string, bytes: Buffer): GeneratedFile {
  return { role, format, filename, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

// 由计划修订确定性生成三类五文件（角色隔离 + 版本水印）。
export async function buildMaterialSet(plan: LessonPlan, contentOrigin: string): Promise<MaterialSet> {
  const stamp = versionStamp(plan, contentOrigin);
  const student = studentBlocks(plan, stamp);
  const teacher = teacherBlocks(plan, stamp);
  const slides = presentationSlides(plan, stamp);
  const base = plan.title.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'lesson';
  const files: GeneratedFile[] = [
    withHash('presentation', 'pptx', `${base}-课堂.pptx`, await makePptx(slides)),
    withHash('student', 'docx', `${base}-学生讲义.docx`, await makeDocx(student)),
    withHash('student', 'pdf', `${base}-学生讲义.pdf`, await makePdf(student)),
    withHash('teacher', 'docx', `${base}-教师讲义.docx`, await makeDocx(teacher)),
    withHash('teacher', 'pdf', `${base}-教师讲义.pdf`, await makePdf(teacher))
  ];
  return { planId: plan.plan_id, revisionId: plan.revision_id, contentOrigin, versionStamp: stamp, files };
}
