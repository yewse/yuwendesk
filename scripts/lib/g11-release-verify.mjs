const RELEASE_DISPOSITIONS = new Set([
  'RELEASE_READY', 'CONTROLLED_TRIAL', 'UNSIGNED_TEST_BUILD', 'BLOCKED'
]);
const TEACHER_GUIDE_TOPICS = Object.freeze([
  '安装与打开', '第一次设置', '备下一课', '三类五文件', '课堂展示', '只改一处', '课后观察',
  '模型辅助归因', '隐私与外发', '备份与换电脑', '离线更新', '诊断', '卸载与数据', '已知限制'
]);
const TEACHER_GUIDE_FORBIDDEN = Object.freeze([
  'npm run', 'node scripts/', 'PowerShell', '关闭 SmartScreen', '全部通过', '保证提分'
]);

export function canonicalizeReleaseText(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/gu, '\n') : text;
}

function sortedGaps(evidence) {
  return [...(Array.isArray(evidence?.knownGaps) ? evidence.knownGaps : [])].sort((left, right) =>
    String(left?.blockerCode ?? '').localeCompare(String(right?.blockerCode ?? ''), 'en') ||
    String(left?.scope ?? '').localeCompare(String(right?.scope ?? ''), 'zh-CN') ||
    String(left?.gapId ?? '').localeCompare(String(right?.gapId ?? ''), 'en'));
}

export function exitCodeForDisposition(disposition) {
  if (!RELEASE_DISPOSITIONS.has(disposition)) return 1;
  return disposition === 'RELEASE_READY' ? 0 : 2;
}

export function releaseVerificationExitCode({ structuralErrors, disposition, verification }) {
  if (!Array.isArray(structuralErrors) || structuralErrors.length > 0) return 1;
  if (disposition === 'RELEASE_READY' && verification?.ok !== true) return 1;
  return exitCodeForDisposition(disposition);
}

export function verifyReleaseCandidate(input) {
  const errors = [];
  if (input?.checksumStatus !== 'VALID') errors.push('RELEASE_CHECKSUM_INVALID');
  if (input?.requiredDocumentsPresent !== true) errors.push('RELEASE_DOCUMENT_MISSING');
  if (input?.formalEnvironmentMatch !== true) errors.push('RELEASE_ENVIRONMENT_MISMATCH');
  if (input?.signatureStatus !== 'SIGNED_VALID') errors.push('RELEASE_SIGNATURE_REQUIRED');
  if (input?.cleanWindowsPassed !== true) errors.push('RELEASE_WINDOWS_EVIDENCE_REQUIRED');
  if (input?.distributionAuthorized !== true) errors.push('RELEASE_DISTRIBUTION_NOT_AUTHORIZED');
  if (input?.defectAuditStatus !== 'COMPLETE') errors.push('RELEASE_DEFECT_AUDIT_REQUIRED');
  if (input?.releaseDisposition !== 'RELEASE_READY') errors.push('RELEASE_DISPOSITION_NOT_READY');
  return { ok: errors.length === 0, errors };
}

