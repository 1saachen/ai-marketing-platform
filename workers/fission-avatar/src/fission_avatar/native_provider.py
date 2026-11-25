from __future__ import annotations

import base64
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from ai_runtime.seedance import ProviderError, SeedanceTransport

from .media import MAX_VIDEO_BYTES
from .provider import TaskFailure, _provider_origin

NATIVE_MODEL = "doubao-seedance-2-5-flash-261115"
_TASK_ID = re.compile(r"cgt-[A-Za-z0-9_-]{1,120}")
_REJECTIONS = {400, 401, 403, 404, 422, 429}
_VOICE_GUIDANCE = "人物口播参考@音频1的声线，台词按上文文案。"


class NativeVideoProvider:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout_seconds: float = 900,
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

    async def render(
        self,
        model: str,
        prompt: str,
        duration_seconds: int,
        reference: dict[str, Any] | None,
        output: Path,
        accept: Callable[[str], Awaitable[None]],
        show_progress: Callable[[int], Awaitable[None]],
        task_id: str | None = None,
        *,
        reference_audio: tuple[Literal["audio/mpeg", "audio/wav"], bytes] | None = None,
    ) -> None:
        if model != NATIVE_MODEL or not 4 <= duration_seconds <= 30:
            raise TaskFailure("INVALID_TASK")
        payload: dict[str, Any] = {}
        if task_id is None:
            if reference is None:
                raise TaskFailure("INVALID_TASK")
            content = [{"type": "text", "text": prompt}, reference]
            if reference_audio is not None:
                mime_type, audio = reference_audio
                audio_format = "mp3" if mime_type == "audio/mpeg" else "wav"
                encoded = base64.b64encode(audio).decode("ascii")
                content[0]["text"] = f"{prompt}\n{_VOICE_GUIDANCE}"
                content.append(
                    {
                        "type": "audio_url",
                        "role": "reference_audio",
                        "audio_url": {"url": f"data:audio/{audio_format};base64,{encoded}"},
                    }
                )
            payload = {
                "model": model,
                "content": content,
                "duration": duration_seconds,
                "resolution": "480p",
                "ratio": "9:16",
                "generate_audio": True,
                "omni_reference_task_type": "reference",
            }
        elif not _TASK_ID.fullmatch(task_id):
            raise TaskFailure("INVALID_TASK")

        accepted = task_id

        async def checkpoint(progress: int, provider_task_id: str | None) -> None:
            nonlocal accepted
            if accepted is None:
                if not provider_task_id or not _TASK_ID.fullmatch(provider_task_id):
                    raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
                await accept(provider_task_id)
                accepted = provider_task_id
            elif accepted != provider_task_id:
                raise TaskFailure("PROVIDER_FAILED")
            await show_progress(progress)

        try:
            result = await self._transport.render_request(
                payload, output.name, checkpoint, task_id
            )
        except ProviderError as error:
            if accepted is None:
                status = re.fullmatch(r"SEEDANCE_HTTP_(\d{3})", error.code)
                if status and (number := int(status[1])) in _REJECTIONS:
                    raise TaskFailure(
                        "PROVIDER_REJECTED", retryable=number == 429
                    ) from None
                raise TaskFailure("PROVIDER_CREATION_UNKNOWN") from None
            raise TaskFailure(
                "PROVIDER_FAILED",
                retryable=error.retryable and not error.reset_provider_task,
            ) from None
        if (
            accepted is None
            or result.provider_task_id != accepted
            or b"ftyp" not in result.content[:32]
        ):
            raise TaskFailure("MEDIA_INVALID")
        with output.open("xb") as file:
            file.write(result.content)
