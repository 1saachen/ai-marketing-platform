from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from shutil import which
from typing import Literal
from uuid import UUID

import aio_pika
from pydantic import BaseModel, ConfigDict, ValidationError

from .api import AvatarApi
from .health import marker
from .long_pipeline import process_long_sync_task
from .pipeline import ProviderPort, process_task, validator
from .provider import MEDIAKIT_ORIGIN, TTS_ORIGIN, TaskFailure, VolcProvider
from .render_pipeline import process_render_task
from .tail_provider import TailPictureProvider

QUEUES = {
    "sync": "fission.avatar.sync.requested",
    "render": "fission.avatar.render.requested",
    "long-sync": "fission.avatar.long-sync.requested",
    "long-render": "fission.avatar.long-render.requested",
}
RENDER_FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
ARK_ORIGIN = "https://ark.cn-beijing.volces.com/api/v3"
LOGGER = logging.getLogger(__name__)


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[1]
    projectId: UUID
    runId: UUID
    requestId: UUID


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def _bounded_timeout(name: str, default: int, maximum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not 30 <= value <= maximum:
        raise ValueError(f"{name} is outside its supported range")
    return value


def _tail_picture_provider() -> TailPictureProvider:
    try:
        return TailPictureProvider(
            base_url=os.getenv("ARK_BASE_URL") or ARK_ORIGIN,
            api_key=_required("ARK_API_KEY"),
            timeout_seconds=_bounded_timeout(
                "FISSION_AVATAR_TAIL_PICTURE_TIMEOUT_SECONDS", 600, 1800
            ),
        )
    except ValueError as error:
        raise TaskFailure("PROVIDER_FAILED", retryable=True) from error


async def handle_message(
    event: Message,
    *,
    mode: str,
    api_url: str,
    api_token: str,
    ffmpeg: str,
    ffprobe: str,
    font: Path,
    timeout: int,
    provider: ProviderPort | None = None,
) -> None:
    if mode not in QUEUES:
        raise ValueError("unsupported avatar worker mode")
    render = mode in {"render", "long-render"}
    api = AvatarApi(
        api_url, api_token, event.projectId, event.runId, event.requestId, render=render
    )
    try:
        if render:
            await process_render_task(
                api,
                ffmpeg,
                ffprobe,
                font=font,
                timeout=timeout,
                long_form=mode == "long-render",
            )
        elif provider is None:
            raise ValueError("avatar sync requires an explicitly configured provider")
        elif mode == "long-sync":
            await process_long_sync_task(
                api,
                provider,
                ffmpeg,
                ffprobe,
                timeout=timeout,
                picture_factory=_tail_picture_provider,
            )
        else:
            await process_task(api, provider, ffmpeg, ffprobe, timeout=timeout)
    finally:
        await api.close()


async def consume() -> None:
    api_url = _required("INTERNAL_API_BASE_URL")
    api_token = _required("FISSION_AVATAR_SYNC_WORKER_TOKEN")
    rabbit_url = _required("RABBITMQ_URL")
    ffmpeg = os.getenv("FISSION_AVATAR_FFMPEG_PATH") or "ffmpeg"
    ffprobe = os.getenv("FISSION_AVATAR_FFPROBE_PATH") or "ffprobe"
    mode = os.getenv("FISSION_AVATAR_WORKER_MODE", "sync")
    if mode not in QUEUES:
        raise ValueError(
            "FISSION_AVATAR_WORKER_MODE must be sync, render, long-sync or long-render"
        )
    provider: VolcProvider | None = None
    font = Path(os.getenv("FISSION_AVATAR_RENDER_FONT_PATH") or RENDER_FONT)
    if mode in {"render", "long-render"}:
        if not which(ffmpeg) or not which(ffprobe):
            raise ValueError("avatar render mode requires FFmpeg and FFprobe")
        if not font.is_file():
            raise ValueError("avatar render mode requires a Chinese font file")
        if mode == "long-render":
            timeout = _bounded_timeout(
                "FISSION_AVATAR_LONG_RENDER_TIMEOUT_SECONDS", 480, 1200
            )
            validator("worker-input", step="long-render")
            validator("completion", step="long-render")
        else:
            timeout = _bounded_timeout(
                "FISSION_AVATAR_RENDER_TIMEOUT_SECONDS", 180, 600
            )
            validator("worker-input", step="render")
            validator("completion", step="render")
    else:
        if mode == "long-sync":
            timeout = _bounded_timeout(
                "FISSION_AVATAR_LONG_SYNC_TIMEOUT_SECONDS", 2400, 7200
            )
            validator("worker-input", step="long-sync")
            validator("completion", step="long-sync")
            validator("worker-input", step="tail-chain")
            validator("checkpoint", step="tail-chain")
        else:
            timeout = _bounded_timeout("FISSION_AVATAR_SYNC_TIMEOUT_SECONDS", 900, 2400)
        for name in ("worker-input", "checkpoint", "completion"):
            validator(name)
        provider = VolcProvider(
            _required("VOLC_TTS_API_KEY"),
            _required("VOLC_MEDIAKIT_API_KEY"),
            tts_timeout=_bounded_timeout(
                "FISSION_AVATAR_TTS_TIMEOUT_SECONDS", 120, 600
            ),
            lip_timeout=_bounded_timeout(
                "FISSION_AVATAR_LIP_SYNC_TIMEOUT_SECONDS", 600, 1800
            ),
            tts_origin=os.getenv("FISSION_AVATAR_TTS_BASE_URL", TTS_ORIGIN),
            mediakit_origin=os.getenv(
                "FISSION_AVATAR_MEDIAKIT_BASE_URL", MEDIAKIT_ORIGIN
            ),
        )

    marker().unlink(missing_ok=True)
    try:
        connection = await aio_pika.connect_robust(rabbit_url)
    except BaseException:
        if provider is not None:
            await provider.close()
        raise

    async def health() -> None:
        while True:
            if connection.connected.is_set():
                marker().touch()
            await asyncio.sleep(15)

    ticker = None
    try:
        channel = await connection.channel()
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(QUEUES[mode], durable=True)
        async with queue.iterator() as deliveries:
            ticker = asyncio.create_task(health())
            LOGGER.info("avatar worker ready mode=%s", mode)
            async for delivery in deliveries:
                try:
                    async with delivery.process(requeue=True):
                        if len(delivery.body) > 4096:
                            LOGGER.warning("invalid avatar delivery size mode=%s", mode)
                            continue
                        try:
                            event = Message.model_validate_json(delivery.body)
                        except ValidationError:
                            LOGGER.warning("invalid avatar delivery mode=%s", mode)
                            continue
                        await handle_message(
                            event,
                            mode=mode,
                            api_url=api_url,
                            api_token=api_token,
                            ffmpeg=ffmpeg,
                            ffprobe=ffprobe,
                            font=font,
                            timeout=timeout,
                            provider=provider,
                        )
                # The delivery context requeues on errors. Isolate interrupted
                # attempts and log only their exception type.
                except Exception as error:  # noqa: BLE001
                    LOGGER.warning(
                        "avatar delivery interrupted mode=%s type=%s",
                        mode,
                        type(error).__name__,
                    )
                    await asyncio.sleep(2)
    finally:
        if ticker is not None:
            ticker.cancel()
            await asyncio.gather(ticker, return_exceptions=True)
        marker().unlink(missing_ok=True)
        if provider is not None:
            await provider.close()
        await connection.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    asyncio.run(consume())
