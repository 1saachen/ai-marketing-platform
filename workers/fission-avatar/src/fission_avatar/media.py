from __future__ import annotations

import asyncio
import json
import math
from array import array
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from sys import byteorder
from typing import Any

MAX_VIDEO_BYTES = 64 * 1024 * 1024
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_DURATION_MS = 30_000
MIN_CORRELATION_PERMILLE = 980
MAX_AUDIO_LAG_MS = 100
_AUDIO_RATE = 4_000
_MOV = ("-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0")
_MP3 = ("-protocol_whitelist", "file,pipe", "-f", "mp3")


class MediaError(ValueError):
    """Media could not be safely read or did not meet synchronization checks."""


@dataclass(frozen=True)
class MediaCheck:
    audio_duration_ms: int
    video_duration_ms: int
    audio_lag_ms: int
    minimum_audio_correlation_permille: int


async def _run(
    *args: str, capture: bool = False, cwd: Path | None = None, timeout: int = 90
) -> bytes:
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=cwd,
        )
    except OSError as error:
        raise MediaError("media tool unavailable") from error
    try:
        async with asyncio.timeout(timeout):
            output, _ = await process.communicate()
    except (TimeoutError, asyncio.CancelledError) as error:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.communicate()
        if isinstance(error, TimeoutError):
            raise MediaError("media tool timed out") from error
        raise
    if process.returncode:
        raise MediaError("media tool failed")
    return output or b""


async def _streams(
    path: Path, ffprobe: str, *, audio_only: bool = False
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    data = await _run(
        ffprobe,
        "-v",
        "error",
        *(_MP3 if audio_only else _MOV),
        "-show_entries",
        "stream=codec_type,codec_name,width,height,color_transfer,pix_fmt,avg_frame_rate,sample_aspect_ratio,"
        "start_time,duration:stream_side_data=rotation:format=duration:format_tags=major_brand",
        "-of",
        "json",
        str(path),
        capture=True,
    )
    try:
        media = json.loads(data)
        container = media["format"]
        streams = media["streams"]
        if not isinstance(container, dict) or not isinstance(streams, list):
            raise TypeError("invalid probe")
        if any(not isinstance(stream, dict) for stream in streams):
            raise TypeError("invalid probe stream")
        return container, streams
    except (KeyError, TypeError, ValueError) as error:
        raise MediaError("invalid media probe") from error


def _ms(value: object) -> int:
    try:
        if not isinstance(value, (str, int, float)):
            raise TypeError("missing time")
        seconds = float(value)
        if not math.isfinite(seconds):
            raise ValueError("invalid time")
        return round(seconds * 1000)
    except (TypeError, ValueError, OverflowError) as error:
        raise MediaError("invalid media time") from error


def _video_track(
    container: dict[str, Any], streams: list[dict[str, Any]]
) -> dict[str, Any]:
    if not container.get("tags", {}).get("major_brand") or (
        container["tags"]["major_brand"].strip() == "qt"
    ):
        raise MediaError("invalid MP4 container")
    videos = [stream for stream in streams if stream.get("codec_type") == "video"]
    if len(videos) != 1:
        raise MediaError("single video track required")
    video = videos[0]
    width, height = video.get("width"), video.get("height")
    try:
        fps = Fraction(video["avg_frame_rate"])
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
        raise MediaError("invalid frame rate") from error
    if (
        not isinstance(width, int)
        or not isinstance(height, int)
        or not 240 <= width <= 4096
        or not 240 <= height <= 4096
        or width * height > 1920 * 1080
        or not 12 <= fps <= 60
        or video.get("color_transfer") in {"smpte2084", "arib-std-b67"}
        or video.get("pix_fmt") not in {"yuv420p", "yuvj420p"}
        or any(item.get("rotation", 0) for item in video.get("side_data_list", []))
    ):
        raise MediaError("video frame geometry or SDR format unsupported")
    return video


async def _require_decodable_video(path: Path, ffmpeg: str) -> None:
    await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        *_MOV,
        "-err_detect",
        "explode",
        "-threads",
        "1",
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-an",
        "-f",
        "null",
        "-",
    )


async def prepare_character(
    source: Path, silent: Path, ffmpeg: str, ffprobe: str
) -> int:
    container, streams = await _streams(source, ffprobe)
    video = _video_track(container, streams)
    if video.get("codec_name") not in {"h264", "hevc"}:
        raise MediaError("unsupported source codec")
    length = _ms(video.get("duration", container.get("duration")))
    if not 1_000 <= length <= MAX_DURATION_MS:
        raise MediaError("character duration not supported")
    await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        *(_MOV),
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "copy",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-movflags",
        "+faststart",
        str(silent),
    )
    if not 0 < silent.stat().st_size <= MAX_VIDEO_BYTES:
        raise MediaError("silent source has invalid size")
    verified_container, verified_streams = await _streams(silent, ffprobe)
    if len(verified_streams) != 1:
        raise MediaError("invalid silent source tracks")
    verified = _video_track(verified_container, verified_streams)
    if abs(_ms(verified.get("duration")) - length) > 40:
        raise MediaError("source remux changed duration")
    await _require_decodable_video(silent, ffmpeg)
    return length


