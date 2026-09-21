import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/main/db/sqliteStore';
import {
  PreparationKeyReuseError,
  PreparationVersionConflictError,
  type TeachingContextInput
} from '../src/main/preparation/types';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-g12-'));
}

const open = new Set<SqliteStore>();
function makeStore(dir: string): SqliteStore {
  const store = new SqliteStore(dir);
  open.add(store);
  return store;
}

afterEach(() => {
  for (const store of open) {
    try { store.close(); } catch { /* already closed */ }
  }
  open.clear();
});

const contextInput: TeachingContextInput = {
  classDisplayName: '八年级一班',
  grade: 'grade8',
  textbookTitle: '语文八年级上册',
  textbookEdition: '统编版',
  unitTitle: '第一单元',
  lessonTitle: '消息二则',
  durationSec: 2700,
  notes: '不含学生姓名'
};

describe('G12 preparation SQLite migration and persistence', () => {
  it('migrates a schema-12 database to schema 13 without losing existing rows', async () => {
    const dir = tmp();
    const seed = makeStore(dir);
    await seed.load();
    await seed.saveDraft('schema-12 fixture');
    seed.close();
    open.delete(seed);

    const raw = new Database(join(dir, 'yuwendesk.db'));
    raw.exec('DROP TABLE IF EXISTS preparation_source; DROP TABLE IF EXISTS preparation_session; DROP TABLE IF EXISTS teaching_context;');
    raw.pragma('user_version = 12');
    raw.close();

    const migrated = makeStore(dir);
    await migrated.load();
    expect(migrated.schemaVersion()).toBe(13);
    expect(migrated.getDraft().content).toBe('schema-12 fixture');
    const tables = migrated.withTransaction((db) => db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('teaching_context','preparation_session','preparation_source') ORDER BY name"
    ).all() as Array<{ name: string }>);
    expect(tables.map((row) => row.name)).toEqual(['preparation_session', 'preparation_source', 'teaching_context']);
  });

  it('persists context, session, exact source selections, and restart reconciliation', async () => {
    const dir = tmp();
    const store = makeStore(dir);
    await store.load();
    const imported = store.importSource({
      title: '教材节选',
      format: 'txt',
      content: '新华社长江前线二十二日二十二时电。',
      classification: 'licensed_reference'
    });
    if (imported.status !== 'imported') throw new Error(`unexpected import status: ${imported.status}`);

    const context = store.saveTeachingContext(contextInput, 0, 'ctx-create-1');
    const replayedContext = store.saveTeachingContext(contextInput, 0, 'ctx-create-1');
    expect(replayedContext).toEqual(context);
    expect(context).toMatchObject({ ...contextInput, revision: 1 });

    const session = store.createPreparationSession(context.contextId, 'local_authored', 'session-create-1');
    const sourceText = '新华社长江前线';
    const withSources = store.replacePreparationSources(session.sessionId, [{
      sourceVersionId: imported.versionId,
      charStart: 0,
      charEnd: sourceText.length,
      purpose: 'textbook',
      approvedForModel: false,
      textSha256: createHash('sha256').update(sourceText).digest('hex')
    }], session.revision, 'sources-set-1');
    expect(withSources.status).toBe('SOURCES_SELECTED');
    expect(withSources.sources).toEqual([{
      sessionId: session.sessionId,
      ordinal: 0,
      sourceVersionId: imported.versionId,
      charStart: 0,
      charEnd: sourceText.length,
      purpose: 'textbook',
      approvedForModel: false,
      textSha256: createHash('sha256').update(sourceText).digest('hex')
    }]);

    const building = store.transitionPreparationSession(
      session.sessionId,
      withSources.revision,
      'BUILDING',
      { focus: '把握消息结构', coreTask: '梳理六要素', answerScope: '依据所选教材片段作答' },
      'build-start-1'
    );
    expect(building.status).toBe('BUILDING');
    store.close();
    open.delete(store);

    const reopened = makeStore(dir);
    await reopened.load();
    expect(reopened.getPreparationSession(session.sessionId)).toMatchObject({
      status: 'SOURCES_SELECTED',
      lastErrorCode: 'PREPARATION_INTERRUPTED',
      focus: '把握消息结构',
      revision: building.revision + 1
    });
    expect(reopened.listPreparationSessions()).toHaveLength(1);
    expect(reopened.getTeachingContext(context.contextId)).toEqual(context);
  });

  it('fails closed on stale revisions and idempotency-key reuse with a different payload', async () => {
    const store = makeStore(tmp());
    await store.load();
    const context = store.saveTeachingContext(contextInput, 0, 'ctx-create-conflict');
    expect(() => store.saveTeachingContext(
      { ...contextInput, contextId: context.contextId, lessonTitle: '过期修改' },
      0,
      'ctx-stale'
    )).toThrow(PreparationVersionConflictError);
    expect(() => store.saveTeachingContext(
      { ...contextInput, lessonTitle: '异载荷' },
      0,
      'ctx-create-conflict'
    )).toThrow(PreparationKeyReuseError);
  });
});
