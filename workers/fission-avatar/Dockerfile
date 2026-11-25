FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 UV_LINK_MODE=copy FISSION_AVATAR_CONTRACTS_DIR=/app/contracts
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ffmpeg fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/fission-avatar
COPY workers/shared/ai-runtime /app/shared/ai-runtime
COPY workers/fission-avatar/pyproject.toml workers/fission-avatar/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY packages/contracts/schemas/fission-avatar-sync-worker-input.schema.json packages/contracts/schemas/fission-avatar-sync-completion.schema.json packages/contracts/schemas/fission-avatar-sync-checkpoint.schema.json /app/contracts/schemas/
COPY packages/contracts/schemas/fission-avatar-render-worker-input.schema.json packages/contracts/schemas/fission-avatar-render-completion.schema.json /app/contracts/schemas/
COPY packages/contracts/schemas/fission-avatar-native-render-worker-input.schema.json packages/contracts/schemas/fission-avatar-native-render-completion.schema.json /app/contracts/schemas/
COPY packages/contracts/schemas/fission-avatar-long-sync-worker-input.schema.json packages/contracts/schemas/fission-avatar-long-sync-completion.schema.json packages/contracts/schemas/fission-avatar-long-render-worker-input.schema.json packages/contracts/schemas/fission-avatar-long-render-completion.schema.json /app/contracts/schemas/
COPY packages/contracts/schemas/fission-avatar-tail-chain-worker-input.schema.json packages/contracts/schemas/fission-avatar-tail-chain-checkpoint.schema.json /app/contracts/schemas/
COPY packages/contracts/schemas/fission-avatar-native-worker-input.schema.json packages/contracts/schemas/fission-avatar-native-checkpoint.schema.json packages/contracts/schemas/fission-avatar-native-completion.schema.json /app/contracts/schemas/
COPY workers/fission-avatar/src ./src
RUN uv sync --frozen --no-dev && useradd --create-home --uid 10001 avatarworker
USER avatarworker
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["/app/fission-avatar/.venv/bin/python", "-m", "fission_avatar.health"]
CMD ["/app/fission-avatar/.venv/bin/fission-avatar-worker"]
