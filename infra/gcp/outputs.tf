output "registry" {
  description = "Docker registry host, for `gcloud auth configure-docker`."
  value       = local.registry
}

output "computer_image" {
  description = "Push the computer image here."
  value       = local.computer_image
}

output "control_image" {
  description = "Push the control image here."
  value       = local.control_image
}

output "worker_control_url" {
  description = "Control's URL as computer VMs reach it."
  value       = local.worker_control_url
}

output "control_ip" {
  description = "Point var.domain's DNS A record here."
  value       = google_compute_address.control_public.address
}

output "public_url" {
  description = "Control as members reach it: the desktop's CHIEFBOT_CONTROL_URL."
  value       = local.public_url
}
