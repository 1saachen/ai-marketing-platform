from __future__ import annotations

import asyncio
import json
import os
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .plan import validate_plan

_MP4_INPUT = ["-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0"]
_MAX_CLIP_BYTES = 128 * 1024 * 1024


class MediaError(RuntimeError):
    """Safe failure message without media paths or tool output."""


async def _run(
    args: list[str], timeout_seconds: float, *, capture: bool = False
) -> bytes:
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError as error:
        raise MediaError("媒体工具不可用") from error
    try:
        async with asyncio.timeout(timeout_seconds):
            output, _ = await process.communicate()
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.wait()
        raise
    if process.returncode:
        raise MediaError("视频无法完整读取或编码")
    return output or b""


async def _probe(
    path: Path, ffprobe: str, timeout: float, *, count_frames: bool = False
) -> list[dict[str, Any]]:
    data = await _run(
        [
            ffprobe,
            "-v",
            "quiet",
            *_MP4_INPUT,
            *(["-count_frames"] if count_frames else []),
            "-show_entries",
            "stream=codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,nb_read_frames,time_base,duration_ts",
            "-of",
            "json",
            str(path),
        ],
        timeout,
        capture=True,
    )
    try:
        streams: list[dict[str, Any]] = json.loads(data)["streams"]
        return streams
    except (ValueError, KeyError, TypeError) as error:
        raise MediaError("无法读取媒体规格") from error


async def compose(
    plan: dict[str, Any],
    clips: dict[str, Path],
    output: Path,
    *,
    ffmpeg: str = "ffmpeg",
    ffprobe: str = "ffprobe",
    timeout_seconds: float = 90,
) -> None:
    """Encode silent cuts from the locked frame indices and verify the decoded output."""
    validate_plan(plan)
    await compose_timeline(
        plan["timeline"],
        clips,
        output,
        width=plan["width"],
        height=plan["height"],
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        timeout_seconds=timeout_seconds,
    )


async def compose_timeline(
    timeline: dict[str, Any],
    clips: dict[str, Path],
    output: Path,
    *,
    width: int,
    height: int,
    ffmpeg: str,
    ffprobe: str,
    timeout_seconds: float = 90,
) -> None:
    """Compose a validated timeline. The output moves into place only after validation."""
    shots = timeline["shots"]
    if set(clips) != {shot["shotId"] for shot in shots} or not shots:
        raise MediaError("镜头素材与锁定列表不一致")
    numerator, denominator = timeline["fpsNumerator"], timeline["fpsDenominator"]
    fps = f"{numerator}/{denominator}"
    time_base = f"{denominator}/{numerator}"
    paths = [clips[shot["shotId"]].resolve() for shot in shots]
    if output.resolve() in paths:
        raise MediaError("成片路径不能覆盖镜头素材")
    inputs, filters, labels = [], [], []
    for index, (path, shot) in enumerate(zip(paths, shots, strict=True)):
        if not path.is_file() or not 0 < path.stat().st_size <= _MAX_CLIP_BYTES:
            raise MediaError("镜头文件不存在或超出大小限制")
        streams = await _probe(path, ffprobe, timeout_seconds)
        videos = [stream for stream in streams if stream.get("codec_type") == "video"]
        if len(videos) != 1 or (videos[0].get("width"), videos[0].get("height")) != (
            width,
            height,
        ):
            raise MediaError("生成镜头画幅或尺寸不符合锁定规格")
        if videos[0].get("sample_aspect_ratio") not in {None, "N/A", "1:1"}:
            raise MediaError("生成镜头像素比例不符合锁定规格")
        count = shot["endFrame"] - shot["startFrame"]
        try:
            clip_seconds = Fraction(videos[0]["time_base"]) * int(
                videos[0]["duration_ts"]
            )
        except (ValueError, KeyError, ZeroDivisionError) as error:
            raise MediaError("无法核对镜头时长") from error
        if clip_seconds < Fraction(count * denominator, numerator):
            raise MediaError("生成镜头短于锁定区间")
        inputs.extend(
            [*_MP4_INPUT, "-noautorotate", "-err_detect", "explode", "-i", str(path)]
        )
        label = f"[shot{index}]"
        labels.append(label)
        filters.append(
            f"[{index}:v:0]setpts=PTS-STARTPTS,fps={fps},trim=end_frame={count},"
            f"settb={time_base},setpts=N,format=yuv420p,setsar=1{label}"
        )
    filters.append(
        f"{''.join(labels)}concat=n={len(shots)}:v=1:a=0,settb={time_base},setpts=N[out]"
    )
    with TemporaryDirectory(prefix="clone-compose-", dir=output.parent) as temporary:
        candidate = Path(temporary) / "result.mp4"
        await _run(
            [
                ffmpeg,
                "-v",
                "error",
                "-xerror",
                "-nostdin",
                "-y",
                *inputs,
                "-filter_complex_threads",
                "1",
                "-filter_complex",
                ";".join(filters),
                "-map",
                "[out]",
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-pix_fmt",
                "yuv420p",
                "-fps_mode",
                "passthrough",
                "-enc_time_base",
                time_base,
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-video_track_timescale",
                str(numerator),
                "-movflags",
                "+faststart",
                str(candidate),
            ],
            timeout_seconds,
        )
        streams = await _probe(candidate, ffprobe, timeout_seconds, count_frames=True)
        target = streams[0] if len(streams) == 1 else {}
        try:
            frame_count = int(target["nb_read_frames"])
            rate = Fraction(target["avg_frame_rate"])
            seconds = Fraction(target["time_base"]) * int(target["duration_ts"])
        except (ValueError, KeyError, ZeroDivisionError) as error:
            raise MediaError("成片帧数或时间基无法验证") from error
        if (
            target.get("codec_name") != "h264"
            or (target.get("width"), target.get("height")) != (width, height)
            or frame_count != timeline["frameCount"]
            or rate != Fraction(numerator, denominator)
            or seconds != Fraction(frame_count * denominator, numerator)
        ):
            raise MediaError("成片未完整覆盖锁定帧时间线")
        await _run(
            [
                ffmpeg,
                "-v",
                "error",
                "-xerror",
                "-nostdin",
                *_MP4_INPUT,
                "-err_detect",
                "explode",
                "-i",
                str(candidate),
                "-map",
                "0:v:0",
                "-f",
                "null",
                "-",
            ],
            timeout_seconds,
        )
        os.replace(candidate, output)
