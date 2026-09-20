import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';

const open = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-src-'));
}
function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('ENC1:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b) => Buffer.from(b.toString('utf8').slice(5), 'base64').toString('utf8')
  };
}
async function makeStore(dir: string, safeStorage?: SafeStorageLike): Promise<SqliteStore> {
  const s = new SqliteStore(dir, { safeStorage });
  open.add(s);
  await s.load();
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

const 春 = `《春》\n盼望着，盼望着，东风来了，春天的脚步近了。\n一切都像刚睡醒的样子，欣欣然张开了眼。\n小草偷偷地从土里钻出来，嫩嫩的，绿绿的。`;

describe('G03 资料导入与版本/哈希', () => {
  it('导入新资料 → imported，含哈希与 v1', async () => {
    const s = await makeStore(tmp());
    const r = s.importSource({ title: '春', format: 'txt', content: 春 });
    expect(r.status).toBe('imported');
    if (r.status === 'imported') {
      expect(r.version).toBe(1);
      expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(s.listSources()[0]).toMatchObject({ title: '春', version: 1, status: 'active' });
  });

  it('相同内容再次导入 → duplicate（同哈希，不新增版本）', async () => {
    const s = await makeStore(tmp());
    s.importSource({ title: '春', format: 'txt', content: 春 });
    const dup = s.importSource({ title: '春', format: 'txt', content: 春 });
    expect(dup.status).toBe('duplicate');
    expect(s.listSources()[0].version).toBe(1);
  });

  it('同标题不同内容 → 仅需确认（不自动新增版本/切换当前版本）', async () => {
    const s = await makeStore(tmp());
    const v1 = s.importSource({ title: '春', format: 'txt', content: 春 });
    const r = s.importSource({ title: '春', format: 'txt', content: 春 + '\n（修订版新增一句）' });
    expect(r.status).toBe('needs_confirmation');
    if (r.status === 'needs_confirmation') {
      expect(r.existing.currentVersion).toBe(1);
    }
    // 未确认前：仍是 v1，未新增版本、当前版本未变
    expect(s.listSources()[0].version).toBe(1);
    if (v1.status === 'imported') expect(s.getSourceVersions(v1.documentId).length).toBe(1);
  });

  it('确认为新版本 → 显式切换当前版本，旧版本保留', async () => {
    const s = await makeStore(tmp());
    const v1 = s.importSource({ title: '春', format: 'txt', content: 春 });
    if (v1.status !== 'imported') throw new Error('setup');
    const v2 = s.importSource({ title: '春', format: 'txt', content: 春 + '\n新增', relation: 'new_version', targetDocumentId: v1.documentId });
    expect(v2.status).toBe('new_version');
    if (v2.status === 'new_version') {
      expect(v2.version).toBe(2);
      expect(v2.versionConflict).toBe(true);
    }
    expect(s.listSources()[0].version).toBe(2); // 当前版本已显式切换
    expect(s.getSourceVersions(v1.documentId).length).toBe(2); // 旧版本保留
  });

  it('确认为独立文档 → 同名但独立文档', async () => {
    const s = await makeStore(tmp());
    s.importSource({ title: '春', format: 'txt', content: 春 });
    const sep = s.importSource({ title: '春', format: 'txt', content: 春 + '\n另一篇', relation: 'separate' });
    expect(sep.status).toBe('imported');
    expect(s.listSources().length).toBe(2);
  });

  it('敏感分类 → 安全后端可用时只落加密载荷；不可用时阻塞', async () => {
    const withSafe = await makeStore(tmp(), fakeSafe(true));
    const r = withSafe.importSource({ title: '学生作答', format: 'txt', content: '自拟样例', classification: 'student_sensitive' });
    expect(r.status).toBe('imported');
    expect(withSafe.listSources()[0].classification).toBe('student_sensitive');
    expect(withSafe.listSources()[0].title).toMatch(/^学生作品/u);
    const withoutSafe = await makeStore(tmp());
    const blocked = withoutSafe.importSource({ title: '学生作答', format: 'txt', content: '自拟样例', classification: 'student_sensitive' });
    expect(blocked.status).toBe('blocked_sensitive');
    if (blocked.status === 'blocked_sensitive') expect(blocked.reason).toBe('encryption_unavailable');
    expect(withoutSafe.listSources().length).toBe(0);
  });

  it('未知分类 → 拒绝；缺省分类为本地私有(不默认公开)', async () => {
    const s = await makeStore(tmp());
    expect(s.importSource({ title: 'x', format: 'txt', content: 'a', classification: 'whatever' }).status).toBe('rejected');
    s.importSource({ title: '默认分类', format: 'txt', content: '正文' });
    expect(s.listSources()[0].classification).toBe('teacher_private');
  });

  it('空内容/超限 → rejected', async () => {
    const s = await makeStore(tmp());
    expect(s.importSource({ title: 'e', format: 'txt', content: '' }).status).toBe('rejected');
  });
});

describe('G03 中文搜索与短词回退 + 原文定位', () => {
  it('≥3 字 FTS trigram 命中并返回锚点与上下文', async () => {
    const s = await makeStore(tmp());
    const imp = s.importSource({ title: '春', format: 'txt', content: 春 });
    const hits = s.searchSources('春天的脚步');
    expect(hits.length).toBeGreaterThan(0);
    const h = hits[0];
    expect(h.title).toBe('春');
    expect(h.anchor).not.toBeNull();
    expect(h.context).toContain('春天的脚步');
    // 锚点定位可回读原文该跨度
    if (h.anchor && imp.status === 'imported') {
      const read = s.readSource(h.versionId, h.anchor.char_start, h.anchor.char_end);
      expect(read?.text).toContain('春天的脚步');
    }
  });

  it('短词（1–2 字）回退 LIKE 命中', async () => {
    const s = await makeStore(tmp());
    s.importSource({ title: '春', format: 'txt', content: 春 });
    const hits = s.searchSources('草'); // 单字，FTS trigram 无法成词 → 回退
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].context).toContain('草');
  });

  it('标题短词回退命中', async () => {
    const s = await makeStore(tmp());
    s.importSource({ title: '春', format: 'txt', content: 春 });
    const hits = s.searchSources('春');
    expect(hits.some((h) => h.title === '春')).toBe(true);
  });

  it('无结果返回空', async () => {
    const s = await makeStore(tmp());
    s.importSource({ title: '春', format: 'txt', content: 春 });
    expect(s.searchSources('量子纠缠不存在于本文').length).toBe(0);
  });

  it('标题命中与正文命中分开：标题命中 matchKind=title 且不制造正文锚点/定位', async () => {
    const s = await makeStore(tmp());
    // 标题含“教案”，正文不含“教案”
    s.importSource({ title: '春天教案', format: 'txt', content: '盼望着，东风来了，春天的脚步近了。' });
    const hits = s.searchSources('教案');
    expect(hits.length).toBeGreaterThan(0);
    const titleHit = hits.find((h) => h.matchKind === 'title');
    expect(titleHit).toBeTruthy();
    expect(titleHit!.anchor).toBeNull(); // 不制造正文锚点
    expect(titleHit!.locator).toBeNull();
    expect(titleHit!.locatorLabel).toBe('标题命中');
    // 正文不含“教案”→ 不应出现 body 命中
    expect(hits.some((h) => h.matchKind === 'body')).toBe(false);
  });

  it('正文命中带真实锚点；标题不含该词时仅正文命中', async () => {
    const s = await makeStore(tmp());
    s.importSource({ title: '春天教案', format: 'txt', content: '盼望着，东风来了，春天的脚步近了。' });
    const hits = s.searchSources('东风');
    const bodyHit = hits.find((h) => h.matchKind === 'body');
    expect(bodyHit).toBeTruthy();
    expect(bodyHit!.anchor).not.toBeNull(); // 正文命中有精确锚点
    expect(bodyHit!.context).toContain('东风');
  });
});

describe('G03 停用与重启恢复', () => {
  it('停用后不再出现在搜索结果', async () => {
    const s = await makeStore(tmp());
    const imp = s.importSource({ title: '春', format: 'txt', content: 春 });
    expect(s.searchSources('春天的脚步').length).toBeGreaterThan(0);
    if (imp.status === 'imported') s.retireSource(imp.documentId);
    expect(s.searchSources('春天的脚步').length).toBe(0);
    expect(s.listSources()[0].status).toBe('retired');
  });

  it('重启（新连接）后资料与搜索恢复', async () => {
    const dir = tmp();
    const a = await makeStore(dir);
    a.importSource({ title: '春', format: 'txt', content: 春 });
    a.close();
    open.delete(a);
    const b = await makeStore(dir);
    expect(b.listSources()[0]).toMatchObject({ title: '春', version: 1 });
    expect(b.searchSources('春天的脚步').length).toBeGreaterThan(0);
  });
});
