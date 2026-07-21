import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejsLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';
import { GatewaySecrets } from './secrets-stack';

export interface GatewayStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
  readonly gatewayTaskSecurityGroup: ec2.SecurityGroup;
  readonly privateSubnets: ec2.ISubnet[];
  readonly oidcIssuer: string;
  readonly oidcClientId: string;
  readonly adminOktaGroupName: string;
  readonly secrets: GatewaySecrets;
  // Built by BuildMachineStack on a real Linux x86_64 EC2 instance, not
  // locally via DockerImageAsset -- see build-machine-stack.ts for why
  // this is required, not optional, for this particular Dockerfile.
  readonly gatewayImageUri: string;
}

/**
 * The Claude apps gateway itself, deployed as an ECS Express Mode service
 * on private subnets. Express Mode derives public-vs-private ingress from
 * the subnets' own routing, not an explicit flag -- placing this service on
 * subnets with no route to an internet gateway is what makes it provision
 * an INTERNAL Application Load Balancer, satisfying the deployment guide's
 * "deploy on your private network" requirement.
 *
 * Three IAM roles are required (confirmed empirically while building the
 * manual predecessor to this repo -- the blog-post-style deployment guide
 * this repo is based on only documents two, execution and task; Express
 * Mode's `create-express-gateway-service` API additionally requires an
 * INFRASTRUCTURE role, or the call fails outright):
 *   - executionRole: pulls the container image and injects the secrets
 *     listed in primaryContainer.secrets as environment variables.
 *   - taskRole: what the gateway PROCESS itself can call -- here, just
 *     bedrock:InvokeModel(WithResponseStream) on the Claude models.
 *   - infrastructureRole: what ECS Express Mode uses on your behalf to
 *     provision the ALB, target group, security groups, and autoscaling
 *     policy this service needs. Uses the AWS-managed policy
 *     AmazonECSInfrastructureRoleforExpressGatewayServices.
 */
