import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { SqliteStore, SQLITE_SCHEMA_TARGET } from '../src/main/db/sqliteStore';
import type { SafeStorageLike } from '../src/main/crypto/secrets';
import { buildBackupManifest } from '../src/main/protection/manifest';
import { sealPortableArchive } from '../src/main/protection/envelope';
import { preparePortableRestore } from '../src/main/protection/restore';
import type { BackupManifest } from '../src/main/protection/types';

const passphrase = 'correct-horse-语文备份-2026';
const deterministic = {
  salt: Buffer.alloc(16, 7), nonce: Buffer.alloc(12, 9), kdf: { N: 32768, r: 8, p: 1 }
};
const roots: string[] = [];
function temp(label = 'yuwendesk-g09-archive-'): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}
function safeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`SAFE:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().slice(5), 'base64').toString()
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function validDatabase(options: { schemaTooNew?: boolean } = {}): Promise<Buffer> {
  const dir = temp('yuwendesk-g09-db-');
  const store = new SqliteStore(dir, { safeStorage: safeStorage() });
  await store.load();
  await store.saveDraft('archive attack fixture');
  store.close();
  const path = join(dir, 'yuwendesk.db');
  if (options.schemaTooNew) {
    const db = new Database(path);
    db.pragma(`user_version=${SQLITE_SCHEMA_TARGET + 1}`);
    db.close();
  }
  return readFileSync(path);
}

type ExtraEntry = { path: string; bytes: Buffer | string; unixPermissions?: number; directory?: boolean };
async function portableFixture(input: {
  db?: Buffer;
  manifestMutate?: (manifest: BackupManifest) => void;
  extras?: ExtraEntry[];
  zipMutate?: (bytes: Buffer) => Buffer;
  compression?: 'STORE' | 'DEFLATE';
} = {}): Promise<Buffer> {
  const db = input.db ?? await validDatabase();
  const manifest = buildBackupManifest({
    backupId: 'attack_fixture', kind: 'portable', createdAt: '2026-09-20T10:00:00.000Z',
    appVersion: '0.1.0', schemaVersion: SQLITE_SCHEMA_TARGET, retention: [],
    files: [{
      path: 'data/yuwendesk.db', sha256: createHash('sha256').update(db).digest('hex'),
      byteSize: db.length, role: 'database'
    }],
    sourceDocumentIds: []
  });
  input.manifestMutate?.(manifest);
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('data/yuwendesk.db', db);
  for (const extra of input.extras ?? []) {
    zip.file(extra.path, extra.bytes, {
      ...(extra.unixPermissions === undefined ? {} : { unixPermissions: extra.unixPermissions }),
      ...(extra.directory === undefined ? {} : { dir: extra.directory })
    });
  }
  let payload = await zip.generateAsync({
    type: 'nodebuffer', platform: 'UNIX', compression: input.compression ?? 'DEFLATE',
    compressionOptions: { level: 9 }
  });
  payload = input.zipMutate?.(payload) ?? payload;
  return sealPortableArchive(payload, passphrase, deterministic);
}

function replaceAllSameLength(bytes: Buffer, from: string, to: string): Buffer {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error('replacement length mismatch');
  const output = Buffer.from(bytes);
  const needle = Buffer.from(from);
  const replacement = Buffer.from(to);
  let offset = 0;
  let replacements = 0;
  while ((offset = output.indexOf(needle, offset)) >= 0) {
    replacement.copy(output, offset);
    offset += replacement.length;
    replacements += 1;
  }
  if (replacements < 2) throw new Error('zip name not found in local and central records');
  return output;
}

function mutateCentralEntry(bytes: Buffer, path: string, mutate: (output: Buffer, centralOffset: number) => void): Buffer {
  const output = Buffer.from(bytes);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while ((offset = output.indexOf(signature, offset)) >= 0) {
    const nameLength = output.readUInt16LE(offset + 28);
    const extraLength = output.readUInt16LE(offset + 30);
    const commentLength = output.readUInt16LE(offset + 32);
    const name = output.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === path) {
      mutate(output, offset);
      return output;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`central entry not found: ${path}`);
}

function mutateLocalName(bytes: Buffer, path: string): Buffer {
  const output = Buffer.from(bytes);
  const name = Buffer.from(path);
  const offset = output.indexOf(name);
  if (offset < 0) throw new Error(`local entry not found: ${path}`);
  output[offset + name.length - 1] = output[offset + name.length - 1] === 116 ? 117 : 116;
  return output;
}

function filesRecursively(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) visit(path);
      else result.push(relative(root, path).replace(/\\/gu, '/'));
    }
  };
  visit(root);
  return result.sort();
}

async function expectRejected(
  container: Buffer,
  jobId: string,
  expected?: string,
  archiveLimits?: { maxEntries?: number; maxEntryBytes?: number; maxExpandedBytes?: number; maxCompressionRatio?: number }
): Promise<void> {
  const sandbox = temp('yuwendesk-g09-target-');
  const target = join(sandbox, 'userData');
  mkdirSync(target, { recursive: true });
  const stageRoot = resolve(target, 'restore-staging', jobId);
  const writes: string[] = [];
  const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
  const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args: Parameters<typeof fsPromises.writeFile>) => {
    writes.push(String(args[0]));
    return originalWriteFile(...args);
  });
  try {
    const promise = preparePortableRestore({
      container, passphrase, userDataDir: target, safeStorage: safeStorage(), jobId,
      now: new Date('2026-09-20T10:05:00.000Z'), archiveLimits
    });
    if (expected) await expect(promise).rejects.toThrow(expected);
    else await expect(promise).rejects.toThrow();
  } finally {
    writeSpy.mockRestore();
  }
  expect(writes.every((path) => {
    const resolved = resolve(path);
    return resolved === stageRoot || resolved.startsWith(`${stageRoot}${sep}`);
  })).toBe(true);
  expect(existsSync(join(target, 'restore-staging', jobId))).toBe(false);
  expect(filesRecursively(sandbox)).toEqual([]);
}

describe('G09-T04 authenticated envelope attacks through preparePortableRestore', () => {
  it('rejects altered magic, nonce/header, ciphertext, tag, and KDF before staging', async () => {
    const base = await portableFixture();
    const headerLength = base.readUInt32BE(9);
    const headerStart = 13;
    const variants: Array<[string, (bytes: Buffer) => Buffer, string | undefined]> = [
      ['magic', (bytes) => { const out = Buffer.from(bytes); out[0] ^= 1; return out; }, 'backup_envelope_invalid'],
      ['nonce', (bytes) => { const out = Buffer.from(bytes); const at = out.indexOf(Buffer.from('CQkJCQkJCQkJCQkJ'), headerStart); out[at] = out[at] === 67 ? 68 : 67; return out; }, undefined],
      ['ciphertext', (bytes) => { const out = Buffer.from(bytes); out[headerStart + headerLength] ^= 1; return out; }, 'backup_authentication_failed'],
      ['tag', (bytes) => { const out = Buffer.from(bytes); out[out.length - 1] ^= 1; return out; }, 'backup_authentication_failed'],
      ['kdf', (bytes) => {
        const out = Buffer.from(bytes);
        const header = JSON.parse(out.subarray(headerStart, headerStart + headerLength).toString('utf8')) as { kdf: { N: number } };
        header.kdf.N = 16384;
        const changed = Buffer.from(JSON.stringify(header));
        if (changed.length !== headerLength) throw new Error('header length changed');
        changed.copy(out, headerStart);
        return out;
      }, 'backup_kdf_parameters_invalid']
    ];
    for (const [name, mutate, expected] of variants) await expectRejected(mutate(base), `envelope_${name}`, expected);
  });
});

describe('G09-T04 ZIP, manifest, resource, and SQLite attacks through preparePortableRestore', () => {
  it('rejects traversal, absolute, drive, UNC, and backslash archive paths without outside writes', async () => {
    for (const [index, path] of [
      '../escape.db', '/absolute.db', 'C:/drive.db', '\\\\server\\share\\data.db', 'materials\\bundle_1\\escape.pdf'
    ].entries()) {
      await expectRejected(await portableFixture({ extras: [{ path, bytes: 'hostile' }] }), `path_${index}`, 'backup_archive_path_invalid');
    }
  });

  it('rejects duplicate central-directory names, symbolic links, and unmanifested safe entries', async () => {
    const duplicate = await portableFixture({
      extras: [
        { path: 'materials/bundle_1/file-a.txt', bytes: 'a' },
        { path: 'materials/bundle_1/file-b.txt', bytes: 'b' }
      ],
      compression: 'STORE',
      zipMutate: (bytes) => replaceAllSameLength(bytes, 'materials/bundle_1/file-b.txt', 'materials/bundle_1/file-a.txt')
    });
    await expectRejected(duplicate, 'duplicate_path', 'backup_archive_duplicate_path');

    const symlink = await portableFixture({
      extras: [{ path: 'materials/bundle_1/link.txt', bytes: '../outside', unixPermissions: 0o120777 }]
    });
    await expectRejected(symlink, 'symlink', 'backup_archive_symlink');

    const unlisted = await portableFixture({ extras: [{ path: 'materials/bundle_1/unlisted.txt', bytes: 'hidden' }] });
    await expectRejected(unlisted, 'unlisted', 'backup_manifest_entry_mismatch');
  });

  it('rejects Windows path aliases, trailing dots, and reserved device names before staging', async () => {
    await expectRejected(await portableFixture({
      extras: [
        { path: 'materials/bundle_case/File.txt', bytes: 'same' },
        { path: 'materials/BUNDLE_CASE/file.TXT', bytes: 'same' }
      ]
    }), 'windows_case_alias', 'backup_archive_duplicate_path');
    await expectRejected(await portableFixture({
      extras: [{ path: 'materials/bundle_dot/name.', bytes: 'x' }]
    }), 'windows_trailing_dot', 'backup_archive_path_invalid');
    await expectRejected(await portableFixture({
      extras: [{ path: 'materials/bundle_device/CON.txt', bytes: 'x' }]
    }), 'windows_device', 'backup_archive_path_invalid');
  });

  it('rejects entry-count and compression-ratio bombs before creating a usable stage', async () => {
    const many: ExtraEntry[] = [];
    for (let i = 0; i < 4095; i += 1) many.push({ path: `materials/bundle_${i}/f.txt`, bytes: 'x' });
    await expectRejected(await portableFixture({ extras: many }), 'too_many', 'backup_archive_too_many_entries');
    await expectRejected(await portableFixture({
      extras: [{ path: 'materials/bundle_ratio/bomb.txt', bytes: Buffer.alloc(2 * 1024 * 1024, 65) }]
    }), 'ratio', 'backup_archive_ratio_exceeded');

    const directories: ExtraEntry[] = [];
    for (let i = 0; i < 4095; i += 1) directories.push({ path: `materials/only_${i}/`, bytes: '', directory: true });
    await expectRejected(await portableFixture({ extras: directories }), 'directory_bomb', 'backup_archive_too_many_entries');
  }, 30_000);

  it('rejects central-size under-reporting and local/central name disagreement', async () => {
    const boundedUnderstatement = await portableFixture({
      compression: 'STORE',
      zipMutate: (bytes) => mutateCentralEntry(bytes, 'data/yuwendesk.db', (output, offset) => {
        output.writeUInt32LE(1, offset + 24);
        const localOffset = output.readUInt32LE(offset + 42);
        output.writeUInt32LE(1, localOffset + 22);
      })
    });
    await expectRejected(boundedUnderstatement, 'central_size_understated_bounded', 'backup_archive_entry_too_large', {
      maxEntryBytes: 4 * 1024
    });

    const inconsistentUnderstatement = await portableFixture({
      compression: 'STORE',
      zipMutate: (bytes) => mutateCentralEntry(bytes, 'data/yuwendesk.db', (output, offset) => {
        output.writeUInt32LE(1, offset + 24);
      })
    });
    await expectRejected(inconsistentUnderstatement, 'central_size_understated_inconsistent', 'backup_archive_metadata_mismatch');

    const mismatch = await portableFixture({
      extras: [{ path: 'materials/bundle_local/file.txt', bytes: 'x' }],
      compression: 'STORE',
      zipMutate: (bytes) => mutateLocalName(bytes, 'materials/bundle_local/file.txt')
    });
    await expectRejected(mismatch, 'local_central_mismatch', 'backup_archive_path_invalid');
  });

  it('rejects manifest path/hash/size mismatches and missing declared files', async () => {
    await expectRejected(await portableFixture({
      manifestMutate: (manifest) => { manifest.files[0].sha256 = '0'.repeat(64); }
    }), 'hash_mismatch', 'backup_verification_failed:hash:data/yuwendesk.db');
    await expectRejected(await portableFixture({
      manifestMutate: (manifest) => { manifest.files[0].byteSize += 1; }
    }), 'size_mismatch', 'backup_verification_failed:size:data/yuwendesk.db');
    await expectRejected(await portableFixture({
      manifestMutate: (manifest) => {
        manifest.files.push({ path: 'materials/bundle_x/missing.txt', sha256: 'a'.repeat(64), byteSize: 1, role: 'material' });
      }
    }), 'missing_file', 'backup_manifest_entry_mismatch');
    await expectRejected(await portableFixture({
      manifestMutate: (manifest) => { manifest.files[0].path = '../outside.db'; }
    }), 'manifest_path', 'backup_manifest_invalid');
  });

  it('rejects corrupt SQLite and a database whose actual schema is newer than the app', async () => {
    await expectRejected(await portableFixture({ db: Buffer.from('not a sqlite database') }), 'corrupt_db');
    await expectRejected(await portableFixture({ db: await validDatabase({ schemaTooNew: true }) }), 'new_schema', 'backup_schema_too_new');
  });
});
