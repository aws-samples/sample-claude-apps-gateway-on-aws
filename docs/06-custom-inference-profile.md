# 6. Routing a model through a custom inference profile

By default, every model routes through the built-in cross-region inference profile (`us.anthropic.*`) that `auto_include_builtin_models: true` in `gateway/gateway.yaml` gives you automatically. This page covers the optional case: pointing one or more specific models at a **custom Bedrock inference profile** instead — most commonly an [application inference profile](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference-profiles-support.html) you created for cost allocation/tracking, a provisioned-throughput allotment, or a guardrail attached to that profile.

You can route as many or as few models this way as you like — each model is an independent entry, and each can point at a different custom profile. Anything you don't explicitly list keeps using the default `us.anthropic.*` profile, untouched.

## What you need before starting

- The custom inference profile's full ARN, e.g. `arn:aws:bedrock:us-east-2:111111111111:application-inference-profile/abc123`. Get this from the Bedrock console (**Inference and Assessment → Cross-region inference** or **Application inference profiles**) or `aws bedrock list-inference-profiles` / `aws bedrock list-application-inference-profiles`.
- The **gateway-canonical model ID** you want to route through it — e.g. `claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5`. This is the short ID the gateway and the admin console's model-access page both use; it's what you'd already see in `AVAILABLE_MODELS_RAW` (`gateway-stack.ts`) if the model is already enabled.
- Confirmed [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) for the underlying model in whichever region the profile lives.

The profile can live in a different region than the one you deploy this stack to — Bedrock allows invoking a profile ARN from a client configured against a different region.

## Step 1: Add the model to `gateway/gateway.yaml`

Open `gateway/gateway.yaml` and find the commented `models:` example just below `auto_include_builtin_models: true`. Uncomment it and fill in your own values:

```yaml
auto_include_builtin_models: true

models:
  - id: claude-sonnet-5
    label: Claude Sonnet 5 (custom inference profile)
    upstream_model:
      bedrock: arn:aws:bedrock:us-east-2:111111111111:application-inference-profile/abc123
```

To route a second model through a different profile, add another list entry:

```yaml
models:
  - id: claude-sonnet-5
    label: Claude Sonnet 5 (custom inference profile)
    upstream_model:
      bedrock: arn:aws:bedrock:us-east-2:111111111111:application-inference-profile/abc123
  - id: claude-opus-4-8
    label: Claude Opus 4.8 (custom inference profile)
    upstream_model:
      bedrock: arn:aws:bedrock:us-east-2:111111111111:application-inference-profile/def456
```

Notes on the syntax:

- The `upstream_model` key (`bedrock:` in both examples) must match the `name:` of the entry in `upstreams:` above it. This repo's default `upstreams:` entry has no explicit `name:`, so it defaults to its provider string, `bedrock` — leave the key as `bedrock` unless you've also added a `name:` to that upstream.
- `id:` is the gateway-canonical model ID developers and the admin console will refer to. It does not need to match any part of the ARN.
- This is a static, plain-YAML list — no environment variables and no CDK context flags are involved in this file. Each entry is a one-time edit you make before building the image.

## Step 2: Enable the model in the allow-list, if it isn't already

