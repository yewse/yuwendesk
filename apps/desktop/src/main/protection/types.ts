export type BackupKind = 'local' | 'portable';
export type BackupRetention = 'daily' | 'weekly';
export type BackupFileRole = 'database' | 'material' | 'workspace-key';

export interface BackupFileEntry {
  path: string;
  sha256: string;
  byteSize: number;
  role: BackupFileRole;
}

export interface BackupManifest {
  format: 'yuwendesk-backup-manifest';
  version: 1;
  backupId: string;
  kind: BackupKind;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  retention: BackupRetention[];
  files: BackupFileEntry[];
  sourceDocumentIds: string[];
  credentialExcluded: true;
}

export interface SnapshotSummary {
  schemaVersion: number;
  credentialRowsRemoved: number;
  secureKeyRowsRemoved: number;
}

