import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

const MAGIC = Buffer.from('YWBACKUP', 'ascii');
const VERSION = 1;
const PREFIX_BYTES = 13;
const TAG_BYTES = 16;

export interface ScryptParameters {
  N: number;
  r: number;
  p: number;
}

export interface EnvelopeOptions {
  salt?: Buffer;
  nonce?: Buffer;
  kdf?: ScryptParameters;
}

interface EnvelopeHeader {
  cipher: { name: 'aes-256-gcm'; nonce: string };
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  payloadBytes: number;
}

const MIN_N = 32768;
const MAX_N = 131072;
const DEFAULT_KDF: ScryptParameters = { N: MIN_N, r: 8, p: 1 };
let calibratedKdf: Promise<ScryptParameters> | null = null;

function validKdf(value: ScryptParameters): boolean {
  return Number.isSafeInteger(value.N) && value.N >= MIN_N && value.N <= MAX_N && (value.N & (value.N - 1)) === 0 &&
    value.r === 8 && value.p === 1;
}

function derive(passphrase: string, salt: Buffer, params: ScryptParameters): Promise<Buffer> {
  const maxmem = Math.max(64 * 1024 * 1024, 128 * params.N * params.r + 32 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(Buffer.from(key));
    });
  });
}

export function selectCalibratedScryptN(elapsedAtMinimumMs: number): number {
  if (!Number.isFinite(elapsedAtMinimumMs) || elapsedAtMinimumMs <= 0) return MIN_N;
  if (elapsedAtMinimumMs * 4 <= 250) return MAX_N;
  if (elapsedAtMinimumMs * 2 <= 313) return 65536;
  return MIN_N;
}

async function productionKdf(): Promise<ScryptParameters> {
  calibratedKdf ??= (async () => {
    const started = performance.now();
    await derive('yuwendesk-kdf-calibration', Buffer.alloc(16, 0xa5), DEFAULT_KDF);
    return { N: selectCalibratedScryptN(performance.now() - started), r: 8, p: 1 };
  })();
  return calibratedKdf;
}

export function validateStrongPassphrase(passphrase: string): { ok: true } | { ok: false; reason: string } {
  if ([...passphrase].length < 14) return { ok: false, reason: 'passphrase_too_short' };
  if (!passphrase.trim()) return { ok: false, reason: 'passphrase_blank' };
  const normalized = passphrase.normalize('NFKC').toLowerCase();
  if (['passwordpassword', '12345678901234', 'qwertyuiopasdf'].includes(normalized)) {
    return { ok: false, reason: 'passphrase_too_common' };
  }
  return { ok: true };
}

function prefix(headerLength: number): Buffer {
  const out = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(out, 0);
  out.writeUInt8(VERSION, 8);
  out.writeUInt32BE(headerLength, 9);
  return out;
}

export async function sealPortableArchive(payload: Buffer, passphrase: string, options: EnvelopeOptions = {}): Promise<Buffer> {
  const strength = validateStrongPassphrase(passphrase);
  if (!strength.ok) throw new Error(strength.reason);
  const params = options.kdf ?? await productionKdf();
  if (!validKdf(params)) throw new Error('backup_kdf_parameters_invalid');
  const salt = options.salt ?? randomBytes(16);
  const nonce = options.nonce ?? randomBytes(12);
  if (salt.length !== 16 || nonce.length !== 12) throw new Error('backup_envelope_random_invalid');
  const header: EnvelopeHeader = {
    cipher: { name: 'aes-256-gcm', nonce: nonce.toString('base64') },
    kdf: { name: 'scrypt', N: params.N, r: params.r, p: params.p, salt: salt.toString('base64') },
    payloadBytes: payload.length
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefixBytes = prefix(headerBytes.length);
  const aad = Buffer.concat([prefixBytes, headerBytes]);
  const key = await derive(passphrase, salt, params);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([aad, encrypted, cipher.getAuthTag()]);
}

function parseHeader(container: Buffer): { header: EnvelopeHeader; headerBytes: Buffer; prefixBytes: Buffer; ciphertext: Buffer; tag: Buffer } {
  if (container.length < PREFIX_BYTES + TAG_BYTES || !container.subarray(0, 8).equals(MAGIC) || container.readUInt8(8) !== VERSION) {
    throw new Error('backup_envelope_invalid');
  }
  const headerLength = container.readUInt32BE(9);
  if (headerLength < 64 || headerLength > 4096 || container.length < PREFIX_BYTES + headerLength + TAG_BYTES) {
    throw new Error('backup_envelope_invalid');
  }
  const prefixBytes = container.subarray(0, PREFIX_BYTES);
  const headerBytes = container.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength);
  let raw: unknown;
  try {
    raw = JSON.parse(headerBytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('backup_envelope_invalid');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('backup_envelope_invalid');
  const header = raw as EnvelopeHeader;
  const params = header.kdf;
  if (!params || params.name !== 'scrypt' || !validKdf(params)) throw new Error('backup_kdf_parameters_invalid');
  if (!header.cipher || header.cipher.name !== 'aes-256-gcm' || !Number.isSafeInteger(header.payloadBytes) || header.payloadBytes < 0) {
    throw new Error('backup_envelope_invalid');
  }
  const end = container.length - TAG_BYTES;
  const ciphertext = container.subarray(PREFIX_BYTES + headerLength, end);
  if (ciphertext.length !== header.payloadBytes) throw new Error('backup_envelope_invalid');
  return { header, headerBytes, prefixBytes, ciphertext, tag: container.subarray(end) };
}

export async function openPortableArchive(container: Buffer, passphrase: string): Promise<Buffer> {
  if (container.length > 512 * 1024 * 1024) throw new Error('backup_container_too_large');
  const parsed = parseHeader(container);
  const salt = Buffer.from(parsed.header.kdf.salt, 'base64');
  const nonce = Buffer.from(parsed.header.cipher.nonce, 'base64');
  if (salt.length !== 16 || nonce.length !== 12 || parsed.tag.length !== TAG_BYTES) throw new Error('backup_envelope_invalid');
  const key = await derive(passphrase, salt, parsed.header.kdf);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.concat([parsed.prefixBytes, parsed.headerBytes]));
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  } catch {
    throw new Error('backup_authentication_failed');
  }
}
