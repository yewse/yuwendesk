// 生成 G06 三类五文件到 /opt/cursor/artifacts/materials，并回解析验证角色隔离/版本一致/一处修改联动。
// 自拟《春》完整课时计划（明确标注 content_origin=authored）。仅确定性文件生成，不涉及真实模型。
const fs = require('node:fs');
const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const { buildLessonPlan, validateLessonPlan } = require(path.join(DIST, 'main', 'lesson', 'build.js'));
const { buildMaterialSet } = require(path.join(DIST, 'main', 'materials', 'generate.js'));
const { extractBuffer } = require(path.join(DIST, 'main', 'sources', 'extract.js'));

const OUT = process.env.MAT_OUT || '/opt/cursor/artifacts/materials';
fs.mkdirSync(OUT, { recursive: true });

function chunSpec(over = {}) {
  return {
    title: '《春》第一课时',
    declared_duration_sec: 45 * 60,
    task_context_id: 'ctx_demo',
    objectives: [
      { description: '朗读课文，把握重音与停连', cognitive_demand: 'aesthetic_response' },
      { description: '找出比喻与拟人并体会其表达效果', cognitive_demand: 'explain' }
    ],
    anchors: [{ source_version_id: 'ver_demo', locator: { line: 2 }, quote: '盼望着，东风来了，春天的脚步近了。', source_class: 'public_reference', verification: 'exact_checked' }],
    tasks: [
      { prompt: '朗读第一段并标出重音与停连', cognitive_demand: 'aesthetic_response', support_level: 'partial_prompt', teacher_notes: '追问：为何反复“盼望着”？', acceptable_variants: ['重音落在盼望着，反复表期盼'], insufficient_examples: ['只标句末停顿'], anchorIndexes: [1] },
      { prompt: '找出一处拟人句并说明效果', cognitive_demand: 'explain', support_level: 'independent', teacher_notes: '追问：拟人与比喻区别？', acceptable_variants: ['东风来了赋予人的动作'], insufficient_examples: ['把比喻误判为拟人'], anchorIndexes: [1] }
    ],
    activities: [
      { title: '导入齐读', start_sec: 0, end_sec: 300, actor: 'both', student_action: '齐读课文', teacher_action: '范读并纠音', priority: 'essential', taskIndexes: [1] },
      { title: '研读修辞', start_sec: 300, end_sec: 1500, actor: 'student', student_action: '分组找修辞句', teacher_action: '巡视点拨并揭示合理答案', priority: 'essential', taskIndexes: [2] }
    ],
    homework: [{ description: '背诵第一段', necessary_reason: '积累语感', estimated_sec: 600, stop_condition: '能流畅背诵' }],
    teacher_summary: '以朗读带动修辞体会，注意情感与语言结合。',
    unknowns: ['本班是否已学拟人（需教师核实）'],
    ...over
  };
}

async function textOf(bytes, format) {
  return (await extractBuffer(bytes, format)).fullText;
}

(async () => {
  const plan = buildLessonPlan(chunSpec());
  const v = validateLessonPlan(plan);
  console.log('MAT validate', JSON.stringify(v));
  const set = await buildMaterialSet(plan, 'authored');
  const manifest = { planId: set.planId, revisionId: set.revisionId, contentOrigin: set.contentOrigin, versionStamp: set.versionStamp, files: [] };
  for (const f of set.files) {
    const p = path.join(OUT, f.filename);
    fs.writeFileSync(p, f.bytes);
    manifest.files.push({ role: f.role, format: f.format, filename: f.filename, bytes: f.bytes.length, sha256: f.sha256 });
  }
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  console.log('MAT files', JSON.stringify(manifest.files.map((x) => `${x.role}/${x.format}:${x.filename} (${x.bytes}B)`)));

  // 回解析验证
  const sDocx = set.files.find((f) => f.role === 'student' && f.format === 'docx');
  const tDocx = set.files.find((f) => f.role === 'teacher' && f.format === 'docx');
  const pptx = set.files.find((f) => f.format === 'pptx');
  const sText = await textOf(sDocx.bytes, 'docx');
  const tText = await textOf(tDocx.bytes, 'docx');
  const pText = await textOf(pptx.bytes, 'pptx');
  const teacherOnly = ['范读并纠音', '把比喻误判为拟人', '追问：为何反复', '巡视点拨并揭示合理答案'];
  console.log('MAT role-isolation studentDocx clean =', teacherOnly.every((s) => !sText.includes(s)));
  console.log('MAT role-isolation pptx clean =', teacherOnly.every((s) => !pText.includes(s)));
  console.log('MAT teacherDocx has answers =', teacherOnly.every((s) => tText.includes(s)));
  console.log('MAT version-consistency all embed revision =', [sText, tText, pText].every((t) => t.includes(plan.revision_id)));

  // 一处修改联动
  const spec2 = chunSpec({ plan_id: plan.plan_id, previous_revision_id: plan.revision_id });
  spec2.tasks[0].prompt = '朗读第一段并标注情感变化（修订）';
  const plan2 = buildLessonPlan(spec2);
  const set2 = await buildMaterialSet(plan2, 'authored');
  const s2 = await textOf(set2.files.find((f) => f.role === 'student' && f.format === 'docx').bytes, 'docx');
  const p2 = await textOf(set2.files.find((f) => f.format === 'pptx').bytes, 'pptx');
  console.log('MAT one-edit-propagation =', s2.includes('标注情感变化（修订）') && p2.includes('标注情感变化（修订）') && plan2.plan_id === plan.plan_id && plan2.revision_id !== plan.revision_id);
  console.log('MAT DONE OUT=' + OUT);
})().catch((e) => {
  console.error('MAT FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
