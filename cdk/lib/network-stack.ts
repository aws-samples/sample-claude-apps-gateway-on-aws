import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Networking for the Claude apps gateway reference architecture.
 *
 * Creates a dedicated VPC (not the account's default VPC -- more portable
 * for a public sample, since not every account has one) with:
 *   - 2 private subnets (with egress via NAT Gateway) for the gateway itself.
 *     Placing the gateway here, with no direct route to an internet gateway,
 *     is what makes ECS Express Mode provision an INTERNAL Application Load
 *     Balancer for it -- confirmed empirically: Express Mode derives public
 *     vs. private ingress from the subnets' own routing, not an explicit
 *     flag. This matches the deployment guide's "deploy on your private
 *     network" requirement for the gateway.
 *   - 2 public subnets for the admin console, which is deliberately public
 *     (gated by Okta group membership, not network placement -- see
 *     admin-console-stack.ts and the design notes in the docs).
 *   - A managed NAT Gateway (one, in the first public subnet) for the
 *     private subnets' egress. The original manual deployment this repo is
 *     based on used a self-managed NAT EC2 instance to cut cost; this public
 *     version uses a standard NAT Gateway instead, trading a few dollars a
 *     month for one less moving part to operate. See docs/02-deploy.md for
 *     the cost note.
 *   - VPC interface endpoints for bedrock-runtime and secretsmanager, so
 *     the gateway's calls to Bedrock and Secrets Manager stay on the AWS
 *     network without needing the NAT Gateway for those two services.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly gatewayTaskSecurityGroup: ec2.SecurityGroup;
  public readonly adminConsoleSecurityGroup: ec2.SecurityGroup;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    this.privateSubnets = this.vpc.privateSubnets;
    this.publicSubnets = this.vpc.publicSubnets;

    // --- Security groups ---

    this.gatewayTaskSecurityGroup = new ec2.SecurityGroup(this, 'GatewayTaskSecurityGroup', {
      vpc: this.vpc,
      description: 'SG for the Claude gateway ECS Express Mode Fargate task (outbound to Aurora, Bedrock, Secrets Manager)',
      allowAllOutbound: true,
    });

    this.adminConsoleSecurityGroup = new ec2.SecurityGroup(this, 'AdminConsoleSecurityGroup', {
      vpc: this.vpc,
      description: 'SG for the admin console ECS Express Mode Fargate task (outbound to the gateway and AWS APIs)',
      allowAllOutbound: true,
    });

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'SG for the Aurora Serverless v2 cluster backing the gateway',
      allowAllOutbound: true,
    });
    this.databaseSecurityGroup.addIngressRule(
      this.gatewayTaskSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow the gateway task to reach Postgres',
    );

    // --- VPC interface endpoints ---
    // Both live in the private subnets, reachable only from inside the VPC.

    const vpcEndpointSecurityGroup = new ec2.SecurityGroup(this, 'VpcEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'SG for VPC interface endpoints (bedrock-runtime, secretsmanager)',
      allowAllOutbound: true,
    });
    vpcEndpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS from within the VPC',
    );

    this.vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${cdk.Stack.of(this).region}.bedrock-runtime`),
      subnets: { subnets: this.privateSubnets },
      securityGroups: [vpcEndpointSecurityGroup],
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnets: this.privateSubnets },
      securityGroups: [vpcEndpointSecurityGroup],
      privateDnsEnabled: true,
    });
  }
}
