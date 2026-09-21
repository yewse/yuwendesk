import type { SourceHitDTO, SourceReadDTO } from '../../shared/ipc';

const MODEL_EXCERPT_CHARS = 3800;
const LEADING_CONTEXT_CHARS = 200;

export interface LessonExcerptGateway {
  search(query: string): Promise<SourceHitDTO[]>;
  read(versionId: string, charStart?: number, charEnd?: number): Promise<SourceReadDTO>;
}

export interface LessonExcerpt {
  charStart: number;
  charEnd: number;
  text: string;
  locatorLabel: string;
}

function hitScore(hit: SourceHitDTO, query: string): number {
  if (hit.matchKind !== 'body' || !hit.anchor || !hit.reliable) return Number.NEGATIVE_INFINITY;
  const compact = hit.context.replace(/\s+/gu, ' ');
  const index = compact.indexOf(query);
  let score = index >= 0 && index <= 12 ? 80 : 20;
  if (compact.includes('目录')) score -= 120;
  score -= (compact.match(/[0-9０-９]/gu) ?? []).length * 4;
  score -= (compact.match(/[/／]/gu) ?? []).length * 8;
  const page = typeof hit.locator?.page === 'number' ? hit.locator.page : 0;
  score += Math.min(page, 20);
  return score;
}

function previewAnchor(text: string, query: string): number {
  const positions: number[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const found = text.indexOf(query, cursor);
    if (found < 0) break;
    positions.push(found);
    cursor = found + Math.max(1, query.length);
  }
  if (positions.length === 0) return 0;
  return positions
    .map((position) => {
      const around = text.slice(Math.max(0, position - 40), Math.min(text.length, position + query.length + 80));
      const penalty = around.includes('目录') ? 100 : 0;
      const titleAtLineStart = position === 0 || /[\n。！？]/u.test(text[position - 1] ?? '') ? 30 : 0;
      return { position, score: titleAtLineStart - penalty - (around.match(/[0-9０-９]/gu) ?? []).length * 2 };
    })
    .sort((a, b) => b.score - a.score || a.position - b.position)[0].position;
}

export async function resolveLessonExcerpt(
  gateway: LessonExcerptGateway,
  versionId: string,
  lessonTitle: string
): Promise<LessonExcerpt> {
  const query = lessonTitle.trim();
  if (!query) throw new Error('请填写课题后再让 AI 备课。');

  const hits = (await gateway.search(query))
    .filter((hit) => hit.versionId === versionId)
    .sort((a, b) => hitScore(b, query) - hitScore(a, query));
  const located = hits.find((hit) => Number.isFinite(hitScore(hit, query)));

  let anchor = located?.anchor?.char_start;
  if (typeof anchor !== 'number') {
    const preview = await gateway.read(versionId);
    anchor = previewAnchor(preview.text, query);
  }

  const charStart = Math.max(0, anchor - LEADING_CONTEXT_CHARS);
  const requestedEnd = charStart + MODEL_EXCERPT_CHARS;
  const ranged = await gateway.read(versionId, charStart, requestedEnd);
  const fullLength = ranged.full_length;
  const charEnd = Math.min(requestedEnd, fullLength);
  const returnedStart = Math.max(0, charStart - 40);
  const prefixLength = charStart - returnedStart;
  const exactLength = Math.max(0, charEnd - charStart);
  const text = ranged.text.slice(prefixLength, prefixLength + exactLength);
  if (!text.trim()) throw new Error('未能从所选资料定位到可用正文，请检查课题或更换资料。');

  return {
    charStart,
    charEnd,
    text,
    locatorLabel: located?.locatorLabel ?? '资料正文'
  };
}
