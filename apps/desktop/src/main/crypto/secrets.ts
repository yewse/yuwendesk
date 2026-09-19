import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

// G02-T03：凭据与敏感 payload 保护。
// - 凭据（如 API key）：由 safeStorage（Windows DPAPI）加密后存密文，界面只显示末四位；
//   加密不可用时拒绝持久化（绝不落明文）；解密失败返回错误，不覆盖原密文。
// - 敏感 payload：每工作区随机 256 位数据密钥（由 safeStorage 封装存储），AES-256-GCM，
//   随机 96 位 nonce 不复用，AAD 绑定工作区/对象/版本；解密失败（篡改/错误密钥/AAD 不符）抛错。
// safeStorage 后端以接口注入，便于 Node 测试（不依赖真实 keyring）。

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type ProtectResult = { ok: true; ciphertext: Buffer; last4: string } | { ok: false; reason: 'encryption_unavailable' };
export type UnprotectResult = { ok: true; plaintext: string } | { ok: false; reason: 'decrypt_failed' };

export class CredentialProtector {
  constructor(private readonly safeStorage: SafeStorageLike) {}

  available(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  // 加密凭据；不可用则拒绝（不返回、不持久化明文）。
  protect(plaintext: string): ProtectResult {
    if (!this.safeStorage.isEncryptionAvailable()) return { ok: false, reason: 'encryption_unavailable' };
    const ciphertext = this.safeStorage.encryptString(plaintext);
    const last4 = plaintext.slice(-4);
    return { ok: true, ciphertext, last4 };
  }

  // 解密凭据；失败返回错误（调用者据此保留原密文，不覆盖）。
  unprotect(ciphertext: Buffer): UnprotectResult {
    try {
      return { ok: true, plaintext: this.safeStorage.decryptString(ciphertext) };
    } catch {
      return { ok: false, reason: 'decrypt_failed' };
    }
  }
}

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

// 生成随机 256 位数据密钥。
export function generateDataKey(): Buffer {
  return randomBytes(KEY_LEN);
}

// AES-256-GCM 加密：输出 iv(12) | tag(16) | ciphertext。AAD 绑定上下文。
export function encryptSensitive(dataKey: Buffer, plaintext: string, aad: string): Buffer {
  if (dataKey.length !== KEY_LEN) throw new Error('invalid_data_key_length');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf-8'));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

// 解密：篡改/错误密钥/AAD 不符会因认证失败抛出（GCM 校验）。
export function decryptSensitive(dataKey: Buffer, blob: Buffer, aad: string): string {
  if (dataKey.length !== KEY_LEN) throw new Error('invalid_data_key_length');
  if (blob.length < IV_LEN + TAG_LEN) throw new Error('invalid_blob');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
  decipher.setAAD(Buffer.from(aad, 'utf-8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}

// 数据密钥经 safeStorage 封装/解封；safeStorage 不可用则拒绝（不落明文密钥）。
export class DataKeyManager {
  constructor(private readonly safeStorage: SafeStorageLike) {}

  available(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  wrap(dataKey: Buffer): { ok: true; wrapped: Buffer } | { ok: false; reason: 'encryption_unavailable' } {
    if (!this.safeStorage.isEncryptionAvailable()) return { ok: false, reason: 'encryption_unavailable' };
    return { ok: true, wrapped: this.safeStorage.encryptString(dataKey.toString('base64')) };
  }

  unwrap(wrapped: Buffer): { ok: true; dataKey: Buffer } | { ok: false; reason: 'decrypt_failed' } {
    try {
      const key = Buffer.from(this.safeStorage.decryptString(wrapped), 'base64');
      if (key.length !== KEY_LEN) return { ok: false, reason: 'decrypt_failed' };
      return { ok: true, dataKey: key };
    } catch {
      return { ok: false, reason: 'decrypt_failed' };
    }
  }
}

// 常量时间比较（避免对末四位等做时序泄露；工具函数）。
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
