#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  loadCandidateBuildProvenance,
  npmCliPathForNodeExecutable,
  validateCandidateBuildProvenanceValue,
  writeJsonAtomic
} from './lib/g11-acceptance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidateRelativePath = 'apps/desktop/release/YuwenDesk-Setup-0.1.0-x64.exe';
const candidatePath = resolve(root, candidateRelativePath);
const provenancePath = resolve(
  root,
  'apps',
  'desktop',
  'release',
  'acceptance',
  'candidate-build-provenance.json'
);

function run(command, args, options = {}) {
  const outcome = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    ...options
  });
  if (outcome.error) throw outcome.error;
  return outcome;
}

function git(...args) {
  const outcome = run('git', args);
  if (outcome.status !== 0) throw new Error(`GIT_COMMAND_FAILED:${outcome.stderr.trim()}`);
  return outcome.stdout.trim();
}

function sanitizedBuildEnvironment() {
  const secretName = /(TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL)/i;
  const entries = Object.entries(process.env).filter(([name]) => !secretName.test(name));
  return {
    ...Object.fromEntries(entries),
    DEBUG: '',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false'
  };
}

if (platform() !== 'win32') throw new Error('WINDOWS_CANDIDATE_BUILD_REQUIRES_WIN32');
if (git('status', '--porcelain').length > 0) throw new Error('CANDIDATE_BUILD_REQUIRES_CLEAN_TREE');

const sourceCommit = git('rev-parse', 'HEAD');
const childEnvironment = sanitizedBuildEnvironment();
const npmCli = existsSync(process.env.npm_execpath ?? '')
  ? process.env.npm_execpath
  : npmCliPathForNodeExecutable(process.execPath);
const npmVersionOutcome = run(process.execPath, [npmCli, '--version'], { env: childEnvironment });
if (npmVersionOutcome.status !== 0) throw new Error('NPM_VERSION_FAILED');

// A failed replacement build must not leave provenance that could bless stale candidate bytes.
rmSync(provenancePath, { force: true });
const build = run(process.execPath, [
  npmCli,
  'run',
  '-w',
  '@yuwendesk/desktop',
  'build:win'
], {
  env: childEnvironment,
  encoding: undefined,
  stdio: 'inherit'
});
if (build.status !== 0) throw new Error(`WINDOWS_CANDIDATE_BUILD_FAILED:${build.status ?? 'unknown'}`);
if (git('status', '--porcelain').length > 0) throw new Error('CANDIDATE_BUILD_CHANGED_TRACKED_TREE');
if (!existsSync(candidatePath) || !statSync(candidatePath).isFile()) {
  throw new Error('CANDIDATE_ARTIFACT_MISSING_AFTER_BUILD');
}

const candidate = readFileSync(candidatePath);
const provenance = {
  schemaVersion: 1,
  sourceCommit,
  builtAt: new Date().toISOString(),
  candidatePath: candidateRelativePath,
  candidateSha256: createHash('sha256').update(candidate).digest('hex'),
  candidateSizeBytes: candidate.byteLength,
  buildCommand: 'npm run build:candidate',
  buildEnvironment: {
    os: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
    npm: npmVersionOutcome.stdout.trim()
  }
};
writeJsonAtomic({
  targetPath: provenancePath,
  value: provenance,
  validate: validateCandidateBuildProvenanceValue
});
loadCandidateBuildProvenance({ root, sourceCommit });

console.log(JSON.stringify({
  sourceCommit,
  candidatePath: candidateRelativePath,
  candidateSha256: provenance.candidateSha256,
  candidateSizeBytes: provenance.candidateSizeBytes,
  provenancePath: 'apps/desktop/release/acceptance/candidate-build-provenance.json'
}, null, 2));
