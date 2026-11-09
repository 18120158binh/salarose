# Single sign-on for the tools with built-in OIDC (AFP-FR-27). bootstrap-cluster.sh reads each client's id and secret
# into the tool's secret: argocd-oidc, grafana-oidc, and kafka-ui-oidc.
locals {
  sso_clients = local.server == 1 ? {
    argocd = {
      callback = "https://argocd.${local.ip_dashed}.sslip.io/auth/callback"
      logout   = "https://argocd.${local.ip_dashed}.sslip.io/login"
    }
    grafana = {
      callback = "https://grafana.${local.ip_dashed}.sslip.io/login/generic_oauth"
      logout   = "https://grafana.${local.ip_dashed}.sslip.io/login"
    }
    kafka-ui = {
      callback = "https://kafka.${local.ip_dashed}.sslip.io/login/oauth2/code/cognito"
      logout   = "https://kafka.${local.ip_dashed}.sslip.io/"
    }
  } : {}
}

resource "aws_cognito_user_pool_client" "sso" {
  for_each                             = local.sso_clients
  name                                 = each.key
  user_pool_id                         = aws_cognito_user_pool.studio.id
  generate_secret                      = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = [each.value.callback]
  logout_urls                          = [each.value.logout]
}

output "argocd_client_id" {
  value = try(aws_cognito_user_pool_client.sso["argocd"].id, null)
}

output "grafana_client_id" {
  value = try(aws_cognito_user_pool_client.sso["grafana"].id, null)
}

output "kafka_ui_client_id" {
  value = try(aws_cognito_user_pool_client.sso["kafka-ui"].id, null)
}
