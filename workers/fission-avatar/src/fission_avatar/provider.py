from __future__ import annotations

import asyncio
import json
import math
import re
import time
import wave
from dataclasses import dataclass
from io import BytesIO
from itertools import pairwise
from pathlib import Path
from typing import Any, Literal, TypedDict
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from .media import MAX_AUDIO_BYTES, MAX_DURATION_MS, MAX_VIDEO_BYTES

TTS_ORIGIN = "https://openspeech.bytedance.com/api/v3/tts"
MEDIAKIT_ORIGIN = "https://mediakit.cn-beijing.volces.com/api/v1"
_TTS_HOSTS = ("bytedance.com", "volces.com", "volcengine.com")
_MEDIAKIT_HOSTS = ("volces.com", "volcengine.com")
_UPLOAD_HOSTS = ("volcvod.com", "volces.com", "volcengine.com")
_LIP_ID = re.compile(r"amk-tool-lip-sync-[a-zA-Z0-9_-]{1,120}")
_MEDIA_ID = re.compile(r"mediakit://[a-zA-Z0-9_-]{1,1024}")
_HOST = re.compile(
    r"(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}"
)
_REJECTED_HTTP = {400, 401, 403, 404, 413, 415, 422, 429}
_LONG_TTS_DURATION_MS = 90_000
_LONG_TTS_MAX_TIMINGS = 2880
_DRIVE_SAMPLE_RATE = 24_000


FailureCode = Literal[
    "MEDIA_INVALID",
    "PROVIDER_REJECTED",
    "PROVIDER_FAILED",
    "PROVIDER_CREATION_UNKNOWN",
    "INTERNAL_API_FAILED",
    "INVALID_TASK",
]


