"""
Claude apps gateway admin console.

A thin, server-rendered admin UI over the gateway's own
/v1/organizations/spend_limits admin API. This app holds no gateway
credentials of its own -- every admin action is performed with the signed-in
admin's own gateway-issued bearer token, obtained via the gateway's device
authorization flow, so every write audits as oidc:<sub> in the gateway's own
audit log (see app/auth.py and app/gateway_client.py for the full rationale).
"""
from __future__ import annotations

from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.auth import (
    get_signed_in_admin,
    store_gateway_token,
    clear_session,
    install_session_middleware,
)
from app.config import settings
from app.gateway_client import GatewayClient, GatewayError
from app.gateway_models import (
    get_catalog_with_state,
    apply_model_selection,
    is_deployment_settled,
    GatewayModelsError,
)

app = FastAPI(title="Claude Gateway Admin Console")
install_session_middleware(app)
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")

# In-memory holding area for in-flight device authorizations, keyed by device_code.
# A single-instance admin console with a handful of concurrent admins doesn't need
# a shared store for this; if this console is ever scaled beyond one task, move this
# to the gateway's own Postgres (a small dedicated table, not the gateway's tables)
# or to a shared cache.
_pending_devices: dict[str, dict] = {}


def render(request: Request, template: str, **context):
    admin = get_signed_in_admin(request)
    return templates.TemplateResponse(request, template, {"admin": admin, **context})


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


# ---- Sign-in (device authorization flow against the gateway) ----

@app.get("/signin", response_class=HTMLResponse)
async def signin_page(request: Request):
    if get_signed_in_admin(request):
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(request, "signin.html", {})


@app.post("/signin/start")
async def signin_start(request: Request):
    client = GatewayClient()
    device = await client.start_device_authorization()
    _pending_devices[device.device_code] = {"device": device}
    return templates.TemplateResponse(request, "device_code.html", {"device": device, "admin": None})


@app.post("/signin/poll")
async def signin_poll(request: Request):
    body = await request.json()
    device_code = body.get("device_code")
    if not device_code or device_code not in _pending_devices:
        return JSONResponse({"status": "error", "message": "Unknown device code"}, status_code=400)

    client = GatewayClient()
    try:
        result = await client.poll_token(device_code)
    except GatewayError as e:
        _pending_devices.pop(device_code, None)
        return JSONResponse({"status": "error", "message": e.message})

    if result is None:
        return JSONResponse({"status": "pending"})

    _pending_devices.pop(device_code, None)
    admin = store_gateway_token(request, result["access_token"])
    if not admin.is_admin:
        return JSONResponse({"status": "complete", "redirect": "/not-authorized"})
    return JSONResponse({"status": "complete", "redirect": "/spend/dashboard"})


@app.get("/signout")
async def signout(request: Request):
    clear_session(request)
    return RedirectResponse("/signin", status_code=303)


@app.get("/not-authorized", response_class=HTMLResponse)
async def not_authorized(request: Request):
    admin = get_signed_in_admin(request)
    if not admin:
        return RedirectResponse("/signin", status_code=303)
    return templates.TemplateResponse(request, "not_authorized.html", {"admin": admin})


def _require_admin(request: Request):
    """Returns the signed-in admin, or None if the caller should be redirected.
    Callers must check for None and redirect themselves (kept as plain data flow
    rather than an exception-based dependency, to keep this file readable end to end)."""
    admin = get_signed_in_admin(request)
    if not admin:
        return None
    if not admin.is_admin:
        return None
    return admin


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    admin = get_signed_in_admin(request)
    if not admin:
        return RedirectResponse("/signin", status_code=303)
    if not admin.is_admin:
        return RedirectResponse("/not-authorized", status_code=303)
    return RedirectResponse("/spend/dashboard", status_code=303)


# ---- Effective spend dashboard ----

@app.get("/spend/dashboard", response_class=HTMLResponse)
async def spend_dashboard(request: Request, q: str = "", period: str = "monthly", sort: str = ""):
    admin = _require_admin(request)
    if not admin:
        return RedirectResponse("/signin", status_code=303)

    client = GatewayClient(bearer_token=admin.token)
    error = None
    rows = []
    try:
        data = await client.get_effective(period=[period], sort=sort or None, q=q or None, limit=100)
        rows = data.get("data", [])
    except GatewayError as e:
        error = f"Could not load effective spend: {e.message}"

    return render(
        request, "dashboard.html",
        active_nav="dashboard", rows=rows, q=q, period=period, sort=sort, error=error,
    )


# ---- Spend limits CRUD ----

