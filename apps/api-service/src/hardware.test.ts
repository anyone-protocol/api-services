import { describe, expect, it } from 'bun:test';
import { validateHardwareInfo } from './hardware';

const FIELDS = ['id', 'company', 'format', 'wallet', 'fingerprint', 'nftid', 'build', 'flags'];

describe('validateHardwareInfo', () => {
  it('reports every missing top level field and skips wildcards with nothing to expand', () => {
    expect(validateHardwareInfo({}).map(({ path, msg }) => `${path}: ${msg}`)).toEqual([
      'id: id should not be empty',
      'company: company should not be empty',
      'format: format should not be empty',
      'wallet: wallet should not be empty',
      'fingerprint: fingerprint should not be empty',
      'fingerprint: fingerprint must be a 40 character hexadecimal string',
      'nftid: nftid should not be empty',
      'build: build should not be empty',
      'flags: flags should not be empty',
      'serNums: serNums should not be empty',
      'pubKeys: ID should not be empty',
      'certs: certs should not be empty',
    ]);
  });

  it('checks every item of an array value and every item of a wildcard', () => {
    const errors = validateHardwareInfo({ id: ['', 'a', null], fingerprint: 'xyz', serNums: [{ type: '' }, 'str', { type: 0 }, []] });

    expect(errors.filter(({ path }) => ['id', 'fingerprint', 'serNums', 'serNums[0].type', 'serNums[1].type', 'serNums[2].type', 'serNums[3].type'].includes(path))).toEqual([
      { type: 'field', value: '', msg: 'id should not be empty', path: 'id', location: 'body' },
      { type: 'field', value: null, msg: 'id should not be empty', path: 'id', location: 'body' },
      { type: 'field', value: 'xyz', msg: 'fingerprint must be a 40 character hexadecimal string', path: 'fingerprint', location: 'body' },
      { type: 'field', value: [], msg: 'serNums should not be empty', path: 'serNums', location: 'body' },
      { type: 'field', value: '', msg: 'serNums.*.type should not be empty', path: 'serNums[0].type', location: 'body' },
      { type: 'field', value: undefined, msg: 'serNums.*.type should not be empty', path: 'serNums[1].type', location: 'body' },
      { type: 'field', value: undefined, msg: 'serNums.*.type should not be empty', path: 'serNums[3].type', location: 'body' },
    ]);
  });

  it('accepts an empty array, numbers, booleans and objects as not empty', () => {
    const body = Object.fromEntries(FIELDS.map((field) => [field, { any: 'object' }]));
    const errors = validateHardwareInfo({ ...body, id: 0, company: false, fingerprint: 'a'.repeat(40), serNums: [], pubKeys: [], certs: [] });

    expect(errors).toEqual([]);
  });

  it('names object keys with dots in brackets', () => {
    const errors = validateHardwareInfo({ serNums: { 'a.b': { type: '' } } });

    expect(errors.find(({ msg }) => msg === 'serNums.*.type should not be empty')?.path).toBe('serNums["a.b"].type');
  });
});
