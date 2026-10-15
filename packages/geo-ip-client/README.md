# @anyone-protocol/geo-ip-client

A typed client for `geo-ip-service`. It batches lookups, caches results by address, keeps serving cached results while the service is unreachable, and reports the state of its cache. It uses only the standard `fetch` API and has no dependencies, so it runs on Bun and on Node.js.

```ts
import { GeoIpClient } from '@anyone-protocol/geo-ip-client';

const geo = new GeoIpClient({ baseUrl: config.GEO_IP_SERVICE_URL, h3Resolution: 4, logger });

const results = await geo.lookupMany(relays.map((relay) => relay.address));
for (const [address, result] of results) {
  if (result.status === 'found') {
    place(address, result.location.h3?.cell);
  }
}
```

## Results

`lookupMany(addresses)` resolves to a `Map` with one entry per distinct address. `lookup(address)` does the same for one address. Each result has a `status`:

| Status | Meaning | Other fields |
| ------ | ------- | ------------ |
| `found` | the address is in the database | `location`, `stale` |
| `not-found` | the address is valid but not in the database | `stale` |
| `invalid` | the service could not parse the address | `stale` |
| `unavailable` | there is no cached result and the service could not be asked | none |

`stale` is `true` when the result comes from the cache past its TTL because the service could not be reached.

`location` holds whatever the database has for the address. Every field is optional:

| Field | Example |
| ----- | ------- |
| `coordinates` | `{ "latitude": -33.86, "longitude": 151.2 }` |
| `countryCode`, `countryName` | `"AU"`, `"Australia"` |
| `regionName`, `cityName` | `"New South Wales"`, `"Sydney"` |
| `timeZone` | `"Australia/Sydney"` |
| `asNumber`, `asName` | `13335`, `"CLOUDFLARENET"` |
| `h3` | `{ "resolution": 4, "cell": "84be0e3ffffffff", "center": { "latitude": -33.7411, "longitude": 151.2858 } }`, present when the client was created with `h3Resolution` and the address has coordinates |

## Options

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `baseUrl` | required | base URL of `geo-ip-service`, for example `http://10.1.0.5:3000` |
| `h3Resolution` | none | H3 resolution to ask for with every lookup |
| `cacheTtlMs` | one hour | age after which a cached result is asked for again |
| `maxCacheEntries` | 50,000 | entries kept; beyond this the least recently refreshed are dropped |
| `maxBatchSize` | 10,000 | addresses per request; must not exceed the service's batch limit |
| `requestTimeoutMs` | five seconds | time allowed for one request |
| `retryAfterFailureMs` | 30 seconds | time after a failed request during which the client does not ask again |
| `logger` | none | anything with a `warn(message, fields)` method, such as the `service-kit` logger; failed requests are logged through it |

## Cache and failure behavior

A lookup asks the service only for addresses with no cached result or an expired one. Distinct addresses are sent in batches of `maxBatchSize`, one batch after another. Every answer is cached, including `not-found` and `invalid`.

A request fails when it cannot connect, runs past `requestTimeoutMs`, gets a status other than `2xx`, or gets a body without `results`. After a failure:

- the remaining batches of that lookup are not sent;
- every address with a cached result gets it, marked `stale`, however old it is;
- every address without one is `unavailable`;
- for `retryAfterFailureMs` no request is sent, and lookups answer from the cache right away instead of each waiting for a timeout;
- the next successful request clears the failure.

Cached results are never dropped for age, only when the cache is over `maxCacheEntries`, so a long outage keeps serving the last answer for every address seen.

## State

`state()` describes the cache and the last request, ready to put in a health check:

```json
{
  "entries": 9120,
  "expiredEntries": 0,
  "failing": false,
  "lastSuccessAt": "2030-01-02T03:04:05.000Z",
  "lastFailureAt": null,
  "lastError": null
}
```

`failing` is `true` from a failed request until the next successful one.

## Protocol

The client sends every lookup as `POST /lookup` with a JSON body:

```json
{ "addresses": ["1.1.1.1", "2001:db8::1", "not-an-address"], "h3Resolution": 4 }
```

and expects `200` with one result per address, each the result object above plus its `address`:

```json
{
  "results": [
    { "address": "1.1.1.1", "status": "found", "location": { "countryCode": "AU" } },
    { "address": "2001:db8::1", "status": "not-found" },
    { "address": "not-an-address", "status": "invalid" }
  ]
}
```

The request and response types are exported from this package as `BatchLookupRequest` and `BatchLookupResponse`, and the path as `BATCH_LOOKUP_PATH`.
