variable "stage" {
  description = "base: no hourly cost. server: adds platform-1, its Elastic IP, the Cognito app client, and env.properties. all: adds data-1 and compute-1 to compute-4."
  type        = string

  validation {
    condition     = contains(["base", "server", "all"], var.stage)
    error_message = "stage must be base, server, or all."
  }
}

locals {
  region     = "us-east-1"
  account_id = "582577265946"
  tags       = { project = "cdp-free-plan" }
  bucket     = "cdp-free-plan-${local.account_id}"
  # The Free Plan accepts only Free Tier types (RunInstances refused m7i-flex.xlarge on 2026-11-07).
  # m7i-flex.large is the largest of them.
  instance_type = "m7i-flex.large"
  volume_gb     = 30
  # Each server publishes its agent token under its own instance id, so an agent can never read a replaced server's token.
  token_param_prefix = "/cdp-free-plan/k3s-agent-token"
  server_name        = "platform-1"
  # GitHub puts the numeric owner and repo ids in the OIDC subject (seen in CloudTrail on 2026-11-07), so a
  # rename keeps the trust working and a new repo that reuses the name gets none of it.
  github_repo   = "18120158binh@55783367/salarose@1451030863"
  deploy_branch = "deploy/aws-free-plan"
  ecr_repos     = toset(["cdp/flink-jobs", "cdp/studio"])
  studio_groups = toset(["studio-admin", "studio-editor"])
  node_managed_policies = toset([
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])

  server = var.stage == "base" ? 0 : 1
  agents = var.stage == "all" ? {
    "data-1" = "data", "compute-1" = "compute", "compute-2" = "compute", "compute-3" = "compute", "compute-4" = "compute"
  } : {}
}
