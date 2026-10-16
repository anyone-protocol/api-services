import { createLogger } from '@anyone-protocol/service-kit';
import { beforeEach, describe, expect, it } from 'bun:test';
import { UnsDomains, type UnsTokenRow } from './uns-domains';

const ROW: UnsTokenRow = { tokenId: '1', name: 'first.anyone', owner: '0x0000000000000000000000000000000000000001' };

let clock: number;
let reads: number;
let rows: () => Promise<UnsTokenRow[]>;

function domains(cacheTtlMs = 30_000) {
  return new UnsDomains({
    rows: () => {
      reads++;
      return rows();
    },
    cacheTtlMs,
    logger: createLogger({ service: 'api-service', write: () => {} }),
    now: () => clock,
  });
}

beforeEach(() => {
  clock = 0;
  reads = 0;
  rows = async () => [ROW];
});

describe('UnsDomains', () => {
  it('maps every token row to an anyone domain', async () => {
    expect(await domains().anyoneDomains()).toEqual([{ ...ROW, tld: 'anyone' }]);
  });

  it('serves from cache within the TTL', async () => {
    const service = domains();

    await service.anyoneDomains();
    clock += 29_999;
    await service.anyoneDomains();
    expect(reads).toBe(1);

    clock += 1;
    await service.anyoneDomains();
    expect(reads).toBe(2);
  });

  it('keeps serving the last good list when the database fails', async () => {
    const service = domains(0);
    const good = await service.anyoneDomains();

    rows = () => Promise.reject(new Error('connection refused'));

    expect(await service.anyoneDomains()).toEqual(good);
  });

  it('answers an empty list when the database fails before anything was read', async () => {
    rows = () => Promise.reject(new Error('connection refused'));

    expect(await domains().anyoneDomains()).toEqual([]);
  });
});