export function validatePublicReleaseText(text) {
  const errors = [];
  if (typeof text !== 'string' || text.length === 0) return { ok: false, errors: ['RELEASE_PUBLIC_TEXT_INVALID'] };
  const hasWindowsDrivePath = /(?:^|[^\p{L}\p{N}+.\-])[A-Za-z]:[\\/]/u.test(text);
  const hasUncPath = /(?:^|[^\\])\\\\[^\\\s]+\\/u.test(text);
  const hasPosixPath = /(?:^|[^\p{L}\p{N}+.\-:/])\/(?!\/)[^\s`<>)\]}]+/u.test(text);
  if (hasWindowsDrivePath || hasUncPath || /file:\/\//i.test(text) || hasPosixPath) {
    errors.push('RELEASE_PUBLIC_TEXT_LOCAL_PATH');
  }
  if (/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text) ||
      /(?:api[_ -]?key|password|secret[_ -]?value)\s*[:=：]\s*\S+/i.test(text)) {
    errors.push('RELEASE_PUBLIC_TEXT_SECRET');
  }
  if (/(?:学生姓名|学号|身份证号?|手机号)\s*[:=：]\s*\S+/i.test(text)) {
    errors.push('RELEASE_PUBLIC_TEXT_STUDENT_IDENTIFIER');
  }
  if (/["'](?:prompt|messages|modelInput|modelOutput|fullPrompt)["']\s*:\s*/i.test(text)) {
    errors.push('RELEASE_PUBLIC_TEXT_MODEL_PAYLOAD');
  }
  if (/(?:^|\n)\s*at\s+(?:file:\/\/|[^\n]*\([^\n]*:\d+:\d+\))/i.test(text)) {
    errors.push('RELEASE_PUBLIC_TEXT_STACK_TRACE');
  }
  return { ok: errors.length === 0, errors };
}

export function validateTeacherGuide(text) {
  const errors = [...validatePublicReleaseText(text).errors];
  for (const topic of TEACHER_GUIDE_TOPICS) {
    if (!text.includes(topic)) errors.push(`TEACHER_GUIDE_TOPIC_MISSING:${topic}`);
  }
  for (const forbidden of TEACHER_GUIDE_FORBIDDEN) {
    if (text.includes(forbidden)) errors.push(`TEACHER_GUIDE_FORBIDDEN:${forbidden}`);
  }
  return { ok: errors.length === 0, errors };
}

export function renderKnownLimitations(evidence) {
  const gaps = sortedGaps(evidence);
  const lines = [
    '# 已知限制与未关闭发行门',
    '',
    `当前发行判定：\`${evidence.statuses.releaseDisposition}\`（\`${evidence.statuses.reasonCode}\`）。`,
    '',
    `校验清单：\`${evidence.supplyChain.checksumPath}\`。本文件不嵌入该清单自身的哈希。`,
    '',
    '以下内容来自同一份机器可读发行证据。不得通过关闭系统保护、跳过签名、绕过隐私授权或删除验收项来关闭这些门。',
    ''
  ];
  for (const gap of gaps) {
    lines.push(
      `## ${gap.gapId}`,
      '',
      `- 阻断码：\`${gap.blockerCode}\``,
      `- 范围：${gap.scope}`,
      `- 状态：${gap.status}`,
      `- 外部输入：${gap.externalInputIds.length > 0 ? gap.externalInputIds.join('、') : '无'}`,
      `- 安全下一步：${gap.safeAction}`,
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderFinalStatus(evidence) {
  const gaps = sortedGaps(evidence);
  const candidateHash = evidence.candidate.sha256 ?? '无（候选安装器不存在）';
  const lines = [
    '# 语文备课工作台最终发行状态',
    '',
    `- 生成时间：${evidence.generatedAt}`,
    `- 源码提交：\`${evidence.sourceCommit}\``,
    `- 最终判定：\`${evidence.statuses.releaseDisposition}\``,
    `- 判定理由：\`${evidence.statuses.reasonCode}\``,
    `- 软件工程状态：\`${evidence.statuses.softwareStatus}\``,
    `- 资源覆盖状态：\`${evidence.statuses.resourceCoverageStatus}\``,
    `- 教学专业复核：\`${evidence.statuses.teachingValidationStatus}\``,
    `- 制品类别：\`${evidence.statuses.artifactClass}\``,
    '',
    '## 当前候选与供应链',
    '',
    `- 固定候选路径：\`${evidence.candidate.expectedPath}\``,
    `- 候选存在：${evidence.candidate.artifactPresent ? '是' : '否'}`,
    `- 候选 SHA-256：${candidateHash}`,
    `- SBOM：\`${evidence.supplyChain.sbomStatus}\``,
    `- 校验清单：\`${evidence.supplyChain.checksumStatus}\`；路径 \`${evidence.supplyChain.checksumPath}\``,
    `- 签名：\`${evidence.supplyChain.signatureStatus}\``,
    `- 锁定环境一致：${evidence.supplyChain.formalEnvironmentMatch === true ? '是' : '否'}`,
    '',
    '本状态页不嵌入校验清单自身的哈希。正式发行校验必须重新读取清单并逐文件计算。',
    '',
    '## 未关闭阻断',
    ''
  ];
  for (const gap of gaps) {
    lines.push(
      `- \`${gap.blockerCode}\`｜${gap.scope}｜${gap.status}｜${gap.safeAction}`
    );
  }
  lines.push('', '## 结论', '');
  if (evidence.statuses.releaseDisposition === 'RELEASE_READY') {
    lines.push('所有机器校验门均已满足；仍应按授权分发位置和支持流程发布。');
  } else {
    lines.push('当前不是正式教师发行版，不得公开分发，也不得把工程自动化结果表述为真实 Windows、签名、隐私授权或教学效果证据。');
  }
  return `${lines.join('\n')}\n`;
}
