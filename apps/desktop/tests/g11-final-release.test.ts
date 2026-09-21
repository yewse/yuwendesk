import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error pure root ESM module
import {
  canonicalizeReleaseText,
  exitCodeForDisposition,
  releaseVerificationExitCode,
  renderFinalStatus,
  renderKnownLimitations,
  validatePublicReleaseText,
  validateTeacherGuide,
  verifyReleaseCandidate
} from '../../../scripts/lib/g11-release-verify.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('G11-T04 formal release gate', () => {
  it('returns zero only for RELEASE_READY', () => {
    expect(exitCodeForDisposition('RELEASE_READY')).toBe(0);
    expect(exitCodeForDisposition('CONTROLLED_TRIAL')).toBe(2);
    expect(exitCodeForDisposition('UNSIGNED_TEST_BUILD')).toBe(2);
    expect(exitCodeForDisposition('BLOCKED')).toBe(2);
    expect(exitCodeForDisposition('UNKNOWN')).toBe(1);
  });

  it('treats structural errors and inconsistent ready claims as invalid, while truthful blockers exit two', () => {
    expect(releaseVerificationExitCode({
      structuralErrors: ['RELEASE_DOCUMENT_MISSING'],
      disposition: 'BLOCKED',
      verification: { ok: false, errors: ['RELEASE_DOCUMENT_MISSING'] }
    })).toBe(1);
    expect(releaseVerificationExitCode({
      structuralErrors: [],
      disposition: 'RELEASE_READY',
      verification: { ok: false, errors: ['RELEASE_SIGNATURE_REQUIRED'] }
    })).toBe(1);
    expect(releaseVerificationExitCode({
      structuralErrors: [],
      disposition: 'BLOCKED',
      verification: { ok: false, errors: ['RELEASE_DISPOSITION_NOT_READY'] }
    })).toBe(2);
    expect(releaseVerificationExitCode({
      structuralErrors: [],
      disposition: 'RELEASE_READY',
      verification: { ok: true, errors: [] }
    })).toBe(0);
  });

  it('rejects stale checksums, missing final documents, environment mismatch, and non-valid signatures', () => {
    const result = verifyReleaseCandidate({
      releaseDisposition: 'RELEASE_READY',
      checksumStatus: 'MISMATCH',
      requiredDocumentsPresent: false,
      formalEnvironmentMatch: false,
      signatureStatus: 'UNSIGNED',
      cleanWindowsPassed: false,
      distributionAuthorized: false,
      defectAuditStatus: 'NOT_RUN'
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'RELEASE_CHECKSUM_INVALID',
      'RELEASE_DOCUMENT_MISSING',
      'RELEASE_ENVIRONMENT_MISMATCH',
      'RELEASE_SIGNATURE_REQUIRED',
      'RELEASE_WINDOWS_EVIDENCE_REQUIRED',
      'RELEASE_DISTRIBUTION_NOT_AUTHORIZED',
      'RELEASE_DEFECT_AUDIT_REQUIRED'
    ]));
  });

  it('does not accept a non-ready aggregate even when every subordinate gate claims ready', () => {
    const result = verifyReleaseCandidate({
      releaseDisposition: 'CONTROLLED_TRIAL',
      checksumStatus: 'VALID',
      requiredDocumentsPresent: true,
      formalEnvironmentMatch: true,
      signatureStatus: 'SIGNED_VALID',
      cleanWindowsPassed: true,
      distributionAuthorized: true,
      defectAuditStatus: 'COMPLETE'
    });
    expect(result).toEqual({ ok: false, errors: ['RELEASE_DISPOSITION_NOT_READY'] });
  });

  it('renders final reports deterministically by blocker code and affected scope', () => {
    const evidence = {
      generatedAt: '2026-09-20T00:00:00.000Z',
      sourceCommit: 'a'.repeat(40),
      statuses: {
        softwareStatus: 'BLOCKED', resourceCoverageStatus: 'BLOCKED', teachingValidationStatus: 'NOT_REVIEWED',
        artifactClass: 'NONE', releaseDisposition: 'BLOCKED', reasonCode: 'RELEASE_ARTIFACT_MISSING'
      },
      candidate: { expectedPath: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe', artifactPresent: false, sha256: null },
      supplyChain: {
        sbomStatus: 'PASS', checksumStatus: 'PASS', signatureStatus: 'NOT_RUN',
        checksumPath: 'reports/release/SHA256SUMS.txt', formalEnvironmentMatch: false
      },
      knownGaps: [
        { gapId: 'B', scope: 'z', status: 'BLOCKED', blockerCode: 'Z_CODE', externalInputIds: [], safeAction: 'z next' },
        { gapId: 'A', scope: 'a', status: 'BLOCKED', blockerCode: 'A_CODE', externalInputIds: ['EXT02'], safeAction: 'a next' }
      ]
    };
    const status = renderFinalStatus(evidence);
    const limitations = renderKnownLimitations(evidence);
    expect(status.indexOf('`A_CODE`')).toBeLessThan(status.indexOf('`Z_CODE`'));
    expect(limitations.indexOf('`A_CODE`')).toBeLessThan(limitations.indexOf('`Z_CODE`'));
    expect(status).toContain('reports/release/SHA256SUMS.txt');
    expect(status).not.toContain(`${'a'.repeat(64)}  reports/release/SHA256SUMS.txt`);
  });

  it('rejects local paths, secrets, student identifiers, model payloads, and stack traces in public release text', () => {
    for (const value of [
      '诊断位置：C:\\Users\\alice\\private.txt',
      '诊断位置：/home/alice/private.txt',
      '路径：`/home/alice/private.txt`',
      '`/Users/alice/private.txt`',
      '路径：`C:\\Users\\alice\\x`',
      '`\\\\server\\share\\x`',
      'api_key=sk-example123456789',
      '学生姓名：张三',
      '{"prompt":"完整模型输入"}',
      'Error: failed\n    at file:///C:/private/script.mjs:1:1'
    ]) {
      expect(validatePublicReleaseText(value).ok).toBe(false);
    }
    expect(validatePublicReleaseText('选项为和/或；公开说明：https://example.invalid/help；学生姓名不会写入报告。').ok).toBe(true);
  });
});