@app.get("/spend/limits", response_class=HTMLResponse)
async def spend_limits_page(request: Request, error: str = "", success: str = ""):
    admin = _require_admin(request)
    if not admin:
        return RedirectResponse("/signin", status_code=303)

    client = GatewayClient(bearer_token=admin.token)
    limits = []
    load_error = error or None
    try:
        data = await client.list_spend_limits(limit=200)
        limits = data.get("data", [])
    except GatewayError as e:
        load_error = f"Could not load spend limits: {e.message}"

    return render(
        request, "limits.html",
        active_nav="limits", limits=limits, error=load_error, success=success or None,
    )


@app.post("/spend/limits/create")
async def spend_limits_create(
    request: Request,
    scope_type: str = Form(...),
    rbac_group_id: str = Form(""),
    user_id: str = Form(""),
    amount_dollars: str = Form(...),
    period: str = Form(...),
):
    admin = _require_admin(request)
    if not admin:
        return RedirectResponse("/signin", status_code=303)

    if scope_type == "organization":
        scope = {"type": "organization"}
    elif scope_type == "rbac_group":
        scope = {"type": "rbac_group", "rbac_group_id": rbac_group_id.strip()}
    else:
        scope = {"type": "user", "user_id": user_id.strip()}

    try:
        amount_cents = str(round(float(amount_dollars) * 100))
    except ValueError:
        return RedirectResponse("/spend/limits?error=Invalid amount", status_code=303)

    client = GatewayClient(bearer_token=admin.token)
    try:
        await client.create_spend_limit(scope=scope, amount=amount_cents, period=period)
    except GatewayError as e:
        return RedirectResponse(f"/spend/limits?error={e.message}", status_code=303)

    return RedirectResponse("/spend/limits?success=Cap saved", status_code=303)


@app.post("/spend/limits/{spend_limit_id}/delete")
async def spend_limits_delete(request: Request, spend_limit_id: str):
    admin = _require_admin(request)
    if not admin:
        return RedirectResponse("/signin", status_code=303)

    client = GatewayClient(bearer_token=admin.token)
    try:
        await client.delete_spend_limit(spend_limit_id)
    except GatewayError as e:
        return RedirectResponse(f"/spend/limits?error={e.message}", status_code=303)

    return RedirectResponse("/spend/limits?success=Cap deleted", status_code=303)


# ---- Model catalog ----

@app.get("/models", response_class=HTMLResponse)
async def models_page(request: Request, error: str = "", success: str = ""):
    admin = _require_admin(request)
    if not admin:
        return RedirectResponse("/signin", status_code=303)

    load_error = error or None
    catalog = []
    try:
        # The full model catalog comes live from Amazon Bedrock, not a
        # hardcoded list -- see app/gateway_models.py for the rationale.
        # Each entry is marked with whether it's currently in the gateway's
        # AVAILABLE_MODELS_RAW, read from the live ECS service config.
        catalog = get_catalog_with_state()
    except GatewayModelsError as e:
        load_error = e.message

    return render(
        request, "models.html",
        active_nav="models", catalog=catalog, error=load_error, success=success or None,
    )


@app.post("/models/apply")
async def models_apply(request: Request, model_id: list[str] = Form(default=[])):
    """Single batch action: applies the admin's full selection from the
    catalog page in one gateway redeploy, rather than one redeploy per
    toggle. This is deliberately an infrequent, explicit action -- see
    models.html for the confirmation copy shown before this is submitted."""
    admin = _require_admin(request)
    if not admin:
        return RedirectResponse("/signin", status_code=303)

    try:
        apply_model_selection(model_id)
    except GatewayModelsError as e:
        return RedirectResponse(f"/models?error={e.message}", status_code=303)

    return RedirectResponse(
        f"/models?success=Applied {len(model_id)} model(s). This will take effect for all developers within a few minutes.",
        status_code=303,
    )


@app.get("/models/status")
async def models_status(request: Request):
    """Polled by the models page while a change is applying. Deliberately
    returns only a settled/applying boolean -- no deployment IDs, canary
    percentages, or task counts -- so the admin sees "Applying..." flip to
    "Active" without any redeploy mechanics leaking into the UI."""
    admin = _require_admin(request)
    if not admin:
        return JSONResponse({"settled": True}, status_code=401)

    return JSONResponse({"settled": is_deployment_settled()})


# ---- Audit log ----

@app.get("/spend/audit", response_class=HTMLResponse)
async def spend_audit(request: Request):
    admin = _require_admin(request)
    if not admin:
        return RedirectResponse("/signin", status_code=303)

    client = GatewayClient(bearer_token=admin.token)
    entries = []
    error = None
    try:
        data = await client.get_audit(limit=100)
        entries = data.get("data", [])
    except GatewayError as e:
        error = f"Could not load audit log: {e.message}"

    return render(request, "audit.html", active_nav="audit", entries=entries, error=error)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
