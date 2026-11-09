output "ci_role_arn" {
  description = "The role that .github/workflows/build-images.yml assumes."
  value       = aws_iam_role.ci.arn
}

output "bucket" {
  value = aws_s3_bucket.flink.bucket
}

output "cognito_pool_id" {
  value = aws_cognito_user_pool.studio.id
}

output "cognito_client_id" {
  value = one(aws_cognito_user_pool_client.studio[*].id)
}

output "flink_ui_client_id" {
  value = one(aws_cognito_user_pool_client.flink_ui[*].id)
}

output "instance_ids" {
  value = { for name, node in local.nodes : name => node.id }
}

output "public_ip" {
  value = one(aws_eip.server[*].public_ip)
}

output "ip_dashed" {
  value = local.ip_dashed
}

output "studio_url" {
  value = local.studio_url
}

output "logins_secret" {
  description = "The Secrets Manager secret that holds the environment's logins. rotate-logins.sh writes it."
  value       = { name = aws_secretsmanager_secret.logins.name, arn = aws_secretsmanager_secret.logins.arn }
}
