import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejsLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

export interface VpnStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
  readonly privateSubnets: ec2.ISubnet[];
}

/**
 * A self-contained AWS Client VPN endpoint, so a stranger deploying this
 * repo has an actual way to reach the gateway's private-subnet endpoint
 * without any manual AWS console work beyond the Okta setup this repo
 * already requires. Without this stack, "the gateway is private by
 * design" is only half a design -- there'd be no way to reach it at all,
 * which defeats the point of a self-contained sample that's supposed to
 * go from `git clone` + `cdk deploy` to a working, USABLE gateway.
 *
 * Uses mutual TLS authentication (not SAML/federated), since it needs no
 * additional Okta app registration beyond what the gateway itself already
 * requires -- the whole CA/server/client certificate chain is generated
 * inside this stack's own Custom Resource (see
 * lib/lambda/vpn-cert-generator.ts), imported into ACM, and the resulting
 * downloadable .ovpn client profile (with the CA cert, client cert, and
 * client private key all inlined, per OpenVPN's standard embedded-cert
 * format) is written to a Secrets Manager secret that docs/02-deploy.md
 * retrieves with a single `aws secretsmanager get-secret-value` command.
 *
 * Split-tunnel is enabled deliberately, not full-tunnel: a real gotcha
 * documented from this repo's own manual predecessor (see amend.md) is
 * that full-tunnel mode routes ALL traffic -- including the developer's
 * browser's redirect to Okta's public sign-in page -- through the VPN,
 * where only the VPC's own CIDR is authorized, silently breaking the
 * "This matches my device -- Continue" sign-in click with no visible
 * error. Split-tunnel routes only VPC-bound traffic through the tunnel,
 * leaving the rest of the developer's internet access (including the
 * Okta redirect) untouched.
 */
export class VpnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VpnStackProps) {
    super(scope, id, props);

    const clientProfileSecret = new secretsmanager.Secret(this, 'VpnClientProfileSecret', {
      description: 'Generated CA/server/client certs and the assembled downloadable .ovpn profile for the Claude Gateway Client VPN endpoint -- see docs/02-deploy.md.',
    });

