data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_ec2_instance_type_offerings" "node" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [local.instance_type]
  }
}

data "aws_subnet" "node" {
  vpc_id            = data.aws_vpc.default.id
  default_for_az    = true
  availability_zone = sort(data.aws_ec2_instance_type_offerings.node.locations)[0]
}

locals {
  ami = nonsensitive(data.aws_ssm_parameter.al2023.value)
}

resource "aws_instance" "server" {
  count                  = local.server
  ami                    = local.ami
  instance_type          = local.instance_type
  subnet_id              = data.aws_subnet.node.id
  vpc_security_group_ids = [aws_security_group.node.id]
  iam_instance_profile   = aws_iam_instance_profile.node.name
  user_data = templatefile("${path.module}/../k3s-server.sh", {
    region             = local.region
    token_param_prefix = local.token_param_prefix
    node_name          = local.server_name
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size           = local.volume_gb
    volume_type           = "gp3"
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = local.server_name })
  }

  tags = { Name = local.server_name }

  # A newer AMI or an edited script must not replace a node that holds cluster state.
  lifecycle {
    ignore_changes = [ami, user_data, subnet_id]
  }
}

resource "aws_instance" "agent" {
  for_each               = local.agents
  ami                    = local.ami
  instance_type          = local.instance_type
  subnet_id              = aws_instance.server[0].subnet_id
  vpc_security_group_ids = [aws_security_group.node.id]
  iam_instance_profile   = aws_iam_instance_profile.node.name
  user_data = templatefile("${path.module}/../k3s-agent.sh", {
    region      = local.region
    token_param = "${local.token_param_prefix}/${aws_instance.server[0].id}"
    server_ip   = aws_instance.server[0].private_ip
    node_name   = each.key
    pool        = each.value
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size           = local.volume_gb
    volume_type           = "gp3"
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = each.key })
  }

  tags = { Name = each.key }

  lifecycle {
    ignore_changes = [ami, user_data, subnet_id]
  }
}

locals {
  nodes = merge(
    { for i in aws_instance.server : i.tags.Name => i },
    aws_instance.agent,
  )
}

# aws_instance cannot tag the primary network interface it creates (AFP-FR-02).
resource "aws_ec2_tag" "eni" {
  for_each = {
    for pair in setproduct(keys(local.nodes), ["project", "Name"]) : "${pair[0]}/${pair[1]}" => {
      eni   = local.nodes[pair[0]].primary_network_interface_id
      key   = pair[1]
      value = pair[1] == "Name" ? pair[0] : local.tags.project
    }
  }
  resource_id = each.value.eni
  key         = each.value.key
  value       = each.value.value
}

resource "aws_eip" "server" {
  count    = local.server
  domain   = "vpc"
  instance = aws_instance.server[0].id
  tags     = { Name = local.server_name }
}

locals {
  ip_dashed  = local.server == 1 ? replace(aws_eip.server[0].public_ip, ".", "-") : null
  studio_url = local.server == 1 ? "https://studio.${local.ip_dashed}.sslip.io" : null
}

resource "aws_cognito_user_pool_client" "studio" {
  count                                = local.server
  name                                 = "studio"
  user_pool_id                         = aws_cognito_user_pool.studio.id
  generate_secret                      = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["${local.studio_url}/api/auth/oidc/callback"]
  logout_urls                          = ["${local.studio_url}/login"]
}

# The Flink URL's sign-in proxy (AFP-FR-24). bootstrap-cluster.sh reads its secret into flink-ui-auth.
resource "aws_cognito_user_pool_client" "flink_ui" {
  count                                = local.server
  name                                 = "flink-ui"
  user_pool_id                         = aws_cognito_user_pool.studio.id
  generate_secret                      = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = ["https://flink.${local.ip_dashed}.sslip.io/oauth2/callback"]
}

resource "local_file" "env_properties" {
  count           = local.server
  filename        = "${path.module}/../../k8s/envs/aws-free-plan/env.properties"
  file_permission = "0644"
  content         = <<-EOT
    IP_DASHED=${local.ip_dashed}
    BUCKET=${local.bucket}
    COGNITO_POOL_ID=${aws_cognito_user_pool.studio.id}
    COGNITO_CLIENT_ID=${aws_cognito_user_pool_client.studio[0].id}
    ACCOUNT_ID=${local.account_id}
    REGION=${local.region}
  EOT
}
