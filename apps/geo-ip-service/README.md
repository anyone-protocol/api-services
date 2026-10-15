# geo-ip-service

Resolves IP addresses to location and network data from the MaxMind GeoLite2 City and ASN databases, which it downloads and keeps up to date itself. It is an internal service with no authentication, meant to be reached only by other services, never from the public edge. Services in this repository call it through [geo-ip-client](../../packages/geo-ip-client/).

## Running locally

The service reads the databases from a directory. To run it without a MaxMind license, copy the test databases under the names the service expects:

```sh
mkdir -p /tmp/geoip
cp apps/geo-ip-service/test-data/GeoLite2-City-Test.mmdb /tmp/geoip/GeoLite2-City.mmdb
cp apps/geo-ip-service/test-data/GeoLite2-ASN-Test.mmdb /tmp/geoip/GeoLite2-ASN.mmdb
GEOIP_DATA_DIR=/tmp/geoip bun run --filter geo-ip-service dev

curl localhost:3000/lookup/89.160.20.112
curl localhost:3000/lookup -H 'content-type: application/json' -d '{"addresses":["89.160.20.112","2001:480::1"],"h3Resolution":4}'
```

The test databases hold only a few made-up networks; [test-data](test-data/) says where to find the list. To run the download and update cycle as well, see [Testing updates locally](#testing-updates-locally).

## Configuration

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `GEOIP_DATA_DIR` | required | directory holding `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` |
| `MAX_BATCH_SIZE` | `10000` | most addresses accepted in one batch lookup, the same as the client's default batch size |
| `MAXMIND_LICENSE_KEY` | none | MaxMind license key, handled as a [secret](../../packages/service-kit/#secrets); turns downloads on |
| `MAXMIND_DOWNLOAD_URL` | `https://download.maxmind.com/app/geoip_download` | where editions are downloaded from |
| `GEOIP_CHECK_INTERVAL` | `1h` | how often the service decides whether an edition is due for an update; deciding makes no request |
| `GEOIP_MAX_AGE` | `72h` | build age after which an edition is due for an update |
| `MAXMIND_MIN_REQUEST_INTERVAL` | `12h` | least time between two requests to MaxMind for the same edition, kept across restarts |
| `PORT`, `LOG_LEVEL` | | see [service-kit](../../packages/service-kit/#environment) |

Durations are written as a number and a unit: `ms`, `s`, `m`, `h` or `d`.

## Databases

Both editions are loaded from `GEOIP_DATA_DIR` at startup, which in a deployment is a host volume, so a restart or redeploy uses the files already there. A file must hold the edition its name says, which is checked against the database's own metadata, so a City file in the ASN slot is refused.

- Without the City edition the service is `down`: `/healthz` answers `503` and lookups answer `503`.
- Without the ASN edition the service is `degraded`: lookups answer, and results have no `asNumber` or `asName`.
- When loading an edition fails and an earlier copy of it is loaded, the earlier copy keeps serving and the failure is reported in `/healthz` and `/metrics`.

`SIGHUP` reloads both editions from `GEOIP_DATA_DIR` without contacting MaxMind, for example after copying files onto the volume or running the [one-shot update](#one-shot-update):

```sh
nomad alloc signal -s SIGHUP <allocation>
```

## Updates

With a license key set, the service keeps the databases current on its own. Every `GEOIP_CHECK_INTERVAL` it decides, per edition, whether the edition is due, and it contacts MaxMind only for an edition that is due:

- the edition is not loaded, or its build is older than `GEOIP_MAX_AGE`, and
- the last request to MaxMind for that edition was at least `MAXMIND_MIN_REQUEST_INTERVAL` ago.

A fresh volume therefore costs one download per edition on the first start, and a restart with current files costs nothing. MaxMind publishes GeoLite2 twice a week, so with the defaults each edition is downloaded about twice a week, with a few release checks in between.

An update of a due edition:

1. Asks MaxMind for the current release with a `HEAD` request, which MaxMind does not count against the download limit, and reads its `Last-Modified` header, or `Content-Disposition` when that is missing. When it matches the release installed last time, the edition is `unchanged` and nothing is downloaded.
2. Otherwise fetches the published SHA-256 checksum of the edition's archive. When it matches the archive installed last time, the edition is `unchanged` and nothing else is downloaded. This is the check that decides when the `HEAD` answer carries neither header.
3. Downloads the archive. MaxMind redirects the download to a file host, which gets no license key.
4. Checks the archive against the checksum, takes the `.mmdb` out of it, opens it, and checks that it is the right edition and not an older build than the one loaded.
5. Writes it next to the current file, renames it over the current file, and swaps the new database in. Lookups in progress finish on the old one; no lookup fails during the swap.

The license key travels in the query string of the request to MaxMind, which is the form MaxMind accepts with a license key alone. It goes only to MaxMind over HTTPS, error messages never include the URL, and the logger redacts the key wherever it appears, URL-encoded or not.

A failure at any step leaves the current file and database in place. Each attempt is recorded per edition in `update-state.json` in `GEOIP_DATA_DIR`, with its time, outcome, error, release and archive checksum; this record is what keeps the request interval across restarts, so leave it on the volume. `/healthz` shows it per edition under `update`, along with `nextCheckAfter`, the earliest time the service will contact MaxMind for the edition again.

While an update runs, the service holds the downloaded archive, the unpacked archive and the new database in memory next to the database being replaced. Size the job's memory for that, with the City edition as the large one.

Without a license key the service never contacts MaxMind and only loads the files it finds, which suits local development and a volume filled by hand.

## One-shot update

`src/update.ts` runs one update with the same code as the service, ignoring the schedule and the request interval, and always downloads. It installs into `GEOIP_DATA_DIR` or `--dir`, logs each edition's outcome, and exits `0` when every edition was installed and `1` otherwise. Use it to check the license key and the download path right away instead of waiting for the schedule, or to fill a volume.

```sh
bun apps/geo-ip-service/src/update.ts --dir /tmp/geoip-check
bun apps/geo-ip-service/src/update.ts --edition GeoLite2-ASN
```

In a deployment, run it inside the service's allocation, where the license key and the volume are already in place, then signal the service to load the new files:

```sh
nomad alloc exec <allocation> bun apps/geo-ip-service/src/update.ts
nomad alloc signal -s SIGHUP <allocation>
```

Every run downloads each edition, so run it only when needed.

## API

All bodies are JSON. Errors are `{ "error": "<message>" }`.

### `POST /lookup`

Looks up a batch of addresses.

```json
{ "addresses": ["89.160.20.112", "2001:480::1", "10.0.0.1", "not-an-address"], "h3Resolution": 4 }
```

`addresses` is required. `h3Resolution` is optional, an integer from 0 to 15; when given, results with coordinates also carry the H3 cell holding them at that resolution and the cell's center.

The answer has one result per requested address, in the same order, duplicates included:

```json
{
  "results": [
    {
      "address": "89.160.20.112",
      "status": "found",
      "location": {
        "coordinates": { "latitude": 58.4167, "longitude": 15.6167 },
        "countryCode": "SE",
        "countryName": "Sweden",
        "regionName": "Östergötland County",
        "cityName": "Linköping",
        "timeZone": "Europe/Stockholm",
        "asNumber": 29518,
        "asName": "Bredband2 AB",
        "h3": { "resolution": 4, "cell": "8408b3dffffffff", "center": { "latitude": 58.40578421882332, "longitude": 15.778067337833107 } }
      }
    },
    { "address": "10.0.0.1", "status": "not-found" },
    { "address": "not-an-address", "status": "invalid" }
  ]
}
```

| Status | Meaning |
| ------ | ------- |
| `found` | at least one edition has a record for the address; `location` holds what the records have |
| `not-found` | a valid IPv4 or IPv6 address that neither edition has a record for |
| `invalid` | not an IPv4 or IPv6 address |

Every `location` field is optional and present only when the databases have it:

| Field | Source |
| ----- | ------ |
| `coordinates` | City: latitude and longitude |
| `countryCode`, `countryName` | City: country ISO code and English name |
| `regionName` | City: English name of the first subdivision |
| `cityName` | City: English city name |
| `timeZone` | City: time zone |
| `asNumber`, `asName` | ASN: autonomous system number and organization |
| `h3` | computed from `coordinates` when `h3Resolution` is given |

An IPv4-mapped IPv6 address such as `::ffff:89.160.20.112` gives the same result as the IPv4 address.

| HTTP status | When |
| ----------- | ---- |
| `200` | the batch was answered, whatever the status of each address |
| `400` | the body is not JSON, `addresses` is missing or holds something other than strings, or `h3Resolution` is out of range |
| `413` | `addresses` holds more than `MAX_BATCH_SIZE` entries |
| `503` | the City edition is not loaded |

### `GET /lookup/:address`

Looks up one address, with `h3Resolution` as an optional query parameter: `GET /lookup/89.160.20.112?h3Resolution=4`. The body is a single result in the shape above. The HTTP status follows the result: `200` for `found`, `404` for `not-found`, `400` for `invalid` or a bad `h3Resolution`, and `503` when the City edition is not loaded. An IPv6 address can be written as is or percent-encoded.

### `GET /healthz`

The [service-kit health report](../../packages/service-kit/#health) with one check per edition, holding its `buildDate`, its `loadedAt` time, the `lastError` of its last load, if that failed, and its [update](#updates) record under `update`.

### `GET /metrics`

Metrics in the Prometheus text format:

| Metric | Type | Labels | Meaning |
| ------ | ---- | ------ | ------- |
| `geoip_database_loaded` | gauge | `edition` | `1` when the edition is loaded |
| `geoip_database_load_failed` | gauge | `edition` | `1` when the last attempt to load the edition failed |
| `geoip_database_build_timestamp_seconds` | gauge | `edition` | build time of the loaded edition, for alerting on its age |
| `geoip_database_load_timestamp_seconds` | gauge | `edition` | time the loaded edition was loaded |
| `geoip_lookups_total` | counter | `status` | addresses looked up, by result |
| `geoip_requests_total` | counter | `route`, `code` | lookup requests by route (`batch` or `single`) and HTTP status |
| `geoip_batch_duration_seconds` | summary | | time to answer a batch, from receiving it to the encoded answer |
| `geoip_updates_enabled` | gauge | | `1` when a MaxMind license key is set and the service downloads updates |
| `geoip_update_last_attempt_timestamp_seconds` | gauge | `edition` | time of the last request to MaxMind for the edition |
| `geoip_update_requests_total` | counter | `edition`, `outcome` | update attempts by outcome: `downloaded`, `unchanged` or `failed` |

## Tests

The tests run against MaxMind's test databases in [test-data](test-data/), so they need no license key or network access. Update tests run against a stub of the MaxMind download service in [src/testing/maxmind-stub.ts](src/testing/maxmind-stub.ts), which serves the test databases as archives; each test sets the stub up for the scenario it needs.

## Testing updates locally

The stub also runs on its own, which lets the real service go through download and update cycles in seconds without contacting MaxMind:

```sh
bun apps/geo-ip-service/src/testing/maxmind-stub.ts
```

In another terminal, run the service against it with a short schedule and an empty directory:

```sh
GEOIP_DATA_DIR=/tmp/geoip-stub \
MAXMIND_DOWNLOAD_URL=http://localhost:4000/app/geoip_download MAXMIND_LICENSE_KEY=stub-license-key \
GEOIP_CHECK_INTERVAL=1s GEOIP_MAX_AGE=1s MAXMIND_MIN_REQUEST_INTERVAL=5s \
bun run --filter geo-ip-service dev
```

It downloads both editions at once, then checks for a new release with `HEAD` every five seconds and reports `unchanged`. `curl localhost:3000/healthz` shows each edition's update record and next check. The one-shot update runs against the stub with the same variables.
