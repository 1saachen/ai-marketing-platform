from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from ai_runtime.seedance import ProviderError, SeedanceTransport

from .media import MAX_VIDEO_BYTES
from .provider import TaskFailure, _provider_origin, _signed_url

_TASK_ID = re.compile(r"cgt-[A-Za-z0-9_-]{1,120}")
_NATIVE_MODEL = re.compile(r"doubao-seedance-2-[05](?:-[a-z]+)?-[0-9]{6}")
_PICTURE_PROMPT = (
    "延续首帧中的单人讲解画面。保持人物身份、服装、景别、背景与光线，"
    "固定机位，正对镜头，口鼻清晰，无明显开口说话。保留自然呼吸和细微动作，"
    "手势从首帧的姿态自然延续，不跳切，不加入其他人物、文字或声音。"
)


class TailPictureProvider:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout_seconds: float = 600,
        poll_interval_seconds: float = 4,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("missing Seedance key")
        origin = _provider_origin(base_url, ("volces.com", "volcengine.com"))
        if urlsplit(origin).path != "/api/v3":
            raise ValueError("invalid Seedance API origin")
        self._transport = SeedanceTransport(
            base_url=origin,
            api_key=api_key,
            timeout_seconds=timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
            create_qps=1,
            download_concurrency=1,
            max_download_bytes=MAX_VIDEO_BYTES,
            transport=transport,
        )

    async def close(self) -> None:
        await self._transport.aclose()

    async def native_tail(self, task_id: str) -> str:
        if not _TASK_ID.fullmatch(task_id):
            raise TaskFailure("INVALID_TASK")
        try:
            receipt = await self._transport.read_task(task_id)
        except ProviderError as error:
            raise TaskFailure("PROVIDER_FAILED", retryable=error.retryable) from None
        content = receipt.get("content")
        model = receipt.get("model")
        if (
            receipt.get("status") != "succeeded"
            or not isinstance(model, str)
            or not _NATIVE_MODEL.fullmatch(model)
            or receipt.get("draft") is True
            or not isinstance(content, Mapping)
        ):
            raise TaskFailure("PROVIDER_REJECTED")
        frame = content.get("last_frame_url")
        if not isinstance(frame, str) or len(frame) > 4096:
            raise TaskFailure("PROVIDER_REJECTED")
        return _signed_url(frame)

    async def render(
        self,
        model: str,
        duration_seconds: int,
        first_frame: str | None,
        output: Path,
        accept: Callable[[str], Awaitable[None]],
        task_id: str | None = None,
    ) -> None:
        if not 4 <= duration_seconds <= 15 or not _NATIVE_MODEL.fullmatch(model):
            raise TaskFailure("INVALID_TASK")
        payload: dict[str, object] = {}
        if task_id is None:
            if not first_frame or len(first_frame) > 4096:
                raise TaskFailure("INVALID_TASK")
            payload = {
                "model": model,
                "duration": duration_seconds,
                "resolution": "480p",
                "ratio": "adaptive",
                "generate_audio": False,
                "return_last_frame": True,
                "content": [
                    {"type": "text", "text": _PICTURE_PROMPT},
                    {
                        "type": "image_url",
                        "role": "first_frame",
                        "image_url": {"url": _signed_url(first_frame)},
                    },
                ],
            }
        elif not _TASK_ID.fullmatch(task_id):
            raise TaskFailure("INVALID_TASK")

        accepted = task_id

        async def checkpoint(progress: int, provider_task_id: str | None) -> None:
            nonlocal accepted
            if progress != 10 or accepted is not None:
                return
            if not provider_task_id or not _TASK_ID.fullmatch(provider_task_id):
                raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
            await accept(provider_task_id)
            accepted = provider_task_id

        try:
            result = await self._transport.render_request(
                payload, output.name, checkpoint, task_id
            )
        except ProviderError as error:
            if accepted is None:
                if re.fullmatch(r"SEEDANCE_HTTP_4\d\d", error.code):
                    raise TaskFailure("PROVIDER_REJECTED") from None
                raise TaskFailure("PROVIDER_CREATION_UNKNOWN") from None
            raise TaskFailure(
                "PROVIDER_FAILED",
                retryable=error.retryable and not error.reset_provider_task,
            ) from None
        if (
            not accepted
            or result.provider_task_id != accepted
            or b"ftyp" not in result.content[:32]
            or result.duration is not None
            and abs(result.duration - duration_seconds) > 0.1
        ):
            raise TaskFailure("PROVIDER_FAILED")
        with output.open("xb") as file:
            file.write(result.content)
