import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const secretsManager = new SecretsManagerClient({});

interface ResourceProperties {
  clientProfileSecretArn: string;
  endpointDnsName: string;
}

interface CloudFormationCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: ResourceProperties;
}

/**
 * Assembles the final, ready-to-import .ovpn client configuration file
 * from the certs the vpn-cert-generator Lambda already wrote to Secrets
 * Manager, plus the Client VPN endpoint's DNS name (only known once the
 * endpoint itself exists, one step after the certs were generated -- see
 * vpn-stack.ts for why this is a second Custom Resource rather than doing
 * everything in one).
 *
 * Uses OpenVPN's standard embedded-certificate format (<ca>, <cert>,
 * <key> inline blocks), so the resulting file is immediately importable
 * into AWS's own OpenVPN client (or any standard OpenVPN client) with no
 * separate cert files to manage.
 */
export const handler = async (event: CloudFormationCustomResourceEvent) => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const { clientProfileSecretArn, endpointDnsName } = event.ResourceProperties;

  const existing = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: clientProfileSecretArn })
  );
  const { caCertPem, clientCertPem, clientKeyPem } = JSON.parse(existing.SecretString ?? '{}');

  const ovpnProfile = `client
dev tun
proto udp
remote ${endpointDnsName} 443
remote-random-hostname
resolv-retry infinite
nobind
remote-cert-tls server
cipher AES-256-GCM
verb 3

<ca>
${caCertPem.trim()}
</ca>

<cert>
${clientCertPem.trim()}
</cert>

<key>
${clientKeyPem.trim()}
</key>
`;

  await secretsManager.send(
    new PutSecretValueCommand({
      SecretId: clientProfileSecretArn,
      SecretString: JSON.stringify({ caCertPem, clientCertPem, clientKeyPem, ovpnProfile }),
    })
  );

  return { PhysicalResourceId: 'claude-gateway-vpn-profile' };
};
