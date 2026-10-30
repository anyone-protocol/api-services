variable "commit_sha" {
  type        = string
  description = "Commit whose geo-ip-service image to run"
  default     = "d63ea9e0093913b3e59a57dbe0da540f07f71ec0"
}

job "geo-ip-service-stage" {
  datacenters = ["ator-fin"]
  type        = "service"
  namespace   = "stage-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "stage"
  }

  group "geo-ip-service-stage-group" {
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

    volume "geo-ip-service-stage" {
      type      = "host"
      read_only = false
      source    = "geo-ip-service-stage"
    }

    service {
      name = "geo-ip-service-stage"
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

    task "geo-ip-service-stage-task" {
      driver = "docker"
      user   = "root"

      config {
        image      = "ghcr.io/anyone-protocol/api-services/geo-ip-service:${var.commit_sha}"
        force_pull = true
      }

      volume_mount {
        volume      = "geo-ip-service-stage"
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
        {{ with secret "kv/stage-services/geo-ip-service-stage" }}
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
