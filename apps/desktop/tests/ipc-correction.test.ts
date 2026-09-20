import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcService } from '../src/main/ipc';
import { LocalStore } from '../src/main/store';
import { IPC_SCHEMA_VERSION } from '../src/shared/ipc';

function request(operation: 'corrections.decide' | 'corrections.revert', payload: Record<string, unknown>) {
  return {
    schema_version: IPC_SCHEMA_VERSION, request_id: 'request_1', operation,
    workspace_id: 'workspace_default', expected_revision: 4, idempotency_key: 'decision_1', payload
  };
}

function service() {
  const decideCorrection = vi.fn(() => ({
    proposalId: 'correction_1', currentStatus: 'accepted', stateRevision: 1,
    streamRevision: 5, lessonChangeSuggestion: null, preferenceState: {}, effectState: 'unknown', replayed: false
  }));
  const revertCorrection = vi.fn(() => ({
    proposalId: 'correction_1', currentStatus: 'reverted', stateRevision: 2,
    streamRevision: 6, lessonChangeSuggestion: null, preferenceState: {}, effectState: 'unknown', replayed: false
  }));
  const store = new LocalStore(mkdtempSync(join(tmpdir(), 'yuwendesk-ipc-correction-')));
  const svc = new IpcService({
    store, appVersion: '0.1.0', appNameZh: '语文备课工作台', platformSupported: true,
    httpListeners: 0, online: false, buildMode: 'production', sandboxEnabled: true,
    platformDevOverride: false, platformTargetSupported: true, platformIdentity: 'win11',
    feedbackService: { analyze: vi.fn(), decideCorrection, revertCorrection }
  });
  return { svc, decideCorrection, revertCorrection };
}

describe('G08 correction IPC', () => {
  it('dispatches a strict accept decision with both optimistic revisions', async () => {
    const { svc, decideCorrection } = service();
    const response = await svc.handle('corrections.decide', request('corrections.decide', {
      planId: 'plan_1', proposalId: 'correction_1', decision: 'accept', reason: '有限试行', expectedProposalRevision: 0
    }));
    expect(response.ok).toBe(true);
    expect(decideCorrection).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace_default', expectedRevision: 4, expectedProposalRevision: 0, idempotencyKey: 'decision_1'
    }));
  });

  it('rejects extra fields and dispatches revert through a dedicated method', async () => {
    const { svc, revertCorrection } = service();
    const invalid = await svc.handle('corrections.decide', request('corrections.decide', {
      planId: 'plan_1', proposalId: 'correction_1', decision: 'accept', reason: '试行', expectedProposalRevision: 0,
      arbitraryPrompt: '不要允许自由提示词'
    }));
    expect(invalid.ok).toBe(false);
    const reverted = await svc.handle('corrections.revert', request('corrections.revert', {
      planId: 'plan_1', proposalId: 'correction_1', reason: '撤回', expectedProposalRevision: 1
    }));
    expect(reverted.ok).toBe(true);
    expect(revertCorrection).toHaveBeenCalledOnce();
  });
});
