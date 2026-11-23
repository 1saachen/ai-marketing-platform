from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

import httpx
from ai_runtime.http import InternalApiError, request, unwrap


class Api:
    def __init__(
        self, url: str, token: str, project: UUID, run: UUID, task: UUID
    ) -> None:
        self.token = ""
        self.client = httpx.AsyncClient(
            base_url=f"{url.rstrip('/')}/internal/workers/fission-local-replace/{project}/{run}/tasks/{task}/",
            headers={"x-worker-token": token},
            timeout=60,
            follow_redirects=False,
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def call(
        self, method: str, path: str, value: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        # The reserve response grants the only permission to submit payment.
        # A lost reservation response can never grant permission on replay.
        attempts = 1 if path in {"claim", "provider/create"} else 3
        for attempt in range(attempts):
            try:
                kwargs = {"json": value} if value is not None else {}
                response = await request(
                    self.client,
                    method,
                    path,
                    headers={"x-attempt-token": self.token},
                    timeout=8,
                    **kwargs,
                )
                data = unwrap(response.json())
                if not isinstance(data, dict):
                    raise InternalApiError("invalid internal response", retryable=False)
                return data
            except InternalApiError as error:
                if not error.retryable or attempt == attempts - 1:
                    raise
                await asyncio.sleep(2**attempt)
        raise AssertionError("unreachable retry boundary")

    async def download(
        self, slot: Literal["source", "target"], destination: Path, expected_size: int
    ) -> None:
        count = 0
        try:
            async with self.client.stream(
                "GET", slot, headers={"x-attempt-token": self.token}
            ) as response:
                if response.status_code != 200:
                    status = response.status_code
                    raise InternalApiError(
                        "frozen asset unavailable",
                        retryable=status == 429 or status >= 500,
                        status_code=status,
                    )
                with destination.open("wb") as target:
                    async for chunk in response.aiter_bytes(64 * 1024):
                        count += len(chunk)
                        if count > expected_size:
                            raise InternalApiError(
                                "frozen asset exceeds its size", retryable=False
                            )
                        target.write(chunk)
            if count != expected_size:
                raise InternalApiError(
                    "frozen asset has a different size", retryable=False
                )
        except (httpx.HTTPError, OSError) as error:
            raise InternalApiError(
                "frozen asset transfer failed", retryable=True
            ) from error

    async def upload(self, path: Path) -> None:
        # Completion is idempotent and the known provider task ID survives
        # lease recovery even if the result upload is interrupted.
        with path.open("rb") as media:
            await request(
                self.client,
                "PUT",
                "result",
                headers={"x-attempt-token": self.token},
                files={"file": ("video.mp4", media, "video/mp4")},
                timeout=150,
            )
