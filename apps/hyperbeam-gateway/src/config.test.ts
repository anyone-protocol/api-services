import { describe, expect, it } from 'bun:test';
import { loadConfig } from './config';

const BASE = {
  HB_URL: 'http://10.1.1.1:8080',
  OPERATOR_REGISTRY_PROCESS_ID: Buffer.alloc(32, 1).toString('base64url'),
  RELAY_REWARDS_PROCESS_ID: Buffer.alloc(32, 2).toString('base64url'),
  STAKING_REWARDS_PROCESS_ID: Buffer.alloc(32, 3).toString('base64url'),
};
const TEAM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('loadConfig', () => {
  it('defaults to no admin actions', () => {
    const config = loadConfig(BASE);
    expect(config.adminActions.size).toBe(0);
    expect(config.VIEW_CACHE_TTL).toBe(30_000);
    expect(config.NODE_WRITE_TIMEOUT).toBe(60_000);
  });

  it('reads admin actions and signers', () => {
    const config = loadConfig({ ...BASE, ADMIN_ACTIONS: 'operator-registry:Block-Operator-Address, relay-rewards:Cancel-Round', ADMIN_SIGNERS: TEAM });
    expect([...config.adminActions]).toEqual(['operator-registry:Block-Operator-Address', 'relay-rewards:Cancel-Round']);
    expect([...config.adminSigners]).toEqual([TEAM]);
  });

  it('refuses process ids that are malformed or repeated', () => {
    expect(() => loadConfig({ ...BASE, RELAY_REWARDS_PROCESS_ID: 'short' })).toThrow('RELAY_REWARDS_PROCESS_ID must be a 43 character process id');
    expect(() => loadConfig({ ...BASE, RELAY_REWARDS_PROCESS_ID: BASE.OPERATOR_REGISTRY_PROCESS_ID })).toThrow('process ids must be distinct');
  });

  it('refuses admin actions that are unknown or controller only', () => {
    expect(() => loadConfig({ ...BASE, ADMIN_ACTIONS: 'relay-rewards:Add-Scores', ADMIN_SIGNERS: TEAM })).toThrow('ADMIN_ACTIONS entry relay-rewards:Add-Scores is not a known admin action');
    expect(() => loadConfig({ ...BASE, ADMIN_ACTIONS: 'relay-rewards:Set-Delegate', ADMIN_SIGNERS: TEAM })).toThrow('is not a known admin action');
  });

  it('refuses admin signers that are not checksummed and admin actions without signers', () => {
    expect(() => loadConfig({ ...BASE, ADMIN_SIGNERS: TEAM.toLowerCase() })).toThrow('must be a checksummed address');
    expect(() => loadConfig({ ...BASE, ADMIN_ACTIONS: 'relay-rewards:Cancel-Round' })).toThrow('ADMIN_ACTIONS needs at least one ADMIN_SIGNERS entry');
  });
});
