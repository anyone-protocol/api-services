import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { StubUpstreams } from './testing/stubs';
import { type QueryResponse, VictoriaMetrics } from './victoria-metrics';

const VECTOR: QueryResponse = {
  status: 'success',
  data: { resultType: 'vector', result: [{ metric: { __name__: 'total_relays', status: 'all' }, value: [1712316485, '43'], values: [] }] },
};

let upstreams: StubUpstreams;

beforeEach(() => {
  upstreams = new StubUpstreams();
});

afterEach(async () => {
  await upstreams.server.stop(true);
});

describe('VictoriaMetrics', () => {
  it('sends an instant query and returns the response body', async () => {
    upstreams.query = VECTOR;

    expect(await new VictoriaMetrics(upstreams.url).query('total_relays')).toEqual(VECTOR);
    expect(upstreams.requests).toMatchObject([{ path: '/api/v1/query', params: { query: 'total_relays' } }]);
  });

  it('sends a range query with start, end and step', async () => {
    upstreams.queryRange = VECTOR;

    expect(await new VictoriaMetrics(upstreams.url).queryRange('total_relays', 'start', 'end', 'step')).toEqual(VECTOR);
    expect(upstreams.requests).toMatchObject([{ path: '/api/v1/query_range', params: { query: 'total_relays', start: 'start', end: 'end', step: 'step' } }]);
  });

  it('throws when VictoriaMetrics answers with an error', async () => {
    upstreams.failWith = 422;

    await expect(new VictoriaMetrics(upstreams.url).query('total_relays')).rejects.toThrow('VictoriaMetrics answered 422');
  });
});
