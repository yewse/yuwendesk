import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildUpdateContainer } from '../src/main/update/container';
import { canonicalUpdateManifest } from '../src/main/update/manifest';
import { UpdateService } from '../src/main/update/service';
import type { UpdateManifestV1 } from '../src/main/update/types';
import { UpdateValidationError } from '../src/main/update/types';

const dirs: string[] = [];
const keypair = generateKeyPairSync('ed25519');

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yuwendesk-update-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function signedContainer(targetVersion = '0.2.0', releaseId = `release-${targetVersion}`, content: string | Buffer = `installer-${targetVersion}`): Buffer {
  const packageBytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const manifest: UpdateManifestV1 = {
    format: 'yuwendesk-update-manifest', version: 1, releaseId,
    appId: 'org.yuwendesk.app', targetVersion, minimumSourceVersion: '0.1.0',
    platform: 'win32', arch: 'x64', packageName: `YuwenDesk-${targetVersion}.exe`,
    packageBytes: packageBytes.length,
    packageSha256: createHash('sha256').update(packageBytes).digest('hex'),
    signingKeyId: 'fixture-key', createdAt: '2026-09-20T00:00:00.000Z'
  };
  const manifestBytes = canonicalUpdateManifest(manifest);
  return buildUpdateContainer({ manifestBytes, signature: sign(null, manifestBytes, keypair.privateKey), packageBytes });
}

function fixture(input?: {
  dir?: string;
  selectedPath?: string | null;
  now?: () => number;
  trusted?: boolean;
  maxPackageBytes?: number;
  ioChunkBytes?: number;
  ledgerMaxBytes?: number;
  hooks?: {
    beforeReadback?: (partialDir: string) => void | Promise<void>;
    beforeReadyRename?: (partialDir: string) => void | Promise<void>;
    onPackageChunk?: (bytes: number) => void;
    beforeLedgerWrite?: () => void | Promise<void>;
    beforeLedgerRename?: () => void | Promise<void>;
  };
}): { service: UpdateService; dir: string; selectedPath: string } {
  const dir = input?.dir ?? tempDir();
  const selectedPath = input?.selectedPath === undefined ? join(dir, 'teacher-choice.yuwenupdate') : (input.selectedPath ?? '');
  if (selectedPath && !existsSync(selectedPath)) writeFileSync(selectedPath, signedContainer());
  return {
    dir,
    selectedPath,
    service: new UpdateService({
      userDataDir: dir,
      currentVersion: '0.1.0',
      appId: 'org.yuwendesk.app',
      platform: 'win32',
      arch: 'x64',
      trustedKeys: input?.trusted === false ? new Map() : new Map([['fixture-key', keypair.publicKey]]),
      maxPackageBytes: input?.maxPackageBytes,
      ioChunkBytes: input?.ioChunkBytes,
      ledgerMaxBytes: input?.ledgerMaxBytes,
      chooseOfflinePath: async () => selectedPath || null,
      now: input?.now,
      hooks: input?.hooks
    })
  };
}

async function previewAndStage(service: UpdateService, idempotencyKey = 'stage-once') {
  const preview = await service.inspectOffline();
  if (preview.cancelled) throw new Error('fixture unexpectedly cancelled');
  return {
    preview,
    result: await service.stageOffline({
      confirmationToken: preview.confirmationToken,
      manifestSha256: preview.summary.manifestSha256,
      currentVersion: preview.summary.currentVersion,
      targetVersion: preview.summary.targetVersion,
      idempotencyKey
    })
  };
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
    throw new Error('expected update validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateValidationError);
    expect((error as UpdateValidationError).code).toBe(code);
  }
}

