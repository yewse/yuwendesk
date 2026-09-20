import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectionService } from '../src/main/protection/service';

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'yuwendesk-protection-service-'));
}

describe('G09 ProtectionService main-process authority', () => {
  it('uses native-selected paths and never returns the selected path to the renderer', async () => {
    const root = temp();
    const output = join(root, 'portable.yuwenbackup');
    const service = new ProtectionService({
      userDataDir: root,
      backup: {
        createLocal: async () => ({ backupId: 'local_1', path: 'C:\\private\\local.ready', valid: true }),
        exportPortable: async () => ({ container: Buffer.from('encrypted'), manifest: { backupId: 'portable_1' } }),
        list: async () => [],
        deleteManaged: async () => true
      },
      choosePortableSavePath: async () => output,
      choosePortableOpenPath: async () => null,
      confirmRestore: async () => false,
      confirmDelete: async () => false,
      relaunch: () => undefined
    });
    const result = await service.create({ mode: 'portable', passphrase: 'restore-语文备份-strong-2026' }, 'create-1') as Record<string, unknown>;
    expect(readFileSync(output).toString()).toBe('encrypted');
    expect(result).toMatchObject({ backupId: 'portable_1', saved: true });
    expect(result.path).toBeUndefined();
    const local = await service.create({ mode: 'local' }, 'create-local-1') as Record<string, unknown>;
    expect(local).toMatchObject({ backupId: 'local_1', valid: true });
    expect(local.path).toBeUndefined();
  });

  it('issues a short-lived bound token, consumes it once, writes pending restore, and relaunches', async () => {
    const root = temp();
    const inputPath = join(root, 'input.yuwenbackup');
    writeFileSync(inputPath, 'encrypted');
    const pending: string[] = [];
    let relaunched = 0;
    const service = new ProtectionService({
      userDataDir: root,
      backup: {
        createLocal: async () => ({ backupId: 'local_1' }),
        exportPortable: async () => ({ container: Buffer.from('encrypted'), manifest: { backupId: 'portable_1' } }),
        list: async () => [],
        deleteManaged: async () => true
      },
      choosePortableSavePath: async () => null,
      choosePortableOpenPath: async () => inputPath,
      prepareRestore: async () => ({
        jobId: 'restore_1', previewHash: 'a'.repeat(64), stagedUserDataDir: join(root, 'restore-staging', 'restore_1', 'userData'),
        preview: { backupId: 'portable_1', createdAt: '2026-09-20T10:00:00.000Z', schemaVersion: 10, apiReconnectRequired: true }
      }),
      writePending: async (_root, prepared, grant) => { pending.push(`${prepared.jobId}:${grant.token}`); },
      confirmRestore: async () => true,
      confirmDelete: async () => false,
      relaunch: () => { relaunched += 1; },
      ids: { restoreJobId: () => 'restore_1', token: () => 'restore-token-1' },
      now: () => 1_000
    });

    const preview = await service.restore({ action: 'preview', passphrase: 'restore-语文备份-strong-2026' }, 'restore-preview') as Record<string, unknown>;
    expect(preview).toMatchObject({ restoreJobId: 'restore_1', previewHash: 'a'.repeat(64) });
    const grant = await service.restore({ action: 'request-confirmation', restoreJobId: 'restore_1', previewHash: 'a'.repeat(64) }, 'restore-confirm-request') as { confirmationToken: string };
    expect(grant.confirmationToken).toBe('restore-token-1');
    const confirmed = await service.restore({
      action: 'confirm', restoreJobId: 'restore_1', previewHash: 'a'.repeat(64), confirmationToken: grant.confirmationToken
    }, 'restore-confirm') as Record<string, unknown>;
    expect(confirmed).toEqual({ restoreJobId: 'restore_1', restartRequired: true });
    expect(pending).toEqual(['restore_1:restore-token-1']);
    expect(relaunched).toBe(1);
    await expect(service.restore({
      action: 'confirm', restoreJobId: 'restore_1', previewHash: 'a'.repeat(64), confirmationToken: grant.confirmationToken
    }, 'restore-confirm-replay')).rejects.toThrow('restore_confirmation_invalid');
  });

  it('binds managed-backup deletion to one backup and consumes the token', async () => {
    const root = temp();
    const deleted: string[] = [];
    const service = new ProtectionService({
      userDataDir: root,
      backup: {
        createLocal: async () => ({ backupId: 'local_1' }),
        exportPortable: async () => ({ container: Buffer.from('encrypted'), manifest: { backupId: 'portable_1' } }),
        list: async () => [{ backupId: 'local_1' }],
        deleteManaged: async (id) => { deleted.push(id); return true; }
      },
      choosePortableSavePath: async () => null,
      choosePortableOpenPath: async () => null,
      confirmRestore: async () => false,
      confirmDelete: async () => true,
      relaunch: () => undefined,
      ids: { restoreJobId: () => 'restore_1', token: () => 'delete-token-1' },
      now: () => 2_000
    });
    const prepared = await service.delete({ action: 'prepare', backupId: 'local_1' }, 'delete-prepare') as { confirmationToken: string };
    expect(prepared.confirmationToken).toBe('delete-token-1');
    expect(await service.delete({ action: 'confirm', backupId: 'local_1', confirmationToken: prepared.confirmationToken }, 'delete-confirm'))
      .toEqual({ backupId: 'local_1', deleted: true });
    expect(deleted).toEqual(['local_1']);
    await expect(service.delete({ action: 'confirm', backupId: 'other', confirmationToken: prepared.confirmationToken }, 'delete-other'))
      .rejects.toThrow('backup_delete_confirmation_invalid');
  });
});
