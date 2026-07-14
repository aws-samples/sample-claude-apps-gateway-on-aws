# 4. Admin console guide

The admin console has three functions: an effective-spend dashboard, spend-limit management, and model-access management. This page covers how to use each, and — importantly — how their underlying mechanisms differ, since that difference affects auditability.

## Spend dashboard and limits

**Dashboard** (`/spend/dashboard`) shows effective spend per scope (organization, RBAC group, or user) for the selected period, read live from the gateway's own `/v1/organizations/effective` API.

**Limits** (`/spend/limits`) lets you create, list, and delete spend caps, scoped to the whole organization, an RBAC group, or an individual user. Each cap has an amount and a period (`daily`, `weekly`, or `monthly`).

Every action here — create or delete — is a direct call to the gateway's own admin API (`/v1/organizations/spend_limits`), authenticated with **the signed-in admin's own gateway-issued bearer token** (obtained via the same device-authorization flow the Claude Code CLI itself uses to sign developers in). The console holds no static admin credential for this. As a result:

- Every spend-limit change is recorded in the gateway's own audit log, attributed to `oidc:<the admin's Okta subject>`.
- If the admin's Okta group membership is revoked, their existing browser session stops being able to make these calls the next time the gateway checks — there's no separate credential to revoke.

## Model access

**Models** (`/models`) shows the full, live Anthropic model catalog from Amazon Bedrock for your region — not a hardcoded list — each one marked as currently enabled or disabled on your gateway.

Select the models you want available to developers and click **Apply changes**. This is a deliberate batch action, not a per-model instant toggle: applying a change triggers a real gateway redeployment (a new ECS task with the updated environment variable), so batching multiple selections into one apply avoids multiple unnecessary redeploys. The page shows "Applying..." while the new task starts and the old one drains, then flips to "Active" once settled (usually under two minutes).

### Why this works without rebuilding the container image

The gateway's own configuration format (`gateway.yaml`) can only substitute a single scalar value per `${VAR}` placeholder — it can't populate a YAML list from an environment variable. To let the admin console change the enabled model list without rebuilding and redeploying a new container image every time, the gateway's container entrypoint (`gateway/entrypoint.sh`) does a shell-level substitution of a single `AVAILABLE_MODELS_RAW` environment variable into the YAML file's `availableModels` list, before the gateway process itself starts and parses the file. Changing which models are enabled is therefore a plain ECS environment-variable update (`ecs:UpdateExpressGatewayService`) — the same container image, just a different variable value.

### The auditability difference from spend limits

Unlike spend limits, model-access changes are **not** gateway API calls — the gateway itself has no runtime API for its own model allow-list. Instead, the console's own AWS IAM task role calls `ecs:UpdateExpressGatewayService` directly against the gateway's ECS service. This means:

- Model-catalog changes do **not** appear in the gateway's own audit log.
- They are visible in AWS CloudTrail, attributed to the admin console's ECS task role — not to the individual admin who clicked "Apply changes" in the browser. If you need per-admin attribution for this action specifically, you'd need to add application-level logging in the console itself (not included in this reference implementation).

This is a real, intentional trade-off: it keeps the console's IAM permissions narrowly scoped to ECS operations on the gateway's own service (see `admin-console-stack.ts`'s task role policy) rather than requiring the gateway to expose a new admin API surface for something that's fundamentally an infrastructure change.
