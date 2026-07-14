"""
Thin async client for the Claude apps gateway's own HTTP surface:
  - the device-authorization flow (used for admin sign-in)
  - the /v1/organizations/spend_limits admin API

This client holds no long-lived credentials of its own. Every call after
sign-in is made with the caller-supplied bearer token, which is the
gateway-issued JWT obtained via the device flow and stored in the admin's
browser session (see app/auth.py).
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings


class GatewayError(RuntimeError):
    """Raised when the gateway returns a non-2xx response with a parseable error envelope."""

    def __init__(self, status_code: int, error_type: str | None, message: str, request_id: str | None):
        self.status_code = status_code
        self.error_type = error_type
        self.message = message
        self.request_id = request_id
        super().__init__(f"gateway error {status_code} ({error_type}): {message}")


@dataclass
class DeviceAuthorization:
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int


def _raise_for_gateway_error(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    request_id = resp.headers.get("request-id")
    try:
        body = resp.json()
        err = body.get("error", {})
        raise GatewayError(resp.status_code, err.get("type"), err.get("message", resp.text), request_id)
    except ValueError:
        raise GatewayError(resp.status_code, None, resp.text, request_id) from None


class GatewayClient:
    """One instance per request/session; cheap to construct."""

    def __init__(self, base_url: str | None = None, bearer_token: str | None = None):
        self.base_url = (base_url or settings.gateway_base_url).rstrip("/")
        self.bearer_token = bearer_token

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.bearer_token:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        return headers

    # ---- Device authorization flow (admin sign-in) ----

    async def start_device_authorization(self) -> DeviceAuthorization:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{self.base_url}/oauth/device_authorization")
            _raise_for_gateway_error(resp)
            data = resp.json()
            return DeviceAuthorization(
                device_code=data["device_code"],
                user_code=data["user_code"],
                verification_uri=data["verification_uri"],
                verification_uri_complete=data["verification_uri_complete"],
                expires_in=data["expires_in"],
                interval=data.get("interval", settings.device_poll_interval_seconds),
            )

    async def poll_token(self, device_code: str) -> dict[str, Any] | None:
        """
        Poll the gateway's token endpoint once. Returns the token response dict
        on success, or None if the authorization is still pending. Raises
        GatewayError for any other failure (expired, denied, etc.).
        """
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{self.base_url}/oauth/token",
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "device_code": device_code,
                },
            )
            if resp.status_code == 400:
                body = resp.json()
                if body.get("error") == "authorization_pending":
                    return None
            _raise_for_gateway_error(resp)
            return resp.json()

    async def wait_for_token(self, device: DeviceAuthorization) -> dict[str, Any]:
        """Blocking poll loop, bounded by settings.device_poll_timeout_seconds. Prefer the
        non-blocking start/poll split (start_device_authorization + poll_token) driven from
        the browser for a responsive UI; this helper exists for scripts/tests."""
        import asyncio

        deadline = time.monotonic() + min(device.expires_in, settings.device_poll_timeout_seconds)
        while time.monotonic() < deadline:
            result = await self.poll_token(device.device_code)
            if result is not None:
                return result
            await asyncio.sleep(device.interval)
        raise GatewayError(408, "device_code_expired", "Device authorization timed out", None)

    # ---- Spend limits admin API ----

    async def list_spend_limits(self, limit: int = 100) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{self.base_url}/v1/organizations/spend_limits",
                params={"limit": limit},
                headers=self._headers(),
            )
            _raise_for_gateway_error(resp)
            return resp.json()

    async def create_spend_limit(self, scope: dict[str, Any], amount: str | None, period: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{self.base_url}/v1/organizations/spend_limits",
                json={"scope": scope, "amount": amount, "period": period},
                headers=self._headers(),
            )
            _raise_for_gateway_error(resp)
            return resp.json()

    async def delete_spend_limit(self, spend_limit_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.delete(
                f"{self.base_url}/v1/organizations/spend_limits/{spend_limit_id}",
                headers=self._headers(),
            )
            _raise_for_gateway_error(resp)
            return resp.json()

    async def get_effective(
        self,
        period: list[str] | None = None,
        sort: str | None = None,
        q: str | None = None,
        limit: int = 20,
        page: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if period:
            params["period[]"] = period
        if sort:
            params["sort"] = sort
        if q:
            params["q"] = q
        if page:
            params["page"] = page
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{self.base_url}/v1/organizations/spend_limits/effective",
                params=params,
                headers=self._headers(),
            )
            _raise_for_gateway_error(resp)
            return resp.json()

    async def get_audit(self, limit: int = 50) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{self.base_url}/v1/organizations/spend_limits/audit",
                params={"limit": limit},
                headers=self._headers(),
            )
            _raise_for_gateway_error(resp)
            return resp.json()

    async def list_models(self) -> list[dict[str, str]]:
        """Fetch the gateway's live model catalog via its Anthropic-compatible
        /v1/models endpoint, which reflects auto_include_builtin_models plus any
        custom models: block in gateway.yaml. Returns a list of {id, label} dicts,
        where label is the human-readable model name (e.g. "Claude Sonnet 4.6")
        and id is the short canonical form the CLI sends (e.g. "claude-sonnet-4-6")
        that the gateway's availableModels enforcement checks against.

        This is the authoritative live source for the model catalog -- not a
        hardcoded list, not Bedrock's list-foundation-models (which returns raw
        Bedrock IDs including legacy models and requires the us.anthropic.* profile
        prefix), but the gateway's own resolved and filtered view.
        """
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{self.base_url}/v1/models",
                headers=self._headers(),
            )
            _raise_for_gateway_error(resp)
            data = resp.json()
            models = []
            for m in data.get("data", []):
                model_id = m.get("id", "")
                # The gateway's /v1/models returns the short canonical model IDs
                # (e.g. "claude-sonnet-4-6") that the CLI uses and that availableModels
                # enforcement checks against. The "name" field is the human-readable label.
                models.append({
                    "id": model_id,
                    "label": m.get("label") or m.get("name") or m.get("display_name") or model_id,
                })
            return models
