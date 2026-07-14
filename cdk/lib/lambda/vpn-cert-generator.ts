import * as forge from 'node-forge';
import {
  ACMClient,
  ImportCertificateCommand,
  DeleteCertificateCommand,
} from '@aws-sdk/client-acm';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const acm = new ACMClient({});
const secretsManager = new SecretsManagerClient({});

interface ResourceProperties {
  clientProfileSecretArn: string;
}

interface CloudFormationCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: ResourceProperties;
}

/**
 * Generates a self-signed CA, a server certificate, and a client
 * certificate for the Client VPN endpoint's mutual TLS authentication --
 * entirely within this deploy, so a stranger cloning this repo never has
 * to run OpenSSL/easy-rsa by hand or paste in pre-generated certs. Imports
 * the CA and server cert into ACM (required for
 * vpc.addClientVpnEndpoint()'s serverCertificateArn/clientCertificateArn),
 * and writes the complete downloadable .ovpn client profile (CA cert +
 * client cert + client private key inlined, per OpenVPN's standard
 * embedded-cert format) into a Secrets Manager secret, which
 * docs/02-deploy.md retrieves via a single `aws secretsmanager
 * get-secret-value` command after deploy.
 *
 * Using node-forge (bundled via NodejsFunction/esbuild) rather than
 * shelling out to openssl: Lambda's own container image doesn't
 * guarantee an openssl binary is on PATH, and shelling out to a
 * subprocess for private-key generation inside a Custom Resource Lambda
 * is a needless complication when a pure-JS X.509 library does the same
 * job.
 */
export const handler = async (event: CloudFormationCustomResourceEvent) => {
  if (event.RequestType === 'Delete') {
    // Best-effort cleanup: delete both certs this resource imported, so a
    // stack teardown doesn't leave orphaned ACM certificates behind. Not
    // scoped to the cert ARNs via CloudFormation's own dependency
    // tracking (Custom Resource Delete events don't receive prior Create
    // response data back), so this reads them from the same secret they
    // were written to.
    try {
      const existing = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: event.ResourceProperties.clientProfileSecretArn })
      );
      const { serverCertificateArn, clientCertificateArn } = JSON.parse(existing.SecretString ?? '{}');
      if (serverCertificateArn) {
        await acm.send(new DeleteCertificateCommand({ CertificateArn: serverCertificateArn })).catch(() => {});
      }
      if (clientCertificateArn) {
        await acm.send(new DeleteCertificateCommand({ CertificateArn: clientCertificateArn })).catch(() => {});
      }
    } catch {
      // The secret may already be gone (e.g. deleted before this
      // resource), or this Delete may be firing for a Create that never
      // completed -- either way, there's nothing more to clean up here.
    }
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const { clientProfileSecretArn } = event.ResourceProperties;

  // --- Certificate Authority ---
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);
  const caAttrs = [{ name: 'commonName', value: 'Claude Gateway VPN CA' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, cRLSign: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  // --- Server certificate, signed by the CA ---
  const serverKeys = forge.pki.rsa.generateKeyPair(2048);
  const serverCert = forge.pki.createCertificate();
  serverCert.publicKey = serverKeys.publicKey;
  serverCert.serialNumber = '02';
  serverCert.validity.notBefore = new Date();
  serverCert.validity.notAfter = new Date();
  serverCert.validity.notAfter.setFullYear(serverCert.validity.notBefore.getFullYear() + 10);
  serverCert.setSubject([{ name: 'commonName', value: 'server.claude-gateway.internal' }]);
  serverCert.setIssuer(caAttrs);
  serverCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    // ACM derives a certificate's "domain name" from the CN/SAN; a bare,
    // non-FQDN CN like "server" leaves it blank, which then makes
    // create-client-vpn-endpoint reject the certificate with "Certificate
    // ... does not have a domain" -- confirmed the hard way against a
    // real deploy attempt. Explicit SAN matching the CN is the standard,
    // more correct X.509 practice anyway (most TLS validators prefer SAN
    // over CN), so this is included even though this cert is self-signed
    // and never validated against a real DNS lookup.
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'server.claude-gateway.internal' }] },
  ]);
  serverCert.sign(caKeys.privateKey, forge.md.sha256.create());

  // --- Client certificate, signed by the CA ---
  const clientKeys = forge.pki.rsa.generateKeyPair(2048);
  const clientCert = forge.pki.createCertificate();
  clientCert.publicKey = clientKeys.publicKey;
  clientCert.serialNumber = '03';
  clientCert.validity.notBefore = new Date();
  clientCert.validity.notAfter = new Date();
  clientCert.validity.notAfter.setFullYear(clientCert.validity.notBefore.getFullYear() + 10);
  clientCert.setSubject([{ name: 'commonName', value: 'claude-gateway-client' }]);
  clientCert.setIssuer(caAttrs);
  clientCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true },
  ]);
  clientCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const caCertPem = forge.pki.certificateToPem(caCert);
  const serverCertPem = forge.pki.certificateToPem(serverCert);
  const serverKeyPem = forge.pki.privateKeyToPem(serverKeys.privateKey);
  const clientCertPem = forge.pki.certificateToPem(clientCert);
  const clientKeyPem = forge.pki.privateKeyToPem(clientKeys.privateKey);

  // ACM requires the server cert's import to include its private key and
  // the CA as its certificate chain; the client cert import for
  // vpc.addClientVpnEndpoint()'s clientCertificateArn only needs the CA
  // itself (this endpoint validates connecting clients' certs against it,
  // it doesn't present the client cert to anyone).
  const serverCertImport = await acm.send(
    new ImportCertificateCommand({
      Certificate: Buffer.from(serverCertPem),
      PrivateKey: Buffer.from(serverKeyPem),
      CertificateChain: Buffer.from(caCertPem),
    })
  );
  const caCertImport = await acm.send(
    new ImportCertificateCommand({
      Certificate: Buffer.from(caCertPem),
      PrivateKey: Buffer.from(forge.pki.privateKeyToPem(caKeys.privateKey)),
    })
  );

  await secretsManager.send(
    new PutSecretValueCommand({
      SecretId: clientProfileSecretArn,
      SecretString: JSON.stringify({
        caCertPem,
        clientCertPem,
        clientKeyPem,
        serverCertificateArn: serverCertImport.CertificateArn,
        clientCertificateArn: caCertImport.CertificateArn,
      }),
    })
  );

  return {
    PhysicalResourceId: 'claude-gateway-vpn-certs',
    Data: {
      ServerCertificateArn: serverCertImport.CertificateArn,
      ClientCertificateArn: caCertImport.CertificateArn,
    },
  };
};
