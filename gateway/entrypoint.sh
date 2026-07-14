#!/bin/sh
# Entrypoint wrapper for the Claude apps gateway container.
#
# Substitutes ${AVAILABLE_MODELS_RAW} in gateway.yaml with the real value from
# the environment variable before the gateway binary reads the config file.
# This allows the model allow-list to be changed via a plain ECS environment
# variable update + redeploy, with no image rebuild required.
#
# AVAILABLE_MODELS_RAW must be a YAML flow-sequence string, e.g.:
#   [claude-sonnet-4-6, claude-opus-4-8, claude-haiku-4-5]
#
# The gateway's own ${VAR} expansion only fills scalar positions, not list
# positions. By doing the substitution at the shell level before the gateway
# reads the file, we bypass that constraint entirely.

set -e

if [ -z "${AVAILABLE_MODELS_RAW:-}" ]; then
  echo "[entrypoint] ERROR: AVAILABLE_MODELS_RAW is not set. Cannot start gateway." >&2
  exit 1
fi

# Write the substituted config to a writable temp path
# (the original /etc/claude/gateway.yaml is read-only in the image layer)
sed "s|\${AVAILABLE_MODELS_RAW}|${AVAILABLE_MODELS_RAW}|g" \
  /etc/claude/gateway.yaml > /tmp/gateway-resolved.yaml

exec claude gateway --config /tmp/gateway-resolved.yaml
