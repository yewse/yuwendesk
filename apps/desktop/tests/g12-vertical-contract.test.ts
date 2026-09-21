import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMPLEMENTED_OPERATIONS } from '../src/shared/ipc';

// @ts-expect-error pure root ESM module
import {
  FROZEN_DEFINITION_SOURCES,
  loadAcceptanceDefinitions,
  validateG12VerticalEvidenceInput
} from '../../../scripts/lib/g11-acceptance.mjs';
// @ts-expect-error pure root ESM module
import { validateTeacherGuide } from '../../../scripts/lib/g11-release-verify.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('G12-T04 current workflow delivery contracts', () => {
  it('documents the enabled preparation-to-presentation workflow without weakening external gates', () => {
    const guide = readFileSync(join(root, 'docs', 'TEACHER_QUICK_GUIDE.md'), 'utf8');
    for (const required of [
      '班级', '教材', '课时', '导入资料', '生成方案', '软件审查', '教师确认',
      '课堂 PPT', '学生讲义', '教师讲解版', '课堂展示', '一处修改',
      '模型生成内容必须由教师复核', 'Office/WPS', '未签名'
    ]) {
      expect(guide).toContain(required);
    }
    for (const removed of [
      '后续版本开放',
      '仍为禁用状态',
      '尚未提供真实的资料解读',
      '尚未提供课堂展示入口',
      '尚未提供班级、教材或实际课时设置入口'
    ]) {
      expect(guide).not.toContain(removed);
    }
    expect(validateTeacherGuide(guide)).toEqual({ ok: true, errors: [] });
  });

  it('keeps the production path named and removes the demo operation', () => {
    expect(IMPLEMENTED_OPERATIONS).toEqual(expect.arrayContaining([
      'preparation.context.save',
      'preparation.session.create',
      'preparation.sources.set',
      'preparation.build',
      'preparation.review',
      'preparation.confirm',
      'preparation.export',
      'preparation.resume',
      'presentation.open',
      'presentation.get',
      'presentation.close'
    ]));
    expect(IMPLEMENTED_OPERATIONS).not.toContain('lesson.buildDemo');
  });

  it('does not modify the frozen 130 plus 40 acceptance definitions', () => {
    expect(FROZEN_DEFINITION_SOURCES).toEqual([
      {
        path: 'acceptance/cases.json',
        count: 130,
        sha256: 'cb215e1ff2da5f6c2a1495b6e14da2e9f0e1e4a7b179031dd08baffc6745eed5'
      },
      {
        path: 'acceptance/addenda/classroom-delivery.cases.json',
        count: 40,
        sha256: 'f7238e8f927d0c6968d8d6bba1a8cadb1e7fd3f54c37a94fc0d07038c9c5fd06'
      }
    ]);
    const loaded = loadAcceptanceDefinitions(root);
    expect(loaded.definitions).toHaveLength(170);
    expect(loaded.definitions.every((entry: { status: string }) => entry.status === 'NOT_RUN')).toBe(true);
  });

  it('accepts only sanitized G12 evidence bound to the current source and candidate bytes', () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'yuwendesk-g12-evidence-'));
    const candidatePath = join(evidenceRoot, 'apps', 'desktop', 'release', 'YuwenDesk-Setup-0.1.0-x64.exe');
    mkdirSync(join(evidenceRoot, 'apps', 'desktop', 'release'), { recursive: true });
    const candidate = Buffer.from('candidate-under-test');
    writeFileSync(candidatePath, candidate);
    const sourceCommit = 'a'.repeat(40);
    const report = {
      schemaVersion: 1,
      sourceCommit,
      startedAt: '2026-09-21T00:00:00.000Z',
      completedAt: '2026-09-21T00:01:00.000Z',
      candidate: {
        path: 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe',
        sha256: createHash('sha256').update(candidate).digest('hex'),
        sizeBytes: candidate.byteLength
      },
      environment: { os: 'win32', release: '10.0.26200', arch: 'x64', electron: '44.4.3' },
      syntheticDataOnly: true,
      frozenAcceptanceCasesUpdated: false,
      observations: {
        artifactCount: 5,
        reviewDisposition: 'ready_for_teacher',
        presentationOpened: true,
        taskVisible: true,
        answerVisible: true,
        changedFileCount: 5,
        restartStatus: 'EXPORTED',
        revisionAdvanced: true,
        bundleAdvanced: true,
        sqliteIntegrity: 'ok'
      },
      passed: true
    };
    expect(validateG12VerticalEvidenceInput({ root: evidenceRoot, sourceCommit, report })).toEqual({ ok: true, errors: [] });
    expect(validateG12VerticalEvidenceInput({ root: evidenceRoot, sourceCommit: 'b'.repeat(40), report }).ok).toBe(false);
    writeFileSync(candidatePath, 'drifted-candidate');
    expect(validateG12VerticalEvidenceInput({ root: evidenceRoot, sourceCommit, report }).ok).toBe(false);
    expect(validateG12VerticalEvidenceInput({
      root: evidenceRoot,
      sourceCommit,
      report: { ...report, rawPrompt: 'must be rejected' }
    }).ok).toBe(false);
  });
});
