# geo-ip-service

Resolves IP addresses to location and network data from the MaxMind GeoLite2 City and ASN databases. It is an internal service with no authentication, meant to be reached only by other services, never from the public edge. Services in this repository call it through [geo-ip-client](../../packages/geo-ip-client/).

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

The test databases hold only a few made-up networks; [test-data](test-data/) says where to find the list.

## Configuration

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `GEOIP_DATA_DIR` | required | directory holding `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` |
| `MAX_BATCH_SIZE` | `10000` | most addresses accepted in one batch lookup, the same as the client's default batch size |
| `PORT`, `LOG_LEVEL` | | see [service-kit](../../packages/service-kit/#environment) |

## Databases

Both editions are loaded at startup. A file must hold the edition its name says, which is checked against the database's own metadata, so a City file in the ASN slot is refused.

- Without the City edition the service is `down`: `/healthz` answers `503` and lookups answer `503`.
- Without the ASN edition the service is `degraded`: lookups answer, and results have no `asNumber` or `asName`.
- When loading an edition fails and an earlier copy of it is loaded, the earlier copy keeps serving and the failure is reported in `/healthz` and `/metrics`.

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

The [service-kit health report](../../packages/service-kit/#health) with one check per edition, holding its `buildDate`, its `loadedAt` time and the `lastError` of its last load, if that failed.

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

## Tests

The tests run against MaxMind's test databases in [test-data](test-data/), so they need no license key or network access.