describe('G11-T04 teacher and final-status documentation contracts', () => {
  it('covers the real teacher workflows without development commands or false promises', () => {
    const guide = readFileSync(join(root, 'docs', 'TEACHER_QUICK_GUIDE.md'), 'utf8');
    for (const topic of [
      '安装与打开', '第一次设置', '备下一课', '三类五文件', '课堂展示', '只改一处', '课后观察',
      '模型辅助归因', '隐私与外发', '备份与换电脑', '离线更新', '诊断', '卸载与数据', '已知限制'
    ]) {
      expect(guide).toContain(topic);
    }
    for (const forbidden of [
      'npm run', 'node scripts/', 'PowerShell', '关闭 SmartScreen', '全部通过', '保证提分'
    ]) {
      expect(guide).not.toContain(forbidden);
    }
    expect(guide).toContain('先保存班级、教材和课时');
    expect(guide).toContain('生成方案并查看内容来源');
    expect(guide).toContain('软件审查通过后仍需教师确认');
    expect(guide).toContain('证据不足');
    expect(guide).toContain('打开应用内课堂展示');
    expect(guide).toContain('模型生成内容必须由教师复核');
    expect(guide).not.toContain('后续版本开放');
    expect(guide).not.toContain('仍为禁用状态');
    expect(guide).not.toContain('尚未提供课堂展示入口');
    expect(guide).not.toContain('尚未提供班级、教材或实际课时设置入口');
    expect(guide).not.toContain('没有足够证据');
    expect(validateTeacherGuide(guide)).toEqual({ ok: true, errors: [] });
  });

  it('keeps final status and limitations bound to the current aggregate blocker set', () => {
    const evidence = JSON.parse(readFileSync(join(root, 'reports', 'release', 'release-evidence.json'), 'utf8'));
    const finalStatus = readFileSync(join(root, 'reports', 'release', 'FINAL_STATUS.md'), 'utf8');
    const limitations = readFileSync(join(root, 'reports', 'release', 'KNOWN_LIMITATIONS.md'), 'utf8');
    expect(canonicalizeReleaseText(finalStatus)).toBe(renderFinalStatus(evidence));
    expect(canonicalizeReleaseText(limitations)).toBe(renderKnownLimitations(evidence));
    expect(finalStatus).toContain(`\`${evidence.statuses.releaseDisposition}\``);
    const blockerCodes = [...new Set(evidence.knownGaps.map((gap: { blockerCode: string }) => gap.blockerCode))];
    for (const blockerCode of blockerCodes) {
      expect(finalStatus).toContain(`\`${blockerCode}\``);
      expect(limitations).toContain(`\`${blockerCode}\``);
    }
  });
});