    const certGeneratorRole = new iam.Role(this, 'CertGeneratorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    certGeneratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['acm:ImportCertificate', 'acm:DeleteCertificate', 'acm:AddTagsToCertificate'],
      // ImportCertificate creates a new resource, so it cannot be scoped
      // to a specific, not-yet-existing certificate ARN.
      resources: ['*'],
    }));
    clientProfileSecret.grantRead(certGeneratorRole);
    clientProfileSecret.grantWrite(certGeneratorRole);

    const certGeneratorFunction = new nodejsLambda.NodejsFunction(this, 'CertGeneratorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, 'lambda', 'vpn-cert-generator.ts'),
      handler: 'handler',
      role: certGeneratorRole,
      timeout: cdk.Duration.seconds(60),
    });

    const certGeneratorProvider = new customResources.Provider(this, 'CertGeneratorProvider', {
      onEventHandler: certGeneratorFunction,
    });

    const certs = new cdk.CustomResource(this, 'VpnCerts', {
      serviceToken: certGeneratorProvider.serviceToken,
      properties: {
        clientProfileSecretArn: clientProfileSecret.secretArn,
      },
    });

    const serverCertificateArn = certs.getAttString('ServerCertificateArn');
    const clientCertificateArn = certs.getAttString('ClientCertificateArn');

    // Built from L1 constructs (CfnClientVpnEndpoint etc.), placed
    // directly in THIS stack, rather than via vpc.addClientVpnEndpoint()
    // -- that L2 helper attaches the endpoint construct onto the Vpc
    // object itself, which lives in ClaudeGatewayNetworkStack (since
    // props.vpc is a reference passed in from there). Since this
    // endpoint's clientCertificateArn depends on VpnCerts (a resource in
    // THIS stack), that would make NetworkStack depend on VpnStack while
    // VpnStack already depends on NetworkStack for the VPC -- a real
    // circular stack dependency, caught by `cdk synth` refusing to
    // proceed ("Adding this dependency would create a cyclic reference")
    // before ever reaching real AWS resources. Building the L1 constructs
    // directly in this stack, referencing the VPC/subnets only by their
    // plain string IDs (not by construct reference), avoids the
    // construct-tree attachment that caused the cycle.
    const clientVpnEndpoint = new ec2.CfnClientVpnEndpoint(this, 'ClientVpnEndpoint', {
      clientCidrBlock: '10.100.0.0/16',
      serverCertificateArn,
      authenticationOptions: [
        {
          type: 'certificate-authentication',
          mutualAuthentication: { clientRootCertificateChainArn: clientCertificateArn },
        },
      ],
      connectionLogOptions: { enabled: false },
      splitTunnel: true,
      transportProtocol: 'udp',
      vpcId: props.vpc.vpcId,
    });

    const associations = props.privateSubnets.map(
      (subnet, index) =>
        new ec2.CfnClientVpnTargetNetworkAssociation(this, `TargetNetworkAssociation${index}`, {
          clientVpnEndpointId: clientVpnEndpoint.ref,
          subnetId: subnet.subnetId,
        })
    );

    // Explicitly authorize connected clients to reach the VPC's own CIDR
    // -- creating target network associations does not implicitly
    // authorize traffic to them.
    const authorizationRule = new ec2.CfnClientVpnAuthorizationRule(this, 'AuthorizeVpcAccess', {
      clientVpnEndpointId: clientVpnEndpoint.ref,
      targetNetworkCidr: props.vpc.vpcCidrBlock,
      authorizeAllGroups: true,
    });
    authorizationRule.node.addDependency(associations[0]);

    // Assembles the final downloadable .ovpn file from the generated
    // certs plus the now-known real Client VPN endpoint DNS name, and
    // writes it back into the same secret alongside the raw certs -- a
    // second Custom Resource, since the endpoint's DNS name is only known
    // after `clientVpnEndpoint` itself is created, one step later than
    // when the certs were generated.
    const profileAssemblerRole = new iam.Role(this, 'ProfileAssemblerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    clientProfileSecret.grantRead(profileAssemblerRole);
    clientProfileSecret.grantWrite(profileAssemblerRole);

    const profileAssemblerFunction = new nodejsLambda.NodejsFunction(this, 'ProfileAssemblerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, 'lambda', 'vpn-profile-assembler.ts'),
      handler: 'handler',
      role: profileAssemblerRole,
      timeout: cdk.Duration.seconds(30),
    });

    const profileAssemblerProvider = new customResources.Provider(this, 'ProfileAssemblerProvider', {
      onEventHandler: profileAssemblerFunction,
    });

    const profile = new cdk.CustomResource(this, 'VpnProfile', {
      serviceToken: profileAssemblerProvider.serviceToken,
      properties: {
        clientProfileSecretArn: clientProfileSecret.secretArn,
        // AWS Client VPN endpoints have a deterministic DNS name --
        // {endpointId}.prod.clientvpn.{region}.amazonaws.com -- documented
        // by AWS and confirmed against the .ovpn profile AWS's own console
        // generates when you download a client configuration by hand.
        // There's no separate CDK/CloudFormation attribute exposing this
        // as a distinct value; it's always derived from the endpoint ID.
        endpointDnsName: `${clientVpnEndpoint.ref}.prod.clientvpn.${cdk.Aws.REGION}.amazonaws.com`,
      },
    });
    profile.node.addDependency(...associations);

    new cdk.CfnOutput(this, 'VpnClientProfileSecretArn', {
      value: clientProfileSecret.secretArn,
      description: 'Download the ready-to-import .ovpn profile with: aws secretsmanager get-secret-value --secret-id <this ARN> --query SecretString --output text | jq -r .ovpnProfile > claude-gateway-vpn-client.ovpn -- see docs/02-deploy.md.',
    });
    new cdk.CfnOutput(this, 'ClientVpnEndpointId', {
      value: clientVpnEndpoint.ref,
    });
  }
}
