import { UpdateValidationError } from './types';

const MAGIC = Buffer.from('YWUPD01!', 'ascii');
const CONTAINER_VERSION = 1;
export const UPDATE_CONTAINER_HEADER_BYTES = 19;
export const UPDATE_MANIFEST_MAX_BYTES = 64 * 1024;
export const UPDATE_SIGNATURE_BYTES = 64;
export const UPDATE_PACKAGE_MAX_BYTES = 1024 * 1024 * 1024;

export interface UpdateContainerSections {
  manifestBytes: Buffer;
  signature: Buffer;
  packageBytes: Buffer;
}

export interface UpdateContainerLayout {
  manifestLength: number;
  signatureLength: number;
  packageLength: number;
  manifestOffset: number;
  signatureOffset: number;
  packageOffset: number;
  totalLength: number;
}

export function buildUpdateContainer(input: UpdateContainerSections): Buffer {
  if (input.manifestBytes.length > 0xffff_ffff || input.signature.length > 0xffff || input.packageBytes.length > 0xffff_ffff) {
    throw new UpdateValidationError('UPDATE_CONTAINER_INVALID');
  }
  const header = Buffer.alloc(UPDATE_CONTAINER_HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt8(CONTAINER_VERSION, 8);
  header.writeUInt32BE(input.manifestBytes.length, 9);
  header.writeUInt16BE(input.signature.length, 13);
  header.writeUInt32BE(input.packageBytes.length, 15);
  return Buffer.concat([header, input.manifestBytes, input.signature, input.packageBytes]);
}

export function parseUpdateContainer(
  container: Buffer,
  maxPackageBytes = UPDATE_PACKAGE_MAX_BYTES
): UpdateContainerSections {
  if (!Buffer.isBuffer(container) || container.length < UPDATE_CONTAINER_HEADER_BYTES) {
    throw new UpdateValidationError('UPDATE_CONTAINER_INVALID');
  }
  const layout = parseUpdateContainerHeader(
    container.subarray(0, UPDATE_CONTAINER_HEADER_BYTES),
    container.length,
    maxPackageBytes
  );
  return {
    manifestBytes: Buffer.from(container.subarray(layout.manifestOffset, layout.signatureOffset)),
    signature: Buffer.from(container.subarray(layout.signatureOffset, layout.packageOffset)),
    packageBytes: Buffer.from(container.subarray(layout.packageOffset))
  };
}

export function parseUpdateContainerHeader(
  header: Buffer,
  totalLength: number,
  maxPackageBytes = UPDATE_PACKAGE_MAX_BYTES
): UpdateContainerLayout {
  if (header.length !== UPDATE_CONTAINER_HEADER_BYTES || !Number.isSafeInteger(totalLength)) {
    throw new UpdateValidationError('UPDATE_CONTAINER_INVALID');
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header.readUInt8(8) !== CONTAINER_VERSION) {
    throw new UpdateValidationError('UPDATE_CONTAINER_INVALID');
  }
  const manifestLength = header.readUInt32BE(9);
  const signatureLength = header.readUInt16BE(13);
  const packageLength = header.readUInt32BE(15);
  if (
    manifestLength === 0 || manifestLength > UPDATE_MANIFEST_MAX_BYTES ||
    signatureLength !== UPDATE_SIGNATURE_BYTES ||
    packageLength === 0 || !Number.isSafeInteger(maxPackageBytes) || maxPackageBytes <= 0 || packageLength > maxPackageBytes
  ) {
    throw new UpdateValidationError('UPDATE_CONTAINER_INVALID');
  }
  const expectedLength = UPDATE_CONTAINER_HEADER_BYTES + manifestLength + signatureLength + packageLength;
  if (!Number.isSafeInteger(expectedLength) || expectedLength !== totalLength) {
    throw new UpdateValidationError('UPDATE_CONTAINER_INVALID');
  }
  const manifestStart = UPDATE_CONTAINER_HEADER_BYTES;
  const signatureStart = manifestStart + manifestLength;
  const packageStart = signatureStart + signatureLength;
  return {
    manifestLength,
    signatureLength,
    packageLength,
    manifestOffset: manifestStart,
    signatureOffset: signatureStart,
    packageOffset: packageStart,
    totalLength: expectedLength
  };
}
