FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

# Minimal deps: only what's needed to install Python packages and run the app.
# Security updates for the base image's OS packages are applied here too --
# without this, Amazon Inspector flags known CVEs in packages that ship with
# the base image itself, not just the ones we explicitly install.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Run as a non-root user -- this container never needs elevated privileges.
RUN useradd --create-home --shell /bin/false appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/healthz || exit 1

CMD ["python", "-m", "app.main"]
