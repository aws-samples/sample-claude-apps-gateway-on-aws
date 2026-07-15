import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejsLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

export interface AdminConsoleStackProps extends cdk.StackProps {
  readonly vpc: ec2.Vpc;
  readonly adminConsoleSecurityGroup: ec2.SecurityGroup;
  readonly publicSubnets: ec2.ISubnet[];
  readonly gatewayServiceArn: string;
  readonly gatewayEndpoint: string;
  readonly gatewayTaskRoleArn: string;
  readonly gatewayExecutionRoleArn: string;
  readonly gatewayTaskDefinitionFamily: string;
  readonly sessionSecret: secretsmanager.Secret;
  // Built by BuildMachineStack on a real Linux x86_64 EC2 instance -- see
  // build-machine-stack.ts and gateway-stack.ts's gatewayImageUri comment.
  readonly adminConsoleImageUri: string;
}

/**
 * The admin console: spend-limit management and model-access management,
 * deployed as its own ECS Express Mode service, deliberately on PUBLIC
 * subnets -- unlike the gateway itself, which is private. This is a
 * conscious choice, not an oversight: the console is gated by Okta group
 * membership (checked by the gateway itself on every admin API call, via
 * `admin.admin_groups` in gateway.yaml), not by network placement, and
 * being publicly reachable means an admin doesn't need VPN/private-network
 * access just to manage spend limits or the model catalog. Every gateway
 * API call the console makes uses the signed-in admin's own gateway-issued
 * bearer token (obtained via the gateway's device-authorization flow, the
 * same one the CLI uses), so every spend-limit change audits as
 * `oidc:<sub>` in the gateway's own audit log -- the console itself holds
 * no gateway admin credential of its own.
 *
 * Model-access management is the one exception: since the gateway has no
 * runtime admin API for its model catalog (`availableModels` only exists
 * as a line in gateway.yaml), the console manages it by calling
 * `ecs:UpdateExpressGatewayService` on the GATEWAY's own ECS service
 * directly, using the console's own IAM task role rather than a gateway
 * bearer token. This means model-catalog changes are NOT part of the
 * gateway's own audit trail (only visible in AWS CloudTrail, attributed to
 * this task role) -- a real, documented difference in auditability between
 * the two admin features. See docs/04-admin-console-guide.md.
 */
export class AdminConsoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AdminConsoleStackProps) {
    super(scope, id, props);

