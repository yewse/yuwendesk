import { createHash } from 'node:crypto';
import type { LessonPlan } from '../lesson/types';
import type { PreparationSession, TeachingContext } from '../preparation/types';
import type { LessonRevisionRecord, ReviewReportRecord } from '../store';

export interface PresentationSlideDTO {
  slideId: string;
  kind: 'task';
  title: string;
  prompt: string;
  hint: string;
  answerScope: string[];
}

export interface PresentationDTO {
  sessionId: string;
  planId: string;
  revisionId: string;
  title: string;
  lessonTitle: string;
  classDisplayName: string;
  contentOrigin: PreparationSession['contentOrigin'];
  slides: PresentationSlideDTO[];
}

export interface PresentationRevealState {
  hints: string[];
  answers: string[];
}

interface PresentationStore {
  getPreparationSession(sessionId: string): PreparationSession | null;
  getTeachingContext(contextId: string): TeachingContext | null;
  getLessonRevision(planId: string, revisionId?: string): LessonRevisionRecord | null;
  getLatestReviewReport(planId: string, revisionId: string): ReviewReportRecord | null;
  getVersionMeta(versionId: string): { status: string; isCurrent: boolean } | null;
  readExactRange(versionId: string, charStart: number, charEnd: number): { text: string; fullLength: number } | null;
}

export class PresentationEligibilityError extends Error {
  constructor() {
    super('PRESENTATION_NOT_ELIGIBLE');
    this.name = 'PresentationEligibilityError';
  }
}

const UNSAFE_PRESENTATION_TEXT = /(?:file:\/\/|https?:\/\/|[A-Za-z]:\\|\\\\)/u;

function assertSafeText(value: string): void {
  if (UNSAFE_PRESENTATION_TEXT.test(value)) throw new PresentationEligibilityError();
}

function taskOrder(plan: LessonPlan): LessonPlan['tasks'] {
  const byId = new Map(plan.tasks.map((task) => [task.task_id, task]));
  const ordered: LessonPlan['tasks'] = [];
  const seen = new Set<string>();
  for (const activity of plan.activities) {
    for (const taskId of activity.task_ids) {
      const task = byId.get(taskId);
      if (task && !seen.has(taskId)) {
        ordered.push(task);
        seen.add(taskId);
      }
    }
  }
  for (const task of plan.tasks) {
    if (!seen.has(task.task_id)) ordered.push(task);
  }
  return ordered;
}

export class PresentationService {
  constructor(private readonly store: PresentationStore) {}

  open(sessionId: string): PresentationDTO {
    const session = this.store.getPreparationSession(sessionId);
    if (!session || !['READY_TO_EXPORT', 'EXPORTED'].includes(session.status) ||
        !session.planId || !session.revisionId || !session.reviewReportId) {
      throw new PresentationEligibilityError();
    }
    const context = this.store.getTeachingContext(session.contextId);
    const revision = this.store.getLessonRevision(session.planId, session.revisionId);
    const current = this.store.getLessonRevision(session.planId);
    const report = this.store.getLatestReviewReport(session.planId, session.revisionId);
    if (!context || !revision || !revision.valid || current?.revisionId !== session.revisionId ||
        !report || report.reportId !== session.reviewReportId || report.report.disposition !== 'ready_for_teacher') {
      throw new PresentationEligibilityError();
    }
    for (const selected of session.sources) {
      const meta = this.store.getVersionMeta(selected.sourceVersionId);
      const exact = this.store.readExactRange(selected.sourceVersionId, selected.charStart, selected.charEnd);
      if (!meta || meta.status !== 'active' || !meta.isCurrent || !exact || selected.charEnd > exact.fullLength ||
          createHash('sha256').update(exact.text).digest('hex') !== selected.textSha256) {
        throw new PresentationEligibilityError();
      }
    }
    let plan: LessonPlan;
    try { plan = JSON.parse(revision.contentJson) as LessonPlan; } catch { throw new PresentationEligibilityError(); }
    const slides = taskOrder(plan).map((task, index) => {
      const rubric = plan.rubrics.find((value) => value.rubric_id === task.rubric_id);
      const answerScope = rubric?.criteria.flatMap((criterion) => criterion.acceptable_variants) ?? [];
      const slide: PresentationSlideDTO = {
        slideId: task.task_id,
        kind: 'task',
        title: `任务 ${index + 1}`,
        prompt: task.prompt,
        hint: task.teacher_notes,
        answerScope
      };
      [slide.title, slide.prompt, slide.hint, ...slide.answerScope].forEach(assertSafeText);
      return slide;
    });
    if (slides.length === 0) throw new PresentationEligibilityError();
    [plan.title, context.lessonTitle, context.classDisplayName].forEach(assertSafeText);
    return Object.freeze({
      sessionId: session.sessionId,
      planId: session.planId,
      revisionId: session.revisionId,
      title: plan.title,
      lessonTitle: context.lessonTitle,
      classDisplayName: context.classDisplayName,
      contentOrigin: session.contentOrigin,
      slides
    });
  }
}

export function initialRevealState(dto: PresentationDTO): PresentationRevealState {
  void dto;
  return { hints: [], answers: [] };
}

export function revealHint(state: PresentationRevealState, slideId: string): PresentationRevealState {
  return state.hints.includes(slideId) ? state : { ...state, hints: [...state.hints, slideId] };
}

export function revealAnswer(state: PresentationRevealState, slideId: string): PresentationRevealState {
  return state.answers.includes(slideId) ? state : { ...state, answers: [...state.answers, slideId] };
}

export interface PresentationWindowLike {
  isDestroyed(): boolean;
  focus(): void;
  close(): void;
  once(event: 'closed', listener: () => void): void;
}

export class PresentationWindowRegistry<TWindow extends PresentationWindowLike> {
  private readonly active = new Map<string, { sessionId: string; window: TWindow }>();

  open(ownerId: string, sessionId: string, create: () => TWindow): { window: TWindow; reused: boolean } {
    const current = this.active.get(ownerId);
    if (current && !current.window.isDestroyed()) {
      if (current.sessionId === sessionId) {
        current.window.focus();
        return { window: current.window, reused: true };
      }
      current.window.close();
    }
    const window = create();
    this.active.set(ownerId, { sessionId, window });
    window.once('closed', () => {
      if (this.active.get(ownerId)?.window === window) this.active.delete(ownerId);
    });
    return { window, reused: false };
  }

  close(ownerId: string): boolean {
    const current = this.active.get(ownerId);
    if (!current || current.window.isDestroyed()) {
      this.active.delete(ownerId);
      return false;
    }
    current.window.close();
    return true;
  }
}

export function isBoundPresentationRequest(
  bindings: ReadonlyMap<number, string>,
  senderId: number,
  operation: string,
  requestedSessionId?: unknown
): boolean {
  const bound = bindings.get(senderId);
  if (!bound) return false;
  if (operation === 'presentation.close') return true;
  return operation === 'presentation.get' && requestedSessionId === bound;
}
