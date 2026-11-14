#!/bin/bash
# User data for platform-1, the k3s server. Terraform renders it with templatefile(), so a bash brace expansion is written $${...}.
# Holds no secret (AFP-FR-18).
set -euo pipefail

K3S_VERSION=v1.37.2+k3s1
ECR_PROVIDER_VERSION=v1.37.0
ECR_PROVIDER_SHA256=842e0fd8159f5ed8df2f38e6521e1e4f0a1ee80cf1e1ac119bbf20bf9c20681c
REGION=${region}
NODE_NAME=${node_name}
IMDS_TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
INSTANCE_ID=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
TOKEN_PARAM=${token_param_prefix}/$INSTANCE_ID

umask 077
mkdir -p /etc/rancher/k3s /var/lib/rancher/credentialprovider/bin

# k3s's default credential provider paths, so the kubelet pulls from ECR with the instance role (AFP-FR-06).
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

# An agent token can join agents only, never servers, so the copy in Parameter Store cannot add a control plane.
if [ ! -s /etc/rancher/k3s/agent-token ]; then
	# Not `tr </dev/urandom | head`: under pipefail, tr's SIGPIPE fails the pipeline and ends the script.
	od -An -tx1 -N32 /dev/urandom | tr -d ' \n' >/etc/rancher/k3s/agent-token
fi

# The enablelb label limits k3s's service load balancer to this node, the only one whose 80 and 443 should answer,
# because the shared security group opens those ports on every node (AFP-FR-16).
cat >/etc/rancher/k3s/config.yaml <<EOF
node-name: $NODE_NAME
node-label:
  - cdp.io/pool=platform
  - svccontroller.k3s.cattle.io/enablelb=true
agent-token-file: /etc/rancher/k3s/agent-token
write-kubeconfig-mode: "0600"
EOF

# k3s applies this directory at start. Traefik runs on the platform node and redirects HTTP to HTTPS.
# Let's Encrypt follows the redirect for HTTP-01 and does not check the certificate it lands on.
# externalTrafficPolicy Local keeps the visitor's address: ServiceLB then skips the SNAT that made every request
# come from 10.42.0.1 (AFP-FR-36). It costs nothing here, because only this node runs ServiceLB and Traefik.
# Traefik trusts no incoming X-Forwarded-For (no forwardedHeaders.trustedIPs), so it overwrites the header with
# the peer address, and the collector reads that header as user_ipaddress. A client cannot forge it.
mkdir -p /var/lib/rancher/k3s/server/manifests
cat >/var/lib/rancher/k3s/server/manifests/traefik-config.yaml <<'EOF'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    nodeSelector:
      cdp.io/pool: platform
    service:
      spec:
        externalTrafficPolicy: Local
    ports:
      web:
        # Traefik chart 41 reads the redirect under http:, and silently ignores it one level up.
        http:
          redirections:
            entryPoint:
              to: websecure
              scheme: https
              permanent: true
EOF

curl -fsSL "https://raw.githubusercontent.com/k3s-io/k3s/$${K3S_VERSION/+/%2B}/install.sh" -o /root/k3s-install.sh
INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_SKIP_SELINUX_RPM=true INSTALL_K3S_SELINUX_WARN=true \
	sh /root/k3s-install.sh server

# The value goes through file:// so it never appears on a command line.
if aws ssm get-parameter --region "$REGION" --name "$TOKEN_PARAM" >/dev/null 2>&1; then
	aws ssm put-parameter --region "$REGION" --name "$TOKEN_PARAM" --type SecureString --overwrite \
		--value file:///etc/rancher/k3s/agent-token >/dev/null
else
	aws ssm put-parameter --region "$REGION" --name "$TOKEN_PARAM" --type SecureString \
		--tags Key=project,Value=cdp-free-plan --value file:///etc/rancher/k3s/agent-token >/dev/null
fi
