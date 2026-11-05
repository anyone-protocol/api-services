variable "commit_sha" {
  type        = string
  description = "Commit whose hyperbeam-gateway image to run"
}

job "hyperbeam-gateway-stage" {
  datacenters = ["ator-fin"]
  type        = "service"
  namespace   = "stage-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "stage"
  }

  group "hyperbeam-gateway-stage-group" {
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

    volume "hyperbeam-gateway-stage" {
      type      = "host"
      read_only = false
      source    = "hyperbeam-gateway-stage"
    }

    service {
      name = "hyperbeam-gateway-stage"
      port = "http"
      tags = [
        "logging",
        "traefik-ec.enable=true",
        "traefik-ec.http.routers.hyperbeam-gateway-stage.rule=Host(`hb-stage.anyone.tech`)",
        "traefik-ec.http.routers.hyperbeam-gateway-stage.entrypoints=https",
        "traefik-ec.http.routers.hyperbeam-gateway-stage.tls=true",
        "traefik-ec.http.routers.hyperbeam-gateway-stage.tls.certresolver=anyoneresolver",
        "traefik-ec.http.routers.hyperbeam-gateway-stage.middlewares=hyperbeam-gateway-stage-ratelimit,hyperbeam-gateway-stage-buffering",
        "traefik-ec.http.middlewares.hyperbeam-gateway-stage-ratelimit.ratelimit.average=30",
        "traefik-ec.http.middlewares.hyperbeam-gateway-stage-ratelimit.ratelimit.burst=60",
        "traefik-ec.http.middlewares.hyperbeam-gateway-stage-buffering.buffering.maxrequestbodybytes=1048576"
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

    task "hyperbeam-gateway-stage-task" {
      driver = "docker"

      config {
        image      = "ghcr.io/anyone-protocol/api-services/hyperbeam-gateway:${var.commit_sha}"
        force_pull = true
      }

      volume_mount {
        volume      = "hyperbeam-gateway-stage"
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
        OPERATOR_REGISTRY_PROCESS_ID="{{ key "smart-contracts/stage/operator-registry-address" }}"
        RELAY_REWARDS_PROCESS_ID="{{ key "smart-contracts/stage/relay-rewards-address" }}"
        STAKING_REWARDS_PROCESS_ID="{{ key "smart-contracts/stage/staking-rewards-address" }}"
        {{- range service "hyperbeam-stage-node|any" }}
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
