# Chiefbot on GCP: network, registry, service accounts, setup's secrets, the
# computer VM template and the control-plane VM with Caddy for HTTPS. Written,
# NOT applied: `terraform apply` waits for the deployer's approval of the spend
# (docs/deploy.md). Computer VMs are not in here: control creates one per bot,
# project coordinator and task worker from the chiefbot-computer template (GceProvider).

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.7"
    }
  }
  # State stays in this folder (git-ignored) for the proof of concept.
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
  # The budgets API needs a quota project when run with user credentials.
  billing_project       = var.project_id
  user_project_override = true
}

locals {
  registry           = "${var.region}-docker.pkg.dev"
  repository         = "${local.registry}/${var.project_id}/${google_artifact_registry_repository.chiefbot.repository_id}"
  computer_image     = "${local.repository}/computer:${var.image_tag}"
  control_image      = "${local.repository}/control:${var.image_tag}"
  control_port       = 7410
  worker_control_url = "http://${google_compute_address.control.address}:${local.control_port}"
  public_url         = "https://${var.domain}"
  # IAP TCP forwarding connects from this range.
  iap_range = "35.235.240.0/20"
}

data "google_project" "this" {}

resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com",
    "iap.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "logging.googleapis.com",
    "billingbudgets.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# --- Network: one subnet; computers have no public IP and go out through Cloud NAT ---

