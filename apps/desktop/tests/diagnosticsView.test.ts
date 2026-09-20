import { describe, expect, it } from 'vitest';
import { diagnosticsPreviewText, diagnosticsScopeNotice, diagnosticsSaveEnabled } from '../src/renderer/diagnosticsView';

const preview = {
  format: 'yuwendesk-diagnostics' as const,
  version: 1 as const,
  generatedAt: '2026-09-20T12:00:00.000Z',
  appVersion: '0.1.0',
  buildMode: 'production' as const,
  platform: { targetSupported: true, identity: 'win11', sandboxEnabled: true },
  storage: {
    schemaVersion: 12, protected: false, credentialEncryption: true,
    objectCounts: { sources: 2, lessonPlans: 1, materialBundles: 1, teachingEvents: 0, observations: 0, modelJobs: 3 }
  },
  maintenance: {
    validBackups: 2, invalidBackups: 0, lastBackupCode: 'BACKUP_OK', lastRestoreCode: null, repeatedFailureCount: 0
  },
  errors: [{ code: 'AUTO_BACKUP_FAILED', count: 1 }],
  network: { automaticUpload: false as const, localHttpService: 'not_started_by_design' as const }
};

describe('G09 diagnostics renderer copy', () => {
  it('renders the full reviewed preview and explains excluded data/no upload', () => {
    const text = diagnosticsPreviewText(preview);
    expect(JSON.parse(text)).toEqual(preview);
    expect(text).toContain('AUTO_BACKUP_FAILED');
    expect(diagnosticsScopeNotice()).toContain('不会自动上传');
    expect(diagnosticsScopeNotice()).toContain('不包含');
  });

  it('enables save only for the exact preview hash still displayed', () => {
    expect(diagnosticsSaveEnabled(null, null, false)).toBe(false);
    expect(diagnosticsSaveEnabled('a'.repeat(64), 'b'.repeat(64), false)).toBe(false);
    expect(diagnosticsSaveEnabled('a'.repeat(64), 'a'.repeat(64), true)).toBe(false);
    expect(diagnosticsSaveEnabled('a'.repeat(64), 'a'.repeat(64), false)).toBe(true);
  });
});
