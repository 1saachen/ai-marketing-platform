"""Local MediaKit helpers for the bounded continuity experiment."""

from __future__ import annotations

import asyncio
import re
import wave
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
from continuity_media import Tools, check_alignment
from fission_avatar.media import (
    MAX_AUDIO_BYTES,
    MAX_DURATION_MS,
    MediaCheck,
)
from fission_avatar.provider import (
    _MEDIA_ID,
    _UPLOAD_HOSTS,
    TaskFailure,
    VolcProvider,
    _http_failure,
    _signed_url,
)

_HEADER_NAME = re.compile(r"[a-z0-9-]{1,128}")
_REJECTED_HEADERS = {
    "authorization",
    "cookie",
    "host",
    "proxy-authorization",
    "transfer-encoding",
}
_MP3_MIME = "audio/mpeg"
_WAV_MIME = "audio/wav"
_MIN_SAMPLE_RATE = 8_000
_MAX_SAMPLE_RATE = 48_000
_MIN_DURATION_MS = 200


def _validate_pcm16_mono(data: bytes) -> None:
    if (
        len(data) < 12
        or data[:4] != b"RIFF"
        or data[8:12] != b"WAVE"
        or int.from_bytes(data[4:8], "little") != len(data) - 8
    ):
        raise TaskFailure("MEDIA_INVALID")
    try:
        with wave.open(BytesIO(data), "rb") as stream:
            count, rate = stream.getnframes(), stream.getframerate()
            if (
                stream.getnchannels() != 1
                or stream.getsampwidth() != 2
                or stream.getcomptype() != "NONE"
                or not _MIN_SAMPLE_RATE <= rate <= _MAX_SAMPLE_RATE
                or not rate * _MIN_DURATION_MS <= count * 1000 <= rate * MAX_DURATION_MS
                or len(stream.readframes(count + 1)) != count * 2
            ):
                raise TaskFailure("MEDIA_INVALID")
    except (EOFError, wave.Error):
        raise TaskFailure("MEDIA_INVALID") from None


def _read_audio(path: Path) -> tuple[bytes, str]:
    extension = path.suffix.lower()
    if extension not in {".mp3", ".wav"}:
        raise TaskFailure("MEDIA_INVALID")
    try:
        with path.open("rb") as source:
            data = source.read(MAX_AUDIO_BYTES + 1)
    except OSError:
        raise TaskFailure("MEDIA_INVALID") from None
    if not 4 <= len(data) <= MAX_AUDIO_BYTES:
        raise TaskFailure("MEDIA_INVALID")
    if extension == ".wav":
        _validate_pcm16_mono(data)
        return data, _WAV_MIME
    # Files are prepared locally by FFmpeg. Reject obviously wrong formats before upload.
    frame_header = data[0] == 0xFF and data[1] & 0xE0 == 0xE0
    if not data.startswith(b"ID3") and not frame_header:
        raise TaskFailure("MEDIA_INVALID")
    return data, _MP3_MIME


def _upload_headers(raw: object, size: int, mime: str) -> dict[str, str]:
    if not isinstance(raw, list):
        raise TaskFailure("PROVIDER_FAILED")
    headers: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, dict):
            raise TaskFailure("PROVIDER_FAILED")
        name, value = item.get("key"), item.get("value")
        if not isinstance(name, str) or not isinstance(value, str):
            raise TaskFailure("PROVIDER_FAILED")
        key = name.lower()
        if (
            key in _REJECTED_HEADERS
            or key in headers
            or not _HEADER_NAME.fullmatch(key)
            or not 0 < len(value) <= 4096
            or any(not 32 <= ord(character) <= 126 for character in value)
        ):
            raise TaskFailure("PROVIDER_FAILED")
        headers[key] = value
    if headers.get("content-length", str(size)) != str(size):
        raise TaskFailure("PROVIDER_FAILED")
    content_type = headers.setdefault("content-type", mime)
    if content_type.split(";", 1)[0].strip().lower() != mime:
        raise TaskFailure("PROVIDER_FAILED")
    return headers


async def upload_audio(provider: VolcProvider, path: Path) -> str:
    """Upload a prepared MP3 or PCM16 mono WAV and return its ``mediakit://`` ID."""
    data, mime = _read_audio(path)
    # The production provider supports the same two-step transfer for video. Reuse
    # its request, credentials and host checks while the production path stays unchanged.
    try:
        payload = await provider._json(
            "POST",
            f"{provider._mediakit_origin}/tools-sync/request-media-upload-url",
            provider._mediakit_headers(),
            {},
        )
        result = payload.get("result")
        if payload.get("success") is not True or not isinstance(result, dict):
            raise TaskFailure("PROVIDER_FAILED")
        file_id = result.get("file_id")
        if (
            result.get("method") != "PUT"
            or not isinstance(file_id, str)
            or not _MEDIA_ID.fullmatch(file_id)
        ):
            raise TaskFailure("PROVIDER_FAILED")
        headers = _upload_headers(result.get("upload_headers"), len(data), mime)
        upload_url = _signed_url(result.get("upload_url"), _UPLOAD_HOSTS)
        async with asyncio.timeout(100):
            async with provider._client.stream(
                "PUT", upload_url, headers=headers, content=data, timeout=90
            ) as response:
                if not response.is_success:
                    raise _http_failure(response.status_code, False)
    except TaskFailure as error:
        raise TaskFailure(error.code, retryable=error.retryable) from None
    except (TimeoutError, httpx.HTTPError, ValueError, TypeError):
        raise TaskFailure("PROVIDER_FAILED", retryable=True) from None
    return file_id


async def download_alignment(
    provider: VolcProvider,
    task_id: str,
    audio_path: Path,
    output_path: Path,
    *,
    ffmpeg: str,
    ffprobe: str,
) -> MediaCheck:
    """Download a known task into a new file after checking tracks and drive audio."""
    if output_path.exists() or output_path.is_symlink():
        raise FileExistsError("alignment output path is already occupied")
    with TemporaryDirectory(prefix=".alignment-", dir=output_path.parent) as workdir:
        staged = Path(workdir) / "aligned.mp4"
        try:
            result = await provider.get_lip_sync_result(task_id)
            await provider.download(result.url, staged, kind="lip-sync")
        except TaskFailure as error:
            raise TaskFailure(error.code, retryable=error.retryable) from None
        audio_ms, video_ms, proof = await asyncio.to_thread(
            check_alignment,
            staged,
            audio_path,
            result.duration_ms,
            Tools(ffmpeg, ffprobe),
        )
        checked = MediaCheck(
            audio_ms,
            video_ms,
            proof["maxAbsAudioLagMs"],
            proof["minimumAudioCorrelationPermille"],
        )
        # This is a same-directory hard link, so an existing arm output is never replaced.
        output_path.hardlink_to(staged)
    return checked
