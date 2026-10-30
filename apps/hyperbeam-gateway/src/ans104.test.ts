import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'bun:test';
import { checksumAddress, InvalidDataItem, isAddress, isChecksumAddress, parseDataItem, verifySigner } from './ans104';
import vectors from './testing/arbundles-vectors.json';
import { encodeTags, serialize, signItem, testSigner } from './testing/signing';

const raw = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));
const signer = testSigner(vectors.privateKey);

describe('data items signed by arbundles', () => {
  for (const vector of vectors.items) {
    it(`parses and verifies ${vector.name}`, () => {
      const item = parseDataItem(raw(vector.raw));
      expect(item.id).toBe(vector.id);
      expect(item.target).toBe(vectors.target);
      expect(item.tags).toEqual(vector.tags);
      expect(new TextDecoder().decode(item.data)).toBe(vector.data);
      expect(verifySigner(item)).toBe(vectors.address);
    });

    it(`is reproduced byte for byte by the test signer for ${vector.name}`, () => {
      const signed = signItem(signer, { tags: vector.tags, data: vector.data, target: vectors.target, anchor: vector.anchor ?? undefined });
      expect(Buffer.from(signed).toString('base64')).toBe(vector.raw);
    });
  }
});

describe('parseDataItem', () => {
  const item = { tags: [{ name: 'action', value: 'Set-Delegate' }], target: vectors.target };

  it('refuses signature types other than Ethereum', () => {
    const bytes = signItem(signer, item);
    bytes[0] = 1;
    expect(() => parseDataItem(bytes)).toThrow('signature type 1 is not accepted');
  });

  it('refuses truncated items', () => {
    expect(() => parseDataItem(signItem(signer, item).subarray(0, 120))).toThrow(InvalidDataItem);
  });

  it('refuses a tag count that does not match the tags', () => {
    const bytes = serialize(new Uint8Array(65), signer.owner, item, encodeTags(item.tags), 2);
    expect(() => parseDataItem(bytes)).toThrow('tag count does not match the tags');
  });

  it('refuses tag bytes with trailing data', () => {
    const tags = Buffer.concat([encodeTags(item.tags), Uint8Array.of(0)]);
    expect(() => parseDataItem(serialize(new Uint8Array(65), signer.owner, item, tags))).toThrow('tags have trailing bytes');
  });

  it('refuses a presence flag other than 0 or 1', () => {
    const bytes = signItem(signer, item);
    bytes[2 + 65 + 65] = 2;
    expect(() => parseDataItem(bytes)).toThrow('presence flag must be 0 or 1');
  });

  it('refuses tags that are not UTF-8', () => {
    const tags = Uint8Array.from([2, 2, 0x61, 2, 0xff, 0]);
    expect(() => parseDataItem(serialize(new Uint8Array(65), signer.owner, { tags: [{ name: 'a', value: '?' }] }, tags))).toThrow('tag is not valid UTF-8');
  });
});

describe('verifySigner', () => {
  const item = { tags: [{ name: 'action', value: 'Set-Delegate' }], target: vectors.target };

  it('refuses a changed tag', () => {
    const signed = signItem(signer, item);
    const tampered = serialize(signed.subarray(2, 67), signer.owner, { ...item, tags: [{ name: 'action', value: 'Set-Delegatf' }] });
    expect(() => verifySigner(parseDataItem(tampered))).toThrow(InvalidDataItem);
  });

  it('refuses an owner that did not sign', () => {
    const signed = signItem(signer, item);
    const other = testSigner('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const swapped = serialize(signed.subarray(2, 67), other.owner, item);
    expect(() => verifySigner(parseDataItem(swapped))).toThrow('signature does not match the owner');
  });

  it('refuses the high-s twin of a valid signature', () => {
    const signed = signItem(signer, item);
    const signature = secp256k1.Signature.fromBytes(signed.subarray(2, 66), 'compact');
    const twin = new secp256k1.Signature(signature.r, secp256k1.Point.CURVE().n - signature.s);
    const recovery = (signed[66] ?? 27) === 27 ? 28 : 27;
    const malleated = serialize(Buffer.concat([twin.toBytes('compact'), Uint8Array.of(recovery)]), signer.owner, item);
    expect(() => verifySigner(parseDataItem(malleated))).toThrow('signature is not in low-s form');
  });
});

describe('addresses', () => {
  it('checksums the way EIP-55 does', () => {
    expect(checksumAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('accepts single-case and correctly checksummed addresses only', () => {
    expect(isAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe(true);
    expect(isAddress('0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266')).toBe(true);
    expect(isAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(true);
    expect(isAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92267')).toBe(false);
    expect(isAddress('0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(false);
    expect(isAddress('f39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe(false);
  });

  it('treats only the checksummed form as canonical', () => {
    expect(isChecksumAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(true);
    expect(isChecksumAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe(false);
  });
});
