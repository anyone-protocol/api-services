# Operations

Nomad job definitions for running the services on the Anyone cluster. Deployments are manual: a person runs a job with the commit to deploy. Nothing in this directory goes into an image, so changing it publishes nothing.

| File | Runs |
| ---- | ---- |
| [geo-ip-service-stage.hcl](geo-ip-service-stage.hcl) | geo-ip-service in `stage-services`, on the `stage` pool |
| [geo-ip-service-live.hcl](geo-ip-service-live.hcl) | geo-ip-service in `live-services`, on the `live-services` pool |
| [api-service-stage.hcl](api-service-stage.hcl) | api-service behind Varnish in `stage-services`, on the `stage` pool |
| [api-service-live.hcl](api-service-live.hcl) | api-service behind Varnish in `live-services`, on the `live-services` pool |

## Choosing a commit

Every job takes `commit_sha`, the commit whose image it runs, and pins a default. Continuous integration publishes a service's image only for commits that changed the service or a package it uses, so pick a commit that did. For a service under `apps/<service>`, the latest one on the default branch is:

```sh
git log -1 --format=%H origin/master -- apps/<service> packages package.json bun.lock tsconfig.json .dockerignore
```

```sh
nomad job run -var commit_sha=<sha> operations/geo-ip-service-stage.hcl
```

## geo-ip-service

What the job sets up, per environment:

- One allocation on the environment's services pool. A new version starts as a canary next to the running one and is promoted once healthy, or reverted.
- A dynamic port on the `wireguard` host network, mapped to the service's port 3000. The job has no Traefik tags, so the service is not on the public edge.
- The Consul service `geo-ip-service-<env>` with an HTTP check on `/healthz`, sent to the allocation's own address. The check is critical while the City database is not loaded and passing otherwise. A failing check does not restart the task, since a restart does not bring a database back.
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

The port changes with every deploy. A consumer takes the address from Consul in its env template, as it does for its other dependencies, and restarts when the address changes:

```hcl
template {
  data        = <<-EOH
  {{- range service "geo-ip-service-stage|any" }}
  GEO_IP_SERVICE_URL="http://{{ .Address }}:{{ .Port }}"
  {{- end }}
  EOH
  destination = "local/config.env"
  env         = true
}
```

- A redeploy of geo-ip-service changes the address, re-renders the template and restarts the consumer.
- `|any` keeps the instance in the template while its health check fails, so a health change alone does not restart the consumer.
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

## api-service

What the job sets up, per environment:

- One allocation on the environment's services pool with two tasks on one network: api-service on port 3000 and Varnish in front of it on port 8080. A new version starts as a canary next to the running one and is promoted once healthy, or reverted; it has ten minutes to become healthy.
- The Consul service `api-service-<env>` on a dynamic port on the `wireguard` host network, mapped to Varnish, with the Traefik tags that publish it as `api-stage.ec.anyone.tech` on stage and `api.ec.anyone.tech` on live.
- An HTTP check on `/healthz` sent to the allocation's own address through Varnish, so it covers both tasks. The service reports `degraded` rather than `down` while geo-ip-service is unavailable, so the check keeps passing then.
- The geo-ip-service address from Consul, as [Reaching it from another job](#reaching-it-from-another-job) describes.
- The UNS indexer database credentials from Vault at `kv/<env>-services/api-service-<env>`, under `DB_USER` and `DB_PASS`.

Varnish:

- Caches successful and `4xx` responses for five minutes. A `5xx` is never cached, so the next request goes to the service again.
- Never caches `/healthz`.
- Accepts requests of up to 128 KB, above the service's own limit of 80 KB, so an oversized request gets `431` from the service instead of a dropped connection.

```sh
nomad job run -var commit_sha=<sha> operations/api-service-stage.hcl
```