async def inspect_speech(path: Path, ffmpeg: str, ffprobe: str) -> int:
    container, streams = await _streams(path, ffprobe, audio_only=True)
    if len(streams) != 1 or (
        streams[0].get("codec_type"),
        streams[0].get("codec_name"),
    ) != ("audio", "mp3"):
        raise MediaError("invalid synthesized MP3")
    container_duration = _ms(streams[0].get("duration", container.get("duration")))
    if not 200 <= container_duration <= MAX_DURATION_MS + 100:
        raise MediaError("speech container duration not supported")
    # MP3 duration includes encoder padding in some containers. The decoded
    # samples, after codec delay removal, determine the driving timeline.
    pcm = await _pcm(path, ffmpeg, source_mp3=True)
    duration = round(len(pcm) * 1000 / _AUDIO_RATE)
    if not 200 <= duration <= MAX_DURATION_MS:
        raise MediaError("decoded speech duration not supported")
    return duration


async def _pcm(path: Path, ffmpeg: str, *, source_mp3: bool) -> array[int]:
    data = await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        *(_MP3 if source_mp3 else _MOV),
        "-threads",
        "1",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        "31",
        "-ac",
        "1",
        "-ar",
        str(_AUDIO_RATE),
        "-f",
        "s16le",
        "pipe:1",
        capture=True,
    )
    if not 0 < len(data) <= 31 * _AUDIO_RATE * 2 or len(data) % 2:
        raise MediaError("invalid decoded speech")
    pcm: array[int] = array("h")
    pcm.frombytes(data)
    if byteorder != "little":
        pcm.byteswap()
    return pcm


def _find_best_offset(
    original: array[int], returned: array[int], start: int, size: int
) -> tuple[float, int]:
    samples = original[start : start + size]
    sample_energy = sum(value * value for value in samples)
    if sample_energy <= size * 100:
        raise MediaError("insufficient speech energy")
    best_score = -1.0
    best_lag = 0
    limit = _AUDIO_RATE * MAX_AUDIO_LAG_MS // 1000
    for lag in range(-limit, limit + 1):
        offset = start + lag
        if offset < 0 or offset + size > len(returned):
            continue
        candidate = returned[offset : offset + size]
        candidate_energy = sum(value * value for value in candidate)
        if candidate_energy == 0:
            continue
        dot = sum(left * right for left, right in zip(samples, candidate, strict=True))
        correlation = dot / math.sqrt(sample_energy * candidate_energy)
        if correlation > best_score:
            best_score, best_lag = correlation, lag
    return best_score, round(best_lag * 1000 / _AUDIO_RATE)


def match_driving_audio(original: array[int], returned: array[int]) -> tuple[int, int]:
    # Sample independently across the three temporal regions to catch swapped sound and drift.
    # Select the strongest window in each region so normal pauses do not become false matches.
    length = min(len(original), len(returned))
    if (
        length < _AUDIO_RATE // 5
        or abs(len(original) - len(returned)) > _AUDIO_RATE // 10
    ):
        raise MediaError("decoded audio duration mismatch")
    block = min(_AUDIO_RATE // 5, length // 3)
    results = []
    for region in range(3):
        left = region * length // 3
        right = (region + 1) * length // 3
        candidates = range(left, right - block + 1, max(1, block // 2))
        start = max(
            candidates,
            key=lambda index: sum(v * v for v in original[index : index + block]),
        )
        results.append(_find_best_offset(original, returned, start, block))
    minimum = math.floor(min(score for score, _ in results) * 1000)
    lags = [lag for _, lag in results]
    if minimum < MIN_CORRELATION_PERMILLE or max(lags) - min(lags) > 30:
        raise MediaError("result audio did not match driving speech")
    return max(lags, key=abs), minimum


async def validate_output(
    video: Path,
    audio: Path,
    audio_ms: int,
    expected_video_ms: int,
    ffmpeg: str,
    ffprobe: str,
) -> MediaCheck:
    container, streams = await _streams(video, ffprobe)
    picture = _video_track(container, streams)
    voices = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if (
        picture.get("codec_name") != "h264"
        or len(streams) != 2
        or (len(voices) != 1 or voices[0].get("codec_name") != "aac")
    ):
        raise MediaError("result must contain H.264 video and AAC audio")
    video_ms = _ms(picture.get("duration", container.get("duration")))
    result_audio_ms = _ms(voices[0].get("duration"))
    if (
        not 200 <= video_ms <= MAX_DURATION_MS
        or abs(_ms(picture.get("start_time"))) > MAX_AUDIO_LAG_MS
        or abs(_ms(voices[0].get("start_time"))) > MAX_AUDIO_LAG_MS
        or abs(result_audio_ms - audio_ms) > MAX_AUDIO_LAG_MS
        or abs(video_ms - result_audio_ms) > MAX_AUDIO_LAG_MS
        or abs(video_ms - audio_ms) > MAX_AUDIO_LAG_MS
        or abs(video_ms - expected_video_ms) > MAX_AUDIO_LAG_MS
    ):
        raise MediaError("result audio or video timeline differs from requested timing")
    await _require_decodable_video(video, ffmpeg)
    original = await _pcm(audio, ffmpeg, source_mp3=True)
    returned = await _pcm(video, ffmpeg, source_mp3=False)
    lag, minimum = await asyncio.to_thread(match_driving_audio, original, returned)
    return MediaCheck(audio_ms, video_ms, lag, minimum)
