# 5. Cleanup

## Tear down the stacks

```bash
cd cdk
npx cdk destroy --all \
  -c oidcIssuer=https://your-org.okta.com \
  -c oidcClientId=0oaXXXXXXXXXXXXXXXXX \
  -c adminOktaGroupName=claude-gateway-admins
```

The context values must match what you deployed with (CDK uses them to re-synthesize the same stacks before destroying them). Confirm each stack's deletion when prompted.

This deletes, in reverse dependency order: both ECS Express Mode services (and the load balancers, target groups, and security groups Express Mode created for them), the Aurora Serverless v2 cluster, all five generated Secrets Manager secrets, and the VPC (NAT Gateway, subnets, interface endpoints).

## What `cdk destroy` does not clean up

- **ECR repositories and their images.** `DockerImageAsset` creates a shared CDK bootstrap ECR repository (`cdk-hnb659fds-container-assets-<account>-<region>`) that isn't tied to these stacks' lifecycle — it may be used by other CDK apps in the same account/region too. It is not deleted by `cdk destroy`. If you want to remove the images from this deployment, either delete the specific image tags manually or leave it — a [lifecycle policy](https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html) to expire untagged/old images automatically is a reasonable alternative to manual cleanup if you deploy this repeatedly.
- **CloudWatch Logs data.** Log groups are deleted (they're managed by the stacks with `RemovalPolicy.DESTROY`), but if you want to review logs after tearing down, export them first.
- **Your Okta application and group.** These are outside AWS and untouched by `cdk destroy`. Delete the Okta app registration and admin group yourself if you no longer need them.

## Verify nothing is left running

```bash
aws cloudformation list-stacks --region <your-region> \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED \
  --query "StackSummaries[?starts_with(StackName,'ClaudeGateway')].{Name:StackName,Status:StackStatus}"
```

An empty result confirms all seven stacks are gone. If any show `DELETE_FAILED`, check the stack's events in the CloudFormation console for the specific resource that failed to delete (most commonly: a security group still referenced by another resource, or a non-empty S3 bucket if you've customized this template to add one) and retry `cdk destroy` after resolving it.
