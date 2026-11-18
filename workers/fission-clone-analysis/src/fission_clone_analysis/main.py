from __future__ import annotations

import asyncio
import logging
import os
from typing import Literal
from uuid import UUID

import aio_pika
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .api import Api
from .contracts import schema
from .health import marker_path
from .media import MediaLimits
from .pipeline import process_task
from .provider import Provider

LOGGER = logging.getLogger(__name__)


class QueueMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[1]
    projectId: UUID
    runId: UUID
    requestId: str = Field(min_length=1, max_length=200)

    @field_validator("schemaVersion", mode="before")
    @classmethod
    def reject_boolean_version(cls, value: object) -> object:
        if isinstance(value, bool):
            raise ValueError("schemaVersion must be an integer")  # noqa: TRY004 - Pydantic validators require ValueError.
        return value


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def integer(name: str, default: int, low: int, high: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not low <= value <= high:
        raise ValueError(f"{name} is out of range")
    return value


async def health_loop(connection: aio_pika.abc.AbstractRobustConnection) -> None:
    while True:
        if connection.connected.is_set():
            marker_path().touch()
        await asyncio.sleep(15)


async def consume() -> None:
    token, api_url, rabbit_url = (
        required("FISSION_CLONE_ANALYSIS_WORKER_TOKEN"),
        required("INTERNAL_API_BASE_URL"),
        required("RABBITMQ_URL"),
    )
    # Fail before consuming messages if the published schema files are absent.
    for name in [
        "fission-clone-analysis-report.schema.json",
        "fission-clone-mapping-draft.schema.json",
        "fission-clone-task-result.schema.json",
    ]:
        schema(name)
    provider = Provider(
        os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        required("ARK_API_KEY"),
        timeout=integer("FISSION_CLONE_ANALYSIS_TIMEOUT_SECONDS", 300, 30, 600),
        attempts=integer("FISSION_CLONE_ANALYSIS_MAX_ATTEMPTS", 2, 1, 3),
        max_output_tokens=integer(
            "FISSION_CLONE_ANALYSIS_MAX_OUTPUT_TOKENS", 16384, 1024, 32768
        ),
    )
    limits = MediaLimits(
        ffmpeg=os.getenv("FISSION_CLONE_FFMPEG_PATH", "ffmpeg") or "ffmpeg",
        ffprobe=os.getenv("FISSION_CLONE_FFPROBE_PATH", "ffprobe") or "ffprobe",
        max_frames=integer("FISSION_CLONE_ANALYSIS_MAX_FRAMES", 24, 2, 48),
    )
    connection = await aio_pika.connect_robust(rabbit_url)
    health: asyncio.Task[None] | None = None
    try:
        channel = await connection.channel(publisher_confirms=True)
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(
            "fission.clone.analysis.requested", durable=True
        )
        health = asyncio.create_task(health_loop(connection))
        LOGGER.info("Clone analysis worker ready; sampled visual evidence only")
        async with queue.iterator() as messages:
            async for message in messages:
                try:
                    async with message.process(requeue=True):
                        try:
                            if len(message.body) > 4096:
                                LOGGER.error("Oversized clone task message")
                                continue
                            event = QueueMessage.model_validate_json(message.body)
                        except ValidationError:
                            LOGGER.error("Invalid clone task message")
                            continue
                        api = Api(
                            api_url, token, str(event.projectId), str(event.runId)
                        )
                        LOGGER.info(
                            "Clone task received project=%s task=%s",
                            event.projectId,
                            event.runId,
                        )
                        try:
                            await process_task(api, provider, limits)
                        finally:
                            await api.close()
                except Exception as error:  # noqa: BLE001 - isolate queue deliveries; log only the exception type.
                    LOGGER.error(
                        "Clone delivery interrupted type=%s", type(error).__name__
                    )
                    await asyncio.sleep(2)
    finally:
        if health is not None:
            health.cancel()
            await asyncio.gather(health, return_exceptions=True)
        marker_path().unlink(missing_ok=True)
        await provider.close()
        await connection.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    # HTTP client debug logs may expose signed addresses or request bodies.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    asyncio.run(consume())
