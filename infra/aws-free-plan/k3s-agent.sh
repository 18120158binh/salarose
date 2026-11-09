#!/bin/bash
# User data for data-1 and compute-1 to compute-4. Terraform renders it with templatefile(), so a bash brace expansion is written
# $${...}. Holds no secret (AFP-FR-18).
set -euo pipefail

K3S_VERSION=v1.37.2+k3s1
ECR_PROVIDER_VERSION=v1.37.0
ECR_PROVIDER_SHA256=842e0fd8159f5ed8df2f38e6521e1e4f0a1ee80cf1e1ac119bbf20bf9c20681c
REGION=${region}
TOKEN_PARAM=${token_param}
SERVER_IP=${server_ip}
NODE_NAME=${node_name}
POOL=${pool}

umask 077
mkdir -p /etc/rancher/k3s /var/lib/rancher/credentialprovider/bin

curl -fsSL -o /var/lib/rancher/credentialprovider/bin/ecr-credential-provider \
	"https://artifacts.k8s.io/binaries/cloud-provider-aws/$ECR_PROVIDER_VERSION/linux/amd64/ecr-credential-provider-linux-amd64"
echo "$ECR_PROVIDER_SHA256  /var/lib/rancher/credentialprovider/bin/ecr-credential-provider" | sha256sum -c -
chmod 0755 /var/lib/rancher/credentialprovider/bin/ecr-credential-provider
cat >/var/lib/rancher/credentialprovider/config.yaml <<'EOF'
apiVersion: kubelet.config.k8s.io/v1
kind: CredentialProviderConfig
providers:
  - name: ecr-credential-provider
    matchImages:
      - "*.dkr.ecr.*.amazonaws.com"
    defaultCacheDuration: 12h
    apiVersion: credentialprovider.kubelet.k8s.io/v1
EOF

# The server publishes the token after k3s starts, which takes a few minutes after both launches.
until token=$(aws ssm get-parameter --region "$REGION" --name "$TOKEN_PARAM" --with-decryption \
	--query Parameter.Value --output text 2>/dev/null); do
	sleep 15
done
printf '%s' "$token" >/etc/rancher/k3s/token
unset token

cat >/etc/rancher/k3s/config.yaml <<EOF
server: https://$SERVER_IP:6443
token-file: /etc/rancher/k3s/token
node-name: $NODE_NAME
node-label:
  - cdp.io/pool=$POOL
EOF

curl -fsSL "https://raw.githubusercontent.com/k3s-io/k3s/$${K3S_VERSION/+/%2B}/install.sh" -o /root/k3s-install.sh
INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_SKIP_SELINUX_RPM=true INSTALL_K3S_SELINUX_WARN=true \
	sh /root/k3s-install.sh agent
