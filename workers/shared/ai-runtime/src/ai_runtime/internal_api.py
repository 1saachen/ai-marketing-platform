from __future__ import annotations
import asyncio
import hashlib
import time
from pathlib import Path
from typing import Any
from uuid import UUID
import httpx
from ai_runtime.http import InternalApiError, request, unwrap


class Api:
    def __init__(self, url: str, secret: str, project: str, task: str, namespace: str = 'customized-storyboard') -> None:
        self.client = httpx.AsyncClient(
            base_url=f"{url.rstrip('/')}/internal/workers/{namespace}/tasks/{task}/",
            headers={"x-worker-token": secret},
            timeout=60,
        )
        self.project = project
        self.token = ""

    async def call(
        self, method: str, path: str, value: dict[str, Any] | None = None
    ) -> Any:
        # All worker endpoints are idempotent and fenced by attemptToken. Keep a
        # completed paid response in memory across short API restarts instead of
        # discarding it and paying for generation again after lease recovery.
        deadline = time.monotonic() + 40
        for attempt in range(6):
            try:
                response = await request(
                    self.client,
                    method,
                    path,
                    headers={"x-attempt-token": self.token},
                    json={"projectId": self.project, **(value or {})},
                    timeout=min(10, max(0.1, deadline - time.monotonic())),
                )
                return unwrap(response.json())
            except InternalApiError as error:
                delay = min(8, 2**attempt)
                if (
                    not error.retryable
                    or attempt == 5
                    or time.monotonic() + delay >= deadline
                ):
                    raise
                await asyncio.sleep(delay)
        raise AssertionError("unreachable retry boundary")

    async def close(self) -> None:
        await self.client.aclose()

    async def download(
        self,
        file_id: str,
        destination: Path,
        *,
        expected_size: int,
        expected_sha256: str,
        limit: int = 256 * 1024 * 1024,
    ) -> None:
        UUID(file_id)
        if (
            not self.token
            or not 0 < expected_size <= limit
            or len(expected_sha256) != 64
            or any(char not in "0123456789abcdef" for char in expected_sha256)
        ):
            raise InternalApiError("invalid frozen file identity", retryable=False)
        digest = hashlib.sha256()
        count = 0
        try:
            async with self.client.stream(
                "GET",
                f"files/{file_id}/content",
                params={"projectId": self.project},
                headers={"x-attempt-token": self.token},
                timeout=60,
                follow_redirects=False,
            ) as response:
                if response.status_code != 200:
                    raise InternalApiError(
                        "source content unavailable",
                        retryable=response.status_code == 429
                        or response.status_code >= 500,
                        status_code=response.status_code,
                    )
                with destination.open("wb") as target:
                    async for chunk in response.aiter_bytes(64 * 1024):
                        count += len(chunk)
                        if count > expected_size or count > limit:
                            raise InternalApiError(
                                "source content exceeds bounds", retryable=False
                            )
                        digest.update(chunk)
                        target.write(chunk)
            if count != expected_size or digest.hexdigest() != expected_sha256:
                raise InternalApiError(
                    "source content identity mismatch", retryable=False
                )
        except (httpx.HTTPError, OSError) as exc:
            destination.unlink(missing_ok=True)
            raise InternalApiError(
                "source content transfer failed", retryable=True
            ) from exc
        except BaseException:
            destination.unlink(missing_ok=True)
            raise
