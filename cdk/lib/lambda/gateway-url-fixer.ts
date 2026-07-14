import {
  ECSClient,
  DescribeExpressGatewayServiceCommand,
  UpdateExpressGatewayServiceCommand,
} from '@aws-sdk/client-ecs';

const client = new ECSClient({});

interface ResourceProperties {
  serviceArn: string;
  realPublicUrl: string;
}

interface CloudFormationCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: ResourceProperties;
}

/**
 * Patches the gateway's GATEWAY_PUBLIC_URL environment variable to its
 * real, now-known ECS Express Mode endpoint, once the service exists.
 *
 * Bundled as a real TypeScript file via NodejsFunction (esbuild), pulling
 * an explicit, current @aws-sdk/client-ecs from this project's own
 * node_modules -- NOT relying on the Lambda Node.js runtime's own
 * pre-bundled AWS SDK v3, which does not yet include the
 * DescribeExpressGatewayServiceCommand/UpdateExpressGatewayServiceCommand
 * exports (ECS Express Mode is new enough that the AWS-managed runtime's
 * bundled SDK version predates it). Confirmed the hard way: an earlier
 * draft used `lambda.Code.fromInline` with the same commands, which
 * resolved against the runtime's own SDK and failed immediately with
 * "DescribeExpressGatewayServiceCommand is not a constructor".
 */
export const handler = async (event: CloudFormationCustomResourceEvent) => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const { serviceArn, realPublicUrl } = event.ResourceProperties;

  const described = await client.send(new DescribeExpressGatewayServiceCommand({ serviceArn }));
  const current = described.service?.activeConfigurations?.[0]?.primaryContainer;
  if (!current) {
    throw new Error('Gateway service has no active configuration to patch.');
  }

  const environment = (current.environment ?? []).map((e) =>
    e.name === 'GATEWAY_PUBLIC_URL' ? { name: e.name, value: realPublicUrl } : e
  );

  await client.send(
    new UpdateExpressGatewayServiceCommand({
      serviceArn,
      primaryContainer: {
        image: current.image,
        containerPort: current.containerPort,
        environment,
        secrets: current.secrets,
      },
    })
  );

  return { PhysicalResourceId: `gateway-url-fixer-${serviceArn}` };
};
