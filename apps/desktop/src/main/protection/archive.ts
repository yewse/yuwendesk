import JSZip from 'jszip';
import { isSafeArchivePath } from './manifest';

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

function allowedPath(path: string): boolean {
  return path === 'manifest.json' || isSafeArchivePath(path);
}

export async function inspectArchive(container: Buffer, limits: ArchiveLimits = {}): Promise<InspectedArchive> {
  const applied = { ...defaults, ...limits };
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(container, { createFolders: false });
  } catch {
    throw new Error('backup_archive_invalid');
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length > applied.maxEntries) throw new Error('backup_archive_too_many_entries');
  const seen = new Set<string>();
  const entries: InspectedArchiveEntry[] = [];
  let expanded = 0;
  for (const file of files) {
    const unsafeOriginalName = (file as unknown as { unsafeOriginalName?: string }).unsafeOriginalName;
    const originalPath = unsafeOriginalName ?? file.name;
    if (originalPath !== file.name || !allowedPath(originalPath)) throw new Error('backup_archive_path_invalid');
    if (seen.has(file.name)) throw new Error('backup_archive_duplicate_path');
    seen.add(file.name);
    const bytes = await file.async('nodebuffer');
    if (bytes.length > applied.maxEntryBytes) throw new Error('backup_archive_entry_too_large');
    expanded += bytes.length;
    if (expanded > applied.maxExpandedBytes) throw new Error('backup_archive_too_large');
    entries.push({ path: file.name, bytes });
  }
  if (expanded > 1024 * 1024 && expanded / Math.max(container.length, 1) > applied.maxCompressionRatio) {
    throw new Error('backup_archive_ratio_exceeded');
  }
  if (!seen.has('manifest.json') || !seen.has('data/yuwendesk.db')) throw new Error('backup_archive_required_entry_missing');
  return { entries };
}

