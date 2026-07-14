"""
Model catalog management for the Claude apps gateway.

Design (see model-access-design-recollection.md for the full history of how
this was arrived at):

  - The full model catalog is read live from Amazon Bedrock
    (bedrock:ListFoundationModels), not a hardcoded list. This is the
    authoritative source for "what models exist" -- Bedrock is the upstream
    the gateway routes to, so it's the correct place to ask.

  - Which of those models the gateway currently allows is read from the
    gateway's live ECS configuration: the AVAILABLE_MODELS_RAW environment
    variable, a YAML flow-sequence string (e.g. "[claude-sonnet-4-6,
    claude-opus-4-8]"). This is substituted into gateway.yaml's
    availableModels field by the gateway image's own /entrypoint.sh wrapper
    at container boot, using a plain shell `sed` substitution -- NOT the
    gateway's own ${VAR} expansion, which only fills scalar YAML positions
    and cannot populate a list. Doing the substitution at the shell level,
    before the gateway binary reads the file, removes that constraint
    entirely: AVAILABLE_MODELS_RAW can hold any number of models.

  - Changing the enabled set is therefore a pure ECS parameter change --
    update the AVAILABLE_MODELS_RAW environment variable and call
    update-express-gateway-service. No image rebuild is needed for a value
    change; the one-time image change (adding the entrypoint wrapper) has
    already been done. An earlier attempt at a full rebuild-per-change
    pipeline (via SSM + docker build + ECR push) was built and then
    abandoned once this simpler mechanism was proven -- if you find traces
    of that in git history, it's dead and intentionally removed here.

  - Applying a change is a single, deliberate, batch action ("Apply
    changes"), not a per-model instant toggle: every model-list change
    triggers a real gateway redeploy, so batching multiple selections into
    one apply avoids multiple unnecessary redeploys for what should be an
    infrequent admin operation.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import boto3

from app.config import settings

_ecs = _bedrock = None


def _ecs_client():
    global _ecs
    if _ecs is None:
        _ecs = boto3.client("ecs", region_name=settings.aws_region)
    return _ecs


def _bedrock_client():
    global _bedrock
    if _bedrock is None:
        _bedrock = boto3.client("bedrock", region_name=settings.aws_region)
    return _bedrock


class GatewayModelsError(Exception):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


@dataclass
class CatalogModel:
    """A model from the live Bedrock catalog, with its gateway-canonical ID
    and whether it's currently in the gateway's availableModels list."""
    gateway_id: str          # short canonical form, e.g. "claude-sonnet-4-6"
    bedrock_id: str          # e.g. "anthropic.claude-sonnet-4-6"
    label: str               # human-readable, e.g. "Claude Sonnet 4.6"
    status: str              # "ACTIVE" or "LEGACY", from Bedrock's modelLifecycle
    enabled: bool             # currently in the gateway's AVAILABLE_MODELS_RAW


# ---- Bedrock catalog ----

def _bedrock_id_to_gateway_id(bedrock_id: str) -> str:
    """Convert a Bedrock model ID to the short canonical gateway form.

    Examples:
      anthropic.claude-sonnet-4-6              -> claude-sonnet-4-6
      anthropic.claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5
      anthropic.claude-3-haiku-20240307-v1:0   -> claude-3-haiku
    """
    s = bedrock_id
    if s.startswith("anthropic."):
        s = s[len("anthropic."):]
    s = re.sub(r"-\d{8}-v\d+:\d+.*$", "", s)   # -20251001-v1:0
    s = re.sub(r"-v\d+:\d+.*$", "", s)          # -v1:0
    s = re.sub(r":\d+$", "", s)                 # :0
    s = re.sub(r":\d+k$", "", s)                # :200k
    s = re.sub(r"-v\d+$", "", s)                 # bare -v1 with no colon suffix
    return s


def _list_bedrock_catalog() -> list[dict]:
    """Raw Bedrock catalog: Anthropic, text-output, inference-profile-capable
    models only (that's what auto_include_builtin_models routes through).
    Deduplicates dated variants onto their short gateway ID, preferring the
    ACTIVE lifecycle entry when both a dated and undated form resolve the
    same gateway_id."""
    try:
        resp = _bedrock_client().list_foundation_models(
            byProvider="Anthropic",
            byOutputModality="TEXT",
        )
    except Exception as e:  # noqa: BLE001
        raise GatewayModelsError(f"Could not list Bedrock models: {e}") from e

    by_gateway_id: dict[str, dict] = {}
    for m in resp.get("modelSummaries", []):
        if "INFERENCE_PROFILE" not in m.get("inferenceTypesSupported", []):
            continue
        bedrock_id = m["modelId"]
        gateway_id = _bedrock_id_to_gateway_id(bedrock_id)
        status = m.get("modelLifecycle", {}).get("status", "ACTIVE")
        entry = {
            "gateway_id": gateway_id,
            "bedrock_id": bedrock_id,
            "label": m.get("modelName", bedrock_id),
            "status": status,
        }
        existing = by_gateway_id.get(gateway_id)
        if existing is None or (existing["status"] != "ACTIVE" and status == "ACTIVE"):
            by_gateway_id[gateway_id] = entry

    return sorted(
        by_gateway_id.values(),
        key=lambda e: (0 if e["status"] == "ACTIVE" else 1, e["label"]),
    )


# ---- Current gateway state ----

def _parse_available_models_raw(raw: str) -> list[str]:
    """Parse the AVAILABLE_MODELS_RAW YAML flow-sequence string, e.g.
    "[claude-sonnet-4-6, claude-opus-4-8]", into a list of gateway IDs."""
    raw = raw.strip()
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    return [m.strip() for m in raw.split(",") if m.strip()]


def _get_gateway_primary_container() -> dict:
    try:
        resp = _ecs_client().describe_express_gateway_service(
            serviceArn=settings.gateway_service_arn
        )
    except Exception as e:  # noqa: BLE001
        raise GatewayModelsError(f"Could not read the gateway's current configuration: {e}") from e

    configs = resp.get("service", {}).get("activeConfigurations", [])
    if not configs:
        raise GatewayModelsError("The gateway service has no active configuration.")
    return configs[0]["primaryContainer"]


def get_current_enabled_gateway_ids() -> list[str]:
    """The gateway IDs currently in AVAILABLE_MODELS_RAW on the live gateway service."""
    container = _get_gateway_primary_container()
    env = {e["name"]: e["value"] for e in container.get("environment", [])}
    raw = env.get("AVAILABLE_MODELS_RAW", "")
    return _parse_available_models_raw(raw)


def get_catalog_with_state() -> list[CatalogModel]:
    """The full live Bedrock catalog, each entry marked with whether it's
    currently enabled on the gateway. This is what the models page renders."""
    catalog = _list_bedrock_catalog()
    enabled_ids = set(get_current_enabled_gateway_ids())
    return [
        CatalogModel(
            gateway_id=m["gateway_id"],
            bedrock_id=m["bedrock_id"],
            label=m["label"],
            status=m["status"],
            enabled=(m["gateway_id"] in enabled_ids),
        )
        for m in catalog
    ]


# ---- Apply a new selection ----

def apply_model_selection(selected_gateway_ids: list[str]) -> None:
    """Set the gateway's availableModels to exactly the given list, in one
    update-express-gateway-service call. Preserves every other part of the
    current container config (image, port, other env vars, secrets) --
    only AVAILABLE_MODELS_RAW changes."""
    if not selected_gateway_ids:
        raise GatewayModelsError("At least one model must be selected.")

    container = _get_gateway_primary_container()
    new_raw = "[" + ", ".join(selected_gateway_ids) + "]"

    env = list(container.get("environment", []))
    found = False
    for entry in env:
        if entry["name"] == "AVAILABLE_MODELS_RAW":
            entry["value"] = new_raw
            found = True
            break
    if not found:
        env.append({"name": "AVAILABLE_MODELS_RAW", "value": new_raw})

    try:
        _ecs_client().update_express_gateway_service(
            serviceArn=settings.gateway_service_arn,
            primaryContainer={
                "image": container["image"],
                "containerPort": container["containerPort"],
                "environment": env,
                "secrets": container.get("secrets", []),
            },
        )
    except Exception as e:  # noqa: BLE001
        raise GatewayModelsError(f"Could not update the gateway: {e}") from e


def is_deployment_settled() -> bool:
    """True once the gateway service has no deployment in flight, i.e. the
    most recent model-list change has fully applied and old tasks have
    drained. Used for the "Applying..." -> "Active" status polling in the
    UI, without exposing canary/bake-time mechanics to the admin."""
    try:
        resp = _ecs_client().describe_express_gateway_service(
            serviceArn=settings.gateway_service_arn
        )
    except Exception:  # noqa: BLE001 -- treat a transient read failure as "still applying"
        return False
    return "currentDeployment" not in resp.get("service", {})
