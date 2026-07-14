# 3. Verify

A quick end-to-end check that the deployment is genuinely working, not just "all resources show green in the console."

## 3.1 Gateway health

```bash
curl -s https://<your-gateway-endpoint>/healthz
```

Expect `{"status":"ok"}` or similar. If this fails, check the gateway's CloudWatch Logs group (`ClaudeGatewayStack-GatewayLogGroup...` in the console, or `aws logs tail /aws/ecs/... --follow`) for the boot sequence — a healthy boot logs config load, database migrations, then `claude gateway listening on http://0.0.0.0:8080`.

## 3.2 Admin console sign-in

1. Open `https://<your-admin-console-endpoint>/signin` in a browser.
2. Click through the device authorization flow — this hands off to your Okta sign-in page, then back to a device-code confirmation screen.
3. Sign in with a user who is a member of your admin Okta group ([01-prerequisites.md](01-prerequisites.md)).
4. You should land on `/spend/dashboard`. If instead you land on `/not-authorized`, the signed-in user isn't in the admin group, or the `groups` claim isn't reaching the gateway — recheck the Okta claims configuration and `adminOktaGroupName` context value from your deploy.

## 3.3 Spend limits

From the console, go to **Limits** (`/spend/limits`) and create a test organization-wide limit (e.g. $10/monthly). Confirm it appears in the list. Then check the gateway's own audit log — go to **Audit** (`/spend/audit`) in the console, or query the gateway directly:

```bash
curl -s -H "Authorization: Bearer <admin's gateway token>" \
  https://<your-gateway-endpoint>/v1/organizations/audit_log?limit=5
```

The entry for your test limit should show `actor: oidc:<the admin's Okta subject>` — confirming the console performed this write using the signed-in admin's own identity, not a shared service credential.

Delete the test limit when done.

## 3.4 Model access

Go to **Models** (`/models`) in the console. You should see the live Bedrock Anthropic model catalog for your region, each marked enabled/disabled based on the gateway's current `AVAILABLE_MODELS_RAW` setting (all three default models — Opus, Sonnet, Haiku — are enabled after a fresh deploy). See [04-admin-console-guide.md](04-admin-console-guide.md) for how to change this.

## 3.5 A real inference call

With a developer's Claude Code CLI pointed at your gateway (see your organization's CLI configuration for `forceLoginGatewayUrl`, set to `https://<your-gateway-endpoint>`), run a simple prompt and confirm it completes. Then check the audit log again — you should see the inference call recorded with the model used and the actor's identity.

If all five of the above pass, the deployment is fully verified: authentication, spend-limit management, model-access management, and real inference through Bedrock.
