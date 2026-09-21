import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildLessonPlan, demoLessonSpec } from '../src/main/lesson/build';
import type { PreparationSession, TeachingContext } from '../src/main/preparation/types';
import {
  PresentationEligibilityError,
  PresentationService,
  PresentationWindowRegistry,
  isBoundPresentationRequest,
  initialRevealState,
  revealAnswer,
  revealHint
} from '../src/main/presentation/service';

function fixture(status: PreparationSession['status'] = 'READY_TO_EXPORT') {
  const sourceText = '盼望着，东风来了，春天的脚步近了。';
  const plan = buildLessonPlan(demoLessonSpec());
  const context: TeachingContext = {
    contextId: plan.task_context_id, classDisplayName: '七年级一班', grade: 'grade7',
    textbookTitle: '语文七年级上册', textbookEdition: '统编版', unitTitle: '第一单元',
    lessonTitle: '春', durationSec: 2700, notes: '', revision: 1,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z'
  };
  const session: PreparationSession = {
    sessionId: 'session-1', contextId: context.contextId, status, mode: 'local_authored',
    focus: '朗读', coreTask: '朗读并标注', answerScope: '有材料依据即可',
    planId: plan.plan_id, revisionId: plan.revision_id, reviewReportId: 'report-1', bundleId: null,
    modelJobId: null, contentOrigin: 'teacher_authored', lastErrorCode: null, revision: 5,
    createdAt: context.createdAt, updatedAt: context.updatedAt,
    sources: [{
      sessionId: 'session-1', ordinal: 0, sourceVersionId: 'ver_demo', charStart: 0,
      charEnd: sourceText.length, purpose: 'textbook', approvedForModel: false,
      textSha256: createHash('sha256').update(sourceText).digest('hex')
    }]
  };
  const revision = {
    planId: plan.plan_id, revisionId: plan.revision_id, previousRevisionId: null, title: plan.title,
    contentJson: JSON.stringify(plan), contentOrigin: 'teacher_authored', valid: true, createdAt: context.createdAt
  };
  const report = {
    reportId: 'report-1', planId: plan.plan_id, revisionId: plan.revision_id, createdAt: context.createdAt,
    report: {
      report_id: 'report-1', plan_revision_id: plan.revision_id, issues: [], disposition: 'ready_for_teacher' as const,
      executed_checks: ['lesson_plan_schema'], not_executed_checks: ['human_pedagogy_review'], is_effectiveness_proof: false as const
    }
  };
  const store = {
    getPreparationSession: (id: string) => id === session.sessionId ? session : null,
    getTeachingContext: (id: string) => id === context.contextId ? context : null,
    getLessonRevision: (id: string, revisionId?: string) =>
      id === plan.plan_id && (!revisionId || revisionId === plan.revision_id) ? revision : null,
    getLatestReviewReport: () => report,
    getVersionMeta: (id: string) => id === 'ver_demo' ? {
      versionId: id, status: 'active', isCurrent: true, classification: 'public_reference'
    } : null,
    readExactRange: (id: string, start: number, end: number) =>
      id === 'ver_demo' && start === 0 && end === sourceText.length
        ? { text: sourceText, fullLength: sourceText.length }
        : null
  };
  return { plan, session, store };
}

describe('G12 restricted classroom presentation', () => {
  it.each(['CONTEXT_DRAFT', 'SOURCES_SELECTED', 'PLAN_REVIEW'] as const)(
    'refuses an unconfirmed %s session',
    (status) => {
      const f = fixture(status);
      expect(() => new PresentationService(f.store).open(f.session.sessionId))
        .toThrowError(PresentationEligibilityError);
    }
  );

  it('refuses a stale plan revision', () => {
    const f = fixture();
    const store = { ...f.store, getLessonRevision: (_id: string, revisionId?: string) => revisionId ? f.store.getLessonRevision(_id, revisionId) : null };
    expect(() => new PresentationService(store).open(f.session.sessionId))
      .toThrowError(PresentationEligibilityError);
  });

  it('builds task-first slides and reveals hints and answers only on explicit actions', () => {
    const f = fixture();
    const dto = new PresentationService(f.store).open(f.session.sessionId);
    expect(dto.slides[0]).toMatchObject({ kind: 'task', prompt: f.plan.tasks[0].prompt });
    const initial = initialRevealState(dto);
    expect(initial).toEqual({ hints: [], answers: [] });
    const hinted = revealHint(initial, dto.slides[0].slideId);
    expect(hinted.hints).toEqual([dto.slides[0].slideId]);
    expect(hinted.answers).toEqual([]);
    const answered = revealAnswer(hinted, dto.slides[0].slideId);
    expect(answered.answers).toEqual([dto.slides[0].slideId]);
  });

  it('omits file paths, source bodies, and network endpoints from the DTO', () => {
    const f = fixture('EXPORTED');
    const dto = new PresentationService(f.store).open(f.session.sessionId);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toMatch(/(?:file:\/\/|https?:\/\/|[A-Za-z]:\\|\\\\)/u);
    expect(serialized).not.toContain('source_anchors');
    expect(Object.keys(dto).sort()).toEqual([
      'classDisplayName', 'contentOrigin', 'lessonTitle', 'planId', 'revisionId', 'sessionId', 'slides', 'title'
    ]);
  });

  it('keeps one active presentation per owner and closes without data mutation', () => {
    const registry = new PresentationWindowRegistry<FakeWindow>();
    const data = { revision: 5 };
    const first = new FakeWindow();
    expect(registry.open('main-1', 'session-1', () => first)).toEqual({ window: first, reused: false });
    expect(registry.open('main-1', 'session-1', () => new FakeWindow())).toEqual({ window: first, reused: true });
    expect(first.focusCount).toBe(1);
    registry.close('main-1');
    expect(first.closed).toBe(true);
    expect(data).toEqual({ revision: 5 });
  });

  it('binds presentation reads to the exact sender window and session', () => {
    const bindings = new Map([[41, 'session-1']]);
    expect(isBoundPresentationRequest(bindings, 41, 'presentation.get', 'session-1')).toBe(true);
    expect(isBoundPresentationRequest(bindings, 41, 'presentation.get', 'session-2')).toBe(false);
    expect(isBoundPresentationRequest(bindings, 42, 'presentation.get', 'session-1')).toBe(false);
    expect(isBoundPresentationRequest(bindings, 41, 'preparation.resume', 'session-1')).toBe(false);
    expect(isBoundPresentationRequest(bindings, 41, 'presentation.close')).toBe(true);
  });
});

class FakeWindow {
  closed = false;
  focusCount = 0;
  private listeners: Array<() => void> = [];
  isDestroyed(): boolean { return this.closed; }
  focus(): void { this.focusCount += 1; }
  close(): void {
    this.closed = true;
    for (const listener of this.listeners) listener();
  }
  once(_event: 'closed', listener: () => void): void { this.listeners.push(listener); }
}
