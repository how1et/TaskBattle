variable "cloud_id" {
  type        = string
  description = "Existing cloud ID selected by its owner."
}

variable "folder_id" {
  type        = string
  description = "Existing dedicated TaskBattle folder ID."
}

variable "runtime_service_account_id" {
  type        = string
  description = "Existing runtime service account; owner assigns its bucket/Lockbox permissions."
}

variable "image_id" {
  type        = string
  description = "Owner-reviewed immutable Ubuntu 24.04 LTS amd64 image ID. No moving image family."
}

variable "zone" {
  type        = string
  description = "Chosen Russia availability zone supporting standard-v3."
  validation {
    condition     = can(regex("^ru-central1-[a-z]$", var.zone))
    error_message = "Choose a currently available Russia zone."
  }
}

variable "name" {
  type        = string
  description = "Explicit resource-name prefix, selected by the owner."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,39}$", var.name))
    error_message = "Use 2–40 lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "subnet_cidr" {
  type        = string
  description = "Unused private IPv4 CIDR selected after checking existing networks."
  validation {
    condition     = can(cidrnetmask(var.subnet_cidr))
    error_message = "Provide a valid IPv4 subnet CIDR."
  }
}

variable "ssh_admin_cidr" {
  type        = string
  description = "Operator public IPv4 /32; SSH is never open to the internet."
  validation {
    condition     = can(cidrnetmask(var.ssh_admin_cidr)) && can(regex("/32$", var.ssh_admin_cidr))
    error_message = "Provide the operator's current public IPv4 address with /32."
  }
}

variable "ssh_public_key" {
  type        = string
  description = "Operator public SSH key only; never a private key."
  validation {
    condition     = can(regex("^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$", var.ssh_public_key))
    error_message = "Provide a single-line ssh-ed25519 public key."
  }
}

variable "photo_bucket_name" {
  type        = string
  description = "Globally unique private photo bucket name selected by the owner."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.photo_bucket_name))
    error_message = "Use a 3–63 character lowercase bucket name without dots."
  }
}

variable "backup_bucket_name" {
  type        = string
  description = "Different globally unique private backup bucket name selected by the owner."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.backup_bucket_name))
    error_message = "Use a 3–63 character lowercase bucket name without dots."
  }
}
