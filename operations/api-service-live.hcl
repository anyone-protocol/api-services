variable "commit_sha" {
  type        = string
  description = "Commit whose api-service image to run"
  default     = "19b7ae94b61e752f72ad0458cc7224075846aa37"
}

job "api-service-live" {
  datacenters = ["ator-fin"]
  type        = "service"
  namespace   = "live-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "live-services"
  }

  group "api-service-live-group" {
    count = 1

    update {
      max_parallel      = 1
      canary            = 1
      min_healthy_time  = "30s"
      healthy_deadline  = "10m"
      progress_deadline = "15m"
      auto_revert       = true
      auto_promote      = true
    }

    network {
      mode = "bridge"
      port "http" {
        to           = 8080
        host_network = "wireguard"
      }
    }

    service {
      name = "api-service-live"
      port = "http"
      tags = [
        "logging",
        "traefik-ec.enable=true",
        "traefik-ec.http.routers.api-live.rule=Host(`api.ec.anyone.tech`)",
        "traefik-ec.http.routers.api-live.entrypoints=https",
        "traefik-ec.http.routers.api-live.tls=true",
        "traefik-ec.http.routers.api-live.tls.certresolver=anyoneresolver",
        "traefik-ec.http.routers.api-live.middlewares=api-live-ratelimit",
        "traefik-ec.http.middlewares.api-live-ratelimit.ratelimit.average=1000",
        "traefik-ec.http.middlewares.api-live-ratelimit.ratelimit.burst=10"
      ]

      check {
        name         = "api-service health"
        type         = "http"
        path         = "/healthz"
        interval     = "10s"
        timeout      = "5s"
        address_mode = "alloc"

        check_restart {
          limit = 10
          grace = "30s"
        }
      }
    }

    task "api-service-live-task" {
      driver = "docker"

      config {
        image      = "ghcr.io/anyone-protocol/api-services/api-service:${var.commit_sha}"
        force_pull = true
      }

      env {
        ONIONOO_PROTOCOL   = "http://"
        CLUSTER            = "local"
        ENV                = "main"
        JOB                = "consulagentonionoo"
        HEXAGON_RESOLUTION = "4"
        HB_URL             = "https://hb.anyone.tech"
        DB_NAME            = "uns_indexer"
        LOG_LEVEL          = "info"
      }

      consul {}

      template {
        data        = <<-EOH
        OPERATOR_REGISTRY_PROCESS_ID="{{ key "smart-contracts/live/operator-registry-address" }}"
        {{- range service "victoriametrics-db|any" }}
        VICTORIA_METRICS_ADDRESS="http://{{ .Address }}:{{ .Port }}"
        {{- end }}
        {{- range service "onionoo-war-live|any" }}
        ONIONOO_INSTANCE="{{ .Address }}:{{ .Port }}"
        {{- end }}
        {{- range service "uns-record-indexer-postgres-live|any" }}
        DB_HOST="{{ .Address }}"
        DB_PORT="{{ .Port }}"
        {{- end }}
        {{- range service "geo-ip-service-live|any" }}
        GEO_IP_SERVICE_URL="http://{{ .Address }}:{{ .Port }}"
        {{- end }}
        EOH
        destination = "local/config.env"
        env         = true
        wait {
          min = "30s"
          max = "90s"
        }
      }

      vault { role = "any1-nomad-workloads-controller" }

      template {
        data        = <<-EOH
        {{ with secret "kv/live-services/api-service-live" }}
        DB_USER="{{ .Data.data.DB_USER }}"
        DB_PASS="{{ .Data.data.DB_PASS }}"
        {{ end }}
        EOH
        destination = "secrets/db.env"
        env         = true
      }

      resources {
        cpu    = 2048
        memory = 1024
      }
    }

    task "varnish-cache-live-task" {
      driver = "docker"

      config {
        image   = "varnish:9.1.0"
        args    = ["-p", "http_req_size=128k", "-p", "workspace_client=256k"]
        volumes = ["local/default.vcl:/etc/varnish/default.vcl:ro"]
      }

      env {
        VARNISH_HTTP_PORT = "8080"
      }

      template {
        data        = <<-EOH
        vcl 4.1;

        backend default {
            .host = "127.0.0.1";
            .port = "3000";
        }

        sub vcl_recv {
            if (req.url ~ "^/healthz/?(\?|$)") {
                return (pass);
            }
        }

        sub vcl_backend_response {
            if (beresp.status >= 500) {
                set beresp.uncacheable = true;
                set beresp.ttl = 10s;
                return (deliver);
            }
            set beresp.ttl = 5m;
        }
        EOH
        destination = "local/default.vcl"
        change_mode = "noop"
      }

      resources {
        cpu    = 256
        memory = 1024
      }
    }
  }
}