resource "google_compute_network" "chiefbot" {
  name                    = "chiefbot"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "chiefbot" {
  name          = "chiefbot"
  network       = google_compute_network.chiefbot.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"
  # VMs without a public IP reach Artifact Registry and other Google APIs.
  private_ip_google_access = true
}

resource "google_compute_router" "chiefbot" {
  name    = "chiefbot"
  network = google_compute_network.chiefbot.id
  region  = var.region
}

# Outbound internet (GitHub, Copilot) for VMs with no public IP.
resource "google_compute_router_nat" "chiefbot" {
  name                               = "chiefbot"
  router                             = google_compute_router.chiefbot.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# SSH through IAP only.
resource "google_compute_firewall" "iap" {
  name          = "chiefbot-allow-iap"
  network       = google_compute_network.chiefbot.id
  source_ranges = [local.iap_range]
  target_tags   = ["chiefbot-control", "chiefbot-computer"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Members and connector OAuth callbacks reach control through Caddy on the
# control VM: 80 for the certificate challenge and the redirect, 443 for HTTPS.
resource "google_compute_firewall" "https" {
  name          = "chiefbot-allow-https"
  network       = google_compute_network.chiefbot.id
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["chiefbot-control"]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

# Computers (bots, coordinators, task workers) dial control's WebSocket inside the network.
resource "google_compute_firewall" "workers_to_control" {
  name        = "chiefbot-allow-workers-to-control"
  network     = google_compute_network.chiefbot.id
  source_tags = ["chiefbot-computer"]
  target_tags = ["chiefbot-control"]
  allow {
    protocol = "tcp"
    ports    = [tostring(local.control_port)]
  }
}

# IAP SSH signs in with Google accounts (OS Login), not project SSH keys.
resource "google_compute_project_metadata_item" "os_login" {
  key        = "enable-oslogin"
  value      = "TRUE"
  depends_on = [google_project_service.apis]
}

# --- Images ---

resource "google_artifact_registry_repository" "chiefbot" {
  location      = var.region
  repository_id = "chiefbot"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

# --- Service accounts ---

# Control creates, starts, stops and deletes computer VMs and disks.
resource "google_service_account" "control" {
  account_id   = "chiefbot-control"
  display_name = "Chiefbot control plane"
}

# Computer VMs only pull their image and write logs. They hold no project rights.
resource "google_service_account" "computer" {
  account_id   = "chiefbot-computer"
  display_name = "Chiefbot bot computer"
}

resource "google_artifact_registry_repository_iam_member" "pull" {
  for_each   = { control = google_service_account.control.member, computer = google_service_account.computer.member }
  location   = google_artifact_registry_repository.chiefbot.location
  repository = google_artifact_registry_repository.chiefbot.name
  role       = "roles/artifactregistry.reader"
  member     = each.value
}

resource "google_project_iam_member" "logs" {
  for_each = { control = google_service_account.control.member, computer = google_service_account.computer.member }
  project  = var.project_id
  role     = "roles/logging.logWriter"
  member   = each.value
}

resource "google_project_iam_member" "control_compute" {
  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = google_service_account.control.member
}

# Lets control start VMs that run as the computer service account.
resource "google_service_account_iam_member" "control_uses_computer" {
  service_account_id = google_service_account.computer.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.control.member
}

# Control keeps users' GitHub refresh tokens and connectors' credentials in
# Secret Manager, one secret each, and reads setup's two secrets below.
resource "google_project_iam_member" "control_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = google_service_account.control.member
}

# What `bun run setup` wrote: config.json (both apps' IDs) and
# github-app-secrets.json (the repo app's private key). Terraform makes the
# empty secrets; you add their versions with gcloud (docs/deploy.md), so the key
# never enters Terraform state. Control reads them on every start (index.ts).
resource "google_secret_manager_secret" "setup" {
  for_each  = toset(["chiefbot-config", "chiefbot-github-app-secrets"])
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# --- Computers: the template control makes each computer's VM from ---

# GceProvider names the boot disk (Container-Optimized OS), the computer's home disk
# and the cloud-init itself, which replace the template's disks and metadata.
# The template owns the machine type, network, service account and labels.
resource "google_compute_instance_template" "computer" {
  name         = "chiefbot-computer"
  machine_type = var.computer_machine_type
  tags         = ["chiefbot-computer"]
  labels       = { app = "chiefbot", role = "computer" }

  disk {
    source_image = "cos-cloud/cos-stable"
    boot         = true
    auto_delete  = true
    disk_size_gb = 10
    disk_type    = "pd-balanced"
  }

  # No access_config block: no public IP.
  network_interface {
    subnetwork = google_compute_subnetwork.chiefbot.id
  }

  service_account {
    email  = google_service_account.computer.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
}

# --- Control plane: one small VM running the control container ---

resource "google_compute_address" "control" {
  name         = "chiefbot-control"
  address_type = "INTERNAL"
  subnetwork   = google_compute_subnetwork.chiefbot.id
  region       = var.region
}

# The address var.domain's DNS A record points at.
resource "google_compute_address" "control_public" {
  name       = "chiefbot-control-public"
  region     = var.region
  depends_on = [google_project_service.apis]
}

# SQLite (users, bots, projects, ledgers, chats), projects' context files and
# Caddy's certificates. Outlives the VM.
resource "google_compute_disk" "control_data" {
  name       = "chiefbot-control-data"
  type       = "pd-balanced"
  size       = 10
  zone       = var.zone
  depends_on = [google_project_service.apis]
}

resource "google_compute_instance" "control" {
  name                      = "chiefbot-control"
  machine_type              = var.control_machine_type
  zone                      = var.zone
  tags                      = ["chiefbot-control"]
  labels                    = { app = "chiefbot", role = "control" }
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 10
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source      = google_compute_disk.control_data.id
    device_name = "data"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.chiefbot.id
    network_ip = google_compute_address.control.address
    access_config {
      nat_ip = google_compute_address.control_public.address
    }
  }

  service_account {
    email  = google_service_account.control.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    user-data = templatefile("${path.module}/control.cloud-init.yaml", {
      registry = local.registry
      image    = local.control_image
      domain   = var.domain
      port     = local.control_port
      env = {
        CHIEFBOT_CONTROL_HOSTNAME   = "0.0.0.0"
        CHIEFBOT_CONTROL_PORT       = tostring(local.control_port)
        CHIEFBOT_DB_PATH            = "/data/control.sqlite"
        CHIEFBOT_COMPUTERS          = "gce"
        CHIEFBOT_GCP_PROJECT        = var.project_id
        CHIEFBOT_GCP_ZONE           = var.zone
        CHIEFBOT_COMPUTER_IMAGE     = local.computer_image
        CHIEFBOT_WORKER_CONTROL_URL = local.worker_control_url
        CHIEFBOT_PUBLIC_URL         = local.public_url
        # Setup's files from Secret Manager, on a tmpfs: never on a disk.
        CHIEFBOT_HOME = "/run/chiefbot"
      }
    })
  }

  depends_on = [google_compute_router_nat.chiefbot]
}

# --- Spend guard ---

resource "google_billing_budget" "chiefbot" {
  billing_account = var.billing_account_id
  display_name    = "chiefbot"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.monthly_budget)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  depends_on = [google_project_service.apis]
}
