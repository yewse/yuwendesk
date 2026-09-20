import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  openPortableArchive,
  selectCalibratedScryptN,
  sealPortableArchive,
  validateStrongPassphrase
} from '../src/main/protection/envelope';
import { inspectArchive } from '../src/main/protection/archive';

const passphrase = 'correct-horse-语文备份-2026';
const deterministic = {
  salt: Buffer.alloc(16, 7),
  nonce: Buffer.alloc(12, 9),
  kdf: { N: 32768, r: 8, p: 1 }
};

describe('G09 portable encrypted envelope', () => {
  it('calibrates scrypt upward only within the bounded production set', () => {
    expect(selectCalibratedScryptN(400)).toBe(32768);
    expect(selectCalibratedScryptN(150)).toBe(65536);
    expect(selectCalibratedScryptN(50)).toBe(131072);
  });

  it('round-trips the complete payload without exposing plaintext markers', async () => {
    const payload = Buffer.from('PK\u0003\u0004database:SQLite format 3;api=sk-NEVER-VISIBLE');
    const sealed = await sealPortableArchive(payload, passphrase, deterministic);
    expect(sealed.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(sealed.includes(Buffer.from('sk-NEVER-VISIBLE'))).toBe(false);
    expect(await openPortableArchive(sealed, passphrase)).toEqual(payload);
  });

  it('rejects wrong passwords and authenticated-field tampering without returning partial plaintext', async () => {
    const sealed = await sealPortableArchive(Buffer.from('private-payload'), passphrase, deterministic);
    await expect(openPortableArchive(sealed, 'wrong-password-is-long-enough')).rejects.toThrow('backup_authentication_failed');
    for (const offset of [12, sealed.length - 17, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[offset] ^= 1;
      await expect(openPortableArchive(tampered, passphrase)).rejects.toThrow();
    }
  });

  it('rejects weak passphrases and decoded KDF parameters outside the production bounds', async () => {
    expect(validateStrongPassphrase('short')).toEqual({ ok: false, reason: 'passphrase_too_short' });
    await expect(sealPortableArchive(Buffer.from('x'), 'short', deterministic)).rejects.toThrow('passphrase_too_short');

    const sealed = await sealPortableArchive(Buffer.from('private-payload'), passphrase, deterministic);
    const headerLength = sealed.readUInt32BE(9);
    const headerStart = 13;
    const header = JSON.parse(sealed.subarray(headerStart, headerStart + headerLength).toString('utf8')) as Record<string, unknown>;
    (header.kdf as { N: number }).N = 16384;
    const changed = Buffer.from(JSON.stringify(header));
    expect(changed.length).toBe(headerLength);
    const hostile = Buffer.concat([sealed.subarray(0, headerStart), changed, sealed.subarray(headerStart + headerLength)]);
    await expect(openPortableArchive(hostile, passphrase)).rejects.toThrow('backup_kdf_parameters_invalid');
  });
});

describe('G09 portable ZIP inspection', () => {
  it('accepts only the fixed backup paths', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', '{}');
    zip.file('data/yuwendesk.db', 'db');
    zip.file('materials/bundle_1/lesson.pdf', 'pdf');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const inspected = await inspectArchive(bytes);
    expect(inspected.entries.map((entry) => entry.path).sort()).toEqual([
      'data/yuwendesk.db', 'manifest.json', 'materials/bundle_1/lesson.pdf'
    ]);
  });

  it.each([
    '../escape.db',
    '/absolute.db',
    'C:/drive.db',
    '\\\\server\\share\\data.db',
    'materials\\bundle_1\\escape.pdf'
  ])('rejects unsafe path %s before extraction', async (path) => {
    const zip = new JSZip();
    zip.file('manifest.json', '{}');
    zip.file('data/yuwendesk.db', 'db');
    zip.file(path, 'hostile');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(inspectArchive(bytes)).rejects.toThrow('backup_archive_path_invalid');
  });

  it('enforces entry count and expanded-byte resource limits', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', '{}');
    zip.file('data/yuwendesk.db', '12345');
    zip.file('materials/bundle_1/file.pdf', '12345');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(inspectArchive(bytes, { maxEntries: 2 })).rejects.toThrow('backup_archive_too_many_entries');
    await expect(inspectArchive(bytes, { maxExpandedBytes: 8 })).rejects.toThrow('backup_archive_too_large');
  });
});
