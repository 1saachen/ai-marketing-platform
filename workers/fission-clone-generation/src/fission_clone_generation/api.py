from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import UUID

from ai_runtime.http import request, unwrap
from ai_runtime.internal_api import Api as InternalApi


_SHOT_SLOTS = {"0", "1", "2", "3"}
_MEDIA_SLOTS = {*_SHOT_SLOTS, "final", *(f"reference-{slot}" for slot in _SHOT_SLOTS)}


class Api(InternalApi):
    def __init__(self, url: str, secret: str, project: str, task: str) -> None:
        UUID(project)
        UUID(task)
        super().__init__(
            url, secret, project, task, namespace="fission-clone-generation"
        )

    async def source_video_url(self) -> str:
        return await self._signed_video_url("source-video-url")

    async def shot_reference_video_url(self, slot: str) -> str:
        if slot not in _SHOT_SLOTS:
            raise ValueError("invalid shot reference slot")
        return await self._signed_video_url(f"shot-reference/{slot}/url")

    async def _signed_video_url(self, route: str) -> str:
        if not self.token:
            raise ValueError("source video signing requires an active attempt")
        response = await request(
            self.client,
            "GET",
            route,
            headers={"x-attempt-token": self.token},
            params={"projectId": self.project},
            timeout=30,
        )
        value: object = unwrap(response.json())
        if not isinstance(value, dict) or not isinstance(value.get("url"), str):
            raise ValueError("source video signing returned an invalid response")
        return str(value["url"])

    async def upload(self, slot: str, path: Path) -> dict[str, Any]:
        if slot not in _MEDIA_SLOTS or not self.token:
            raise ValueError("invalid media checkpoint slot")
        with path.open("rb") as file:
            response = await request(
                self.client,
                "POST",
                f"media/{slot}",
                headers={"x-attempt-token": self.token},
                params={"projectId": self.project},
                files={"file": ("video.mp4", file, "video/mp4")},
                timeout=150,
            )
        result: dict[str, Any] = unwrap(response.json())
        return result
