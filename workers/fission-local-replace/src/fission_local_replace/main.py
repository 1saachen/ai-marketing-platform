from __future__ import annotations

import asyncio
import logging
import os
from typing import Literal
from uuid import UUID

import aio_pika
from ai_runtime.seedance import SeedanceTransport
from pydantic import BaseModel, ConfigDict, ValidationError

from .api import Api
from .health import marker
from .media import MAX_OUTPUT_BYTES
from .pipeline import process_task, validator

QUEUE = "fission.local_replace.requested"
LOGGER = logging.getLogger(__name__)


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[1]
    projectId: UUID
    runId: UUID
    requestId: UUID


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


async def consume() -> None:
    api_url = required("INTERNAL_API_BASE_URL")
    api_token = required("FISSION_LOCAL_REPLACE_WORKER_TOKEN")
    rabbit_url = required("RABBITMQ_URL")
    ark_key = required("ARK_API_KEY")
    ark_url = os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
    ffmpeg = os.getenv("FISSION_LOCAL_REPLACE_FFMPEG_PATH") or "ffmpeg"
    ffprobe = os.getenv("FISSION_LOCAL_REPLACE_FFPROBE_PATH") or "ffprobe"
    timeout = int(os.getenv("FISSION_LOCAL_REPLACE_TIMEOUT_SECONDS", "900"))
    if not 30 <= timeout <= 1800:
        raise ValueError("invalid local replacement timeout")
    validator()
    marker().unlink(missing_ok=True)
    connection = await aio_pika.connect_robust(rabbit_url)
    transport = SeedanceTransport(
        base_url=ark_url,
        api_key=ark_key,
        timeout_seconds=timeout,
        poll_interval_seconds=5,
        create_qps=0.5,
        download_concurrency=1,
        max_download_bytes=MAX_OUTPUT_BYTES,
    )

    async def health() -> None:
        while True:
            if connection.connected.is_set():
                marker().touch()
            await asyncio.sleep(15)

    ticker = None
    try:
        channel = await connection.channel()
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(QUEUE, durable=True)
        async with queue.iterator() as deliveries:
            ticker = asyncio.create_task(health())
            LOGGER.info("local replacement worker ready")
            async for delivery in deliveries:
                try:
                    async with delivery.process(requeue=True):
                        if len(delivery.body) > 4096:
                            LOGGER.warning("invalid local replacement delivery size")
                            continue
                        try:
                            event = Message.model_validate_json(delivery.body)
                        except ValidationError:
                            LOGGER.warning("invalid local replacement delivery")
                            continue
                        api = Api(
                            api_url,
                            api_token,
                            event.projectId,
                            event.runId,
                            event.requestId,
                        )
                        try:
                            await process_task(api, transport, ffmpeg, ffprobe)
                        finally:
                            await api.close()
                except Exception as error:
                    LOGGER.warning(
                        "local replacement delivery interrupted type=%s",
                        type(error).__name__,
                    )
                    await asyncio.sleep(2)
    finally:
        if ticker is not None:
            ticker.cancel()
            await asyncio.gather(ticker, return_exceptions=True)
        marker().unlink(missing_ok=True)
        await transport.aclose()
        await connection.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    asyncio.run(consume())
