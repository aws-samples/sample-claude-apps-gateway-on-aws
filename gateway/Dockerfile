# Claude apps gateway container image.
#
# Builds a container image around the native `claude` binary, downloaded and
# cryptographically verified from Anthropic's release channel at build time --
# no binary is checked into this repository or copied in from outside the
# build context.
#
# Verification follows Anthropic's documented process exactly (see
# https://docs.claude.com/en/setup#binary-integrity-and-code-signing):
#   1. Import Anthropic's release signing GPG key and confirm its fingerprint.
#   2. Download the version's manifest.json and its detached signature,
#      manifest.json.sig, and verify the signature against the imported key.
#   3. Download the platform binary and verify its SHA256 checksum against
#      the value the (now signature-verified) manifest lists for that platform.
#
# Only after all three checks pass does the binary get installed into the
# image. Any failure aborts the build (`set -e` plus explicit fingerprint and
# checksum comparisons that exit non-zero on mismatch).

FROM public.ecr.aws/docker/library/debian:12-slim

# Pin the exact Claude Code release this image ships. Bump deliberately when
# you want to move to a newer gateway version -- this is the version pin the
# deployment guide recommends keeping under your own control rather than
# tracking "latest".
ARG CLAUDE_CODE_VERSION=2.1.204
# Anthropic's release signing key fingerprint. This is a second, independent
# check beyond "did gpg say the signature was good" -- it confirms the key
# itself is the one Anthropic publishes, not merely internally self-consistent.
ARG CLAUDE_CODE_SIGNING_KEY_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/claude-download

# Download, verify, and install the claude binary. Runs as a single RUN layer
# so the downloaded manifest/signature/binary don't persist in any image layer
# once this step completes.
RUN set -eu; \
    export GNUPGHOME="$(mktemp -d)"; \
    REPO="https://downloads.claude.ai/claude-code-releases"; \
    PLATFORM="linux-x64"; \
    \
    echo "Importing Anthropic's release signing key..."; \
    curl -fsSL https://downloads.claude.ai/keys/claude-code.asc | gpg --batch --no-tty --import; \
    \
    ACTUAL_FPR="$(gpg --batch --no-tty --with-colons --fingerprint security@anthropic.com 2>/dev/null \
      | awk -F: '/^fpr:/ {print $10; exit}')"; \
    if [ "$ACTUAL_FPR" != "$CLAUDE_CODE_SIGNING_KEY_FINGERPRINT" ]; then \
      echo "FATAL: signing key fingerprint mismatch."; \
      echo "  expected: $CLAUDE_CODE_SIGNING_KEY_FINGERPRINT"; \
      echo "  actual:   $ACTUAL_FPR"; \
      exit 1; \
    fi; \
    echo "Signing key fingerprint confirmed: $ACTUAL_FPR"; \
    \
    echo "Downloading manifest for version $CLAUDE_CODE_VERSION..."; \
    curl -fsSLO "$REPO/$CLAUDE_CODE_VERSION/manifest.json"; \
    curl -fsSLO "$REPO/$CLAUDE_CODE_VERSION/manifest.json.sig"; \
    \
    echo "Verifying manifest signature..."; \
    gpg --batch --no-tty --verify manifest.json.sig manifest.json; \
    \
    echo "Downloading $PLATFORM binary..."; \
    curl -fsSL -o claude "$REPO/$CLAUDE_CODE_VERSION/$PLATFORM/claude"; \
    \
    EXPECTED_SHA256="$(grep -A2 "\"$PLATFORM\"" manifest.json | grep checksum | sed -E 's/.*"checksum": *"([a-f0-9]+)".*/\1/')"; \
    ACTUAL_SHA256="$(sha256sum claude | awk '{print $1}')"; \
    if [ -z "$EXPECTED_SHA256" ]; then \
      echo "FATAL: could not find a checksum for platform '$PLATFORM' in manifest.json."; \
      exit 1; \
    fi; \
    if [ "$EXPECTED_SHA256" != "$ACTUAL_SHA256" ]; then \
      echo "FATAL: binary checksum mismatch."; \
      echo "  expected: $EXPECTED_SHA256"; \
      echo "  actual:   $ACTUAL_SHA256"; \
      exit 1; \
    fi; \
    echo "Binary checksum confirmed: $ACTUAL_SHA256"; \
    \
    install -m 0755 claude /usr/local/bin/claude; \
    cd /; \
    rm -rf /tmp/claude-download "$GNUPGHOME"

# The gateway runs as any user, so it needs a writable state directory even
# in a minimal image that has no writable home for a non-root user.
ENV CLAUDE_CONFIG_DIR=/tmp/.claude
RUN mkdir -p /tmp/.claude /etc/claude && chmod 1777 /tmp/.claude

COPY gateway.yaml /etc/claude/gateway.yaml
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
CMD ["/entrypoint.sh"]
