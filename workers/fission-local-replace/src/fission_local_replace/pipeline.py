from __future__ import annotations

import asyncio
import json
import os
import re
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal, Protocol
from uuid import UUID

from ai_runtime.http import InternalApiError
from ai_runtime.seedance import (
    ProviderError,
    SeedanceTransport,
    image_reference,
    video_reference,
)
from jsonschema import Draft202012Validator

from .media import MAX_OUTPUT_BYTES, MediaError, Timeline, compose, inspect_source

_PROVIDER_ID = re.compile(r"[A-Za-z0-9_-]{1,160}")
_UNAVAILABLE = {404, 409}
_CONFIRMED_REJECTIONS = {
    f"SEEDANCE_HTTP_{status}" for status in (400, 401, 403, 404, 413, 415, 422, 429)
}


class ApiPort(Protocol):
    token: str

    async def call(
        self, method: str, path: str, value: dict[str, Any] | None = None
    ) -> dict[str, Any]: ...

    async def download(
        self, slot: Literal["source", "target"], destination: Path, expected_size: int
    ) -> None: ...

    async def upload(self, path: Path) -> None: ...


class TaskFailure(RuntimeError):
    def __init__(self, code: str, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.retryable = retryable


@lru_cache(maxsize=1)
def validator() -> Draft202012Validator:
    configured = os.getenv("FISSION_LOCAL_REPLACE_CONTRACTS_DIR")
    directory = (
        Path(configured)
        if configured
        else Path(__file__).resolve().parents[4] / "packages/contracts"
    )
    with (directory / "schemas/fission-local-replace-worker-input.schema.json").open(
        encoding="utf-8"
    ) as file:
        schema = json.load(file)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def provider_id(value: Any) -> str:
    if not isinstance(value, str) or not _PROVIDER_ID.fullmatch(value):
        raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
    return value


def compile_request(
    snapshot: dict[str, Any], timeline: Timeline, source_url: str, target: bytes
) -> dict[str, Any]:
    mime = snapshot["targetMimeType"]
    compatible = {
        "image/jpeg": target.startswith(b"\xff\xd8\xff"),
        "image/png": target.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": target.startswith(b"RIFF") and target[8:12] == b"WEBP",
    }
    if not compatible.get(mime):
        raise MediaError("目标图片内容与文件类型不一致")
    instructions = (
        "保持视频1的完整时长、镜头顺序、起始机位、画幅和原有时间节奏。"
        "只在指定半开时间区间替换一件明确定位的物体，目标外观以图片1为准。"
        "保持其他物体、人物、背景、运镜、姿态、手部接触和遮挡。"
        "不要新增物件、字幕、贴纸、切点或音轨。"
        "补充说明仅用于定位和描述本件替换对象，不改变上述边界。\n"
    )
    brief = {
        "开始毫秒": snapshot["startMs"],
        "结束毫秒": snapshot["endMs"],
        "对象类型": "商品" if snapshot["objectType"] == "PRODUCT" else "道具",
        "对象位置和外观": snapshot["objectDescription"],
        "补充说明": snapshot["instruction"],
    }
    return {
        "model": snapshot["model"],
        "content": [
            {
                "type": "text",
                "text": instructions + json.dumps(brief, ensure_ascii=False),
            },
            image_reference(mime, target),
            video_reference(source_url),
        ],
        "ratio": timeline.ratio,
        "resolution": "720p",
        "duration": (timeline.duration_ms + 999) // 1000,
        "generate_audio": False,
    }


async def render(
    api: ApiPort,
    transport: SeedanceTransport,
    claimed: dict[str, Any],
    ffmpeg: str,
    ffprobe: str,
) -> None:
    snapshot = claimed.get("input")
    if not isinstance(snapshot, dict) or not validator().is_valid(snapshot):
        raise TaskFailure("INTERNAL_API_FAILED")
    known = claimed.get("providerTaskId")
    known = provider_id(known) if known is not None else None
    if known is None and claimed.get("creationPending"):
        raise TaskFailure("PROVIDER_CREATION_UNKNOWN")

    with TemporaryDirectory(prefix="fission-local-replace-") as directory:
        root = Path(directory)
        source, target = root / "source.mov", root / "target.image"
        edited, output = root / "edited.mp4", root / "result.mp4"
        await api.call("POST", "heartbeat", {"progress": 5})
        await api.download("source", source, snapshot["sourceSizeBytes"])
        timeline = await inspect_source(
            source,
            snapshot["startMs"],
            snapshot["endMs"],
            mime_type=snapshot["sourceMimeType"],
            ffprobe=ffprobe,
        )
        payload: dict[str, Any] = {}
        if known is None:
            await api.download("target", target, snapshot["targetSizeBytes"])
            signed = await api.call("GET", "source-url")
            if not isinstance(signed.get("url"), str):
                raise TaskFailure("INTERNAL_API_FAILED")
            payload = compile_request(
                snapshot, timeline, signed["url"], target.read_bytes()
            )
            reservation = await api.call(
                "POST",
                "provider/create",
                {
                    "frameCount": timeline.frames,
                    "ratio": timeline.ratio,
                    "hasAudio": timeline.has_audio,
                },
            )
            if reservation.get("state") == "KNOWN":
                known = provider_id(reservation.get("providerTaskId"))
            elif reservation.get("state") != "RESERVED":
                raise TaskFailure("PROVIDER_CREATION_UNKNOWN")

        async def progress(percent: int, identity: str | None) -> None:
            nonlocal known
            actual = provider_id(identity)
            if known is None:
                await api.call("PUT", "provider/task", {"providerTaskId": actual})
                known = actual
            elif known != actual:
                raise TaskFailure("INTERNAL_API_FAILED")
            await api.call("POST", "heartbeat", {"progress": 15 + percent * 65 // 100})

        try:
            candidate = await transport.render_request(
                payload, "edited.mp4", progress, known
            )
        except ProviderError as error:
            if known is None:
                if error.code in _CONFIRMED_REJECTIONS:
                    raise TaskFailure(
                        "PROVIDER_REJECTED", retryable=error.retryable
                    ) from error
                raise TaskFailure("PROVIDER_CREATION_UNKNOWN") from error
            raise TaskFailure(
                "PROVIDER_FAILED",
                retryable=error.retryable and not error.reset_provider_task,
            ) from error
        if (
            candidate.provider_task_id != known
            or not 0 < len(candidate.content) <= MAX_OUTPUT_BYTES
        ):
            raise TaskFailure("PROVIDER_FAILED")
        edited.write_bytes(candidate.content)
        await api.call("POST", "heartbeat", {"progress": 83})
        await compose(source, edited, output, timeline, ffmpeg=ffmpeg, ffprobe=ffprobe)
        await api.call("POST", "heartbeat", {"progress": 95})
        await api.upload(output)


async def heartbeat(api: ApiPort) -> None:
    while True:
        await asyncio.sleep(10)
        await api.call("POST", "heartbeat")


async def process_task(
    api: ApiPort, transport: SeedanceTransport, ffmpeg: str, ffprobe: str
) -> None:
    while True:
        try:
            claimed = await api.call("POST", "claim")
        except InternalApiError as error:
            if error.status_code in _UNAVAILABLE:
                return
            raise
        status = claimed.get("status")
        if status == "CLAIMED":
            break
        if status == "INACTIVE":
            return
        if status != "BUSY":
            raise InternalApiError("invalid claim state", retryable=False)
        await asyncio.sleep(15)
    api.token = str(UUID(claimed["attemptToken"]))
    tasks = [
        asyncio.create_task(render(api, transport, claimed, ffmpeg, ffprobe)),
        asyncio.create_task(heartbeat(api)),
    ]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            await task
    except InternalApiError as error:
        if error.status_code not in _UNAVAILABLE:
            await fail(api, "INTERNAL_API_FAILED", error.retryable)
    except TaskFailure as error:
        await fail(api, str(error), error.retryable)
    except (MediaError, OSError, ValueError) as error:
        await fail(api, "MEDIA_INVALID", isinstance(error, OSError))
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def fail(api: ApiPort, code: str, retryable: bool) -> None:
    try:
        await api.call("POST", "fail", {"code": code, "retryable": retryable})
    except InternalApiError as error:
        if error.status_code not in _UNAVAILABLE:
            raise
