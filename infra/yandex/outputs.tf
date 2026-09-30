output "public_ip" {
  value = yandex_vpc_address.app.external_ipv4_address[0].address
}

output "instance_id" {
  value = yandex_compute_instance.app.id
}

output "persistent_disk_id" {
  value = yandex_compute_disk.app.id
}

output "photo_bucket" {
  value = yandex_storage_bucket.photos.bucket
}

output "backup_bucket" {
  value = yandex_storage_bucket.backups.bucket
}
