import JSZip from 'jszip';
import type { Readable } from 'node:stream';
import { isSafeArchivePath, windowsArchivePathKey } from './manifest';

export interface ArchiveLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxExpandedBytes?: number;
  maxCompressionRatio?: number;
}

export interface InspectedArchiveEntry {
  path: string;
  bytes: Buffer;
}

export interface InspectedArchive {
  entries: InspectedArchiveEntry[];
}

const defaults = {
  maxEntries: 4096,
  maxEntryBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_U16 = 0xffff;
const ZIP64_U32 = 0xffffffff;

interface CentralEntryMetadata {
  compressedBytes: number;
  expandedBytes: number;
}

interface CentralDirectoryMetadata {
  entries: Map<string, CentralEntryMetadata>;
  fileCount: number;
  compressedBytes: number;
}

function allowedDirectoryPath(path: string): boolean {
  if (!path.endsWith('/') || windowsArchivePathKey(path) === null) return false;
  const parts = path.slice(0, -1).split('/');
  if (parts.length === 1) return ['data', 'keys', 'materials'].includes(parts[0]);
  return parts[0] === 'materials' && parts.slice(1).every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(part));
}

function containsZip64Extra(extra: Buffer): boolean {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) return true;
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > extra.length) return true;
    if (id === 0x0001) return true;
    offset += length;
  }
  return false;
}

function findEocd(container: Buffer): number {
  const minimum = Math.max(0, container.length - 22 - 65_535);
  for (let offset = container.length - 22; offset >= minimum; offset -= 1) {
    if (container.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = container.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === container.length) return offset;
  }
  return -1;
}

function preflightCentralDirectory(container: Buffer, limits: Required<ArchiveLimits>): CentralDirectoryMetadata {
  const eocd = findEocd(container);
  if (eocd < 0) throw new Error('backup_archive_invalid');
  const disk = container.readUInt16LE(eocd + 4);
  const centralDisk = container.readUInt16LE(eocd + 6);
  const entriesOnDisk = container.readUInt16LE(eocd + 8);
  const totalEntries = container.readUInt16LE(eocd + 10);
  const centralBytes = container.readUInt32LE(eocd + 12);
  const centralOffset = container.readUInt32LE(eocd + 16);
  if (totalEntries > limits.maxEntries) throw new Error('backup_archive_too_many_entries');
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries ||
      totalEntries === ZIP64_U16 || centralBytes === ZIP64_U32 || centralOffset === ZIP64_U32 ||
      centralOffset + centralBytes !== eocd) {
    throw new Error('backup_archive_invalid');
  }
  const seen = new Set<string>();
  const entries = new Map<string, CentralEntryMetadata>();
  const localRanges: Array<{ start: number; end: number }> = [];
  let offset = centralOffset;
  let files = 0;
  let expanded = 0;
  let compressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocd || container.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('backup_archive_invalid');
    const flags = container.readUInt16LE(offset + 8);
    const method = container.readUInt16LE(offset + 10);
    const crc32 = container.readUInt32LE(offset + 16);
    const compressedBytes = container.readUInt32LE(offset + 20);
    const expandedBytes = container.readUInt32LE(offset + 24);
    const nameLength = container.readUInt16LE(offset + 28);
    const extraLength = container.readUInt16LE(offset + 30);
    const commentLength = container.readUInt16LE(offset + 32);
    const externalAttributes = container.readUInt32LE(offset + 38);
    const localOffset = container.readUInt32LE(offset + 42);
    if ([compressedBytes, expandedBytes, localOffset].includes(ZIP64_U32)) throw new Error('backup_archive_invalid');
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw new Error('backup_archive_invalid');
    const centralNameBytes = container.subarray(offset + 46, offset + 46 + nameLength);
    const name = centralNameBytes.toString('utf8');
    const centralExtra = container.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    if (containsZip64Extra(centralExtra)) throw new Error('backup_archive_invalid');
    const pathKey = windowsArchivePathKey(name);
    if (pathKey === null) throw new Error('backup_archive_path_invalid');
    if (seen.has(pathKey)) throw new Error('backup_archive_duplicate_path');
    seen.add(pathKey);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) throw new Error('backup_archive_symlink');
    const directory = name.endsWith('/');
    if (directory ? !allowedDirectoryPath(name) : !allowedPath(name)) throw new Error('backup_archive_path_invalid');
    if (![0, 8].includes(method)) throw new Error('backup_archive_invalid');
    const allowedFlags = method === 8 ? 0x0806 : 0x0800;
    if ((flags & ~allowedFlags) !== 0) throw new Error('backup_archive_invalid');
    if (localOffset + 30 > centralOffset || container.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('backup_archive_invalid');
    const localFlags = container.readUInt16LE(localOffset + 6);
    const localMethod = container.readUInt16LE(localOffset + 8);
    const localCrc32 = container.readUInt32LE(localOffset + 14);
    const localCompressedBytes = container.readUInt32LE(localOffset + 18);
    const localExpandedBytes = container.readUInt32LE(localOffset + 22);
    const localNameLength = container.readUInt16LE(localOffset + 26);
    const localExtraLength = container.readUInt16LE(localOffset + 28);
    if (localOffset + 30 + localNameLength + localExtraLength > centralOffset) throw new Error('backup_archive_invalid');
    const localNameBytes = container.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!localNameBytes.equals(centralNameBytes)) throw new Error('backup_archive_path_invalid');
    const localExtra = container.subarray(localOffset + 30 + localNameLength, localOffset + 30 + localNameLength + localExtraLength);
    if (containsZip64Extra(localExtra)) throw new Error('backup_archive_invalid');
    if (localFlags !== flags || localMethod !== method || localCrc32 !== crc32 ||
        localCompressedBytes !== compressedBytes || localExpandedBytes !== expandedBytes) {
      throw new Error('backup_archive_metadata_mismatch');
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedBytes;
    if (dataEnd > centralOffset || localRanges.some((range) => localOffset < range.end && dataEnd > range.start)) {
      throw new Error('backup_archive_invalid');
    }
    localRanges.push({ start: localOffset, end: dataEnd });
    entries.set(name, { compressedBytes, expandedBytes });
    if (directory && (compressedBytes !== 0 || expandedBytes !== 0)) throw new Error('backup_archive_invalid');
    if (!directory) {
      files += 1;
      if (expandedBytes > limits.maxEntryBytes) throw new Error('backup_archive_entry_too_large');
      expanded += expandedBytes;
      compressed += compressedBytes;
      if (expanded > limits.maxExpandedBytes) throw new Error('backup_archive_too_large');
    }
    offset = next;
  }
  if (offset !== centralOffset + centralBytes) throw new Error('backup_archive_invalid');
  if (expanded > 1024 * 1024 && expanded / Math.max(compressed, 1) > limits.maxCompressionRatio) {
    throw new Error('backup_archive_ratio_exceeded');
  }
  return { entries, fileCount: files, compressedBytes: compressed };
}

