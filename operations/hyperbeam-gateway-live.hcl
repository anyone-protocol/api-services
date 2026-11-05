variable "commit_sha" {
  type        = string
  description = "Commit whose hyperbeam-gateway image to run"
}

job "hyperbeam-gateway-live" {
  datacenters = ["ator-fin"]
  type        = "service"
  namespace   = "live-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "live-services"
  }

  group "hyperbeam-gateway-live-group" {
    count = 1

    update {
      max_parallel     = 1
      min_healthy_time = "30s"
      healthy_deadline = "5m"
      auto_revert      = true
    }

    network {
      mode = "bridge"
      port "http" {
        to           = 3000
        host_network = "wireguard"
      }
    }

    volume "hyperbeam-gateway-live" {
      type      = "host"
      read_only = false
      source    = "hyperbeam-gateway-live"
    }

    service {
      name = "hyperbeam-gateway-live"
      port = "http"
      tags = [
        "logging",
        "traefik-ec.enable=true",
        "traefik-ec.http.routers.hyperbeam-gateway-live.rule=Host(`hb.anyone.tech`)",
        "traefik-ec.http.routers.hyperbeam-gateway-live.entrypoints=https",
        "traefik-ec.http.routers.hyperbeam-gateway-live.tls=true",
        "traefik-ec.http.routers.hyperbeam-gateway-live.tls.certresolver=anyoneresolver",
        "traefik-ec.http.routers.hyperbeam-gateway-live.middlewares=hyperbeam-gateway-live-ratelimit,hyperbeam-gateway-live-buffering",
        "traefik-ec.http.middlewares.hyperbeam-gateway-live-ratelimit.ratelimit.average=30",
        "traefik-ec.http.middlewares.hyperbeam-gateway-live-ratelimit.ratelimit.burst=60",
        "traefik-ec.http.middlewares.hyperbeam-gateway-live-buffering.buffering.maxrequestbodybytes=1048576"
      ]

      check {
        name         = "hyperbeam-gateway health"
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

    task "hyperbeam-gateway-live-task" {
      driver = "docker"

      config {
        image      = "ghcr.io/anyone-protocol/api-services/hyperbeam-gateway:${var.commit_sha}"
        force_pull = true
      }

      volume_mount {
        volume      = "hyperbeam-gateway-live"
        destination = "/data"
        read_only   = false
      }

      env {
        MESSAGE_STORE_PATH = "/data/messages.sqlite"
        LOG_LEVEL          = "info"
      }

      consul {}

      template {
        data        = <<-EOH
        OPERATOR_REGISTRY_PROCESS_ID="{{ key "smart-contracts/live/operator-registry-address" }}"
        RELAY_REWARDS_PROCESS_ID="{{ key "smart-contracts/live/relay-rewards-address" }}"
        STAKING_REWARDS_PROCESS_ID="{{ key "smart-contracts/live/staking-rewards-address" }}"
        {{- range service "hyperbeam-live-node|any" }}
        HB_URL="http://{{ .Address }}:{{ .Port }}"
        {{- end }}
        EOH
        destination = "local/config.env"
        env         = true
      }

      resources {
        cpu    = 512
        memory = 256
      }
    }
  }
}
