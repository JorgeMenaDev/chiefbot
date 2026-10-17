variable "project_id" {
  description = "The GCP project Chiefbot runs in. Create it and link billing first (docs/deploy-gcp.md)."
  type        = string
}

variable "github_client_id" {
  description = "Client ID of your sign-in app: `bun run setup` writes it to ~/.chiefbot/config.json (signIn.app.clientId, or signIn.clientId for an OAuth App). The desktop signs in with the same app."
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
  description = "Zone for the control VM and the bot VMs. Must be in var.region."
  type        = string
  default     = "europe-west2-a"
}

variable "image_tag" {
  description = "Tag of the control and bot computer images in Artifact Registry."
  type        = string
  default     = "v1"
}

variable "computer_machine_type" {
  description = "Machine type of each bot's VM."
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
