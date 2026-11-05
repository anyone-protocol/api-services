import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ETHEREUM_SIGNATURE_TYPE, ownerAddress, parseDataItem, signingMessage, type Tag, utf8 } from '../ans104';

export const TEST_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export interface UnsignedItem {
  tags: Tag[];
  data?: string | Uint8Array;
  target?: string;
  anchor?: string | Uint8Array;
}

function zigzag(value: number): number[] {
  let encoded = value >= 0 ? value * 2 : -value * 2 - 1;
  const bytes: number[] = [];
  do {
    let byte = encoded % 128;
    encoded = Math.floor(encoded / 128);
    if (encoded > 0) byte |= 0x80;
    bytes.push(byte);
  } while (encoded > 0);
  return bytes;
}

export function encodeTags(tags: Tag[]): Uint8Array {
  if (tags.length === 0) return new Uint8Array(0);
  const bytes: number[] = [...zigzag(tags.length)];
  for (const { name, value } of tags) {
    for (const text of [name, value]) {
      const encoded = utf8(text);
      bytes.push(...zigzag(encoded.length), ...encoded);
    }
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}

function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let index = 0; index < 8; index++) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? utf8(value) : value;
}

export function serialize(signature: Uint8Array, owner: Uint8Array, item: UnsignedItem, rawTags = encodeTags(item.tags), tagCount = item.tags.length): Uint8Array {
  const target = item.target ? Buffer.from(item.target, 'base64url') : undefined;
  const anchor = item.anchor === undefined ? undefined : toBytes(item.anchor);
  return Buffer.concat([
    Uint8Array.of(ETHEREUM_SIGNATURE_TYPE, 0),
    signature,
    owner,
    target ? Buffer.concat([Uint8Array.of(1), target]) : Uint8Array.of(0),
    anchor ? Buffer.concat([Uint8Array.of(1), anchor]) : Uint8Array.of(0),
    u64(tagCount),
    u64(rawTags.length),
    rawTags,
    toBytes(item.data ?? ''),
  ]);
}

export interface TestSigner {
  privateKey: Uint8Array;
  owner: Uint8Array;
  address: string;
}

export function testSigner(privateKeyHex = TEST_PRIVATE_KEY): TestSigner {
  const privateKey = Uint8Array.from(Buffer.from(privateKeyHex, 'hex'));
  const owner = secp256k1.getPublicKey(privateKey, false);
  return { privateKey, owner, address: ownerAddress(owner) };
}

export function randomSigner(): TestSigner {
  return testSigner(Buffer.from(secp256k1.utils.randomSecretKey()).toString('hex'));
}

export function signItem(signer: TestSigner, item: UnsignedItem): Uint8Array {
  const placeholder = serialize(new Uint8Array(65), signer.owner, item);
  const digest = signingMessage(parseDataItem(placeholder));
  const recovered = secp256k1.Signature.fromBytes(secp256k1.sign(digest, signer.privateKey, { prehash: false, format: 'recovered' }), 'recovered');
  const signature = Buffer.concat([recovered.toBytes('compact'), Uint8Array.of(27 + (recovered.recovery ?? 0))]);
  return serialize(signature, signer.owner, item);
}
