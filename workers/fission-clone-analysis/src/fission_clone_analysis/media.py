from __future__ import annotations

import asyncio
import json
import math
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any


class MediaError(RuntimeError):
    """Safe media failure; never includes FFmpeg stderr or a local file path."""


MOTION_SAMPLE_INTERVAL_MS = 500
LEGACY_DURATION_TOLERANCE_MS = 42


@dataclass(frozen=True)
class MediaLimits:
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"
    max_duration_ms: int = 120_000
    max_pixels: int = 4096 * 2160
    max_frames: int = 24
    interval_ms: int = 3000
    max_frame_bytes: int = 1024 * 1024
    max_sample_bytes: int = 12 * 1024 * 1024
    process_timeout: float = 45

    def __post_init__(self) -> None:
        if not 2 <= self.max_frames <= 48 or self.interval_ms < MOTION_SAMPLE_INTERVAL_MS:
            raise ValueError("invalid bounded frame sampling configuration")
        if not 1 <= self.process_timeout <= 120:
            raise ValueError("invalid media process timeout")


@dataclass(frozen=True)
class Frame:
    time_ms: int
    jpeg: bytes


@dataclass(frozen=True)
class CutCandidate:
    time_ms: int
    before_ms: int
    after_ms: int


@dataclass(frozen=True)
class Sample:
    duration_ms: int
    width: int
    height: int
    has_audio: bool
    frames: tuple[Frame, ...]
    cut_candidates: tuple[CutCandidate, ...] = ()

    def metadata(self) -> dict[str, Any]:
        return {
            "durationMs": self.duration_ms,
            "width": self.width,
            "height": self.height,
            "hasAudioTrack": self.has_audio,
            "sampleTimesMs": [frame.time_ms for frame in self.frames],
            "cutCandidates": [
                {"timeMs": cut.time_ms, "beforeMs": cut.before_ms, "afterMs": cut.after_ms}
                for cut in self.cut_candidates
            ],
            "audioSemantics": "UNASSESSED",
            "limitation": "镜头由采样画面推断，画面变化候选可能包含运镜或闪光。音频语义未分析。",
        }


async def _limited_read(stream: asyncio.StreamReader, limit: int) -> bytes:
    data = bytearray()
    while chunk := await stream.read(64 * 1024):
        data.extend(chunk)
        if len(data) > limit:
            raise MediaError("媒体工具输出超出限制")
    return bytes(data)


async def run_process(args: list[str], timeout: float) -> bytes:
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        raise MediaError("媒体工具不可用") from exc
    assert process.stdout is not None and process.stderr is not None
    readers = [
        asyncio.create_task(_limited_read(process.stdout, 1024 * 1024)),
        asyncio.create_task(_limited_read(process.stderr, 128 * 1024)),
    ]
    try:
        async with asyncio.timeout(timeout):
            output, _ = await asyncio.gather(*readers)
            code = await process.wait()
        if code != 0:
            raise MediaError("媒体探测或抽帧失败")
        return output
    except TimeoutError as exc:
        raise MediaError("媒体处理超时") from exc
    finally:
        for task in readers:
            if not task.done():
                task.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
        if process.returncode is None:
            process.kill()
        # Drain pipes after stopping producers. Waiting on the process before
        # draining a full pipe can deadlock (notably on Windows Proactor).
        await asyncio.wait_for(process.communicate(), timeout=5)


