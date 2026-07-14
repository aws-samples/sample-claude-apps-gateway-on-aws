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
 * Patches the admin console's PUBLIC_URL environment variable to its
 * real, now-known ECS Express Mode endpoint. Same pattern and same fix
 * as lib/lambda/gateway-url-fixer.ts -- see that file's comment for why
 * this is bundled via NodejsFunction rather than lambda.Code.fromInline.
 */
export const handler = async (event: CloudFormationCustomResourceEvent) => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const { serviceArn, realPublicUrl } = event.ResourceProperties;

  const described = await client.send(new DescribeExpressGatewayServiceCommand({ serviceArn }));
  const current = described.service?.activeConfigurations?.[0]?.primaryContainer;
  if (!current) {
    throw new Error('Admin console service has no active configuration to patch.');
  }

  const environment = (current.environment ?? []).map((e) =>
    e.name === 'PUBLIC_URL' ? { name: e.name, value: realPublicUrl } : e
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

  return { PhysicalResourceId: `admin-console-url-fixer-${serviceArn}` };
};
