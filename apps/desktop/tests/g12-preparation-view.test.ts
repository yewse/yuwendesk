import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LessonPlan } from '../src/main/lesson/types';
import type { PreparationSession } from '../src/main/preparation/types';
import type { ReviewReport } from '../src/main/review/types';
import { buildPreparationView } from '../src/renderer/preparation/viewModel';

function session(status: PreparationSession['status'], overrides: Partial<PreparationSession> = {}): PreparationSession {
  return {
    sessionId: 'session-1',
    contextId: 'context-1',
    status,
    mode: 'local_authored',
    focus: '抓住材料依据',
    coreTask: '依据片段概括要点',
    answerScope: '答案必须能由片段支持',
    planId: status === 'CONTEXT_DRAFT' || status === 'SOURCES_SELECTED' ? null : 'plan-1',
    revisionId: status === 'CONTEXT_DRAFT' || status === 'SOURCES_SELECTED' ? null : 'revision-1',
    reviewReportId: ['READY_TO_EXPORT', 'EXPORTING', 'EXPORTED'].includes(status) ? 'report-1' : null,
    bundleId: status === 'EXPORTED' ? 'bundle-1' : null,
    modelJobId: null,
    contentOrigin: 'teacher_authored',
    lastErrorCode: null,
    revision: 3,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    sources: status === 'CONTEXT_DRAFT' ? [] : [{
      sessionId: 'session-1', ordinal: 0, sourceVersionId: 'version-1', charStart: 0, charEnd: 8,
      purpose: 'textbook', approvedForModel: false, textSha256: 'a'.repeat(64)
    }],
    ...overrides
  };
}

const plan = {
  title: '《消息二则》第一课时',
  unknowns: ['本班学情仍需教师核实'],
  teacher_summary: '只使用已核验材料。'
} as LessonPlan;

const readyReport: ReviewReport = {
  report_id: 'report-1', plan_revision_id: 'revision-1', issues: [], disposition: 'ready_for_teacher',
  executed_checks: ['lesson_plan_schema'], not_executed_checks: ['human_pedagogy_review'], is_effectiveness_proof: false
};

describe('G12 preparation renderer view model', () => {
  it('removes the demo lesson operation from production IPC and renderer sources', () => {
    const files = [
      '../src/shared/ipc.ts',
      '../src/preload/index.ts',
      '../src/main/ipc.ts',
      '../src/main/schemaGate.ts',
      '../src/renderer/App.tsx'
    ];
    for (const relative of files) {
      const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      expect(text, relative).not.toContain('lesson.buildDemo');
    }
  });

  it.each([
    [null, 'context', 'save_context'],
    [session('CONTEXT_DRAFT'), 'sources', 'select_sources'],
    [session('SOURCES_SELECTED'), 'build', 'build_plan'],
    [session('BUILDING'), 'build', 'wait'],
    [session('PLAN_REVIEW'), 'review', 'run_review'],
    [session('PLAN_REVIEW'), 'review', 'confirm_plan', readyReport],
    [session('READY_TO_EXPORT'), 'export', 'export_files'],
    [session('EXPORTING'), 'export', 'wait'],
    [session('EXPORTED'), 'complete', 'open_presentation']
  ] as const)('maps %s to one legal primary action', (value, step, action, report) => {
    const view = buildPreparationView({ session: value, plan, report: report ?? null, artifacts: [] });
    expect(view.step).toBe(step);
    expect(view.primaryActions).toEqual([action]);
  });

  it('keeps export disabled until review confirmation and shows origin plus unknowns', () => {
    const reviewing = buildPreparationView({
      session: session('PLAN_REVIEW', { contentOrigin: 'model_assisted_simulated' }),
      plan,
      report: readyReport,
      artifacts: []
    });
    expect(reviewing.canExport).toBe(false);
    expect(reviewing.originLabel).toBe('模型辅助（模拟）');
    expect(reviewing.unknowns).toEqual(['本班学情仍需教师核实']);
    const ready = buildPreparationView({ session: session('READY_TO_EXPORT'), plan, report: readyReport, artifacts: [] });
    expect(ready.canExport).toBe(true);
  });

  it('offers the local fallback only after a model failure', () => {
    const failed = buildPreparationView({
      session: session('SOURCES_SELECTED', {
        mode: 'model_assisted', lastErrorCode: 'PREPARATION_MODEL_UNAVAILABLE'
      }),
      plan: null,
      report: null,
      artifacts: []
    });
    expect(failed.localFallbackAvailable).toBe(true);
    expect(buildPreparationView({
      session: session('SOURCES_SELECTED'), plan: null, report: null, artifacts: []
    }).localFallbackAvailable).toBe(false);
  });

  it('returns a closed display model without paths, keys, or raw prompts', () => {
    const value = session('EXPORTED') as PreparationSession & Record<string, unknown>;
    value.apiKey = 'should-never-render';
    value.rawModelPrompt = 'hidden-prompt';
    const view = buildPreparationView({
      session: value,
      plan: { ...plan, localPath: 'C:\\private\\lesson.docx' } as LessonPlan,
      report: readyReport,
      artifacts: [{
        role: 'teacher', format: 'docx', filename: '教师讲义.docx', sha256: 'b'.repeat(64), byteSize: 120
      }]
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('should-never-render');
    expect(serialized).not.toContain('hidden-prompt');
    expect(serialized).not.toContain('C:\\private');
    expect(view.artifacts[0]).toEqual({
      role: 'teacher', format: 'docx', filename: '教师讲义.docx', sha256: 'b'.repeat(64), byteSize: 120
    });
  });
});
