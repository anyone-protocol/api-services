variable "commit_sha" {
  type        = string
  description = "Commit whose geo-ip-service image to run"
  default     = "75ae786042adab24e328b71f2a08b378a655c429"
}

job "geo-ip-service-live" {
  datacenters = ["ator-fin"]
  type        = "service"
  namespace   = "live-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "live-services"
  }

  group "geo-ip-service-live-group" {
    count = 1

    update {
      max_parallel     = 1
      canary           = 1
      min_healthy_time = "30s"
      healthy_deadline = "5m"
      auto_revert      = true
      auto_promote     = true
    }

    network {
      mode = "bridge"
      port "http" {
        to           = 3000
        host_network = "wireguard"
      }
    }

    volume "geo-ip-service-live" {
      type      = "host"
      read_only = false
      source    = "geo-ip-service-live"
    }

    service {
      name = "geo-ip-service-live"
      port = "http"
      tags = ["logging"]

      check {
        name         = "geo-ip-service health"
        type         = "http"
        path         = "/healthz"
        interval     = "10s"
        timeout      = "5s"
        address_mode = "alloc"
      }
    }

    task "geo-ip-service-live-task" {
      driver = "docker"
      user   = "root"

      config {
        image      = "ghcr.io/anyone-protocol/api-services/geo-ip-service:${var.commit_sha}"
        force_pull = true
      }

      volume_mount {
        volume      = "geo-ip-service-live"
        destination = "/data"
        read_only   = false
      }

      env {
        GEOIP_DATA_DIR = "/data"
        LOG_LEVEL      = "info"
      }

      vault { role = "any1-nomad-workloads-controller" }

      template {
        data        = <<-EOH
        {{ with secret "kv/live-services/geo-ip-service-live" }}
        MAXMIND_LICENSE_KEY="{{ .Data.data.MAXMIND_LICENSE_KEY }}"
        {{ end }}
        EOH
        destination = "secrets/maxmind.env"
        env         = true
      }

      resources {
        cpu    = 1024
        memory = 512
      }
    }
  }
}
