from __future__ import annotations

import asyncio
import json
from contextlib import ExitStack
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from ai_runtime.http import InternalApiError, request, unwrap

from .media import MAX_VIDEO_BYTES


class AvatarApi:
    def __init__(
        self,
        url: str,
        token: str,
        project: UUID,
        run: UUID,
        task: UUID,
        *,
        render: bool = False,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.token = ""
        tasks = "render/tasks" if render else "tasks"
        self._client = httpx.AsyncClient(
            base_url=f"{url.rstrip('/')}/internal/workers/fission-avatar/{project}/{run}/{tasks}/{task}/",
            headers={"x-worker-token": token},
            timeout=60,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        if not self.token:
            return {}
        return {"x-attempt-token": self.token}

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        # Reservation responses authorize paid requests once. A dropped reservation
        # response leaves the provider operation in an unknown state on redelivery.
        is_reservation = (
            (path == "checkpoint" or path.endswith("/checkpoint"))
            and body is not None
            and body.get("kind")
            in {"TTS_SUBMIT", "LIP_SYNC_SUBMIT", "TTS_STARTED", "PICTURE_STARTED"}
        )
        attempts = 1 if path == "claim" or is_reservation else 3
        for attempt in range(attempts):
            try:
                response = await request(
                    self._client,
                    method,
                    path,
                    headers=self._headers(),
                    json=body,
                    timeout=8,
                )
                raw = unwrap(response.json())
                if not isinstance(raw, dict):
                    raise TypeError("invalid internal response")
                return raw
            except (TypeError, ValueError) as error:
                raise InternalApiError(
                    "invalid internal response", retryable=False
                ) from error
            except InternalApiError as error:
                if not error.retryable or attempt == attempts - 1:
                    raise
                await asyncio.sleep(2**attempt)
        raise AssertionError("unreachable retry boundary")

    async def download_character(self, path: Path, expected_size: int) -> None:
        await self.download_file("character", path, expected_size, MAX_VIDEO_BYTES)

    async def download_file(
        self, route: str, path: Path, expected_size: int, maximum_size: int
    ) -> None:
        if not self.token or not 0 < expected_size <= maximum_size:
            raise InternalApiError("invalid frozen input size", retryable=False)
        size = 0
        try:
            async with asyncio.timeout(75):
                async with self._client.stream(
                    "GET",
                    route,
                    headers={**self._headers(), "Accept-Encoding": "identity"},
                ) as response:
                    if response.status_code != 200:
                        status = response.status_code
                        raise InternalApiError(
                            "frozen input is unavailable",
                            retryable=status == 429 or status >= 500,
                            status_code=status,
                        )
                    with path.open("wb") as target:
                        async for chunk in response.aiter_raw(64 * 1024):
                            size += len(chunk)
                            if size > expected_size:
                                raise InternalApiError(
                                    "frozen input size mismatch", retryable=False
                                )
                            target.write(chunk)
            if size != expected_size:
                raise InternalApiError("frozen input size mismatch", retryable=False)
        except BaseException as error:
            path.unlink(missing_ok=True)
            if isinstance(error, (TimeoutError, httpx.HTTPError, OSError)):
                raise InternalApiError(
                    "frozen input transfer failed", retryable=True
                ) from error
            raise

    async def complete(
        self,
        video: Path,
        audio: Path,
        metadata: dict[str, Any],
        *,
        route: str = "result",
    ) -> None:
        with video.open("rb") as picture, audio.open("rb") as voice:
            await request(
                self._client,
                "PUT",
                route,
                headers=self._headers(),
                data={
                    "metadata": json.dumps(
                        metadata, ensure_ascii=False, allow_nan=False
                    )
                },
                files={
                    "video": ("sync.mp4", picture, "video/mp4"),
                    "audio": ("speech.mp3", voice, "audio/mpeg"),
                },
                timeout=150,
            )

    async def complete_render(
        self, video: Path, subtitles: Path | None, metadata: dict[str, Any]
    ) -> None:
        with ExitStack() as files:
            picture = files.enter_context(video.open("rb"))
            parts = {"video": ("avatar.mp4", picture, "video/mp4")}
            if subtitles is not None:
                sidecar = files.enter_context(subtitles.open("rb"))
                parts["subtitles"] = ("avatar.srt", sidecar, "application/x-subrip")
            await request(
                self._client,
                "PUT",
                "result",
                headers=self._headers(),
                data={
                    "metadata": json.dumps(
                        metadata, ensure_ascii=False, allow_nan=False
                    )
                },
                files=parts,
                timeout=150,
            )
