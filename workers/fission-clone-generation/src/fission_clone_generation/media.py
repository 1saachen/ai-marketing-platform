from __future__ import annotations

import asyncio
import json
import os
from fractions import Fraction
from math import ceil
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal

from .plan import SHOT_REFERENCE_MODE, SOURCE_EDIT_MODE, SOURCE_VIDEO_MAX_BYTES, validate_plan

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
    if plan["mode"] == SOURCE_EDIT_MODE:
        raise MediaError("原片编辑需要使用整段原片和编辑结果")
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


async def normalize_original(
    plan: dict[str, Any], original: Path, normalized: Path, *, ffmpeg: str, ffprobe: str
) -> None:
    """Prepare the frozen source timeline for direct reuse and frame-aligned review."""
    mode = plan["mode"]
    if mode not in {SOURCE_EDIT_MODE, SHOT_REFERENCE_MODE}:
        raise MediaError("成片方案未绑定原片")
    timeline = plan["timeline"]
    shot = {
        "shotId": "original",
        "startFrame": 0,
        "endFrame": timeline["frameCount"],
    }
    await compose_timeline(
        {**timeline, "shots": [shot]},
        {"original": original},
        normalized,
        width=plan["width"],
        height=plan["height"],
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        normalize_source=mode,
    )


async def extract_shot_reference(
    plan: dict[str, Any],
    index: int,
    normalized_original: Path,
    output: Path,
    *,
    ffmpeg: str,
    ffprobe: str,
) -> None:
    """Cut the frozen frame span and extend only its last frame when required."""
    if plan["mode"] != SHOT_REFERENCE_MODE or not 0 <= index < len(plan["shots"]):
        raise MediaError("成片方案缺少当前镜头参考")
    timeline = plan["timeline"]
    span = timeline["shots"][index]
    start, end = span["startFrame"], span["endFrame"]
    frames = plan["shots"][index]["referenceFrames"]
    pad_frames = frames - (end - start)
    if pad_frames < 0 or normalized_original.resolve() == output.resolve():
        raise MediaError("镜头参考帧数或文件路径无效")
    padding = f",tpad=stop_mode=clone:stop={pad_frames}" if pad_frames else ""
    numerator, denominator = timeline["fpsNumerator"], timeline["fpsDenominator"]
    graph = (
        f"[0:v:0]trim=start_frame={start}:end_frame={end},"
        f"settb={denominator}/{numerator},setpts=N{padding},setpts=N,"
        "format=yuv420p,setsar=1[out]"
    )
    await _encode_verified(
        _video_input(normalized_original),
        graph,
        output,
        width=plan["width"],
        height=plan["height"],
        numerator=numerator,
        denominator=denominator,
        expected_frames=frames,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        timeout_seconds=90,
    )


async def compose_source_edit(
    plan: dict[str, Any],
    normalized_original: Path,
    edited: Path,
    output: Path,
    *,
    ffmpeg: str,
    ffprobe: str,
) -> None:
    """Use the same absolute frame indices in both source and edited media."""
    validate_plan(plan)
    if plan["mode"] != SOURCE_EDIT_MODE:
        raise MediaError("成片方案未启用原片编辑")
    clips = {
        shot["shotId"]: edited if shot["targets"] else normalized_original
        for shot in plan["shots"]
    }
    await compose_timeline(
        plan["timeline"],
        clips,
        output,
        width=plan["width"],
        height=plan["height"],
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        absolute_ranges=True,
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
    absolute_ranges: bool = False,
    normalize_source: Literal["SEEDANCE_2_0_SOURCE_EDIT", "SEEDANCE_2_0_SHOT_REFERENCE"] | None = None,
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
    limit = SOURCE_VIDEO_MAX_BYTES if normalize_source else _MAX_CLIP_BYTES
    for index, (path, shot) in enumerate(zip(paths, shots, strict=True)):
        if not path.is_file() or not 0 < path.stat().st_size <= limit:
            raise MediaError("镜头文件不存在或超出大小限制")
        streams = await _probe(path, ffprobe, timeout_seconds)
        videos = [stream for stream in streams if stream.get("codec_type") == "video"]
        if len(videos) != 1:
            raise MediaError("镜头应只包含一个画面视频轨")
        video = videos[0]
        picture = (video.get("width"), video.get("height"))
        if normalize_source:
            source_width, source_height = picture
            if (
                not isinstance(source_width, int)
                or not isinstance(source_height, int)
                or source_width * height != source_height * width
                or (
                    normalize_source == SOURCE_EDIT_MODE
                    and video.get("codec_name") not in {"h264", "hevc"}
                )
            ):
                raise MediaError("原片画幅或编码不符合参考要求")
        elif picture != (width, height):
            raise MediaError("生成镜头画幅或尺寸不符合锁定规格")
        if video.get("sample_aspect_ratio") not in {None, "N/A", "1:1"}:
            raise MediaError("镜头像素比例不符合锁定规格")
        start_frame = shot["startFrame"] if absolute_ranges else 0
        count = shot["endFrame"] - shot["startFrame"]
        end_frame = start_frame + count
        try:
            clip_seconds = Fraction(video["time_base"]) * int(video["duration_ts"])
        except (ValueError, KeyError, ZeroDivisionError) as error:
            raise MediaError("无法核对镜头时长") from error
        # The source duration is rounded to the nearest timeline frame. Decode
        # and verify the normalized frame count rather than rounding it down.
        required_frames = timeline["frameCount"] if absolute_ranges else end_frame
        if not normalize_source and clip_seconds < Fraction(
            required_frames * denominator, numerator
        ):
            raise MediaError("生成镜头短于锁定区间")
        padding = ""
        if normalize_source == SHOT_REFERENCE_MODE:
            video_duration_ms = int(clip_seconds * 1000 + Fraction(1, 2))
            max_tail_ms = ceil(Fraction(1000 * denominator, numerator))
            if 0 < timeline["durationMs"] - video_duration_ms <= max_tail_ms:
                # Old uploads could lock the longer container duration. One
                # clone after FPS normalization can fill only the missing tail.
                padding = ",tpad=stop_mode=clone:stop=1"
        inputs.extend(_video_input(path))
        label = f"[shot{index}]"
        labels.append(label)
        resize = f",scale={width}:{height}:flags=lanczos" if normalize_source else ""
        filters.append(
            f"[{index}:v:0]setpts=PTS-STARTPTS,fps={fps}{padding},"
            f"trim=start_frame={start_frame}:end_frame={end_frame}{resize},"
            f"settb={time_base},setpts=N,format=yuv420p,setsar=1{label}"
        )
    filters.append(
        f"{''.join(labels)}concat=n={len(shots)}:v=1:a=0,settb={time_base},setpts=N[out]"
    )
    await _encode_verified(
        inputs,
        ";".join(filters),
        output,
        width=width,
        height=height,
        numerator=numerator,
        denominator=denominator,
        expected_frames=timeline["frameCount"],
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        timeout_seconds=timeout_seconds,
    )


def _video_input(path: Path) -> list[str]:
    return [
        *_MP4_INPUT, "-noautorotate", "-err_detect", "explode",
        "-threads", "1", "-i", str(path),
    ]


async def _encode_verified(
    inputs: list[str],
    graph: str,
    output: Path,
    *,
    width: int,
    height: int,
    numerator: int,
    denominator: int,
    expected_frames: int,
    ffmpeg: str,
    ffprobe: str,
    timeout_seconds: float,
) -> None:
    time_base = f"{denominator}/{numerator}"
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
                graph,
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
            or frame_count != expected_frames
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
