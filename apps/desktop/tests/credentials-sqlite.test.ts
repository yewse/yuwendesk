import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';

// 伪 safeStorage：base64 包裹（可逆，但密文不含明文子串）。
function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('ENC1:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b) => {
      const s = b.toString('utf8');
      if (!s.startsWith('ENC1:')) throw new Error('bad');
      return Buffer.from(s.slice(5), 'base64').toString('utf8');
    }
  };
}
const open = new Set<SqliteStore>();
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-cred-'));
}
async function store(dir: string, safeStorage?: SafeStorageLike): Promise<SqliteStore> {
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

describe('凭据保护（SqliteStore + safeStorage，T03）', () => {
  it('可用：存凭据仅密文+末四位，读回往返；DB 不含明文', async () => {
    const s = await store(tmp(), fakeSafe(true));
    const set = s.setCredential('grok_api_key', 'sk-SECRET-9999');
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.last4).toBe('9999');
    expect(s.getCredentialLast4('grok_api_key')).toBe('9999');
    const raw = s.withTransaction((db) => db.prepare('SELECT ciphertext FROM credential WHERE name=?').get('grok_api_key')) as {
      ciphertext: Buffer;
    };
    expect(raw.ciphertext.toString('utf8')).not.toContain('sk-SECRET-9999');
    const read = s.readCredential('grok_api_key');
    expect(read.ok && read.plaintext).toBe('sk-SECRET-9999');
  });

  it('加密不可用：拒绝存储，绝不落明文（无行）', async () => {
    const s = await store(tmp(), fakeSafe(false));
    const set = s.setCredential('grok_api_key', 'sk-x');
    expect(set.ok).toBe(false);
    expect(s.getCredentialLast4('grok_api_key')).toBeNull();
    const cnt = s.withTransaction((db) => db.prepare('SELECT COUNT(*) c FROM credential').get()) as { c: number };
    expect(cnt.c).toBe(0);
  });

  it('无 safeStorage 注入：凭据加密不可用', async () => {
    const s = await store(tmp());
    expect(s.credentialEncryptionAvailable()).toBe(false);
    expect(s.setCredential('k', 'v').ok).toBe(false);
  });

  it('解密失败：返回 decrypt_failed，且不覆盖已存密文', async () => {
    const s = await store(tmp(), fakeSafe(true));
    s.setCredential('grok_api_key', 'sk-KEEP-1234');
    // 篡改已存密文，模拟解密失败
    s.withTransaction((db) => db.prepare("UPDATE credential SET ciphertext=? WHERE name=?").run(Buffer.from('tampered'), 'grok_api_key'));
    const read = s.readCredential('grok_api_key');
    expect(read.ok).toBe(false);
    // 读失败不改动已存密文
    const raw = s.withTransaction((db) => db.prepare('SELECT ciphertext FROM credential WHERE name=?').get('grok_api_key')) as {
      ciphertext: Buffer;
    };
    expect(raw.ciphertext.toString('utf8')).toBe('tampered');
  });
});

describe('敏感 payload 保护（AES-256-GCM，T03）', () => {
  it('可用：putSensitive/getSensitive 往返；DB 不含明文', async () => {
    const s = await store(tmp(), fakeSafe(true));
    const aad = 'workspace=w1;object=obs1;version=1';
    const put = s.putSensitive('obs1', '学生原始作答（自拟）', aad);
    expect(put.ok).toBe(true);
    const raw = s.withTransaction((db) => db.prepare('SELECT blob FROM sensitive WHERE name=?').get('obs1')) as {
      blob: Buffer;
    };
    expect(raw.blob.toString('utf8')).not.toContain('学生原始作答');
    const got = s.getSensitive('obs1', aad);
    expect(got.ok && got.value).toBe('学生原始作答（自拟）');
  });

  it('AAD 不符 → decrypt_failed，且不覆盖密文', async () => {
    const s = await store(tmp(), fakeSafe(true));
    s.putSensitive('obs1', 'x', 'workspace=w1');
    const before = s.withTransaction((db) => db.prepare('SELECT blob FROM sensitive WHERE name=?').get('obs1')) as {
      blob: Buffer;
    };
    const got = s.getSensitive('obs1', 'workspace=OTHER');
    expect(got.ok).toBe(false);
    const after = s.withTransaction((db) => db.prepare('SELECT blob FROM sensitive WHERE name=?').get('obs1')) as {
      blob: Buffer;
    };
    expect(Buffer.compare(before.blob, after.blob)).toBe(0);
  });

  it('加密不可用：putSensitive 拒绝', async () => {
    const s = await store(tmp(), fakeSafe(false));
    const put = s.putSensitive('obs1', 'x', 'aad');
    expect(put.ok).toBe(false);
  });
});
