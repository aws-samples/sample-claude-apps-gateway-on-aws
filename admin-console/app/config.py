"""
Configuration for the Claude apps gateway admin console.

All values are read from environment variables so the same container image
can be promoted across environments without a rebuild. Secrets (session
signing key) are expected to be injected by the platform (e.g. ECS Express
Mode `secrets`, backed by AWS Secrets Manager) rather than baked into the
image.

Auth model: this console does NOT run its own OIDC client against Okta.
The gateway's own OAuth token endpoint only supports the device-code grant
and refresh tokens (confirmed via GET /.well-known/oauth-authorization-server:
grant_types_supported = ["urn:ietf:params:oauth:grant-type:device_code",
"refresh_token"] -- there is no authorization_code grant, so a standard OIDC
redirect against the gateway is not available). Instead, the console starts
a device authorization against the gateway, shows the admin the verification
link, polls the gateway's token endpoint, and on success holds a
gateway-issued bearer token. The gateway itself checks that token's `groups`
claim against `admin.admin_groups` on every admin API call, so:
  - every admin action audits as oidc:<sub> in the gateway's own audit log
  - this console never holds a static x-api-key admin credential
  - group membership (claude-gateway-admins) is enforced by the gateway,
    not re-implemented here

Model catalog management (see app/gateway_models.py) is a separate concern
from the rest of this console: it's an AWS-side operation (an ECS Express
Mode service update), not a gateway API call, so it uses this console's own
IAM task role rather than a signed-in admin's bearer token. Every admin
still has to be signed in and pass the same admin.admin_groups check to
reach that page; the distinction is only in which credential performs the
underlying write.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="", case_sensitive=False)

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 8080
    public_url: str = "http://localhost:8080"

    # --- Session (this console's own browser session, separate from the
    # gateway bearer token, which is stored inside the session) ---
    session_secret_key: str
    session_ttl_seconds: int = 8 * 60 * 60  # 8 hours, matches gateway session.ttl_hours

    # --- Claude apps gateway ---
    gateway_base_url: str  # e.g. https://cl-xxxx.ecs.us-east-2.on.aws
    # Poll interval/timeout for the device-authorization flow. The gateway's
    # own device_authorization response includes `interval` and `expires_in`;
    # these are just client-side safety bounds if the gateway ever omits them.
    device_poll_interval_seconds: int = 5
    device_poll_timeout_seconds: int = 600

    # --- Model catalog management ---
    # The gateway's model allow-list has no runtime admin API (see
    # app/gateway_models.py for why), so this console manages it directly
    # via two narrowly-scoped ECS Express Mode calls against the gateway's
    # own service, using this console's task role -- not a gateway-issued
    # bearer token, since this is an AWS-side operation, not a gateway API call.
    gateway_service_arn: str = ""
    aws_region: str = "us-east-2"


settings = Settings()
