resource "aws_s3_bucket" "flink" {
  bucket = local.bucket
}

resource "aws_s3_bucket_public_access_block" "flink" {
  bucket                  = aws_s3_bucket.flink.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_ecr_repository" "image" {
  for_each = local.ecr_repos
  name     = each.key

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Outside local.ecr_repos because imports.tf adopts every entry there, and this repository did not exist before Terraform.
resource "aws_ecr_repository" "simulator" {
  name = "cdp/simulator"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cognito_user_pool" "studio" {
  name                     = "cdp-studio"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
}

resource "aws_cognito_user_pool_domain" "studio" {
  domain       = "cdp-studio-${local.account_id}"
  user_pool_id = aws_cognito_user_pool.studio.id
}

resource "aws_cognito_user_group" "studio" {
  for_each     = local.studio_groups
  name         = each.key
  user_pool_id = aws_cognito_user_pool.studio.id
}

# No secret version in Terraform, so the state never holds a login. rotate-logins.sh writes the value from platform-1.
resource "aws_secretsmanager_secret" "logins" {
  name                    = "cdp-free-plan/logins"
  description             = "Argo CD, Grafana, and studio logins of the cdp free plan environment"
  recovery_window_in_days = 0
}

resource "aws_iam_role" "node" {
  name = "cdp-free-plan-node"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each   = local.node_managed_policies
  role       = aws_iam_role.node.name
  policy_arn = each.key
}

# The SSM parameter statement carries the k3s agent token from the server to the agents (AFP-FR-18).
resource "aws_iam_role_policy" "node" {
  name = "cdp-free-plan-node"
  role = aws_iam_role.node.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.flink.arn}/flink/*"
      },
      {
        Effect    = "Allow"
        Action    = "s3:ListBucket"
        Resource  = aws_s3_bucket.flink.arn
        Condition = { StringLike = { "s3:prefix" = ["flink", "flink/*"] } }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.flink.arn}/sim-reports/*"
      },
      {
        Effect   = "Allow"
        Action   = "cognito-idp:DescribeUserPoolClient"
        Resource = aws_cognito_user_pool.studio.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter", "ssm:AddTagsToResource"]
        Resource = "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.token_param_prefix}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.logins.arn
      },
    ]
  })
}

resource "aws_iam_instance_profile" "node" {
  name = aws_iam_role.node.name
  role = aws_iam_role.node.name
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "ci" {
  name = "cdp-free-plan-ci"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${local.github_repo}:ref:refs/heads/${local.deploy_branch}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "ci" {
  name = "cdp-free-plan-ci"
  role = aws_iam_role.ci.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
        ]
        Resource = concat([for name in sort(tolist(local.ecr_repos)) : aws_ecr_repository.image[name].arn], [aws_ecr_repository.simulator.arn])
      },
    ]
  })
}

data "aws_vpc" "default" {
  default = true
}

# Egress stays inline: a separate rule resource would tag the existing untagged default egress rule.
resource "aws_security_group" "node" {
  name        = "cdp-free-plan"
  description = "cdp free plan nodes"
  vpc_id      = data.aws_vpc.default.id

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_vpc_security_group_ingress_rule" "public" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.node.id
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "within_group" {
  security_group_id            = aws_security_group.node.id
  ip_protocol                  = "-1"
  referenced_security_group_id = aws_security_group.node.id
}
