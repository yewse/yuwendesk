import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { GeneratedFile, MaterialFormat, MaterialRole, MaterialSet } from './generate';

export interface BundleIo {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, bytes: Buffer): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface StagedFile {
  role: MaterialRole;
  format: MaterialFormat;
  filename: string;
  sha256: string;
  byteSize: number;
}

export interface StagedBundle {
  bundleId: string;
  revisionId: string;
  stagingDirectory: string;
  files: StagedFile[];
}

export interface PublishedBundle extends StagedBundle {
  directory: string;
}

const EXPECTED_FILES = new Set([
  'presentation:pptx',
  'student:docx',
  'student:pdf',
  'teacher:docx',
  'teacher:pdf'
]);

export const nodeBundleIo: BundleIo = {
  mkdir: async (path) => {
    await fs.mkdir(path, { recursive: true });
  },
  writeFile: (path, bytes) => fs.writeFile(path, bytes),
  readFile: (path) => fs.readFile(path),
  rename: (from, to) => fs.rename(from, to),
  rm: (path) => fs.rm(path, { recursive: true, force: true })
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function assertExactMaterialSet(set: MaterialSet): void {
  if (!safeSegment(set.revisionId)) throw new Error('INVALID_BUNDLE_REVISION_ID');
  if (set.files.length !== EXPECTED_FILES.size) throw new Error('INVALID_BUNDLE_FILE_SET');
  const pairs = new Set(set.files.map((file) => `${file.role}:${file.format}`));
  if (pairs.size !== EXPECTED_FILES.size || [...EXPECTED_FILES].some((pair) => !pairs.has(pair))) {
    throw new Error('INVALID_BUNDLE_FILE_SET');
  }
  for (const file of set.files) {
    if (basename(file.filename) !== file.filename || file.bytes.length === 0 || sha256(file.bytes) !== file.sha256) {
      throw new Error('INVALID_BUNDLE_FILE');
    }
  }
}

function stagedFile(file: GeneratedFile): StagedFile {
  return {
    role: file.role,
    format: file.format,
    filename: file.filename,
    sha256: file.sha256,
    byteSize: file.bytes.length
  };
}

export async function stageMaterialSet(
  root: string,
  bundleId: string,
  set: MaterialSet,
  io: BundleIo = nodeBundleIo
): Promise<StagedBundle> {
  if (!safeSegment(bundleId)) throw new Error('INVALID_BUNDLE_ID');
  assertExactMaterialSet(set);
  const stagingDirectory = join(root, '.staging', bundleId);
  await io.mkdir(stagingDirectory);
  for (const file of set.files) {
    const path = join(stagingDirectory, file.filename);
    await io.writeFile(path, file.bytes);
    const written = await io.readFile(path);
    if (written.length !== file.bytes.length || sha256(written) !== file.sha256) {
      throw new Error(`STAGED_BUNDLE_HASH_MISMATCH:${file.filename}`);
    }
  }
  return {
    bundleId,
    revisionId: set.revisionId,
    stagingDirectory,
    files: set.files.map(stagedFile)
  };
}

async function existingBundleMatches(directory: string, staged: StagedBundle, io: BundleIo): Promise<boolean> {
  try {
    for (const file of staged.files) {
      const bytes = await io.readFile(join(directory, file.filename));
      if (bytes.length !== file.byteSize || sha256(bytes) !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function promoteStagedBundle(
  root: string,
  staged: StagedBundle,
  io: BundleIo = nodeBundleIo
): Promise<PublishedBundle> {
  const directory = join(root, staged.revisionId, staged.bundleId);
  await io.mkdir(dirname(directory));
  try {
    await io.rename(staged.stagingDirectory, directory);
  } catch (error) {
    if (!(await existingBundleMatches(directory, staged, io))) throw error;
    await io.rm(staged.stagingDirectory);
  }
  return { ...staged, directory };
}
