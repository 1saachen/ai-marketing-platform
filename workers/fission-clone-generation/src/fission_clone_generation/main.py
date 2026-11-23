from __future__ import annotations

import asyncio
import logging
import os
from functools import partial
from typing import Literal
from uuid import UUID

import aio_pika
from ai_runtime.seedance import SeedanceTransport
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .api import Api
from .health import marker
from .pipeline import process_generation
from .plan import validator
from .planning import BatchPlanner
from .provider import render_shot, render_source_edit
from .review import Reviewer

LOGGER = logging.getLogger(__name__)
QUEUE = "fission.clone.generation.requested"


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[1]
    projectId: UUID
    runId: UUID
    requestId: str = Field(min_length=1, max_length=200)


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


async def consume() -> None:
    url = required("INTERNAL_API_BASE_URL")
    token = required("FISSION_CLONE_GENERATION_WORKER_TOKEN")
    rabbit = required("RABBITMQ_URL")
    ark_key = required("ARK_API_KEY")
    ark_url = os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
    ffmpeg = os.getenv("FISSION_CLONE_FFMPEG_PATH") or "ffmpeg"
    ffprobe = os.getenv("FISSION_CLONE_FFPROBE_PATH") or "ffprobe"
    timeout = int(os.getenv("FISSION_CLONE_GENERATION_TIMEOUT_SECONDS", "900"))
    if not 30 <= timeout <= 1800:
        raise ValueError("invalid generation timeout")
    validator()
    validator("review")
    validator("variant-draft")
    validator("variant-shot-draft")
    validator("variant-review")
    connection = await aio_pika.connect_robust(rabbit)
    transport = SeedanceTransport(
        base_url=ark_url,
        api_key=ark_key,
        timeout_seconds=timeout,
        poll_interval_seconds=5,
        create_qps=0.5,
        download_concurrency=1,
        max_download_bytes=128 * 1024 * 1024,
    )
    reviewer = Reviewer(ark_url, ark_key, ffmpeg)
    planner = BatchPlanner(ark_url, ark_key)

    async def health() -> None:
        while True:
            if connection.connected.is_set():
                marker().touch()
            await asyncio.sleep(15)

    ticker = asyncio.create_task(health())
    try:
        channel = await connection.channel()
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(QUEUE, durable=True)
        LOGGER.info("clone generation worker ready")
        async with queue.iterator() as deliveries:
            async for delivery in deliveries:
                try:
                    async with delivery.process(requeue=True):
                        if len(delivery.body) > 4096:
                            LOGGER.warning("invalid clone generation delivery size")
                            continue
                        try:
                            event = Message.model_validate_json(delivery.body)
                        except ValidationError:
                            LOGGER.warning("invalid clone generation delivery")
                            continue
                        api = Api(url, token, str(event.projectId), str(event.runId))
                        try:
                            await process_generation(
                                api,
                                partial(render_shot, transport),
                                reviewer,
                                ffmpeg,
                                ffprobe,
                                planner,
                                render_source=partial(render_source_edit, transport),
                            )
                        finally:
                            await api.close()
                except Exception as error:  # noqa: BLE001 - isolate queue deliveries and log only the exception type.
                    LOGGER.warning(
                        "clone generation delivery interrupted type=%s",
                        type(error).__name__,
                    )
                    await asyncio.sleep(2)
    finally:
        ticker.cancel()
        await asyncio.gather(ticker, return_exceptions=True)
        marker().unlink(missing_ok=True)
        await reviewer.close()
        await planner.close()
        await transport.aclose()
        await connection.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    asyncio.run(consume())
