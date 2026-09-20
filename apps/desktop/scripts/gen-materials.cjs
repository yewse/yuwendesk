// 生成 G06 三类五文件到 /opt/cursor/artifacts/materials，并回解析验证（角色规则/版本一致/一处修改联动）。
// 自拟《春》完整课时计划（content_origin=authored，明确标注）。仅确定性文件生成，不涉及真实模型。
const fs = require('node:fs');
const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const { buildLessonPlan, demoLessonSpec, validateLessonPlan } = require(path.join(DIST, 'main', 'lesson', 'build.js'));
const { buildMaterialSet } = require(path.join(DIST, 'main', 'materials', 'generate.js'));
const { extractBuffer } = require(path.join(DIST, 'main', 'sources', 'extract.js'));

const OUT = process.env.MAT_OUT || '/opt/cursor/artifacts/materials';
fs.mkdirSync(OUT, { recursive: true });
const textOf = async (bytes, fmt) => (await extractBuffer(bytes, fmt)).fullText;

(async () => {
  const plan = buildLessonPlan(demoLessonSpec());
  console.log('MAT validate', JSON.stringify(validateLessonPlan(plan)));
  const set = await buildMaterialSet(plan, 'authored');
  const manifest = { planId: set.planId, revisionId: set.revisionId, contentOrigin: set.contentOrigin, versionStamp: set.versionStamp, files: [] };
  for (const f of set.files) {
    fs.writeFileSync(path.join(OUT, f.filename), f.bytes);
    manifest.files.push({ role: f.role, format: f.format, filename: f.filename, bytes: f.bytes.length, sha256: f.sha256 });
  }
  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  console.log('MAT files', JSON.stringify(manifest.files.map((x) => `${x.role}/${x.format}:${x.filename} (${x.bytes}B)`)));

  const s = await textOf(set.files.find((f) => f.role === 'student' && f.format === 'docx').bytes, 'docx');
  const t = await textOf(set.files.find((f) => f.role === 'teacher' && f.format === 'docx').bytes, 'docx');
  const p = await textOf(set.files.find((f) => f.format === 'pptx').bytes, 'pptx');
  const priv = ['本班是否已学拟人', '以朗读带动修辞体会', '范读并纠音'];
  const reveal = ['东风来了赋予人的动作', '把比喻误判为拟人', '拟人与比喻区别'];
  console.log('MAT student clean(private+answers) =', priv.every((x) => !s.includes(x)) && reveal.every((x) => !s.includes(x)));
  console.log('MAT student has writing space =', s.includes('＿') && s.includes('课本定位'));
  console.log('MAT ppt reveal answers(after advance) =', reveal.every((x) => p.includes(x)) && p.includes('课堂推进后展示') && priv.every((x) => !p.includes(x)));
  console.log('MAT teacher has answers+notes =', reveal.every((x) => t.includes(x)) && priv.every((x) => t.includes(x)));
  console.log('MAT version-consistency =', [s, t, p].every((x) => x.includes(plan.revision_id) && x.includes(plan.plan_id)));

  const spec2 = demoLessonSpec({ plan_id: plan.plan_id, previous_revision_id: plan.revision_id });
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
