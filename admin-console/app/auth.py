"""
Session and authorization helpers for the admin console.

The console never verifies the gateway JWT's signature itself -- it doesn't
have (and shouldn't have) the gateway's session.jwt_secret. Trust boundary:
the gateway is the only party that verifies the signature, on every admin
API call the console makes with the token attached. Here we only decode the
unverified payload to read `groups`/`email`/`sub` for *display* and for
gating which pages the console shows -- a cosmetic, UX-only check. Actual
authorization is always enforced by the gateway itself via admin.admin_groups,
so a forged/expired token still fails at the gateway, not just in this UI.
"""
from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings

ADMIN_GROUP_NAME = "claude-gateway-admins"

SESSION_KEY_TOKEN = "gateway_token"
SESSION_KEY_CLAIMS = "gateway_claims"
SESSION_KEY_EXPIRES_AT = "gateway_token_expires_at"


def install_session_middleware(app):
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret_key,
        max_age=settings.session_ttl_seconds,
        same_site="lax",
        https_only=settings.public_url.startswith("https://"),
    )


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def decode_jwt_payload_unverified(token: str) -> dict[str, Any]:
    """Decode a JWT's payload without verifying the signature. See module docstring
    for why this is safe: it's used only to render the UI, never to authorize an
    action -- every write still round-trips through the gateway, which verifies
    the signature and re-checks admin.admin_groups itself."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("not a JWT")
    return json.loads(_b64url_decode(parts[1]))


@dataclass
class SignedInAdmin:
    sub: str
    email: str | None
    groups: list[str]
    token: str

    @property
    def is_admin(self) -> bool:
        return ADMIN_GROUP_NAME in (self.groups or [])


def get_signed_in_admin(request: Request) -> SignedInAdmin | None:
    token = request.session.get(SESSION_KEY_TOKEN)
    expires_at = request.session.get(SESSION_KEY_EXPIRES_AT)
    if not token or not expires_at or time.time() >= expires_at:
        return None
    claims = request.session.get(SESSION_KEY_CLAIMS, {})
    return SignedInAdmin(
        sub=claims.get("sub", ""),
        email=claims.get("email"),
        groups=claims.get("groups", []),
        token=token,
    )


def store_gateway_token(request: Request, token: str) -> SignedInAdmin:
    claims = decode_jwt_payload_unverified(token)
    exp = claims.get("exp", time.time() + settings.session_ttl_seconds)
    request.session[SESSION_KEY_TOKEN] = token
    request.session[SESSION_KEY_CLAIMS] = claims
    request.session[SESSION_KEY_EXPIRES_AT] = exp
    return SignedInAdmin(
        sub=claims.get("sub", ""),
        email=claims.get("email"),
        groups=claims.get("groups", []),
        token=token,
    )


def clear_session(request: Request) -> None:
    request.session.clear()
