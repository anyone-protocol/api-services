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
        "traefik-ec.http.middlewares.hyperbeam-gateway-stage-buffering.buffering.maxrequestbodybytes=1048576",
        "traefik-ec.http.routers.hyperbeam-gateway-stage-push.rule=Host(`hb-stage.anyone.tech`) && Method(`POST`)",
        "traefik-ec.http.routers.hyperbeam-gateway-stage-push.entrypoints=https",
        "traefik-ec.http.routers.hyperbeam-gateway-stage-push.tls=true",
        "traefik-ec.http.routers.hyperbeam-gateway-stage-push.tls.certresolver=anyoneresolver",
        "traefik-ec.http.routers.hyperbeam-gateway-stage-push.middlewares=hyperbeam-gateway-stage-push-ratelimit,hyperbeam-gateway-stage-buffering",
        "traefik-ec.http.middlewares.hyperbeam-gateway-stage-push-ratelimit.ratelimit.average=2",
        "traefik-ec.http.middlewares.hyperbeam-gateway-stage-push-ratelimit.ratelimit.burst=20"
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
        ADMIN_SIGNERS      = "0x38121cf84d897EF1ebE0d1804Ebf502f1E8D2Be0"
        ADMIN_ACTIONS = join(",", [
          "operator-registry:Admin-Submit-Operator-Certificates",
          "operator-registry:Remove-Fingerprint-Certificate",
          "operator-registry:Block-Operator-Address",
          "operator-registry:Unblock-Operator-Address",
          "operator-registry:Add-Registration-Credit",
          "operator-registry:Remove-Registration-Credit",
          "operator-registry:Add-Verified-Hardware",
          "operator-registry:Remove-Verified-Hardware",
          "operator-registry:Update-Roles",
          "relay-rewards:Update-Configuration",
          "relay-rewards:Cancel-Round",
          "relay-rewards:Update-Roles",
          "staking-rewards:Update-Configuration",
          "staking-rewards:Update-Shares-Configuration",
          "staking-rewards:Toggle-Feature-Shares",
          "staking-rewards:Cancel-Round",
          "staking-rewards:Update-Roles",
        ])
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
