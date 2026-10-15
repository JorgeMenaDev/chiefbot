output "registry" {
  description = "Docker registry host, for `gcloud auth configure-docker`."
  value       = local.registry
}

output "computer_image" {
  description = "Push the bot computer image here."
  value       = local.computer_image
}

output "control_image" {
  description = "Push the control image here."
  value       = local.control_image
}

output "worker_control_url" {
  description = "Control's URL as bot VMs reach it."
  value       = local.worker_control_url
}

output "control_tunnel" {
  description = "Opens control on http://127.0.0.1:7410 on this Mac, through IAP."
  value       = "gcloud compute start-iap-tunnel ${google_compute_instance.control.name} ${local.control_port} --local-host-port=localhost:${local.control_port} --zone=${var.zone} --project=${var.project_id}"
}
