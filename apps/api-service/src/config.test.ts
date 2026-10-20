import { describe, expect, it } from 'bun:test';
import { loadConfig } from './config';

const REQUIRED = {
  ONIONOO_INSTANCE: '10.1.0.5:9090',
  VICTORIA_METRICS_ADDRESS: 'http://10.1.0.6:8428',
  GEO_IP_SERVICE_URL: 'http://10.1.0.7:24312',
  HB_URL: 'https://hb.example.org',
  OPERATOR_REGISTRY_PROCESS_ID: 'operator-registry-process-id',
  DB_HOST: '10.1.0.8',
  DB_USER: 'api',
  DB_NAME: 'uns_indexer',
};

describe('loadConfig', () => {
  it('applies the defaults of the old service', () => {
    expect(loadConfig(REQUIRED)).toMatchObject({
      PORT: 3000,
      ONIONOO_PROTOCOL: 'http://',
      ONIONOO_DETAILS_CACHE_TTL_SECONDS: 60,
      ONIONOO_DETAILS_TIMEOUT_SECONDS: 30,
      CLUSTER: 'local',
      ENV: 'main',
      JOB: 'consulagentonionoo',
      FROM: '-7d',
      TO: 'now',
      INTERVAL: '6h',
      HEXAGON_RESOLUTION: 4,
      GEO_IP_CACHE_TTL: 60 * 60 * 1000,
      OPERATOR_REGISTRY_CACHE_TTL_SECONDS: 0,
      DB_PORT: 5432,
      UNS_DOMAINS_CACHE_TTL_SECONDS: 30,
      geoIpServiceUrl: 'http://10.1.0.7:24312',
    });
  });

  it.each(['HB_URL', 'OPERATOR_REGISTRY_PROCESS_ID', 'ONIONOO_INSTANCE', 'VICTORIA_METRICS_ADDRESS', 'DB_HOST'])('fails closed without %s', (name) => {
    expect(() => loadConfig({ ...REQUIRED, [name]: undefined })).toThrow(`${name} is required`);
  });

  it('reads the geo-ip-service address from a file when given one', () => {
    const { geoIpServiceUrl } = loadConfig({ ...REQUIRED, GEO_IP_SERVICE_URL: undefined, GEO_IP_SERVICE_URL_FILE: '/nonexistent/geo-ip-service-url' });

    expect(typeof geoIpServiceUrl).toBe('function');
    expect(typeof geoIpServiceUrl === 'function' && geoIpServiceUrl()).toBeUndefined();
  });

  const GEO_IP_SOURCE = 'exactly one of GEO_IP_SERVICE_URL and GEO_IP_SERVICE_URL_FILE is required';

  it.each([
    ['no geo-ip-service address', { GEO_IP_SERVICE_URL: undefined }, GEO_IP_SOURCE],
    ['two geo-ip-service addresses', { GEO_IP_SERVICE_URL_FILE: '/local/geo-ip-service-url' }, GEO_IP_SOURCE],
    ['an H3 resolution above 15', { HEXAGON_RESOLUTION: '16' }, 'HEXAGON_RESOLUTION must be from 0 to 15'],
    ['a zero Onionoo timeout', { ONIONOO_DETAILS_TIMEOUT_SECONDS: '0' }, 'ONIONOO_DETAILS_TIMEOUT_SECONDS must be greater than 0'],
    ['a negative cache TTL', { UNS_DOMAINS_CACHE_TTL_SECONDS: '-1' }, 'UNS_DOMAINS_CACHE_TTL_SECONDS must not be negative'],
  ])('rejects %s', (_, overrides, problem) => {
    expect(() => loadConfig({ ...REQUIRED, ...overrides })).toThrow(problem);
  });
});