function allowedPath(path: string): boolean {
  return path === 'manifest.json' || isSafeArchivePath(path);
}

export async function inspectArchive(container: Buffer, limits: ArchiveLimits = {}): Promise<InspectedArchive> {
  const applied = { ...defaults, ...limits };
  const central = preflightCentralDirectory(container, applied);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(container, { createFolders: false });
  } catch {
    throw new Error('backup_archive_invalid');
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length !== central.fileCount || files.length > applied.maxEntries) throw new Error('backup_archive_invalid');
  const seen = new Set<string>();
  const entries: InspectedArchiveEntry[] = [];
  let expanded = 0;
  for (const file of files) {
    const unsafeOriginalName = (file as unknown as { unsafeOriginalName?: string }).unsafeOriginalName;
    const originalPath = unsafeOriginalName ?? file.name;
    if (originalPath !== file.name || !allowedPath(originalPath)) throw new Error('backup_archive_path_invalid');
    const pathKey = windowsArchivePathKey(file.name);
    if (pathKey === null || seen.has(pathKey)) throw new Error('backup_archive_duplicate_path');
    seen.add(pathKey);
    const expected = central.entries.get(originalPath);
    if (!expected) throw new Error('backup_archive_metadata_mismatch');
    const stream = file.nodeStream('nodebuffer') as Readable;
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          stream.destroy();
          reject(error);
        };
        stream.on('data', (value: Buffer | Uint8Array) => {
          if (settled) return;
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          entryBytes += chunk.length;
          if (entryBytes > applied.maxEntryBytes) {
            fail(new Error('backup_archive_entry_too_large'));
            return;
          }
          if (expanded + entryBytes > applied.maxExpandedBytes) {
            fail(new Error('backup_archive_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        stream.once('error', (error) => fail(error instanceof Error ? error : new Error('backup_archive_invalid')));
        stream.once('end', () => {
          if (settled) return;
          settled = true;
          resolve();
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('backup_archive_')) throw error;
      throw new Error('backup_archive_metadata_mismatch');
    }
    if (entryBytes !== expected.expandedBytes) throw new Error('backup_archive_metadata_mismatch');
    const bytes = Buffer.concat(chunks, entryBytes);
    expanded += entryBytes;
    entries.push({ path: file.name, bytes });
  }
  if (expanded > 1024 * 1024 && expanded / Math.max(central.compressedBytes, 1) > applied.maxCompressionRatio) {
    throw new Error('backup_archive_ratio_exceeded');
  }
  if (!seen.has('manifest.json') || !seen.has('data/yuwendesk.db')) throw new Error('backup_archive_required_entry_missing');
  return { entries };
}
