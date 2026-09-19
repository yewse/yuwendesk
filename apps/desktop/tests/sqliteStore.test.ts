import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, SQLITE_SCHEMA_TARGET } from '../src/main/db/sqliteStore';
import { StoreProtectedError } from '../src/main/store';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-sqlite-'));
}
const open = new Set<SqliteStore>();
function makeStore(dir: string): SqliteStore {
  const s = new SqliteStore(dir);
  open.add(s);
  return s;
}
afterEach(() => {
  for (const s of open) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  open.clear();
});

describe('SqliteStore 初始化与迁移（G02-T02）', () => {
  it('迁移到目标 schema 版本；重复 load 幂等', async () => {
    const dir = tmp();
    const a = makeStore(dir);
    await a.load();
    expect(a.schemaVersion()).toBe(SQLITE_SCHEMA_TARGET);
    a.close();
    open.delete(a);
    const b = makeStore(dir);
    await b.load();
    expect(b.schemaVersion()).toBe(SQLITE_SCHEMA_TARGET);
  });

  it('WAL 与外键 pragma 已启用', async () => {
    const dir = tmp();
    const s = makeStore(dir);
    await s.load();
    // 通过 withTransaction 访问底层 db 读取 pragma（仅测试用途）
    const mode = s.withTransaction((db) => db.pragma('journal_mode', { simple: true }));
    const fk = s.withTransaction((db) => db.pragma('foreign_keys', { simple: true }));
    expect(String(mode).toLowerCase()).toBe('wal');
    expect(Number(fk)).toBe(1);
  });
});

describe('SqliteStore 保存与新连接持久化', () => {
  it('保存后由新连接读取到已提交数据（跨连接持久化）', async () => {
    const dir = tmp();
    const a = makeStore(dir);
    await a.load();
    await a.saveDraft('SQLite 持久化');
    expect(a.getDraft()).toMatchObject({ content: 'SQLite 持久化', revision: 1 });
    a.close();
    open.delete(a);

    const b = makeStore(dir);
    await b.load();
    expect(b.getDraft()).toMatchObject({ content: 'SQLite 持久化', revision: 1 });
  });

  it('saveDraftExpecting 原子乐观并发：过期版本冲突且不写入', async () => {
    const dir = tmp();
    const s = makeStore(dir);
    await s.load();
    const r1 = await s.saveDraftExpecting('A', 0);
    expect(r1.ok).toBe(true);
    const conflict = await s.saveDraftExpecting('B', 0); // 期望 0，实际已是 1
    expect(conflict.ok).toBe(false);
    expect(s.getDraft()).toMatchObject({ content: 'A', revision: 1 });
  });

  it('保存窗口不影响草稿版本', async () => {
    const dir = tmp();
    const s = makeStore(dir);
    await s.load();
    await s.saveDraft('稿');
    await s.saveWindow({ width: 1200, height: 800, x: 10, y: 20 });
    expect(s.getWindow()).toMatchObject({ width: 1200, height: 800, x: 10, y: 20 });
    expect(s.getDraft().revision).toBe(1);
  });
});

describe('SqliteStore 失败回滚', () => {
  it('事务内抛出 → 回滚，已提交数据不变（新连接确认）', async () => {
    const dir = tmp();
    const a = makeStore(dir);
    await a.load();
    await a.saveDraft('已提交-A');
    expect(() =>
      a.withTransaction((db) => {
        db.prepare('UPDATE draft SET content=?, revision=revision+1 WHERE id=1').run('半途-B');
        throw new Error('boom');
      })
    ).toThrow('boom');
    a.close();
    open.delete(a);
    const b = makeStore(dir);
    await b.load();
    expect(b.getDraft()).toMatchObject({ content: '已提交-A', revision: 1 }); // 回滚后仍为 A
  });
});

describe('SqliteStore 旧 JSON 安全迁入', () => {
  it('有效旧 JSON 首次运行迁入并备份原文件', async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'yuwendesk-local-state.json'),
      JSON.stringify({
        draft: { content: '旧稿内容', revision: 3, updated_at: '2026-09-19T00:00:00.000Z' },
        window: { width: 1000, height: 700 }
      })
    );
    const s = makeStore(dir);
    await s.load();
    expect(s.getDraft()).toMatchObject({ content: '旧稿内容', revision: 3 });
    expect(s.recoveredFromCorruption()).toBe(true);
    // 原 JSON 已改名备份（保留证据），不再存于原路径
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes('yuwendesk-local-state.json.migrated.'))).toBe(true);
    expect(files.includes('yuwendesk-local-state.json')).toBe(false);
  });

  it('坏 JSON 不迁入、不覆盖：坏内容被安全隔离保留', async () => {
    const dir = tmp();
    const damaged = '{"draft":{"content":"坏片段"';
    writeFileSync(join(dir, 'yuwendesk-local-state.json'), damaged);
    const s = makeStore(dir);
    await s.load();
    expect(s.getDraft()).toMatchObject({ content: '', revision: 0 }); // 未迁入
    // 坏内容被保留（LocalStore 隔离为 .corrupt.*）
    const preserved = readdirSync(dir).some(
      (f) => statSync(join(dir, f)).isFile() && readFileSync(join(dir, f), 'utf8') === damaged
    );
    expect(preserved).toBe(true);
  });

  it('已有 SQLite 数据时不被旧 JSON 覆盖', async () => {
    const dir = tmp();
    const a = makeStore(dir);
    await a.load();
    await a.saveDraft('SQLite 已有');
    a.close();
    open.delete(a);
    writeFileSync(
      join(dir, 'yuwendesk-local-state.json'),
      JSON.stringify({ draft: { content: '旧稿', revision: 9, updated_at: null }, window: { width: 800, height: 600 } })
    );
    const b = makeStore(dir);
    await b.load();
    expect(b.getDraft()).toMatchObject({ content: 'SQLite 已有', revision: 1 }); // 未被旧 JSON 覆盖
  });
});

describe('SqliteStore 保护态', () => {
  it('probeWritable 在可写目录为 true', async () => {
    const dir = tmp();
    const s = makeStore(dir);
    await s.load();
    expect(await s.probeWritable()).toBe(true);
  });

  it('未打开数据库时写入抛出保护错误', async () => {
    const s = makeStore(tmp());
    // 未 load：db 为空
    await expect(s.saveDraft('x')).rejects.toBeInstanceOf(StoreProtectedError);
  });
});
