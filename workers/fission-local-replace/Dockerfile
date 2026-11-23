FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 UV_LINK_MODE=copy FISSION_LOCAL_REPLACE_CONTRACTS_DIR=/app/contracts
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/fission-local-replace
COPY workers/shared/ai-runtime /app/shared/ai-runtime
COPY workers/fission-local-replace/pyproject.toml workers/fission-local-replace/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY packages/contracts/schemas/fission-local-replace-worker-input.schema.json /app/contracts/schemas/
COPY workers/fission-local-replace/src ./src
RUN uv sync --frozen --no-dev && useradd --create-home --uid 10001 replaceworker
USER replaceworker
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/app/fission-local-replace/.venv/bin/python", "-m", "fission_local_replace.health"]
CMD ["/app/fission-local-replace/.venv/bin/fission-local-replace-worker"]
