import type { UpdatePublicKey } from './types';

export interface UpdateTrustConfiguration {
  trustedKeys: ReadonlyMap<string, UpdatePublicKey>;
  configured: boolean;
  externalBlocker: 'BLOCKED_EXTERNAL: real update public key and signing identity are not provided';
}

// The production trust set intentionally fails closed until the release owner supplies and reviews a real public key.
// Never populate this from environment variables, the selected package, renderer input, or remote response.
export function trustedUpdateKeys(): UpdateTrustConfiguration {
  return {
    trustedKeys: new Map(),
    configured: false,
    externalBlocker: 'BLOCKED_EXTERNAL: real update public key and signing identity are not provided'
  };
}
