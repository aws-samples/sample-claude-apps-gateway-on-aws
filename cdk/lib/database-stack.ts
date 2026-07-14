import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
  readonly databaseSecurityGroup: ec2.SecurityGroup;
}

/**
 * Aurora Serverless v2 PostgreSQL cluster backing the gateway's device-grant
 * store and (if spend limits are enabled) its spend tracking tables.
 *
 * Credential handling: rather than generating and holding a master password
 * ourselves, this lets `rds.DatabaseCluster` create and manage its own
 * credentials secret (the default behavior when no `credentials` are
 * supplied) -- CDK never sees or holds a plaintext password at synth time.
 *
 * The gateway's config file wants a single connection-string secret
 * (`postgres_url`), not separate host/port/user/password fields. Building
 * that string by concatenating `SecretValue`s with `Fn.join` and
 * `unsafeUnwrap()` is a real anti-pattern (the name is a warning, not a
 * suggestion) -- it can leak the secret value into the synthesized
 * CloudFormation template. Instead, a small Lambda-backed Custom Resource
 * runs once at deploy time, reads the RDS-managed secret's username and
 * password via `secretsmanager:GetSecretValue`, and writes the combined URL
 * into a second secret via `secretsmanager:PutSecretValue`. Neither value
 * ever appears in the CDK template or CloudFormation console.
 */
export class DatabaseStack extends cdk.Stack {
  public readonly cluster: rds.DatabaseCluster;
  public readonly postgresUrlSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const subnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
      vpc: props.vpc,
      description: 'Private subnets for the Claude gateway Aurora cluster',
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.cluster = new rds.DatabaseCluster(this, 'GatewayDatabase', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      vpc: props.vpc,
      subnetGroup,
      securityGroups: [props.databaseSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret('gateway'),
      defaultDatabaseName: 'claude_gateway',
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 4,
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      storageEncrypted: true,
      // This is a reference/sample deployment meant to be torn down easily;
      // production deployments should set this true and add a retained
      // final snapshot policy.
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Aurora Serverless v2 auto-pause isn't yet a first-class CDK prop on
    // ClusterInstance as of this CDK version, so it's set via an escape
    // hatch on the underlying CFN resource.
    const cfnCluster = this.cluster.node.defaultChild as rds.CfnDBCluster;
    cfnCluster.serverlessV2ScalingConfiguration = {
      minCapacity: 0,
      maxCapacity: 4,
      secondsUntilAutoPause: 1800,
    };

    // Placeholder secret; its real value is written by the Custom Resource
    // below immediately after the cluster becomes available. Creating it
    // here (rather than letting the Custom Resource create it) means CDK
    // owns its lifecycle -- deleted on stack teardown -- and other stacks
    // can reference it by construct before the Custom Resource has run.
    //
    // No explicit secretName -- see the comment in secrets-stack.ts for why
    // (name collisions with a pre-existing same-named secret cause a real
    // CREATE_FAILED, confirmed during this repo's own fresh-deploy test).
    this.postgresUrlSecret = new secretsmanager.Secret(this, 'PostgresUrlSecret', {
      description: "Full Postgres connection URL for the Claude apps gateway store, derived from the Aurora cluster's own managed credential secret by a deploy-time Custom Resource.",
      generateSecretString: {
        // Real value overwritten by the Custom Resource; this placeholder
        // just satisfies Secret's requirement that it hold some string.
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'placeholder',
      },
    });

    const combinerFunction = new lambda.Function(this, 'PostgresUrlCombinerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
        const { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
        const client = new SecretsManagerClient({});

        exports.handler = async (event) => {
          if (event.RequestType === 'Delete') {
            return { PhysicalResourceId: event.PhysicalResourceId };
          }

          const { clusterSecretArn, clusterEndpoint, clusterPort, databaseName, targetSecretArn } = event.ResourceProperties;

          const clusterSecretResp = await client.send(new GetSecretValueCommand({ SecretId: clusterSecretArn }));
          const { username, password } = JSON.parse(clusterSecretResp.SecretString);

          const url = \`postgresql://\${encodeURIComponent(username)}:\${encodeURIComponent(password)}@\${clusterEndpoint}:\${clusterPort}/\${databaseName}?sslmode=require\`;

          await client.send(new PutSecretValueCommand({ SecretId: targetSecretArn, SecretString: url }));

          return { PhysicalResourceId: \`postgres-url-combiner-\${targetSecretArn}\` };
        };
      `),
    });

    this.cluster.secret!.grantRead(combinerFunction);
    this.postgresUrlSecret.grantWrite(combinerFunction);

    const provider = new customResources.Provider(this, 'PostgresUrlCombinerProvider', {
      onEventHandler: combinerFunction,
    });

    new cdk.CustomResource(this, 'PostgresUrlCombiner', {
      serviceToken: provider.serviceToken,
      properties: {
        clusterSecretArn: this.cluster.secret!.secretArn,
        clusterEndpoint: this.cluster.clusterEndpoint.hostname,
        clusterPort: this.cluster.clusterEndpoint.port,
        databaseName: 'claude_gateway',
        targetSecretArn: this.postgresUrlSecret.secretArn,
        // Bump this whenever the cluster is replaced, so the Custom
        // Resource re-runs against the new endpoint/secret rather than
        // reusing a stale combined URL from a prior deployment.
        clusterResourceId: this.cluster.clusterResourceIdentifier,
      },
    }).node.addDependency(this.cluster);
  }
}