def frame_times(duration_ms: int, limits: MediaLimits) -> list[int]:
    if not 1 <= duration_ms <= limits.max_duration_ms:
        raise MediaError("参考视频时长不在支持范围内")
    count = min(
        limits.max_frames, max(2, math.ceil(duration_ms / limits.interval_ms) + 1)
    )
    # Frames are evidence samples, not exact shot boundaries. Leave the final
    # sample inside the file so seeking never requests a frame beyond EOF.
    final_ms = max(0, duration_ms - min(200, duration_ms // 2))
    return sorted({(index * final_ms) // (count - 1) for index in range(count)})


async def _detect_changes(source: Path, limits: MediaLimits) -> list[tuple[int, float]]:
    # This pass supplies image-change hints, never confirmed shot boundaries.
    output = await run_process(
        [
            limits.ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-threads",
            "2",
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-filter_threads",
            "1",
            "-vf",
            "scale=256:256:force_original_aspect_ratio=decrease,"
            "select='gt(scene,0.18)',metadata=print:key=lavfi.scene_score:file=-",
            "-f",
            "null",
            "-",
        ],
        limits.process_timeout,
    )
    changes = []
    for stamp, score in re.findall(
        rb"pts_time:(\S+)\s+lavfi\.scene_score=(\S+)", output
    ):
        seconds, strength = float(stamp), float(score)
        if math.isfinite(seconds) and math.isfinite(strength):
            changes.append((round(seconds * 1000), strength))
    return changes


async def _sampling_plan(
    source: Path, duration_ms: int, limits: MediaLimits
) -> tuple[list[int], tuple[CutCandidate, ...]]:
    uniform_times = frame_times(duration_ms, limits)
    # Keep at least half the image budget for coverage across the full video.
    max_candidates = limits.max_frames // 4
    if not max_candidates:
        return uniform_times, ()
    try:
        changes = await _detect_changes(source, limits)
    except (MediaError, ValueError, OverflowError):
        return uniform_times, ()

    candidates: list[CutCandidate] = []
    for time_ms, _ in sorted(changes, key=lambda item: (-item[1], item[0])):
        before_ms, after_ms = time_ms - 150, time_ms + 50
        if not 0 < before_ms < after_ms < uniform_times[-1]:
            continue
        if any(
            before_ms <= cut.after_ms and cut.before_ms <= after_ms
            for cut in candidates
        ):
            continue
        candidates.append(CutCandidate(time_ms, before_ms, after_ms))
        if len(candidates) >= max_candidates:
            break
    baseline = frame_times(
        duration_ms, replace(limits, max_frames=limits.max_frames - 2 * len(candidates))
    )
    paired_times = {t for cut in candidates for t in (cut.before_ms, cut.after_ms)}
    return sorted(set(baseline) | paired_times), tuple(
        sorted(candidates, key=lambda cut: cut.time_ms)
    )


def _positive_duration_seconds(value: object) -> float | None:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    try:
        seconds = float(value)
    except (ValueError, OverflowError):
        return None
    return seconds if math.isfinite(seconds) and seconds > 0 else None


async def sample_video(
    source: Path,
    directory: Path,
    limits: MediaLimits,
    *,
    frozen_media: dict[str, Any] | None = None,
) -> Sample:
    output = await run_process(
        [
            limits.ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height,duration",
            "-of",
            "json",
            str(source),
        ],
        limits.process_timeout,
    )
    try:
        probe = json.loads(output)
        streams = probe["streams"]
        video = next(
            stream for stream in streams if stream.get("codec_type") == "video"
        )
        duration = _positive_duration_seconds(video.get("duration"))
        if duration is None:
            duration = _positive_duration_seconds(probe.get("format", {}).get("duration"))
        width, height = int(video["width"]), int(video["height"])
        if duration is None or width <= 0 or height <= 0:
            raise ValueError("invalid probe")
        probed_duration_ms = math.floor(duration * 1000 + 0.5)
        if width * height > limits.max_pixels:
            raise ValueError("pixel limit")
        has_audio = any(stream.get("codec_type") == "audio" for stream in streams)
    except (KeyError, ValueError, TypeError, StopIteration, OverflowError) as exc:
        raise MediaError("参考视频媒体信息无效") from exc
    duration_ms = probed_duration_ms
    if frozen_media is not None:
        frozen_duration = frozen_media.get("durationMs")
        frozen_width = frozen_media.get("width")
        frozen_height = frozen_media.get("height")
        if (
            type(frozen_duration) is not int
            or frozen_duration <= 0
            or type(frozen_width) is not int
            or frozen_width <= 0
            or type(frozen_height) is not int
            or frozen_height <= 0
        ):
            raise MediaError("已确认的参考视频媒体信息无效")
        if (width, height) != (frozen_width, frozen_height):
            raise MediaError("参考视频尺寸与已确认来源不一致")
        if abs(frozen_duration - probed_duration_ms) > LEGACY_DURATION_TOLERANCE_MS:
            raise MediaError("参考视频时长与已确认来源不一致")
        duration_ms = frozen_duration
    if not 1 <= duration_ms <= limits.max_duration_ms:
        raise MediaError("参考视频时长不在支持范围内")
    # Preserve the frozen report timeline but only request frames within both time ranges.
    times, cuts = await _sampling_plan(
        source, min(probed_duration_ms, duration_ms), limits
    )
    frames: list[Frame] = []
    total_bytes = 0
    for index, timestamp in enumerate(times):
        destination = directory / f"frame-{index:03d}.jpg"
        await run_process(
            [
                limits.ffmpeg,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{timestamp / 1000:.3f}",
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-an",
                "-sn",
                "-frames:v",
                "1",
                "-vf",
                "scale=640:640:force_original_aspect_ratio=decrease",
                "-threads",
                "1",
                "-q:v",
                "4",
                "-y",
                str(destination),
            ],
            limits.process_timeout,
        )
        try:
            size = destination.stat().st_size
            if not 0 < size <= limits.max_frame_bytes:
                raise MediaError("采样图片超过限制或为空")
            total_bytes += size
            if total_bytes > limits.max_sample_bytes:
                raise MediaError("采样图片总量超过限制")
            frames.append(Frame(timestamp, destination.read_bytes()))
        except OSError as exc:
            raise MediaError("采样图片不可读") from exc
        finally:
            destination.unlink(missing_ok=True)
    return Sample(duration_ms, width, height, has_audio, tuple(frames), cuts)