    const executionRole = new iam.Role(this, 'AdminConsoleExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task execution role for the admin console: pulls the image and injects the session secret',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    props.sessionSecret.grantRead(executionRole);

    // Scoped to exactly what model-access management needs: describe/update
    // the gateway's OWN service, register a task definition revision under
    // that service's own family (UpdateExpressGatewayService registers a
    // new task definition revision internally -- ecs:RegisterTaskDefinition
    // is required or the call fails with AccessDenied, confirmed the hard
    // way while building this), PassRole on the gateway's own two roles
    // (also required by RegisterTaskDefinition), and read-only access to
    // the Bedrock model catalog so the console can show the full live list
    // of available models rather than a hardcoded one.
    //
    // Deliberately NOT granted: any Secrets Manager access to the gateway's
    // secrets, any SSM/ECR/docker-build permissions. An earlier design
    // considered having the console trigger a full image rebuild per model
    // change; that was abandoned once it was confirmed the gateway's own
    // ${VAR} templating can't populate a YAML list, but a shell-level `sed`
    // substitution in the container's own entrypoint (see
    // gateway/entrypoint.sh) can -- so a model-catalog change is a plain ECS
    // environment-variable update, with no image rebuild and no additional
    // permissions beyond what's below.
    const taskRole = new iam.Role(this, 'AdminConsoleTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Lets the admin console manage the gateway\'s model catalog via ECS parameters; holds no gateway credential',
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ManageGatewayModelConfig',
      actions: ['ecs:UpdateExpressGatewayService', 'ecs:DescribeExpressGatewayService'],
      resources: [props.gatewayServiceArn],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RegisterGatewayTaskDefinition',
      actions: ['ecs:RegisterTaskDefinition'],
      resources: [`arn:${cdk.Aws.PARTITION}:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task-definition/${props.gatewayTaskDefinitionFamily}:*`],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DescribeGatewayTaskDefinition',
      // ecs:DescribeTaskDefinition does not support resource-level
      // restriction -- confirmed via IAM policy simulator that scoping this
      // to a specific task-definition ARN silently evaluates to
      // implicitDeny even with a matching statement present.
      actions: ['ecs:DescribeTaskDefinition'],
      resources: ['*'],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassGatewayRoles',
      actions: ['iam:PassRole'],
      // These must be the gateway's REAL, CDK-generated role ARNs (passed
      // in as props from gateway-stack.ts), not a guessed/hardcoded literal
      // role name -- an earlier draft hardcoded "claude-gateway-ecs-task-role"
      // etc., names that only existed in an unrelated prior manual
      // deployment, never in this stack. RegisterTaskDefinition would have
      // failed on iam:PassRole against those nonexistent ARNs the first
      // time an admin tried to change the model catalog.
      resources: [props.gatewayTaskRoleArn, props.gatewayExecutionRoleArn],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadBedrockCatalog',
      actions: ['bedrock:ListFoundationModels'],
      resources: ['*'],
    }));

    const infrastructureRole = new iam.Role(this, 'AdminConsoleInfrastructureRole', {
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
      description: 'Lets ECS Express Mode provision the ALB, target group, security groups, and autoscaling policy for the admin console service',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSInfrastructureRoleforExpressGatewayServices'),
      ],
    });

    const logGroup = new logs.LogGroup(this, 'AdminConsoleLogGroup', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Same collision concern as gateway-stack.ts's own serviceName -- an
    // earlier draft hardcoded "claude-gateway-admin-console", which
    // collided with a pre-existing service of that name from an unrelated
    // prior manual deployment. Derived from the stack name for uniqueness.
    const consoleServiceName = `${cdk.Stack.of(this).stackName.toLowerCase()}-console`;
    const consoleTaskDefinitionFamily = `default-${consoleServiceName}`;

    const service = new ecs.CfnExpressGatewayService(this, 'AdminConsoleService', {
      serviceName: consoleServiceName,
      executionRoleArn: executionRole.roleArn,
      taskRoleArn: taskRole.roleArn,
      infrastructureRoleArn: infrastructureRole.roleArn,
      cpu: '1024',
      memory: '2048',
      healthCheckPath: '/healthz',
      networkConfiguration: {
        subnets: props.publicSubnets.map((s) => s.subnetId),
        securityGroups: [props.adminConsoleSecurityGroup.securityGroupId],
      },
      scalingTarget: {
        minTaskCount: 1,
        maxTaskCount: 2,
        autoScalingMetric: 'AVERAGE_CPU',
        autoScalingTargetValue: 60,
      },
      primaryContainer: {
        image: props.adminConsoleImageUri,
        containerPort: 8080,
        awsLogsConfiguration: {
          logGroup: logGroup.logGroupName,
          logStreamPrefix: 'ecs',
        },
        environment: [
          // Placeholder; corrected the same way as the gateway's own
          // GATEWAY_PUBLIC_URL -- see the Custom Resource below.
          { name: 'PUBLIC_URL', value: 'https://placeholder.invalid' },
          { name: 'GATEWAY_BASE_URL', value: `https://${props.gatewayEndpoint}` },
          { name: 'GATEWAY_SERVICE_ARN', value: props.gatewayServiceArn },
          { name: 'AWS_REGION', value: cdk.Aws.REGION },
        ],
        secrets: [
          { name: 'SESSION_SECRET_KEY', valueFrom: props.sessionSecret.secretArn },
        ],
      },
    });

    // Second-pass correction for the console's own PUBLIC_URL, same pattern
    // as the gateway's GATEWAY_PUBLIC_URL fix in gateway-stack.ts.
    const urlFixerRole = new iam.Role(this, 'AdminConsoleUrlFixerRole', {
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
      resources: [`arn:${cdk.Aws.PARTITION}:ecs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:task-definition/${consoleTaskDefinitionFamily}:*`],
    }));
    urlFixerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTaskDefinition'],
      resources: ['*'],
    }));
    urlFixerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskRole.roleArn, executionRole.roleArn],
    }));

    const urlFixerFunction = new nodejsLambda.NodejsFunction(this, 'AdminConsoleUrlFixerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, 'lambda', 'admin-console-url-fixer.ts'),
      handler: 'handler',
      role: urlFixerRole,
      timeout: cdk.Duration.seconds(60),
      bundling: {
        // Same fix as gateway-stack.ts's GatewayUrlFixerFunction -- see
        // lib/lambda/gateway-url-fixer.ts's comment for why this must be
        // a NodejsFunction bundling a real, current @aws-sdk/client-ecs
        // rather than lambda.Code.fromInline relying on the runtime's own
        // pre-bundled (too old) SDK.
        externalModules: [],
      },
    });

    const urlFixerProvider = new customResources.Provider(this, 'AdminConsoleUrlFixerProvider', {
      onEventHandler: urlFixerFunction,
    });

    new cdk.CustomResource(this, 'AdminConsoleUrlFixer', {
      serviceToken: urlFixerProvider.serviceToken,
      properties: {
        serviceArn: service.attrServiceArn,
        realPublicUrl: cdk.Fn.sub('https://${Endpoint}', { Endpoint: service.attrEndpoint }),
        // Forces this custom resource to re-run on every deploy -- see the
        // matching comment in gateway-stack.ts's GatewayUrlFixer for why
        // this is required, not optional, on redeploys that only change
        // the container image.
        deployTrigger: Date.now().toString(),
      },
    }).node.addDependency(service);

    new cdk.CfnOutput(this, 'AdminConsoleEndpoint', {
      value: `https://${service.attrEndpoint}`,
      description: 'The admin console URL. Publicly reachable; access is gated by Okta group membership, not network placement.',
    });
  }
}
