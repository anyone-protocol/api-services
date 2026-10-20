variable "commit_sha" {
  type        = string
  description = "Commit whose api-service image to run"
  default     = "be5303e389fba3bf4cb96921de311be17304c1ff"
}

job "api-service-parity-stage" {
  datacenters = ["ator-fin"]
  type        = "service"
  namespace   = "stage-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "stage"
  }

  group "api-service-parity-stage-group" {
    count = 1

    network {
      mode = "bridge"
      port "http" {
        to           = 3000
        host_network = "wireguard"
      }
    }

    service {
      name = "api-service-parity-stage"
      port = "http"
      tags = ["logging"]

      check {
        name     = "api-service health"
        type     = "http"
        path     = "/healthz"
        interval = "10s"
        timeout  = "5s"
      }
    }

    task "api-service-parity-stage-task" {
      driver = "docker"

      config {
        image      = "ghcr.io/anyone-protocol/api-services/api-service:${var.commit_sha}"
        force_pull = true
      }

      env {
        ONIONOO_PROTOCOL        = "http://"
        CLUSTER                 = "local"
        ENV                     = "main"
        JOB                     = "consulagentonionoo"
        HEXAGON_RESOLUTION      = "4"
        HB_URL                  = "https://hb-stage.anyone.tech"
        DB_NAME                 = "uns_indexer"
        GEO_IP_SERVICE_URL_FILE = "/local/geo-ip-service-url"
        GEO_IP_CACHE_TTL        = "2m"
        LOG_LEVEL               = "info"
      }

      consul {}

      template {
        data        = <<-EOH
        OPERATOR_REGISTRY_PROCESS_ID="{{ key "smart-contracts/stage/operator-registry-address" }}"
        {{- range service "victoriametrics-db|any" }}
        VICTORIA_METRICS_ADDRESS="http://{{ .Address }}:{{ .Port }}"
        {{- end }}
        {{- range service "onionoo-war-live|any" }}
        ONIONOO_INSTANCE="{{ .Address }}:{{ .Port }}"
        {{- end }}
        {{- range service "uns-record-indexer-postgres-stage|any" }}
        DB_HOST="{{ .Address }}"
        DB_PORT="{{ .Port }}"
        {{- end }}
        EOH
        destination = "local/config.env"
        env         = true
        wait {
          min = "30s"
          max = "90s"
        }
      }

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

      vault { role = "any1-nomad-workloads-controller" }

      template {
        data        = <<-EOH
        {{ with secret "kv/stage-services/api-service-parity-stage" }}
        DB_USER="{{ .Data.data.DB_USER }}"
        DB_PASS="{{ .Data.data.DB_PASS }}"
        {{ end }}
        EOH
        destination = "secrets/db.env"
        env         = true
      }

      resources {
        cpu    = 1024
        memory = 512
      }
    }
  }
}
