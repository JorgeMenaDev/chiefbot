variable "project_id" {
  description = "The GCP project Chiefbot runs in. Create it and link billing first (docs/deploy.md)."
  type        = string
}

variable "domain" {
  description = "DNS name members reach control on, e.g. chiefbot.example.com. Point its A record at the control_ip output; Caddy gets its certificate. Also the base of connectors' OAuth callbacks."
  type        = string
}

variable "billing_account_id" {
  description = "Billing account for the budget alert, e.g. 012345-6789AB-CDEF01."
  type        = string
}

variable "region" {
  description = "Region for the network, registry and VMs. London by default."
  type        = string
  default     = "europe-west2"
}

variable "zone" {
  description = "Zone for the control VM and the computer VMs. Must be in var.region."
  type        = string
  default     = "europe-west2-a"
}

variable "image_tag" {
  description = "Tag of the control and computer images in Artifact Registry."
  type        = string
  default     = "v1"
}

variable "computer_machine_type" {
  description = "Machine type of each computer's VM: bots, project coordinators and task workers."
  type        = string
  default     = "e2-standard-2"
}

variable "control_machine_type" {
  description = "Machine type of the control-plane VM."
  type        = string
  default     = "e2-medium"
}

variable "monthly_budget" {
  description = "Monthly budget; alerts go to the billing account admins at 50%, 90% and 100%."
  type        = number
  default     = 100
}

variable "budget_currency" {
  description = "Must be the billing account's currency (USD or GBP)."
  type        = string
  default     = "USD"
}
