from __future__ import annotations

from uuid import UUID

from ai_runtime.internal_api import Api as SharedApi


class Api(SharedApi):
    def __init__(self, url: str, secret: str, project: str, task: str) -> None:
        UUID(project)
        UUID(task)
        super().__init__(url, secret, project, task, namespace="fission-clone-analysis")
