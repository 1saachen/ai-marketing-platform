FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 UV_LINK_MODE=copy FISSION_CLONE_CONTRACTS_DIR=/app/contracts
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app/fission-clone-analysis
COPY workers/shared/ai-runtime /app/shared/ai-runtime
COPY workers/fission-clone-analysis/pyproject.toml workers/fission-clone-analysis/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY packages/contracts/schemas/fission-clone-analysis-report.schema.json packages/contracts/schemas/fission-clone-mapping-draft.schema.json packages/contracts/schemas/fission-clone-task-result.schema.json /app/contracts/schemas/
COPY workers/fission-clone-analysis/src ./src
RUN uv sync --frozen --no-dev && useradd --create-home --uid 10001 cloneworker
USER cloneworker
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/app/fission-clone-analysis/.venv/bin/python", "-m", "fission_clone_analysis.health"]
CMD ["/app/fission-clone-analysis/.venv/bin/fission-clone-analysis-worker"]
