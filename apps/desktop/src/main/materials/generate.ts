// G06：从 LessonPlan 生成“三类五文件”。PPTX 用成熟库 PptxGenJS（标准页/形状/文本框/布局/关系）；
// PDF 用内置许可 CJK 字体（不依赖系统字体路径），缺字体即失败不静默成功；DOCX 段落+表格+书写区。
// 内容随任务展开（非固定提纲）：教材全文只供规划与核验，学生讲义含课本阅读提示 + 书写/比较/修改空间；教师版与任务/PPT 位置对应。
// 角色规则（CR-001）：私密学情不入 PPT/学生；合理答案与追问可在课堂推进后由 PPT 展示，但不提前发给学生。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import type { LessonPlan, Task } from '../lesson/types';
import type { PresentationSpec } from '../change/types';

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

const DEFAULT_PRESENTATION_SPEC: PresentationSpec = {
  fontScale: 1,
  paperSize: 'A4',
  theme: 'light'
};

export class FontMissingError extends Error {
  constructor() {
    super('CJK_FONT_MISSING');
    this.name = 'FontMissingError';
  }
}

// 解析内置 CJK 字体（不依赖运行环境系统字体路径）；缺失返回 null（调用方转为失败）。
export function resolveCjkFont(): string | null {
  const candidates = [
    process.env.YUWENDESK_CJK_FONT,
    join(__dirname, '..', '..', '..', 'assets', 'fonts', 'DroidSansFallbackFull.ttf'),
    typeof process.resourcesPath === 'string' ? join(process.resourcesPath, 'assets', 'fonts', 'DroidSansFallbackFull.ttf') : undefined
  ].filter((x): x is string => !!x);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function versionStamp(plan: LessonPlan, contentOrigin: string): string {
  const label = contentOrigin === 'authored' || contentOrigin === 'teacher_authored'
    ? '教师自拟'
    : contentOrigin === 'real' || contentOrigin === 'model_assisted_real'
      ? '模型辅助（真实服务）'
      : contentOrigin === 'model_assisted_simulated'
        ? '模型辅助（模拟）'
        : `${contentOrigin}（模拟/未经真实模型或教师核验）`;
  return `计划 ${plan.plan_id} · 修订 ${plan.revision_id} · 内容来源 ${label}`;
}

export interface Section {
  heading: string;
  lines: string[];
  table?: string[][];
  writeLines?: number; // 书写/作答留白行数
}

function minutes(sec: number): string {
  return `${Math.round(sec / 60)}′`;
}
function lessonLabel(plan: LessonPlan): string {
  return plan.title.match(/《[^》]+》/u)?.[0] ?? plan.title.split(/[：:]/u)[0].trim();
}

function hasMaterialAnchor(plan: LessonPlan, task: Task): boolean {
  const ids = new Set(task.material_anchor_ids);
  return plan.source_anchors.some((anchor) => ids.has(anchor.anchor_id));
}

function sourceInstruction(plan: LessonPlan, task: Task): string {
  if (!hasMaterialAnchor(plan, task)) return '阅读提示：请按教师课堂指定的课本段落完成任务。';
  return `阅读提示：请在课本${lessonLabel(plan)}对应段落中圈画证据，结合任务作答。`;
}
function isCompare(t: Task): boolean {
  return t.cognitive_demand === 'compare';
}

// ---- 学生讲义：任务 + 课本阅读提示 + 书写/比较/修改空间；不复制教材全文，不含答案/教师私密内容 ----
export function studentSections(plan: LessonPlan, stamp: string): Section[] {
  const secs: Section[] = [{ heading: `学生讲义：${plan.title}`, lines: [stamp, `建议时长 ${minutes(plan.declared_duration_sec)}`] }];
  secs.push({ heading: '学习目标', lines: plan.objectives.map((o, i) => `${i + 1}. ${o.description}`) });
  plan.tasks.forEach((t, i) => {
    const lines = [`任务：${t.prompt}`, sourceInstruction(plan, t)];
    const sec: Section = { heading: `学习任务 ${i + 1}`, lines, writeLines: 3 };
    if (isCompare(t)) sec.table = [['比较角度', '甲', '乙'], ['', '', ''], ['', '', '']];
    secs.push(sec);
    // 修改区：写作/修订类任务提供
    if (t.cognitive_demand === 'create' || t.support_level === 'independent') secs.push({ heading: `任务 ${i + 1} 修改区`, lines: ['初稿 → 同伴/教师反馈后修改：'], writeLines: 3 });
  });
  if (plan.homework.length) secs.push({ heading: '课后', lines: plan.homework.map((h) => `· ${h.description}`) });
  return secs;
}

// ---- 教师讲解版：与任务/PPT 位置对应，含合理答案范围、误解、追问、教师动作、小结、需核实 ----
export function teacherSections(plan: LessonPlan, stamp: string): Section[] {
  const secs: Section[] = [{ heading: `教师讲解版：${plan.title}`, lines: [stamp, `建议时长 ${minutes(plan.declared_duration_sec)}`, `教师小结：${plan.teacher_summary}`] }];
  secs.push({
    heading: '时间线与教师动作',
    lines: plan.activities.map((a, i) => `${i + 1}. [${minutes(a.start_sec)}-${minutes(a.end_sec)}] ${a.title}（角色:${a.actor}）｜学生:${a.student_action}｜教师:${a.teacher_action}`)
  });
  plan.tasks.forEach((t, i) => {
    const rub = plan.rubrics.find((r) => r.rubric_id === t.rubric_id);
    const lines = [`任务：${t.prompt}`, `对应 PPT：任务${i + 1}页 / 参考答案页`, `追问：${t.teacher_notes}`];
    rub?.criteria.forEach((c) => {
      if (c.acceptable_variants.length) lines.push(`合理答案：${c.acceptable_variants.join('；')}`);
      if (c.insufficient_examples.length) lines.push(`典型误解：${c.insufficient_examples.join('；')}`);
    });
    lines.push('观察与反馈提示：巡视时关注书写区，针对误解给出定向反馈。');
    secs.push({ heading: `任务 ${i + 1}（教师）`, lines });
  });
  if (plan.unknowns.length) secs.push({ heading: '需教师核实（不进入学生/投屏）', lines: plan.unknowns.map((u) => `· ${u}`) });
  return secs;
}

// ---- 课堂 PPT：随任务展开；先题后答（合理答案/追问置于“课堂推进后展示”页）；不含私密学情与书写区 ----
interface Slide {
  title: string;
  body: string[];
  reveal?: boolean;
}
function presentationSlides(plan: LessonPlan, stamp: string): Slide[] {
  const slides: Slide[] = [{ title: plan.title, body: [stamp, `建议时长 ${minutes(plan.declared_duration_sec)}`] }];
  slides.push({ title: '学习目标', body: plan.objectives.map((o) => o.description) });
  plan.tasks.forEach((t, i) => {
    const body = [`任务：${t.prompt}`, sourceInstruction(plan, t)];
    // 活动指令（对应该任务的活动）
    const act = plan.activities.find((a) => a.task_ids.includes(t.task_id));
    if (act) body.push(`活动：${act.student_action}`);
    slides.push({ title: `任务 ${i + 1}`, body });
    // 参考答案与追问（课堂推进后展示）——允许在 PPT 呈现，但作为“揭示”页，不提前发学生
    const rub = plan.rubrics.find((r) => r.rubric_id === t.rubric_id);
    const revealBody: string[] = [];
    rub?.criteria.forEach((c) => {
      if (c.acceptable_variants.length) revealBody.push(`参考答案：${c.acceptable_variants.join('；')}`);
      if (c.insufficient_examples.length) revealBody.push(`常见误区：${c.insufficient_examples.join('；')}`);
    });
    if (t.teacher_notes) revealBody.push(`追问：${t.teacher_notes}`);
    if (revealBody.length) slides.push({ title: `任务 ${i + 1}·参考答案（课堂推进后展示）`, body: revealBody, reveal: true });
  });
  return slides;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- DOCX：段落 + 表格 + 书写留白（可编辑） ----
async function makeDocx(sections: Section[], spec: PresentationSpec): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.folder('_rels')!.file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const para = (text: string, bold = false): string => {
    const halfPoints = Math.round((bold ? 28 : 22) * spec.fontScale);
    const color = spec.theme === 'high_contrast' ? '000000' : bold ? '203040' : '202020';
    return `<w:p><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${halfPoints}"/><w:color w:val="${color}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  };
  const tableXml = (rows: string[][]): string => {
    const trs = rows
      .map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr><w:tcW w:w="2600" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${esc(c || ' ')}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`)
      .join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${trs}</w:tbl>`;
  };
  const body = sections
    .map((s) => {
      let x = para(s.heading, true);
      x += s.lines.map((l) => para(l)).join('');
      if (s.table) x += tableXml(s.table);
      if (s.writeLines) for (let i = 0; i < s.writeLines; i++) x += para('＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿');
      return x;
    })
    .join('');
  const pageSize = spec.paperSize === 'Letter' ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 };
  zip.folder('word')!.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="${pageSize.width}" w:h="${pageSize.height}"/></w:sectPr></w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---- PPTX：PptxGenJS 生成标准可编辑课件（16:9、标题与正文文本框、揭示页配色区分） ----
async function makePptx(slides: Slide[], spec: PresentationSpec): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'YW16x9', width: 10, height: 5.63 });
  pptx.layout = 'YW16x9';
  for (const s of slides) {
    const slide = pptx.addSlide();
    const highContrast = spec.theme === 'high_contrast';
    slide.background = { color: highContrast ? '000000' : s.reveal ? 'FFF7E6' : 'FFFFFF' };
    slide.addText(s.title, {
      x: 0.4,
      y: 0.3,
      w: 9.2,
      h: 0.8,
      fontSize: Math.round(24 * spec.fontScale),
      bold: true,
      fontFace: 'Microsoft YaHei',
      color: highContrast ? 'FFFFFF' : '203040'
    });
    slide.addText(
      s.body.map((t) => ({
        text: t,
        options: {
          bullet: true,
          fontSize: Math.round(16 * spec.fontScale),
          fontFace: 'Microsoft YaHei',
          color: highContrast ? 'FFFFFF' : '202020',
          breakLine: true
        }
      })),
      { x: 0.6, y: 1.3, w: 8.8, h: 4.0, valign: 'top' }
    );
  }
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

// ---- PDF：pdfkit + 内置 CJK 字体（缺失即失败，不静默成功） ----
export async function renderSectionsPdf(
  sections: Section[],
  fontPath: string | null,
  spec: PresentationSpec = DEFAULT_PRESENTATION_SPEC
): Promise<Buffer> {
  if (!fontPath) throw new FontMissingError(); // 目标平台字体缺失 → 阻止成为合格成品
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const PDFDocument = require('pdfkit');
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 48, size: spec.paperSize });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.registerFont('cjk', fontPath);
      doc.fillColor(spec.theme === 'high_contrast' ? '#000000' : '#202020');
      const writeMixed = (value: string, fontSize: number): void => {
        const runs = value.match(/[ -~]+|[^ -~]+/g) ?? [value];
        runs.forEach((run, index) => {
          const ascii = [...run].every((char) => {
            const code = char.charCodeAt(0);
            return code >= 32 && code <= 126;
          });
          doc
            .font(ascii ? 'Helvetica' : 'cjk')
            .fontSize(fontSize)
            .text(run, { width: 500, continued: index < runs.length - 1 });
        });
      };
      for (const s of sections) {
        writeMixed(s.heading, 15 * spec.fontScale);
        for (const l of s.lines) writeMixed(l, 12 * spec.fontScale);
        if (s.table) for (const row of s.table) writeMixed(row.join('  |  '), 12 * spec.fontScale);
        if (s.writeLines) for (let i = 0; i < s.writeLines; i++) writeMixed('＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿', 12 * spec.fontScale);
        doc.moveDown(0.5);
      }
      doc.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}

function withHash(role: MaterialRole, format: MaterialFormat, filename: string, bytes: Buffer): GeneratedFile {
  return { role, format, filename, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function buildMaterialSet(
  plan: LessonPlan,
  contentOrigin: string,
  presentationSpec: PresentationSpec = DEFAULT_PRESENTATION_SPEC
): Promise<MaterialSet> {
  const stamp = versionStamp(plan, contentOrigin);
  const student = studentSections(plan, stamp);
  const teacher = teacherSections(plan, stamp);
  const slides = presentationSlides(plan, stamp);
  const base = plan.title.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'lesson';
  const files: GeneratedFile[] = [
    withHash('presentation', 'pptx', `${base}-课堂.pptx`, await makePptx(slides, presentationSpec)),
    withHash('student', 'docx', `${base}-学生讲义.docx`, await makeDocx(student, presentationSpec)),
    withHash('student', 'pdf', `${base}-学生讲义.pdf`, await renderSectionsPdf(student, resolveCjkFont(), presentationSpec)),
    withHash('teacher', 'docx', `${base}-教师讲义.docx`, await makeDocx(teacher, presentationSpec)),
    withHash('teacher', 'pdf', `${base}-教师讲义.pdf`, await renderSectionsPdf(teacher, resolveCjkFont(), presentationSpec))
  ];
  return { planId: plan.plan_id, revisionId: plan.revision_id, contentOrigin, versionStamp: stamp, files };
}
