from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import UUID

from ai_runtime.http import request, unwrap
from ai_runtime.internal_api import Api as InternalApi


class Api(InternalApi):
    def __init__(self, url: str, secret: str, project: str, task: str) -> None:
        UUID(project)
        UUID(task)
        super().__init__(
            url, secret, project, task, namespace="fission-clone-generation"
        )

    async def upload(self, slot: str, path: Path) -> dict[str, Any]:
        if slot not in {"0", "1", "2", "3", "final"} or not self.token:
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
