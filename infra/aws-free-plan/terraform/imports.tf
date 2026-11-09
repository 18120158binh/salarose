# Stage base ran before Terraform managed this account, so its resources are adopted, not created.

import {
  to = aws_s3_bucket.flink
  id = "cdp-free-plan-582577265946"
}

import {
  to = aws_s3_bucket_public_access_block.flink
  id = "cdp-free-plan-582577265946"
}

import {
  for_each = local.ecr_repos
  to       = aws_ecr_repository.image[each.key]
  id       = each.key
}

import {
  to = aws_cognito_user_pool.studio
  id = "us-east-1_wXHpiFUAI"
}

import {
  to = aws_cognito_user_pool_domain.studio
  id = "cdp-studio-582577265946"
}

import {
  for_each = local.studio_groups
  to       = aws_cognito_user_group.studio[each.key]
  id       = "us-east-1_wXHpiFUAI/${each.key}"
}

import {
  to = aws_iam_role.node
  id = "cdp-free-plan-node"
}

import {
  for_each = local.node_managed_policies
  to       = aws_iam_role_policy_attachment.node[each.key]
  id       = "cdp-free-plan-node/${each.key}"
}

import {
  to = aws_iam_role_policy.node
  id = "cdp-free-plan-node:cdp-free-plan-node"
}

import {
  to = aws_iam_instance_profile.node
  id = "cdp-free-plan-node"
}

import {
  to = aws_iam_openid_connect_provider.github
  id = "arn:aws:iam::582577265946:oidc-provider/token.actions.githubusercontent.com"
}

import {
  to = aws_iam_role.ci
  id = "cdp-free-plan-ci"
}

import {
  to = aws_iam_role_policy.ci
  id = "cdp-free-plan-ci:cdp-free-plan-ci"
}

import {
  to = aws_security_group.node
  id = "sg-0d9d756f4484859a9"
}

import {
  to = aws_vpc_security_group_ingress_rule.within_group
  id = "sgr-02a8dfabc114a609b"
}

import {
  to = aws_vpc_security_group_ingress_rule.public["80"]
  id = "sgr-0f08860e37d015cd4"
}

import {
  to = aws_vpc_security_group_ingress_rule.public["443"]
  id = "sgr-0dda271109f3e15c0"
}
