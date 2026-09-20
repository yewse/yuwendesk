import type { KeyObject } from 'node:crypto';

export const UPDATE_REJECTION_CODES = [
  'UPDATE_TRUST_NOT_CONFIGURED',
  'UPDATE_CONTAINER_INVALID',
  'UPDATE_MANIFEST_INVALID',
  'UPDATE_SIGNATURE_INVALID',
  'UPDATE_TARGET_MISMATCH',
  'UPDATE_VERSION_REJECTED',
  'UPDATE_PACKAGE_INVALID',
  'UPDATE_SPACE_INSUFFICIENT',
  'UPDATE_STATE_CHANGED',
  'UPDATE_STAGE_FAILED'
] as const;

export type UpdateRejectionCode = (typeof UPDATE_REJECTION_CODES)[number];

const CLOSED_MESSAGES: Record<UpdateRejectionCode, string> = {
  UPDATE_TRUST_NOT_CONFIGURED: 'trusted update identity is not configured',
  UPDATE_CONTAINER_INVALID: 'update container is invalid',
  UPDATE_MANIFEST_INVALID: 'update manifest is invalid',
  UPDATE_SIGNATURE_INVALID: 'update signature is invalid',
  UPDATE_TARGET_MISMATCH: 'update target does not match this application',
  UPDATE_VERSION_REJECTED: 'update version is not applicable',
  UPDATE_PACKAGE_INVALID: 'update package integrity is invalid',
  UPDATE_SPACE_INSUFFICIENT: 'update staging space is insufficient',
  UPDATE_STATE_CHANGED: 'update selection or application state changed',
  UPDATE_STAGE_FAILED: 'update staging failed'
};

export class UpdateValidationError extends Error {
  constructor(readonly code: UpdateRejectionCode) {
    super(CLOSED_MESSAGES[code]);
    this.name = 'UpdateValidationError';
  }
}

export interface UpdateManifestV1 {
  format: 'yuwendesk-update-manifest';
  version: 1;
  releaseId: string;
  appId: string;
  targetVersion: string;
  minimumSourceVersion: string;
  platform: string;
  arch: string;
  packageName: string;
  packageBytes: number;
  packageSha256: string;
  signingKeyId: string;
  createdAt: string;
}

export type UpdatePublicKey = KeyObject | string | Buffer;

export interface UpdateInspectionOptions {
  currentVersion: string;
  appId: string;
  platform: string;
  arch: string;
  trustedKeys: ReadonlyMap<string, UpdatePublicKey>;
  maxPackageBytes?: number;
}

export interface VerifiedUpdate {
  manifest: UpdateManifestV1;
  manifestBytes: Buffer;
  manifestSignature: Buffer;
  manifestSha256: string;
  packageBytes: Buffer;
  containerSha256: string;
}

export interface UpdateSummary {
  releaseId: string;
  currentVersion: string;
  targetVersion: string;
  packageBytes: number;
  packageSha256: string;
  manifestSha256: string;
  createdAt: string;
}
