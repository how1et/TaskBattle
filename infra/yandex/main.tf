resource "yandex_vpc_network" "app" {
  name = "${var.name}-network"
}

resource "yandex_vpc_subnet" "app" {
  name           = "${var.name}-subnet"
  network_id     = yandex_vpc_network.app.id
  zone           = var.zone
  v4_cidr_blocks = [var.subnet_cidr]
}

resource "yandex_vpc_security_group" "app" {
  name       = "${var.name}-web"
  network_id = yandex_vpc_network.app.id

  ingress {
    protocol       = "TCP"
    port           = 80
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    protocol       = "TCP"
    port           = 443
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    protocol       = "TCP"
    port           = 22
    v4_cidr_blocks = [var.ssh_admin_cidr]
  }
  egress {
    protocol       = "ANY"
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "yandex_vpc_address" "app" {
  name = "${var.name}-ip"
  external_ipv4_address {
    zone_id = var.zone
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_compute_disk" "app" {
  name     = "${var.name}-persistent"
  type     = "network-ssd"
  zone     = var.zone
  size     = 20
  image_id = var.image_id
  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_compute_instance" "app" {
  name                      = var.name
  platform_id               = "standard-v3"
  zone                      = var.zone
  service_account_id        = var.runtime_service_account_id
  allow_stopping_for_update = false

  resources {
    cores         = 2
    core_fraction = 20
    memory        = 4
  }
  scheduling_policy {
    preemptible = false
  }
  boot_disk {
    disk_id     = yandex_compute_disk.app.id
    auto_delete = false
  }
  network_interface {
    subnet_id          = yandex_vpc_subnet.app.id
    nat                = true
    nat_ip_address     = yandex_vpc_address.app.external_ipv4_address[0].address
    security_group_ids = [yandex_vpc_security_group.app.id]
  }
  metadata = {
    serial-port-enable = "0"
    user-data = "#cloud-config\n${yamlencode({
      package_update = true
      packages       = ["ca-certificates", "curl", "xz-utils", "caddy", "sqlite3"]
      ssh_pwauth     = false
      disable_root   = true
      users = [
        {
          name                = "deploy"
          groups              = ["sudo"]
          shell               = "/bin/bash"
          lock_passwd         = true
          sudo                = "ALL=(ALL) NOPASSWD:ALL"
          ssh_authorized_keys = [var.ssh_public_key]
        },
        {
          name        = "taskbattle"
          system      = true
          shell       = "/usr/sbin/nologin"
          lock_passwd = true
        }
      ]
    })}"
  }
  lifecycle {
    prevent_destroy = true
  }
}

# IAM token authentication is supported by provider 0.230.0. No access keys.
# Owner-managed policy/ACL grants are deliberately not represented here.
resource "yandex_storage_bucket" "photos" {
  bucket                = var.photo_bucket_name
  folder_id             = var.folder_id
  force_destroy         = false
  default_storage_class = "STANDARD"
  max_size              = 21474836480
  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }
  versioning {
    enabled = true
  }
  lifecycle_rule {
    id      = "previous-versions-seven-days"
    enabled = true
    prefix  = ""
    noncurrent_version_expiration {
      days = 7
    }
  }
  lifecycle_rule {
    id                                     = "abandoned-multipart-one-day"
    enabled                                = true
    prefix                                 = ""
    abort_incomplete_multipart_upload_days = 1
  }
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [policy, grant, acl]
  }
}

resource "yandex_storage_bucket" "backups" {
  bucket                = var.backup_bucket_name
  folder_id             = var.folder_id
  force_destroy         = false
  default_storage_class = "STANDARD"
  # Actual stored bytes are billed; leave room for photos, database snapshots and churn.
  max_size = 32212254720
  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }
  lifecycle_rule {
    id      = "snapshots-seven-days"
    enabled = true
    prefix  = "snapshots/"
    expiration {
      days = 7
    }
  }
  lifecycle_rule {
    # Photo and SQLite objects are uploaded before the manifest. Equal TTLs can
    # expire an object while its newer manifest is still a restore candidate.
    id      = "objects-nine-days"
    enabled = true
    prefix  = "objects/"
    expiration {
      days = 9
    }
  }
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [policy, grant, acl]
    precondition {
      condition     = var.backup_bucket_name != var.photo_bucket_name
      error_message = "Backups and photos must use separate buckets."
    }
  }
}