class TaskFailure(RuntimeError):
    def __init__(self, code: FailureCode, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


class Timing(TypedDict):
    text: str
    startMs: int
    endMs: int
    confidencePermille: int | None


@dataclass(frozen=True)
class Speech:
    url: str
    timings: list[Timing]


@dataclass(frozen=True)
class AlignedVideo:
    url: str
    duration_ms: int


def _signed_url(value: object, allowed_hosts: tuple[str, ...] = ()) -> str:
    if (
        not isinstance(value, str)
        or not value.isascii()
        or any(ch.isspace() or ch == "\\" for ch in value)
    ):
        raise TaskFailure("PROVIDER_FAILED")
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        if (
            url.scheme != "https"
            or not _HOST.fullmatch(host)
            or url.username is not None
            or url.port is not None
            or url.fragment
            or (
                allowed_hosts
                and not any(
                    host == domain or host.endswith(f".{domain}")
                    for domain in allowed_hosts
                )
            )
        ):
            raise TaskFailure("PROVIDER_FAILED")
    except ValueError as error:
        raise TaskFailure("PROVIDER_FAILED") from error
    return value


def _provider_origin(value: str, allowed_hosts: tuple[str, ...]) -> str:
    try:
        origin = _signed_url(value, allowed_hosts)
        if urlsplit(origin).query:
            raise TaskFailure("PROVIDER_FAILED")
        return origin.rstrip("/")
    except TaskFailure as error:
        raise ValueError("invalid avatar provider endpoint configuration") from error


def _http_failure(
    status: int, submitting: bool, *, retry_if_not_found: bool = False
) -> TaskFailure:
    if submitting:
        if status in _REJECTED_HTTP:
            return TaskFailure("PROVIDER_REJECTED")
        return TaskFailure("PROVIDER_CREATION_UNKNOWN")
    return TaskFailure(
        "PROVIDER_FAILED",
        retryable=status == 429
        or status >= 500
        or (status == 404 and retry_if_not_found),
    )


def _read_upload(path: Path, limit: int) -> bytes:
    try:
        with path.open("rb") as source:
            data = source.read(limit + 1)
    except OSError as error:
        raise TaskFailure("MEDIA_INVALID") from error
    if not 0 < len(data) <= limit:
        raise TaskFailure("MEDIA_INVALID")
    return data


def _ms(seconds: object, max_duration_ms: int = MAX_DURATION_MS) -> int | None:
    if (
        isinstance(seconds, (int, float))
        and not isinstance(seconds, bool)
        and 0 <= seconds <= max_duration_ms / 1000
    ):
        return round(seconds * 1000)
    return None


def _timings(
    sentences: object, max_duration_ms: int = MAX_DURATION_MS, max_timings: int = 240
) -> list[Timing]:
    if not isinstance(sentences, list):
        raise TaskFailure("PROVIDER_FAILED")
    timings: list[Timing] = []
    for sentence in sentences:
        if not isinstance(sentence, dict) or not isinstance(
            sentence.get("words"), list
        ):
            continue
        for word in sentence["words"]:
            if not isinstance(word, dict):
                continue
            text = word.get("word")
            start = _ms(word.get("startTime"), max_duration_ms)
            end = _ms(word.get("endTime"), max_duration_ms)
            if (
                not isinstance(text, str)
                or not 1 <= len(text.strip()) <= 80
                or any(ord(char) < 32 or ord(char) == 127 for char in text)
                or start is None
                or end is None
                or start >= end
            ):
                continue
            confidence = word.get("confidence")
            permille = (
                round(confidence * 1000)
                if isinstance(confidence, (int, float))
                and not isinstance(confidence, bool)
                and math.isfinite(confidence)
                and 0 <= confidence <= 1
                else None
            )
            timings.append(
                {
                    "text": text.strip(),
                    "startMs": start,
                    "endMs": end,
                    "confidencePermille": permille,
                }
            )
    if not 1 <= len(timings) <= max_timings or any(
        current["startMs"] < previous["startMs"]
        for previous, current in pairwise(timings)
    ):
        raise TaskFailure("PROVIDER_FAILED")
    return timings


class VolcProvider:
    def __init__(
        self,
        tts_key: str,
        mediakit_key: str,
        *,
        tts_timeout: int = 120,
        lip_timeout: int = 600,
        tts_origin: str = TTS_ORIGIN,
        mediakit_origin: str = MEDIAKIT_ORIGIN,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._tts_key = tts_key
        self._mediakit_key = mediakit_key
        self._tts_timeout = tts_timeout
        self._lip_timeout = lip_timeout
        self._tts_origin = _provider_origin(tts_origin, _TTS_HOSTS)
        self._mediakit_origin = _provider_origin(mediakit_origin, _MEDIAKIT_HOSTS)
        self._client = httpx.AsyncClient(
            timeout=30, follow_redirects=False, trust_env=False, transport=transport
        )

    async def close(self) -> None:
        await self._client.aclose()

    def _tts_headers(self) -> dict[str, str]:
        return {
            "X-Api-Key": self._tts_key,
            "X-Api-Resource-Id": "seed-tts-2.0",
            "X-Api-Request-Id": str(uuid4()),
        }

    def _mediakit_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._mediakit_key}"}

    async def _json(
        self,
        method: Literal["GET", "POST"],
        url: str,
        headers: dict[str, str],
        body: dict[str, Any] | None = None,
        *,
        submitting: bool = False,
        retry_if_not_found: bool = False,
    ) -> dict[str, Any]:
        try:
            async with asyncio.timeout(35):
                async with self._client.stream(
                    method, url, headers=headers, json=body
                ) as response:
                    if response.status_code != 200:
                        raise _http_failure(
                            response.status_code,
                            submitting,
                            retry_if_not_found=retry_if_not_found,
                        )
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > 512 * 1024:
                            raise ValueError("provider response exceeded size limit")
            payload = json.loads(data)
            if not isinstance(payload, dict):
                raise TypeError("provider response is not an object")
            return payload
        except (TimeoutError, httpx.HTTPError, TypeError, ValueError) as error:
            if submitting:
                raise TaskFailure("PROVIDER_CREATION_UNKNOWN") from error
            raise TaskFailure(
                "PROVIDER_FAILED",
                retryable=isinstance(error, (TimeoutError, httpx.HTTPError)),
            ) from error

    async def submit_tts(self, operation_id: str, script: str, speaker: str) -> None:
        payload = await self._json(
            "POST",
            f"{self._tts_origin}/submit",
            self._tts_headers(),
            {
                "user": {"uid": "20261124"},
                "unique_id": operation_id,
                "req_params": {
                    "text": script,
                    "speaker": speaker,
                    "audio_params": {
                        "format": "mp3",
                        "sample_rate": 24000,
                        "enable_timestamp": True,
                    },
                    "additions": "{}",
                },
            },
            submitting=True,
        )
        data = payload.get("data")
        if payload.get("code") != 20_000_000:
            raise TaskFailure("PROVIDER_REJECTED")
        if not isinstance(data, dict) or data.get("task_id") != operation_id:
            raise TaskFailure("PROVIDER_CREATION_UNKNOWN")

    async def get_tts_result(self, operation_id: str) -> Speech:
        return await self._get_tts_result(operation_id, MAX_DURATION_MS, 240)

    async def get_long_tts_result(self, operation_id: str) -> Speech:
        return await self._get_tts_result(
            operation_id, _LONG_TTS_DURATION_MS, _LONG_TTS_MAX_TIMINGS
        )

    async def _get_tts_result(
        self, operation_id: str, max_duration_ms: int, max_timings: int
    ) -> Speech:
        deadline = time.monotonic() + self._tts_timeout
        while time.monotonic() < deadline:
            payload = await self._json(
                "POST",
                f"{self._tts_origin}/query",
                self._tts_headers(),
                {"task_id": operation_id},
            )
            if payload.get("code") == 40_000_001:
                raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
            data = payload.get("data")
            if (
                payload.get("code") != 20_000_000
                or not isinstance(data, dict)
                or data.get("task_id") != operation_id
            ):
                raise TaskFailure("PROVIDER_FAILED")
            if data.get("task_status") == 2:
                return Speech(
                    _signed_url(data.get("audio_url")),
                    _timings(data.get("sentences"), max_duration_ms, max_timings),
                )
            if data.get("task_status") != 1:
                raise TaskFailure("PROVIDER_FAILED")
            await asyncio.sleep(2)
        raise TaskFailure("PROVIDER_FAILED", retryable=True)

    async def upload_character(self, character: Path) -> str:
        data = _read_upload(character, MAX_VIDEO_BYTES)
        return await self._upload_media(data, "video/mp4")

    async def upload_drive_audio(self, wav: Path) -> str:
        data = _read_upload(wav, MAX_AUDIO_BYTES)
        try:
            with wave.open(BytesIO(data), "rb") as sound:
                frames = sound.getnframes()
                if (
                    sound.getnchannels() != 1
                    or sound.getsampwidth() != 2
                    or sound.getframerate() != _DRIVE_SAMPLE_RATE
                    or frames % _DRIVE_SAMPLE_RATE != 0
                    or not 4 <= frames // _DRIVE_SAMPLE_RATE <= 15
                    or len(sound.readframes(frames)) != frames * 2
                ):
                    raise TaskFailure("MEDIA_INVALID")
        except (EOFError, wave.Error) as error:
            raise TaskFailure("MEDIA_INVALID") from error
        return await self._upload_media(data, "audio/wav")

    async def _upload_media(self, data: bytes, mime: str) -> str:
        payload = await self._json(
            "POST",
            f"{self._mediakit_origin}/tools-sync/request-media-upload-url",
            self._mediakit_headers(),
            {},
        )
        result = payload.get("result")
        if payload.get("success") is not True or not isinstance(result, dict):
            raise TaskFailure("PROVIDER_FAILED")
        file_id, raw_headers = result.get("file_id"), result.get("upload_headers")
        if (
            result.get("method") != "PUT"
            or not isinstance(file_id, str)
            or not _MEDIA_ID.fullmatch(file_id)
            or not isinstance(raw_headers, list)
        ):
            raise TaskFailure("PROVIDER_FAILED")
        upload_url = _signed_url(result.get("upload_url"), _UPLOAD_HOSTS)
        headers: dict[str, str] = {}
        for item in raw_headers:
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("key"), str)
                or not isinstance(item.get("value"), str)
            ):
                raise TaskFailure("PROVIDER_FAILED")
            key, value = item["key"].lower(), item["value"]
            if (
                key
                in {
                    "authorization",
                    "cookie",
                    "proxy-authorization",
                    "host",
                    "transfer-encoding",
                }
                or not re.fullmatch(r"[a-z0-9-]{1,128}", key)
                or "\r" in value
                or "\n" in value
            ):
                raise TaskFailure("PROVIDER_FAILED")
            headers[key] = value
        content_type = headers.setdefault("content-type", mime)
        if mime == "audio/wav" and (
            content_type.split(";", 1)[0].strip().lower() != mime
            or headers.get("content-length", str(len(data))) != str(len(data))
        ):
            raise TaskFailure("PROVIDER_FAILED")
        try:
            async with asyncio.timeout(100):
                async with self._client.stream(
                    "PUT", upload_url, headers=headers, content=data, timeout=90
                ) as response:
                    if not response.is_success:
                        raise _http_failure(response.status_code, False)
        except (TimeoutError, httpx.HTTPError, TypeError, ValueError) as error:
            raise TaskFailure("PROVIDER_FAILED", retryable=True) from error
        return file_id

    async def submit_lip_sync(
        self, client_token: str, file_id: str, audio_url: str
    ) -> str:
        payload = await self._json(
            "POST",
            f"{self._mediakit_origin}/tools/lip-sync",
            self._mediakit_headers(),
            {
                "client_token": client_token,
                "video_url": file_id,
                "audio_url": audio_url,
                "enable_video_loop": False,
            },
            submitting=True,
        )
        task_id = payload.get("task_id")
        if payload.get("success") is False and not task_id:
            raise TaskFailure("PROVIDER_REJECTED")
        if (
            payload.get("success") is not True
            or not isinstance(task_id, str)
            or not _LIP_ID.fullmatch(task_id)
        ):
            raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
        return task_id

    async def get_lip_sync_result(self, task_id: str) -> AlignedVideo:
        if not _LIP_ID.fullmatch(task_id):
            raise TaskFailure("INVALID_TASK")
        started = time.monotonic()
        deadline = started + self._lip_timeout
        while time.monotonic() < deadline:
            try:
                payload = await self._json(
                    "GET",
                    f"{self._mediakit_origin}/tasks/{task_id}",
                    self._mediakit_headers(),
                    retry_if_not_found=time.monotonic() < started + 15,
                )
            except TaskFailure as error:
                if not error.retryable:
                    raise
                await asyncio.sleep(min(5, max(0, deadline - time.monotonic())))
                continue
            if (
                payload.get("success") is not True
                or payload.get("task_id") != task_id
                or payload.get("task_type") not in (None, "lip-sync")
            ):
                raise TaskFailure("PROVIDER_FAILED")
            if payload.get("status") == "completed":
                value = payload.get("result")
                if not isinstance(value, dict):
                    raise TaskFailure("PROVIDER_FAILED")
                duration = _ms(value.get("duration"))
                if duration is None or duration <= 0:
                    raise TaskFailure("PROVIDER_FAILED")
                return AlignedVideo(_signed_url(value.get("video_url")), duration)
            if payload.get("status") != "running":
                raise TaskFailure("PROVIDER_FAILED")
            await asyncio.sleep(5)
        raise TaskFailure("PROVIDER_FAILED", retryable=True)

    async def download(
        self, url: str, path: Path, *, kind: Literal["speech", "lip-sync"]
    ) -> None:
        limit = MAX_AUDIO_BYTES if kind == "speech" else MAX_VIDEO_BYTES
        size = 0
        try:
            async with asyncio.timeout(100):
                async with self._client.stream(
                    "GET", _signed_url(url), timeout=90
                ) as response:
                    if response.status_code != 200:
                        raise _http_failure(response.status_code, False)
                    with path.open("wb") as handle:
                        async for chunk in response.aiter_bytes(64 * 1024):
                            size += len(chunk)
                            if size > limit:
                                raise TaskFailure("PROVIDER_FAILED")
                            handle.write(chunk)
            if size == 0:
                raise TaskFailure("PROVIDER_FAILED")
        except BaseException as error:
            path.unlink(missing_ok=True)
            if isinstance(error, (TimeoutError, httpx.HTTPError, OSError)):
                raise TaskFailure("PROVIDER_FAILED", retryable=True) from error
            raise
