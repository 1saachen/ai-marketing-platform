from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from .media import (
    _AUDIO_RATE,
    _MOV,
    _MP3,
    MAX_AUDIO_BYTES,
    MAX_AUDIO_LAG_MS,
    MAX_DURATION_MS,
    MAX_VIDEO_BYTES,
    MediaError,
    _ms,
    _pcm,
    _require_decodable_video,
    _run,
    _streams,
    _video_track,
    inspect_speech,
)


async def inspect_native_reference_audio(
    path: Path, mime_type: Literal["audio/mpeg", "audio/wav"], ffmpeg: str, ffprobe: str
) -> None:
    options = (
        _MP3
        if mime_type == "audio/mpeg"
        else ("-protocol_whitelist", "file,pipe", "-f", "wav")
    )
    raw = await _run(
        ffprobe,
        "-v",
        "error",
        *options,
        "-show_entries",
        "stream=codec_type,codec_name",
        "-of",
        "json",
        str(path),
        capture=True,
    )
    try:
        streams = json.loads(raw)["streams"]
        if len(streams) != 1 or streams[0]["codec_type"] != "audio":
            raise ValueError("single audio track required")
        if mime_type == "audio/mpeg" and streams[0]["codec_name"] != "mp3":
            raise ValueError("unexpected audio codec")
    except (KeyError, TypeError, ValueError) as error:
        raise MediaError("invalid native reference audio format") from error

    # Decode at a fixed rate to measure playable time without container padding.
    pcm = await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        *options,
        "-threads",
        "1",
        "-i",
        str(path),
        "-map",
        "0:a:0",
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
    if len(pcm) % 2 or not 2 * _AUDIO_RATE <= len(pcm) // 2 <= 30 * _AUDIO_RATE:
        raise MediaError("native reference audio duration must be 2 to 30 seconds")


async def _native_durations(
    source: Path, requested_ms: int, ffprobe: str
) -> tuple[int, int]:
    if not 0 < source.stat().st_size <= MAX_VIDEO_BYTES:
        raise MediaError("invalid native video size")
    container, streams = await _streams(source, ffprobe)
    video = _video_track(container, streams)
    audios = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if (
        len(streams) != 2
        or len(audios) != 1
        or video.get("codec_name") != "h264"
        or audios[0].get("codec_name") != "aac"
    ):
        raise MediaError("native MP4 requires H.264 video and AAC audio")
    if abs(16 * video["width"] - 9 * video["height"]) > video["height"] / 4:
        raise MediaError("native video has an unexpected aspect ratio")

    audio = audios[0]
    video_ms, audio_ms = _ms(video.get("duration")), _ms(audio.get("duration"))
    video_start, audio_start = (
        _ms(video.get("start_time")),
        _ms(audio.get("start_time")),
    )
    if (
        max(abs(video_ms - requested_ms), abs(audio_ms - requested_ms))
        > MAX_AUDIO_LAG_MS
        or abs(video_ms - audio_ms) > MAX_AUDIO_LAG_MS
        or max(abs(video_start), abs(audio_start), abs(video_start - audio_start))
        > MAX_AUDIO_LAG_MS
    ):
        raise MediaError("native video and audio do not match the requested timeline")
    return video_ms, audio_ms


async def prepare_native_video(
    source: Path, audio: Path, duration_seconds: int, ffmpeg: str, ffprobe: str
) -> tuple[Path, dict[str, Any]]:
    requested_ms = duration_seconds * 1000
    video_ms, audio_ms = await _native_durations(source, requested_ms, ffprobe)
    video = source
    # The provider may include a trailing frame or AAC padding at 30 seconds.
    if max(video_ms, audio_ms) > MAX_DURATION_MS:
        video = source.with_name("normalized.mp4")
        await _run(
            ffmpeg,
            "-v",
            "error",
            "-nostdin",
            "-xerror",
            *_MOV,
            "-threads",
            "1",
            "-i",
            str(source),
            "-t",
            str(duration_seconds),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-threads",
            "1",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            str(video),
        )
        video_ms, audio_ms = await _native_durations(video, requested_ms, ffprobe)
        if max(video_ms, audio_ms) > MAX_DURATION_MS:
            raise MediaError("normalized native video exceeds the duration limit")

    await _require_decodable_video(video, ffmpeg)
    pcm = await _pcm(video, ffmpeg, source_mp3=False)
    if sum(sample * sample for sample in pcm) <= len(pcm) * 16**2:
        raise MediaError("native video audio is silent")

    await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        *_MOV,
        "-threads",
        "1",
        "-i",
        str(video),
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        "30",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        str(audio),
    )
    if not 0 < audio.stat().st_size <= MAX_AUDIO_BYTES:
        raise MediaError("invalid native audio size")
    preview_ms = await inspect_speech(audio, ffmpeg, ffprobe)
    if (
        max(abs(preview_ms - video_ms), abs(preview_ms - requested_ms))
        > MAX_AUDIO_LAG_MS
    ):
        raise MediaError("native preview audio duration does not match")
    return video, {
        "schemaVersion": 4,
        "audioDurationMs": preview_ms,
        "videoDurationMs": video_ms,
        "wordTimings": [],
    }
