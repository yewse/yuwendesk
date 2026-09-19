import { describe, expect, it } from 'vitest';
import {
  CredentialProtector,
  DataKeyManager,
  decryptSensitive,
  encryptSensitive,
  generateDataKey,
  type SafeStorageLike
} from '../src/main/crypto/secrets';

// 伪 safeStorage：base64 包裹（可逆，但密文不含明文子串，近似真实 DPAPI 的不透明性）。
function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('ENC1:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b) => {
      const s = b.toString('utf8');
      if (!s.startsWith('ENC1:')) throw new Error('not encrypted by this backend');
      return Buffer.from(s.slice(5), 'base64').toString('utf8');
    }
  };
}

describe('AES-256-GCM 敏感 payload（T03）', () => {
  const aad = 'workspace=w1;object=obs1;version=1';
  it('往返：加密后可解回原文', () => {
    const key = generateDataKey();
    const blob = encryptSensitive(key, '学生原始作答（自拟测试）', aad);
    expect(decryptSensitive(key, blob, aad)).toBe('学生原始作答（自拟测试）');
  });
  it('密文篡改 → 认证失败（抛出）', () => {
    const key = generateDataKey();
    const blob = encryptSensitive(key, 'secret', aad);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptSensitive(key, blob, aad)).toThrow();
  });
  it('AAD 不符 → 抛出', () => {
    const key = generateDataKey();
    const blob = encryptSensitive(key, 'secret', aad);
    expect(() => decryptSensitive(key, blob, 'workspace=OTHER')).toThrow();
  });
  it('错误密钥 → 抛出', () => {
    const blob = encryptSensitive(generateDataKey(), 'secret', aad);
    expect(() => decryptSensitive(generateDataKey(), blob, aad)).toThrow();
  });
  it('nonce 不复用：同明文两次加密产出不同（前 12 字节 IV 不同）', () => {
    const key = generateDataKey();
    const a = encryptSensitive(key, 'same', aad);
    const b = encryptSensitive(key, 'same', aad);
    expect(Buffer.compare(a.subarray(0, 12), b.subarray(0, 12))).not.toBe(0);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

describe('CredentialProtector（safeStorage 包裹）', () => {
  it('可用：protect 返回密文+末四位；unprotect 往返', () => {
    const p = new CredentialProtector(fakeSafe(true));
    const r = p.protect('sk-ABCD1234');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.last4).toBe('1234');
      expect(r.ciphertext.toString('utf8')).not.toContain('sk-ABCD1234'); // 非明文存放
      const u = p.unprotect(r.ciphertext);
      expect(u.ok && u.plaintext).toBe('sk-ABCD1234');
    }
  });
  it('不可用：protect 拒绝（encryption_unavailable），不返回明文', () => {
    const p = new CredentialProtector(fakeSafe(false));
    const r = p.protect('sk-x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('encryption_unavailable');
  });
  it('解密失败 → decrypt_failed（不抛出）', () => {
    const p = new CredentialProtector(fakeSafe(true));
    const u = p.unprotect(Buffer.from('not-encrypted'));
    expect(u.ok).toBe(false);
  });
});

describe('DataKeyManager', () => {
  it('wrap/unwrap 往返', () => {
    const m = new DataKeyManager(fakeSafe(true));
    const key = generateDataKey();
    const w = m.wrap(key);
    expect(w.ok).toBe(true);
    if (w.ok) {
      const u = m.unwrap(w.wrapped);
      expect(u.ok && Buffer.compare(u.dataKey, key)).toBe(0);
    }
  });
  it('不可用 → 拒绝封装（不落明文密钥）', () => {
    const m = new DataKeyManager(fakeSafe(false));
    const r = m.wrap(generateDataKey());
    expect(r.ok).toBe(false);
  });
  it('解封篡改 → decrypt_failed', () => {
    const m = new DataKeyManager(fakeSafe(true));
    const u = m.unwrap(Buffer.from('garbage'));
    expect(u.ok).toBe(false);
  });
});
