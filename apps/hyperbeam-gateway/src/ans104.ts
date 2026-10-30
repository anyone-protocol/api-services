import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const ETHEREUM_SIGNATURE_TYPE = 3;
export const MAX_TAGS = 128;

const SIGNATURE_LENGTH = 65;
const OWNER_LENGTH = 65;
const ID_LENGTH = 32;
const MAX_TAG_NAME_BYTES = 1024;
const MAX_TAG_VALUE_BYTES = 3072;
const EMPTY = new Uint8Array(0);

export class InvalidDataItem extends Error {}

export interface Tag {
  name: string;
  value: string;
}

export interface DataItem {
  id: string;
  signatureType: number;
  signature: Uint8Array;
  owner: Uint8Array;
  target?: string;
  tags: Tag[];
  data: Uint8Array;
  rawTarget?: Uint8Array;
  rawAnchor?: Uint8Array;
  rawTags: Uint8Array;
}

const encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function hash(algorithm: 'sha256' | 'sha384', ...parts: Uint8Array[]): Uint8Array {
  const hasher = new Bun.CryptoHasher(algorithm);
  for (const part of parts) hasher.update(part);
  return new Uint8Array(hasher.digest());
}

export function deepHash(value: Uint8Array | Uint8Array[]): Uint8Array {
  if (Array.isArray(value)) {
    let accumulator = hash('sha384', utf8(`list${value.length}`));
    for (const chunk of value) accumulator = hash('sha384', accumulator, deepHash(chunk));
    return accumulator;
  }
  return hash('sha384', hash('sha384', utf8(`blob${value.byteLength}`)), hash('sha384', value));
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) throw new InvalidDataItem('data item is truncated');
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  u16(): number {
    const [low = 0, high = 0] = this.take(2);
    return low | (high << 8);
  }

  u64(): number {
    const bytes = this.take(8);
    let value = 0;
    for (let index = 7; index >= 0; index--) value = value * 256 + (bytes[index] ?? 0);
    if (!Number.isSafeInteger(value)) throw new InvalidDataItem('length field is out of range');
    return value;
  }

  present(): boolean {
    const [flag] = this.take(1);
    if (flag === 0) return false;
    if (flag === 1) return true;
    throw new InvalidDataItem('presence flag must be 0 or 1');
  }

  rest(): Uint8Array {
    return this.take(this.bytes.length - this.offset);
  }
}

class AvroReader {
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  long(): number {
    let value = 0;
    let scale = 1;
    for (let index = 0; index < 8; index++) {
      const byte = this.bytes[this.offset++];
      if (byte === undefined) throw new InvalidDataItem('tags are truncated');
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
      scale *= 128;
    }
    throw new InvalidDataItem('tag length is out of range');
  }

  string(maxBytes: number): string {
    const length = this.long();
    if (length < 0 || length > maxBytes || this.offset + length > this.bytes.length) throw new InvalidDataItem('tag is malformed');
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    try {
      return utf8Decoder.decode(slice);
    } catch {
      throw new InvalidDataItem('tag is not valid UTF-8');
    }
  }
}

function decodeTags(bytes: Uint8Array, expectedCount: number): Tag[] {
  const tags: Tag[] = [];
  if (bytes.length === 0) {
    if (expectedCount !== 0) throw new InvalidDataItem('tag count does not match the tags');
    return tags;
  }

  const reader = new AvroReader(bytes);
  for (;;) {
    let count = reader.long();
    if (count === 0) break;
    if (count < 0) {
      count = -count;
      reader.long();
    }
    for (let index = 0; index < count; index++) {
      const name = reader.string(MAX_TAG_NAME_BYTES);
      const value = reader.string(MAX_TAG_VALUE_BYTES);
      if (name.length === 0) throw new InvalidDataItem('tag name is empty');
      tags.push({ name, value });
      if (tags.length > MAX_TAGS) throw new InvalidDataItem(`more than ${MAX_TAGS} tags`);
    }
  }

  if (!reader.done) throw new InvalidDataItem('tags have trailing bytes');
  if (tags.length !== expectedCount) throw new InvalidDataItem('tag count does not match the tags');
  return tags;
}

export function parseDataItem(raw: Uint8Array): DataItem {
  const reader = new Reader(raw);
  const signatureType = reader.u16();
  if (signatureType !== ETHEREUM_SIGNATURE_TYPE) throw new InvalidDataItem(`signature type ${signatureType} is not accepted, only Ethereum signatures are`);

  const signature = reader.take(SIGNATURE_LENGTH);
  const owner = reader.take(OWNER_LENGTH);
  const rawTarget = reader.present() ? reader.take(ID_LENGTH) : undefined;
  const rawAnchor = reader.present() ? reader.take(ID_LENGTH) : undefined;
  const tagCount = reader.u64();
  if (tagCount > MAX_TAGS) throw new InvalidDataItem(`more than ${MAX_TAGS} tags`);
  const rawTags = reader.take(reader.u64());
  const tags = decodeTags(rawTags, tagCount);

  return {
    id: base64url(hash('sha256', signature)),
    signatureType,
    signature,
    owner,
    target: rawTarget && base64url(rawTarget),
    tags,
    data: reader.rest(),
    rawTarget,
    rawAnchor,
    rawTags,
  };
}

export function signingMessage(item: DataItem): Uint8Array {
  const message = deepHash([
    utf8('dataitem'),
    utf8('1'),
    utf8(String(item.signatureType)),
    item.owner,
    item.rawTarget ?? EMPTY,
    item.rawAnchor ?? EMPTY,
    item.rawTags,
    item.data,
  ]);
  return keccak_256(Buffer.concat([utf8(`\x19Ethereum Signed Message:\n${message.length}`), message]));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function checksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const digest = hex(keccak_256(utf8(lower)));
  let checksummed = '0x';
  for (let index = 0; index < lower.length; index++) {
    const character = lower[index] ?? '';
    checksummed += Number.parseInt(digest[index] ?? '0', 16) >= 8 ? character.toUpperCase() : character;
  }
  return checksummed;
}

export function isAddress(value: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return false;
  const digits = value.slice(2);
  return digits === digits.toLowerCase() || digits === digits.toUpperCase() || checksumAddress(value) === value;
}

export function isChecksumAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value) && checksumAddress(value) === value;
}

export function ownerAddress(owner: Uint8Array): string {
  return checksumAddress(hex(keccak_256(owner.subarray(1)).subarray(12)));
}

export function verifySigner(item: DataItem): string {
  const recoveryByte = item.signature[64] ?? 0;
  const recovery = recoveryByte >= 27 ? recoveryByte - 27 : recoveryByte;
  if (recovery !== 0 && recovery !== 1) throw new InvalidDataItem('signature recovery byte is invalid');

  let publicKey: Uint8Array;
  try {
    const signature = secp256k1.Signature.fromBytes(item.signature.subarray(0, 64), 'compact');
    if (signature.hasHighS()) throw new InvalidDataItem('signature is not in low-s form');
    publicKey = signature.addRecoveryBit(recovery).recoverPublicKey(signingMessage(item)).toBytes(false);
  } catch (error) {
    if (error instanceof InvalidDataItem) throw error;
    throw new InvalidDataItem('signature does not verify');
  }

  if (!Buffer.from(publicKey).equals(Buffer.from(item.owner))) throw new InvalidDataItem('signature does not match the owner');
  return ownerAddress(item.owner);
}
