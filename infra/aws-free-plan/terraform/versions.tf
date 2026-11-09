terraform {
  required_version = "1.17.1"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.72.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "2.9.1"
    }
  }

  # The state holds the Cognito client secret, so it lives only in the private bucket.
  backend "s3" {
    bucket       = "cdp-free-plan-582577265946"
    key          = "tfstate/aws-free-plan.tfstate"
    region       = "us-east-1"
    use_lockfile = true
  }
}

provider "aws" {
  region = local.region

  default_tags {
    tags = local.tags
  }
}
