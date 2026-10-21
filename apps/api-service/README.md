# api-service

The public HTTP API behind `api.ec.anyone.tech`. It serves relay metrics from VictoriaMetrics, relay details and maps from Onionoo, operator addresses from the operator registry process on HyperBEAM, and `.anyone` domains from the UNS indexer database. Relay locations come from [geo-ip-service](../geo-ip-service/) through [geo-ip-client](../../packages/geo-ip-client/).

Responses keep the shape, status codes and headers of the Express service it replaces; see [Responses](#responses).

## Running locally

The service needs every upstream it reads from. With geo-ip-service running locally as [its README](../geo-ip-service/#running-locally) shows, started with `PORT=3001`:

```sh
GEO_IP_SERVICE_URL=http://localhost:3001 \
ONIONOO_INSTANCE=<onionoo host:port> \
VICTORIA_METRICS_ADDRESS=http://<victoriametrics host:port> \
HB_URL=https://hb.anyone.tech \
OPERATOR_REGISTRY_PROCESS_ID=<process id> \
DB_HOST=<host> DB_USER=<user> DB_PASS=<password> DB_NAME=uns_indexer \
bun run --filter api-service dev
```

`dev` and `start` run Bun with `--max-http-header-size=80000`, and so does the image. Bun otherwise refuses requests whose request line and headers exceed 16 KiB with `431`, and a relay lookup for many fingerprints is a long query string.

## Configuration

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `ONIONOO_INSTANCE` | required | Onionoo `host:port`; also the `instance` label of the relay metrics |
| `ONIONOO_PROTOCOL` | `http://` | scheme put in front of `ONIONOO_INSTANCE` |
| `ONIONOO_DETAILS_CACHE_TTL_SECONDS` | `60` | how long the Onionoo details document is served from memory; `0` asks Onionoo on every request |
| `ONIONOO_DETAILS_TIMEOUT_SECONDS` | `30` | time allowed for an Onionoo details request |
| `VICTORIA_METRICS_ADDRESS` | required | VictoriaMetrics base URL |
| `CLUSTER`, `ENV`, `JOB` | `local`, `main`, `consulagentonionoo` | labels selecting the relay metrics series |
| `FROM`, `TO`, `INTERVAL` | `-7d`, `now`, `6h` | default range and step of the metrics range routes |
| `HEXAGON_RESOLUTION` | `4` | H3 resolution of the relay map cells, 0 to 15 |
| `GEO_IP_SERVICE_URL` | | base URL of geo-ip-service |
| `GEO_IP_SERVICE_URL_FILE` | | file holding the base URL of geo-ip-service, read again for every lookup request; set this or `GEO_IP_SERVICE_URL` |
| `GEO_IP_CACHE_TTL` | `1h` | age after which a cached location is asked for again |
| `HB_URL` | required | HyperBEAM node the operator registry is read from |
| `OPERATOR_REGISTRY_PROCESS_ID` | required | operator registry process |
| `OPERATOR_REGISTRY_CACHE_TTL_SECONDS` | `0` | how long the operator list is served from memory |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME` | `DB_PORT` `5432`, others required | UNS indexer Postgres database, read only |
| `DB_PASS` | none | its password, handled as a [secret](../../packages/service-kit/#secrets) |
| `UNS_DOMAINS_CACHE_TTL_SECONDS` | `30` | how long the domain list is served from memory |
| `PORT`, `LOG_LEVEL` | | see [service-kit](../../packages/service-kit/#environment) |

The Nomad jobs set `GEO_IP_SERVICE_URL` from Consul, as [operations](../../operations/#reaching-it-from-another-job) describes. With `GEO_IP_SERVICE_URL_FILE`, a missing or empty file counts as geo-ip-service being unavailable.

## API

| Route | Answer |
| ----- | ------ |
| `GET /total-relays`, `/total-observed-bandwidth`, `/average-bandwidth-rate` | samples per relay status (`all`, `offline`, `online`) over a range |
| `GET /total-relays-latest`, `/total-observed-bandwidth-latest`, `/average-bandwidth-rate-latest` | latest value per relay status |
| `GET /relays/:fingerprint` | one relay's nickname, fingerprint, running flag, consensus weight, observed bandwidth and measured flag; `404` when unknown |
| `GET /relays?fingerprints=<a>,<b>` | the same for every known relay in the list; `400` without fingerprints |
| `GET /relay-map/` | H3 cells holding relays: `index`, `relayCount`, `geo` (cell center) and `boundary` |
| `GET /fingerprint-map/` | per relay fingerprint: `hexId`, `coordinates` (cell center), country, region, city and autonomous system |
| `POST /hardware` | validates hardware relay info and stores it in Onionoo; `400` with the list of validation errors |
| `GET /operators` | operator addresses; `?withDomains=true` adds the `.anyone` domains each one owns |
| `GET /anyone-domains` | every `.anyone` domain with its token id and owner |
| `GET /healthz` | service health, see [Health](#health) |

The range routes take `from`, `to` and `interval`, passed to VictoriaMetrics as `start`, `end` and `step` in any format its range queries accept, for example `/total-relays?from=-3d&to=now&interval=12h`.

A failing upstream answers `500` with a short text naming it, such as `Error querying Onionoo`.

### Relay locations

The map routes look up the first OR address of every relay in geo-ip-service, one batch for the addresses not cached or cached longer than `GEO_IP_CACHE_TTL`. Relays without coordinates, or with a latitude or longitude of exactly zero, are left off the maps.

While geo-ip-service is unreachable, cached locations are used however old they are, and relays whose address has never been looked up are left off. When no address has a location at all, which happens on a start while geo-ip-service is down, both map routes answer `503` with `Relay geolocation is unavailable`. The other routes do not depend on geo-ip-service.

### Health

`/healthz` has one check, `geoIp`, holding the geo-ip-client cache state. It is `degraded` while lookups fail and `ok` otherwise, and the service is never `down` on its account, so a geo-ip-service outage does not take the API out of service discovery.

## Responses

Every route answer carries `Access-Control-Allow-Origin: *` and a weak `ETag` computed the way Express computes it, and a `GET` whose `If-None-Match` holds the current tag gets `304`. JSON is sent as `application/json; charset=utf-8` and text as `text/html; charset=utf-8`. Any `OPTIONS` request is a CORS preflight answered `204`. Every route also matches with a trailing slash. An unknown path or method gets the Express not found page, for example `<pre>Cannot GET /missing</pre>`. A `POST /hardware` body that is malformed JSON, or JSON other than an object or array, gets `400` with the Express error page and no CORS header.

[src/express-compat.ts](src/express-compat.ts) holds these rules.

Differences from the Express service that are kept:

- `X-Powered-By`, `Connection: keep-alive` and `Keep-Alive` are not sent, nor the `Content-Security-Policy` and `X-Content-Type-Options` headers of the not found page.
- Error pages show the status text only. Express without `NODE_ENV=production` printed the stack trace.
- `HEAD` is answered by Bun. Varnish turns `HEAD` into `GET` before it reaches the service.
- Paths match with their exact case. Express matched `/Relays` too.
- A query parameter given twice counts once, with its first value. Express made it a list, which `/relays` answered with `500`.
- Cell centers and boundaries can differ from the Express service in the last digits, since the JavaScript engines round trigonometry differently.

## Tests

```sh
bun test apps/api-service
```

The tests run the service against stub upstreams. One test reads a real operator registry when `HB_URL` and a 43 character `OPERATOR_REGISTRY_PROCESS_ID` are set, and is skipped otherwise.

## Parity check

[parity/parity.ts](parity/parity.ts) replays a fixed set of requests, covering every route and the error, preflight, not found and conditional cases, against a running Express service and the ported one, and reports every difference:

```sh
bun apps/api-service/parity/parity.ts --old https://api-stage.ec.anyone.tech --new http://localhost:3000
```

- Status and body must match. JSON bodies are compared after putting lists whose order carries no meaning into a fixed order, after keeping only the samples both sides have for ranges that end at `now`, and with numbers that differ by at most `1e-9` counted as equal.
- `Content-Type`, `ETag` and the CORS headers must match. ETags are compared where the bodies are byte for byte equal.
- Every other header difference is listed, with how many responses had it, and does not fail the check.
- Each request goes to both services at once and is retried up to `--attempts` times, so a relay or metric changing between the two answers does not count as a difference. A random `_parity` query parameter on every request keeps Varnish from answering from its cache.
- `POST /hardware` is sent only with invalid bodies, so nothing reaches Onionoo.
- Finally it sends a relay lookup with a request line of `--long-query-bytes`, 79,000 by default, to both and requires `200` from the ported one.

The relays it asks for are the first three of the old service's fingerprint map, or `--fingerprints`. It exits `1` when a difference remains. Both services should read the same GeoLite2 release, or relays whose location changed between releases show up as differences in the maps.