`models:` controls *where a request for this model ID goes*; it doesn't put the model ID in front of developers. Separately, the model ID must be in the gateway's `availableModels` allow-list (`AVAILABLE_MODELS_RAW` in `cdk/lib/gateway-stack.ts`, or the admin console's **Models** page after deploy — see [04-admin-console-guide.md](04-admin-console-guide.md)) or requests for it will be rejected with `400` regardless of the `models:` entry.

If the model you're routing (e.g. `claude-sonnet-5`) is already in your enabled catalog, there's nothing to do here. If it isn't, add it either:

- Before first deploy, in `cdk/lib/gateway-stack.ts`'s `AVAILABLE_MODELS_RAW` env var, or
- After deploy, via the admin console's **Models** page (no image rebuild needed for this step — see [04-admin-console-guide.md](04-admin-console-guide.md) for why).

## Step 3: IAM — nothing to add, if you're on the current version of this repo

`cdk/lib/gateway-stack.ts` already grants the gateway's task role `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` on **any application inference profile in your AWS account**, in any region:

```typescript
taskRole.addToPolicy(new iam.PolicyStatement({
  sid: 'BedrockInvokeCustomInferenceProfiles',
  actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  resources: [
    `arn:${cdk.Aws.PARTITION}:bedrock:*:${cdk.Aws.ACCOUNT_ID}:application-inference-profile/*`,
    `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/anthropic.*`,
  ],
}));
```

`cdk.Aws.ACCOUNT_ID` resolves to your deploying account automatically at synth/deploy time — this isn't a placeholder you fill in. That's deliberate: because the grant is scoped to "any profile in this account" rather than one specific profile ARN, adding, removing, or repointing model entries in Step 1 later **never requires touching IAM again** — only `gateway.yaml` changes.

If your custom inference profile lives in a **different AWS account** than the one this stack deploys into, this grant does not cover it — you'd need to add a separate statement naming that account's specific profile ARN, and that account would also need to grant your gateway's task role cross-account access to the profile. That's outside the scope of this reference deployment; the common case (profile in the same account, possibly a different region) needs no extra IAM work.

## Step 4: Rebuild and redeploy

`gateway.yaml` is baked into the gateway's container image at build time (`gateway/Dockerfile`), so a `models:` change requires an image rebuild — unlike the model *allow-list*, which is a plain environment variable (see Step 2). Redeploy the build machine and gateway stacks:

```bash
cd cdk
npx cdk deploy ClaudeGatewayBuildMachineStack ClaudeGatewayStack \
  -c oidcIssuer=https://your-org.okta.com \
  -c oidcClientId=0oaXXXXXXXXXXXXXXXXX \
  -c oidcClientSecret="<your Okta app's client secret>" \
  -c adminOktaGroupName=claude-gateway-admins
```

(Or `cdk deploy --all` with the same context values, if you'd rather redeploy everything.)

CDK will show an IAM Statement Changes prompt for the new `BedrockInvokeCustomInferenceProfiles` statement the first time you deploy this — review and accept it. This provisions a fresh build-machine EC2 instance that rebuilds and pushes the gateway image with your updated `gateway.yaml` baked in, then rolls the ECS Express Mode service to the new image. See [02-deploy.md](02-deploy.md) for what to expect timing-wise.

## Verifying it worked

This is the exact sequence used to confirm this feature works end to end; each step is independent evidence, so use as many as you need for your own confidence level.

**1. Gateway boot log.** Tail the gateway's CloudWatch log group (`ClaudeGatewayStack-GatewayLogGroup...`, see the `GatewayEndpoint`/log group name in stack outputs) right after a new task starts. A successful load of your `models:` block shows up as a spend-meter warning naming your ARN, e.g.:

```
warn spend meter has no exact rates for claude-sonnet-5 (arn:aws:bedrock:...:application-inference-profile/abc123) — these will be metered at the unknown-model default tier
```

This is expected and harmless — it means the gateway parsed your custom ARN, not that something is broken. It does **not** mean spend isn't tracked; see the note below.

**2. Live inference request log.** After signing in via the VPN (see [03-verify.md](03-verify.md) or [trying-out-a-deployed-gateway.md](trying-out-a-deployed-gateway.md)) and sending a request for the model, the same log group shows:

```json
{"evt":"inference","model":"claude-sonnet-5","upstream":"bedrock","status":200,...}
```

`status: 200` confirms the call succeeded through this path.

**3. Amazon Bedrock's own invocation log** (if you have [model invocation logging](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html) enabled) is the strongest confirmation, because it's independent of anything the gateway reports about itself — it's what Bedrock's own control plane recorded receiving:

```json
{
  "operation": "InvokeModelWithResponseStream",
  "modelId": "arn:aws:bedrock:us-east-2:111111111111:application-inference-profile/abc123",
  "output": { "outputBodyJson": [{ "message": { "model": "claude-sonnet-5", ... } }] }
}
```

A request for a model you did **not** add to `models:` shows the default profile ARN instead (`arn:...:inference-profile/us.anthropic.claude-sonnet-4-6` for example) in the same log — useful as a side-by-side check that only the models you listed are affected.

**4. Effective spend dashboard.** Despite the "unknown-model default tier" boot warning in step 1, usage against a custom-profile model does show up correctly in the admin console's spend dashboard (`/spend/dashboard`, see [04-admin-console-guide.md](04-admin-console-guide.md)) — confirmed empirically. The warning affects the gateway's *internal* per-token rate table, not whether usage against the model is tracked at all.

## Troubleshooting

- **`AccessDeniedException` on `bedrock:InvokeModel`**: almost always means the redeploy in Step 4 hasn't happened yet (the running task is still on the old image/IAM policy), or the custom profile is in a different AWS account than this stack deploys into (see the cross-account note in Step 3).
- **`400` rejecting the model at `/v1/messages`**: the model ID is in `models:` but not in `AVAILABLE_MODELS_RAW` / the admin console's enabled list — see Step 2.
- **Gateway fails to boot / config validation error naming `models`**: check the YAML indentation matches the example exactly, and that every `id:` in the list is unique.