describe('offline update inspection and fixed staging', () => {
  it('fails closed when production trust is empty and leaves no staging directory', async () => {
    const { service, dir } = fixture({ trusted: false });
    expect((await service.status()).state).toBe('trust_not_configured');
    await expectCode(() => service.inspectOffline(), 'UPDATE_TRUST_NOT_CONFIGURED');
    expect(existsSync(join(dir, 'updates'))).toBe(false);
  });

  it('treats native picker cancellation as a side-effect-free result', async () => {
    const { service, dir } = fixture({ selectedPath: null });
    await expect(service.inspectOffline()).resolves.toEqual({ cancelled: true });
    expect(existsSync(join(dir, 'updates'))).toBe(false);
  });

  it('rejects an oversized selected container under the configured read cap', async () => {
    const { service, dir } = fixture({ maxPackageBytes: 8 });
    await expectCode(() => service.inspectOffline(), 'UPDATE_CONTAINER_INVALID');
    expect(existsSync(join(dir, 'updates'))).toBe(false);
  });

  it('previews first, then writes only a fixed ready directory without installing', async () => {
    const { service, dir, selectedPath } = fixture();
    const { preview, result } = await previewAndStage(service);
    expect(preview).toMatchObject({ cancelled: false, state: 'verified' });
    expect(preview).not.toHaveProperty('path');
    expect(result).toMatchObject({ state: 'verified_ready', replayed: false, releaseId: 'release-0.2.0' });
    const ready = join(dir, 'updates', 'release-0.2.0.ready');
    expect(readdirSync(ready).sort()).toEqual(['installer.exe', 'manifest.json', 'verification.json']);
    expect(readFileSync(join(ready, 'installer.exe'))).toEqual(Buffer.from('installer-0.2.0'));
    expect(existsSync(selectedPath)).toBe(true);
    expect(existsSync(join(dir, 'updates', 'release-0.2.0.partial'))).toBe(false);
  });

  it('streams package verification in bounded chunks instead of retaining the raw package in a selection', async () => {
    const dir = tempDir();
    const selectedPath = join(dir, 'large-fixture.yuwenupdate');
    writeFileSync(selectedPath, signedContainer('0.2.0', 'release-0.2.0', Buffer.alloc(2 * 1024 * 1024, 7)));
    let largestChunk = 0;
    const setup = fixture({
      dir, selectedPath, ioChunkBytes: 32 * 1024,
      hooks: { onPackageChunk: (bytes: number) => { largestChunk = Math.max(largestChunk, bytes); } }
    });
    const preview = await setup.service.inspectOffline();
    expect(preview.cancelled).toBe(false);
    expect(largestChunk).toBeGreaterThan(0);
    expect(largestChunk).toBeLessThanOrEqual(32 * 1024);
  });

  it('binds the token to manifest/current/target, expires it, and consumes it once', async () => {
    let time = 1_000;
    const { service } = fixture({ now: () => time });
    const preview = await service.inspectOffline();
    if (preview.cancelled) throw new Error('unexpected cancel');
    const base = {
      confirmationToken: preview.confirmationToken,
      manifestSha256: preview.summary.manifestSha256,
      currentVersion: preview.summary.currentVersion,
      targetVersion: preview.summary.targetVersion
    };
    await expectCode(() => service.stageOffline({ ...base, currentVersion: '0.0.9', idempotencyKey: 'wrong-current' }), 'UPDATE_STATE_CHANGED');

    const fresh = await service.inspectOffline();
    if (fresh.cancelled) throw new Error('unexpected cancel');
    time = fresh.expiresAt + 1;
    await expectCode(() => service.stageOffline({
      confirmationToken: fresh.confirmationToken,
      manifestSha256: fresh.summary.manifestSha256,
      currentVersion: fresh.summary.currentVersion,
      targetVersion: fresh.summary.targetVersion,
      idempotencyKey: 'expired'
    }), 'UPDATE_STATE_CHANGED');

    time = 2_000;
    const last = await service.inspectOffline();
    if (last.cancelled) throw new Error('unexpected cancel');
    const lastInput = {
      confirmationToken: last.confirmationToken,
      manifestSha256: last.summary.manifestSha256,
      currentVersion: last.summary.currentVersion,
      targetVersion: last.summary.targetVersion
    };
    await service.stageOffline({ ...lastInput, idempotencyKey: 'consumed-first' });
    await expectCode(() => service.stageOffline({ ...lastInput, idempotencyKey: 'consumed-second' }), 'UPDATE_STATE_CHANGED');
  });

  it('replays the same idempotency request across service instances and rejects key reuse for another package', async () => {
    const first = fixture();
    const { preview, result } = await previewAndStage(first.service, 'persistent-key');
    const second = fixture({ dir: first.dir, selectedPath: null });
    await expect(second.service.stageOffline({
      confirmationToken: 'not-needed-for-a-recorded-success',
      manifestSha256: preview.summary.manifestSha256,
      currentVersion: preview.summary.currentVersion,
      targetVersion: preview.summary.targetVersion,
      idempotencyKey: 'persistent-key'
    })).resolves.toEqual({ ...result, replayed: true });

    const samePackageAgain = fixture({ dir: first.dir, selectedPath: first.selectedPath });
    const samePreview = await samePackageAgain.service.inspectOffline();
    if (samePreview.cancelled) throw new Error('unexpected cancel');
    await expect(samePackageAgain.service.stageOffline({
      confirmationToken: samePreview.confirmationToken,
      manifestSha256: samePreview.summary.manifestSha256,
      currentVersion: samePreview.summary.currentVersion,
      targetVersion: samePreview.summary.targetVersion,
      idempotencyKey: 'second-persistent-key'
    })).resolves.toMatchObject({ state: 'verified_ready' });
    const replaySecondKey = fixture({ dir: first.dir, selectedPath: null });
    await expect(replaySecondKey.service.stageOffline({
      confirmationToken: 'response-was-lost',
      manifestSha256: samePreview.summary.manifestSha256,
      currentVersion: samePreview.summary.currentVersion,
      targetVersion: samePreview.summary.targetVersion,
      idempotencyKey: 'second-persistent-key'
    })).resolves.toMatchObject({ state: 'verified_ready', replayed: true });

    const otherPath = join(first.dir, 'other.yuwenupdate');
    writeFileSync(otherPath, signedContainer('0.3.0'));
    const other = fixture({ dir: first.dir, selectedPath: otherPath });
    const otherPreview = await other.service.inspectOffline();
    if (otherPreview.cancelled) throw new Error('unexpected cancel');
    await expectCode(() => other.service.stageOffline({
      confirmationToken: otherPreview.confirmationToken,
      manifestSha256: otherPreview.summary.manifestSha256,
      currentVersion: otherPreview.summary.currentVersion,
      targetVersion: otherPreview.summary.targetVersion,
      idempotencyKey: 'persistent-key'
    }), 'UPDATE_STATE_CHANGED');
  });

  it('recovers the initial idempotency result from a verified ready reservation if the ledger is lost after publish', async () => {
    const first = fixture();
    const { preview } = await previewAndStage(first.service, 'recover-after-publish');
    rmSync(join(first.dir, 'updates', 'idempotency.json'));
    const reopened = fixture({ dir: first.dir, selectedPath: null });
    await expect(reopened.service.stageOffline({
      confirmationToken: 'process-restarted-after-publish',
      manifestSha256: preview.summary.manifestSha256,
      currentVersion: preview.summary.currentVersion,
      targetVersion: preview.summary.targetVersion,
      idempotencyKey: 'recover-after-publish'
    })).resolves.toMatchObject({ state: 'verified_ready', replayed: true });
  });

  it.each(['write', 'rename'] as const)('rolls back a newly published ready directory after a ledger %s fault and permits the same retry', async (fault) => {
    let failOnce = true;
    const setup = fixture({
      hooks: fault === 'write'
        ? { beforeLedgerWrite: () => { if (failOnce) { failOnce = false; throw new Error('ledger write fault'); } } }
        : { beforeLedgerRename: () => { if (failOnce) { failOnce = false; throw new Error('ledger rename fault'); } } }
    });
    const preview = await setup.service.inspectOffline();
    if (preview.cancelled) throw new Error('unexpected cancel');
    const input = {
      confirmationToken: preview.confirmationToken,
      manifestSha256: preview.summary.manifestSha256,
      currentVersion: preview.summary.currentVersion,
      targetVersion: preview.summary.targetVersion,
      idempotencyKey: `ledger-${fault}`
    };
    await expectCode(() => setup.service.stageOffline(input), 'UPDATE_STAGE_FAILED');
    expect(existsSync(join(setup.dir, 'updates', 'release-0.2.0.ready'))).toBe(false);
    await expect(setup.service.stageOffline(input)).resolves.toMatchObject({ state: 'verified_ready', replayed: false });
  });

  it('rejects an idempotency ledger result that does not exactly match the reverified ready record', async () => {
    const setup = fixture();
    const { preview } = await previewAndStage(setup.service, 'ledger-ready-binding');
    const ledgerPath = join(setup.dir, 'updates', 'idempotency.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { entries: Array<{ result: { packageSha256: string } }> };
    ledger.entries[0].result.packageSha256 = 'f'.repeat(64);
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    const reopened = fixture({ dir: setup.dir, selectedPath: null });
    await expectCode(() => reopened.service.stageOffline({
      confirmationToken: 'replay', manifestSha256: preview.summary.manifestSha256,
      currentVersion: preview.summary.currentVersion, targetVersion: preview.summary.targetVersion,
      idempotencyKey: 'ledger-ready-binding'
    }), 'UPDATE_STATE_CHANGED');
  });

  it('bounds the idempotency ledger by serialized bytes and keeps the newest entry readable', async () => {
    const setup = fixture({ ledgerMaxBytes: 900 });
    await previewAndStage(setup.service, `a-${'a'.repeat(240)}`);
    for (const prefix of ['b', 'c']) {
      const next = fixture({ dir: setup.dir, selectedPath: setup.selectedPath, ledgerMaxBytes: 900 });
      await previewAndStage(next.service, `${prefix}-${prefix.repeat(240)}`);
    }
    const ledgerPath = join(setup.dir, 'updates', 'idempotency.json');
    expect(readFileSync(ledgerPath).length).toBeLessThanOrEqual(900);
    const latest = fixture({ dir: setup.dir, selectedPath: null, ledgerMaxBytes: 900 });
    const summary = (await setup.service.status()).ready[0];
    await expect(latest.service.stageOffline({
      confirmationToken: 'replay', manifestSha256: summary.manifestSha256,
      currentVersion: '0.1.0', targetVersion: summary.targetVersion,
      idempotencyKey: `c-${'c'.repeat(240)}`
    })).resolves.toMatchObject({ replayed: true });
  });

  it('re-reads and re-verifies the selected container before staging', async () => {
    const { service, selectedPath } = fixture();
    const preview = await service.inspectOffline();
    if (preview.cancelled) throw new Error('unexpected cancel');
    writeFileSync(selectedPath, signedContainer('0.3.0'));
    await expectCode(() => service.stageOffline({
      confirmationToken: preview.confirmationToken,
      manifestSha256: preview.summary.manifestSha256,
      currentVersion: preview.summary.currentVersion,
      targetVersion: preview.summary.targetVersion,
      idempotencyKey: 'changed-source'
    }), 'UPDATE_STATE_CHANGED');
  });

  it('does not list partial staging as ready', async () => {
    const { service, dir } = fixture();
    await mkdir(join(dir, 'updates', 'stranded.partial'), { recursive: true });
    writeFileSync(join(dir, 'updates', 'stranded.partial', 'installer.exe'), 'not-ready');
    expect((await service.status()).ready).toEqual([]);
  });

  it('marks older verified releases as superseded while retaining their evidence', async () => {
    const first = fixture();
    await previewAndStage(first.service, 'release-020');
    const nextPath = join(first.dir, 'release-030.yuwenupdate');
    writeFileSync(nextPath, signedContainer('0.3.0'));
    const next = fixture({ dir: first.dir, selectedPath: nextPath });
    await previewAndStage(next.service, 'release-030');
    const status = await next.service.status();
    expect(status.ready.map((item) => [item.targetVersion, item.state])).toEqual([
      ['0.2.0', 'superseded'],
      ['0.3.0', 'verified_ready']
    ]);
  });

  it('does not list or idempotently replay a ready directory whose staged package changed', async () => {
    const first = fixture();
    const { preview } = await previewAndStage(first.service, 'integrity-bound-key');
    writeFileSync(join(first.dir, 'updates', 'release-0.2.0.ready', 'installer.exe'), 'changed-after-stage');
    const reopened = fixture({ dir: first.dir, selectedPath: null });
    expect((await reopened.service.status()).ready).toEqual([]);
    await expectCode(() => reopened.service.stageOffline({
      confirmationToken: 'missing-after-reopen',
      manifestSha256: preview.summary.manifestSha256,
      currentVersion: preview.summary.currentVersion,
      targetVersion: preview.summary.targetVersion,
      idempotencyKey: 'integrity-bound-key'
    }), 'UPDATE_STATE_CHANGED');
  });

  it('rejects a verification record with extra result fields instead of forwarding them to the renderer', async () => {
    const setup = fixture();
    await previewAndStage(setup.service, 'closed-record');
    const recordPath = join(setup.dir, 'updates', 'release-0.2.0.ready', 'verification.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { result: Record<string, unknown> };
    record.result.path = 'C:\\private\\must-not-leak';
    writeFileSync(recordPath, JSON.stringify(record));
    const reopened = fixture({ dir: setup.dir, selectedPath: null });
    expect((await reopened.service.status()).ready).toEqual([]);
  });

  it.each(['readback', 'tamper-before-rename', 'rename'] as const)('cleans the partial directory after a %s fault', async (fault) => {
    const setup = fixture({
      hooks: fault === 'readback'
        ? { beforeReadback: async (partial) => { await readFile(join(partial, 'installer.exe')); writeFileSync(join(partial, 'installer.exe'), 'corrupt'); } }
        : fault === 'tamper-before-rename'
          ? { beforeReadyRename: (partial) => { writeFileSync(join(partial, 'installer.exe'), 'tampered after verification'); } }
          : { beforeReadyRename: () => { throw new Error('injected rename fault'); } }
    });
    await expectCode(() => previewAndStage(setup.service, `fault-${fault}`), 'UPDATE_STAGE_FAILED');
    expect(existsSync(join(setup.dir, 'updates', 'release-0.2.0.partial'))).toBe(false);
    expect(existsSync(join(setup.dir, 'updates', 'release-0.2.0.ready'))).toBe(false);
  });

  it('contains no installer execution, shell reveal, quit, or relaunch capability', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'main', 'update', 'service.ts'), 'utf8');
    expect(source).not.toMatch(/child_process|spawn\s*\(|exec(File)?\s*\(|openPath\s*\(|\.quit\s*\(|relaunch\s*\(/u);
  });
});
