# Operations

Nomad job definitions for running the services on the Anyone cluster. Deployments are manual: a person runs a job with the commit to deploy. Nothing in this directory goes into an image, so changing it publishes nothing.

| File | Runs |
| ---- | ---- |
| [geo-ip-service-stage.hcl](geo-ip-service-stage.hcl) | geo-ip-service in `stage-services`, on the `stage` pool |
| [geo-ip-service-live.hcl](geo-ip-service-live.hcl) | geo-ip-service in `live-services`, on the `live-services` pool |
| [api-service-parity-stage.hcl](api-service-parity-stage.hcl) | the ported api-service next to the running one in `stage-services`, for the [parity run](#api-service-parity-run-on-stage) |

## Choosing a commit

Every job takes `commit_sha`, the commit whose image it runs, and pins a default. Continuous integration publishes a service's image only for commits that changed the service or a package it uses, so pick a commit that did. For geo-ip-service, the latest one on the default branch is:

```sh
git log -1 --format=%H origin/master -- apps/geo-ip-service packages package.json bun.lock tsconfig.json .dockerignore
```

```sh
nomad job run -var commit_sha=<sha> operations/geo-ip-service-stage.hcl
```

## geo-ip-service

What the job sets up, per environment:

- One allocation on the environment's services pool. A new version starts as a canary next to the running one and is promoted once healthy, or reverted.
- A dynamic port on the `wireguard` host network, mapped to the service's port 3000. The job has no Traefik tags, so the service is not on the public edge.
- The Consul service `geo-ip-service-<env>` with an HTTP check on `/healthz`. The check is critical while the City database is not loaded and passing otherwise. A failing check does not restart the task, since a restart does not bring a database back.
- The host volume `geo-ip-service-<env>` at `/data`, holding the databases and the update record between restarts and deploys. The task runs as root, like the cluster's other jobs, so it can write to a volume owned by `nomad:docker`.
- The MaxMind license key from Vault, which turns on [database updates](../apps/geo-ip-service/#updates).
- 512 MB of memory, which covers an update: the old and new City databases and the downloaded archive are in memory at the same time.

### Before the first deploy

Once per environment.

1. Create the host volume on the client in the environment's services pool, owned by `nomad:docker` like the cluster's other volumes.

   ```sh
   sudo mkdir -p /opt/volumes/geo-ip-service-stage
   sudo chown nomad:docker /opt/volumes/geo-ip-service-stage
   ```

   Register it in the `client` block of `/etc/nomad.d/nomad.hcl`, restart the Nomad agent, and check that `nomad node status -verbose <node>` lists it:

   ```hcl
   host_volume "geo-ip-service-stage" {
     path      = "/opt/volumes/geo-ip-service-stage"
     read_only = false
   }
   ```

2. Store the MaxMind license key in Vault at `kv/<env>-services/geo-ip-service-<env>`, under `MAXMIND_LICENSE_KEY`.

### Deploying

```sh
nomad job run -var commit_sha=<sha> operations/geo-ip-service-stage.hcl
```

On an empty volume the service starts without databases, reports `down`, and downloads both editions right away; the check passes once the City edition is loaded. Its logs show `Database downloaded` for each edition, and `/healthz` shows each edition's build date and update record.

Its current address is under Allocation Addresses in the allocation's status:

```sh
nomad job allocs -namespace stage-services geo-ip-service-stage
nomad alloc status -namespace stage-services <allocation>
```

Updating the databases by hand, reloading them and the update schedule are described in the [service README](../apps/geo-ip-service/#updates).

### Reaching it from another job

The port changes with every deploy, so a consumer must not take the address once at startup, and must not restart when it changes. A consumer renders the address into a file with a template that never restarts the task, and reads the file whenever it makes a request:

```hcl
template {
  data        = <<-EOH
  {{- $url := "" -}}
  {{- range service "geo-ip-service-stage|any" -}}
    {{- if or (eq $url "") (eq .Status "passing") }}{{ $url = printf "http://%s:%d" .Address .Port }}{{ end -}}
  {{- end -}}
  {{ $url }}
  EOH
  destination = "local/geo-ip-service-url"
  change_mode = "noop"
}
```

- `change_mode = "noop"`: a redeploy or a health change of geo-ip-service rewrites the file and leaves the consumer running.
- `|any` with the `passing` preference: the file holds a passing instance when there is one, and otherwise keeps the address of an unhealthy one rather than going empty while its health flaps.
- The file is empty only while no instance is registered at all; treat that as geo-ip-service being unavailable.
- The task needs a `consul {}` block for the template to see the service.

Consumers in other environments use `geo-ip-service-live` the same way.

### Metrics and alerts

The cluster's metrics agent scrapes `/metrics` as the scrape job `consulagentgeoip`, with the Consul service name in the `service` label. The metrics are listed in the [service README](../apps/geo-ip-service/#get-metrics).

Alert rules are created in Grafana on the VictoriaMetrics datasource:

| Alert | Query | Fires when | Pending | No data |
| ----- | ----- | ---------- | ------- | ------- |
| geo-ip-service-live down | `min(geoip_database_loaded{service="geo-ip-service-live", edition="GeoLite2-City"})` | below 1 | 15m | Alerting |
| GeoLite2 databases not updating | `max by (service, edition) (time() - geoip_database_build_timestamp_seconds{job="consulagentgeoip"})` | above 604800 (7 days) | 1h | OK |

- The down rule covers the service being stopped, unreachable or without its City database. Without data the series disappears, so "No data" has to count as alerting. It is per environment; create the same rule for `geo-ip-service-stage` if stage should alert too.
- The age rule catches updates failing while the service keeps serving older data. MaxMind publishes twice a week and a healthy copy stays under about five days old, so seven days fires a couple of days after updates stop. A stopped service is left to the down rule.
- To test a rule, lower its threshold below the current value, for example the age to 3600 seconds, wait for it to fire, and restore it.

### Checks after a deploy

From an allocation of api-service, of each controller and of Onionoo in the same environment, the service answers on its current address:

```sh
nomad alloc exec -namespace <namespace> -task <task> <allocation> sh -c 'wget -qO- http://<address>:<port>/healthz || curl -s http://<address>:<port>/healthz'
```

From outside the WireGuard network, the same address and port do not answer.

## api-service parity run on stage

The parity job runs the ported api-service next to `api-service-stage`, with the same upstreams, so the two can be compared before the ported one replaces it. It is reachable only on WireGuard: it has no Traefik tags and no Varnish, and no other job reads its Consul service `api-service-parity-stage`. `GEO_IP_CACHE_TTL` is `2m` so that cached locations go stale within the checks below.

A job reads only the Vault path named after it, so before the first run the database credentials go to `kv/stage-services/api-service-parity-stage`, under `DB_USER` and `DB_PASS`, the same values as `kv/stage-services/api-service-stage`.

```sh
nomad job run operations/api-service-parity-stage.hcl
```

### Parity

From inside the allocation, against the running service through its public hostname:

```sh
nomad alloc exec -namespace stage-services -task api-service-parity-stage-task <allocation> \
  bun apps/api-service/parity/parity.ts --old https://api-stage.ec.anyone.tech --new http://127.0.0.1:3000
```

The [parity check](../apps/api-service/#parity-check) describes what it compares. Map differences for single relays usually mean the two services read different GeoLite2 releases; the running service loads its databases only when it starts.

### geo-ip-service outages

1. Request `/relay-map/` and `/fingerprint-map/` once, then stop geo-ip-service with `nomad job stop -namespace stage-services geo-ip-service-stage`. After more than two minutes both maps still answer `200` with the same relays, and `/healthz` reports `geoIp` as `degraded`.
2. With geo-ip-service still stopped, restart the parity allocation. Both maps answer `503` with `Relay geolocation is unavailable`, and every other route answers as before.
3. Run geo-ip-service again. It loads its databases from the volume and comes up on a new port. The parity job picks up the new address without restarting, the maps answer `200` again, and `/healthz` reports `geoIp` as `ok`.

Stop the parity job afterwards with `nomad job stop -namespace stage-services api-service-parity-stage`.