export class GatewayStack extends cdk.Stack {
  public readonly serviceArn: string;
  public readonly endpoint: string;
  public readonly taskRoleArn: string;
  public readonly executionRoleArn: string;
  public readonly taskDefinitionFamily: string;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    const executionRole = new iam.Role(this, 'GatewayExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task execution role for the Claude gateway: pulls the image and injects secrets as environment variables',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    props.secrets.jwtSecret.grantRead(executionRole);
    props.secrets.oidcClientSecret.grantRead(executionRole);
    props.secrets.postgresUrl.grantRead(executionRole);
    props.secrets.adminWriteKey.grantRead(executionRole);

    const taskRole = new iam.Role(this, 'GatewayTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'What the gateway process itself can call: Bedrock model invocation only',
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvokeClaudeModels',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.anthropic.*`,
        `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/anthropic.*`,
      ],
    }));
    // Covers any custom Bedrock inference profile you add to gateway.yaml's
    // optional models: block (see docs/06-custom-inference-profile.md) --
    // most commonly an application inference profile created for cost
    // allocation, provisioned throughput, or a guardrail. Scoped to any
    // region (application inference profiles aren't region-restricted the
    // way the account is) but only this account's own profiles, using
    // cdk.Aws.ACCOUNT_ID rather than a hardcoded ID so this grant needs no
    // changes when you add, remove, or point a model at a different
    // profile in gateway.yaml -- only the YAML changes; IAM doesn't.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvokeCustomInferenceProfiles',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:bedrock:*:${cdk.Aws.ACCOUNT_ID}:application-inference-profile/*`,
        `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/anthropic.*`,
      ],
    }));

    const infrastructureRole = new iam.Role(this, 'GatewayInfrastructureRole', {
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
      description: 'Lets ECS Express Mode provision the ALB, target group, security groups, and autoscaling policy for the gateway service',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSInfrastructureRoleforExpressGatewayServices'),
      ],
    });

    const logGroup = new logs.LogGroup(this, 'GatewayLogGroup', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Express Mode's generated ingress hostname is unpredictable and known
    // only after the service is created -- it bears no relation to
    // serviceName. GATEWAY_PUBLIC_URL is set to a placeholder on creation
    // and corrected to the real value by a second update-express-gateway-
    // service call, made from a Custom Resource immediately after this
    // resource exists (see below) -- avoiding the manual two-pass "deploy,
    // note the URL, patch it in by hand" step the predecessor to this repo
    // required.
    // No fixed serviceName here -- an earlier draft hardcoded "claude-gateway",
    // which collided with a pre-existing ECS Express Mode service of the
    // same name in the same account/region (confirmed the hard way during
    // this repo's own fresh-deploy test, which hit exactly this collision
    // against an unrelated prior manual deployment). Deriving the name from
    // the stack name keeps it unique per deployment without a user-supplied
    // parameter, and ECS Express Mode's task-definition family name is
    // always `default-${serviceName}` (confirmed via
    // `list-task-definition-families` against a real deployment), so this
    // one value drives both the service name and every IAM policy below
    // that needs to reference the resulting task-definition family --
    // no second hardcoded literal to keep in sync.
    const serviceName = `${cdk.Stack.of(this).stackName.toLowerCase()}-gateway`;
    this.taskDefinitionFamily = `default-${serviceName}`;

    const service = new ecs.CfnExpressGatewayService(this, 'GatewayService', {
      serviceName,
      executionRoleArn: executionRole.roleArn,
      taskRoleArn: taskRole.roleArn,
      infrastructureRoleArn: infrastructureRole.roleArn,
      cpu: '1024',
      memory: '2048',
      healthCheckPath: '/healthz',
      networkConfiguration: {
        subnets: props.privateSubnets.map((s) => s.subnetId),
        securityGroups: [props.gatewayTaskSecurityGroup.securityGroupId],
      },
      scalingTarget: {
        minTaskCount: 1,
        maxTaskCount: 2,
        autoScalingMetric: 'AVERAGE_CPU',
        autoScalingTargetValue: 60,
      },
      primaryContainer: {
        image: props.gatewayImageUri,
        containerPort: 8080,
        awsLogsConfiguration: {
          logGroup: logGroup.logGroupName,
          logStreamPrefix: 'ecs',
        },
        environment: [
          // Placeholder; corrected in place by the Custom Resource below
          // once the real endpoint is known.
          { name: 'GATEWAY_PUBLIC_URL', value: 'https://placeholder.invalid' },
          { name: 'OIDC_ISSUER', value: props.oidcIssuer },
          { name: 'OIDC_CLIENT_ID', value: props.oidcClientId },
          { name: 'ADMIN_OKTA_GROUP_NAME', value: props.adminOktaGroupName },
          { name: 'AWS_REGION', value: cdk.Aws.REGION },
          // All three catalog models enabled by default. Change this list
          // via the admin console's "Available models" page after deploy --
          // no image rebuild required; see gateway/entrypoint.sh and
          // docs/04-admin-console-guide.md for how this works.
          { name: 'AVAILABLE_MODELS_RAW', value: '[claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5]' },
        ],
        secrets: [
          { name: 'OIDC_CLIENT_SECRET', valueFrom: props.secrets.oidcClientSecret.secretArn },
          { name: 'GATEWAY_JWT_SECRET', valueFrom: props.secrets.jwtSecret.secretArn },
          { name: 'GATEWAY_POSTGRES_URL', valueFrom: props.secrets.postgresUrl.secretArn },
          { name: 'GATEWAY_ADMIN_WRITE_KEY', valueFrom: props.secrets.adminWriteKey.secretArn },
        ],
      },
    });

    this.serviceArn = service.attrServiceArn;
    this.endpoint = service.attrEndpoint;
    this.taskRoleArn = taskRole.roleArn;
    this.executionRoleArn = executionRole.roleArn;

    // Second-pass correction: now that `service.attrEndpoint` is known,
    // patch GATEWAY_PUBLIC_URL to the real value with an
    // update-express-gateway-service call from a Custom Resource. This
    // resource depends on `service`, so CloudFormation always creates the
    // gateway (and learns its endpoint) first, then runs this correction.
    const urlFixerRole = new iam.Role(this, 'GatewayUrlFixerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    urlFixerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateExpressGatewayService', 'ecs:DescribeExpressGatewayService'],
      resources: [service.attrServiceArn],
    }));
    urlFixerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RegisterTaskDefinition'],
      resources: [`arn:${cdk.Aws.PARTITION}:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task-definition/${this.taskDefinitionFamily}:*`],
    }));
    urlFixerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTaskDefinition'],
      resources: ['*'],
    }));
    urlFixerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskRole.roleArn, executionRole.roleArn],
    }));

    const urlFixerFunction = new nodejsLambda.NodejsFunction(this, 'GatewayUrlFixerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, 'lambda', 'gateway-url-fixer.ts'),
      handler: 'handler',
      role: urlFixerRole,
      timeout: cdk.Duration.seconds(60),
      bundling: {
        // Bundle a real, current @aws-sdk/client-ecs from this project's
        // own node_modules rather than relying on the Lambda Node.js
        // runtime's own pre-bundled AWS SDK v3 -- confirmed the hard way
        // that the runtime's bundled version predates
        // DescribeExpressGatewayServiceCommand/UpdateExpressGatewayServiceCommand
        // (ECS Express Mode is too new for it), which made an earlier
        // Code.fromInline draft fail immediately with
        // "DescribeExpressGatewayServiceCommand is not a constructor".
        externalModules: [],
      },
    });

    const urlFixerProvider = new customResources.Provider(this, 'GatewayUrlFixerProvider', {
      onEventHandler: urlFixerFunction,
    });

    new cdk.CustomResource(this, 'GatewayUrlFixer', {
      serviceToken: urlFixerProvider.serviceToken,
      properties: {
        serviceArn: service.attrServiceArn,
        realPublicUrl: cdk.Fn.sub('https://${Endpoint}', { Endpoint: service.attrEndpoint }),
        // Forces this custom resource to re-run on every deploy, not just
        // when serviceArn/realPublicUrl themselves change (they don't --
        // Express Mode's endpoint hostname is stable across redeploys).
        // Without this, a redeploy that only changes the container image
        // (e.g. rebuilding after a Dockerfile fix) has CloudFormation
        // re-apply this stack's own CfnExpressGatewayService definition --
        // which still has the literal "https://placeholder.invalid" baked
        // into its template -- and since this custom resource's own
        // properties are unchanged, CloudFormation skips re-invoking it,
        // leaving the placeholder live and unpatched. Confirmed the hard
        // way: a redeploy left GATEWAY_PUBLIC_URL as the placeholder and
        // broke sign-in, even though the original deploy had patched it
        // correctly.
        deployTrigger: Date.now().toString(),
      },
    }).node.addDependency(service);

    new cdk.CfnOutput(this, 'GatewayEndpoint', {
      value: `https://${service.attrEndpoint}`,
      description: "The gateway's real, unpredictable ECS Express Mode ingress hostname. Set forceLoginGatewayUrl to this in managed-settings.json on developer machines (see docs/03-verify.md).",
    });
    new cdk.CfnOutput(this, 'GatewayServiceArn', {
      value: service.attrServiceArn,
    });

    // Also expose OIDC issuer/client ID and the admin group name as stack
    // outputs purely for operator convenience when cross-checking against
    // the Okta app registration -- these aren't secrets.
    new cdk.CfnOutput(this, 'OidcIssuer', { value: props.oidcIssuer });
    new cdk.CfnOutput(this, 'AdminOktaGroupName', { value: props.adminOktaGroupName });
  }
}
