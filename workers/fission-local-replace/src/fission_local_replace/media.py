from __future__ import annotations

import asyncio
import json
import math
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

FPS = 24
AUDIO_RATE = 48_000
MAX_OUTPUT_BYTES = 128 * 1024 * 1024
_MOV = ["-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0"]


class MediaError(RuntimeError):
    """Media could not be safely read or converted."""


@dataclass(frozen=True)
class Timeline:
    duration_ms: int
    width: int
    height: int
    frames: int
    start_frame: int
    end_frame: int
    has_audio: bool

    @property
    def ratio(self) -> str:
        return "9:16" if self.width < self.height else "16:9"


async def _run(*args: str, capture: bool = False) -> bytes:
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
        async with asyncio.timeout(90):
            output, _ = await process.communicate()
    except (TimeoutError, asyncio.CancelledError) as error:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.communicate()
        if isinstance(error, TimeoutError):
            raise MediaError("媒体工具处理超时") from error
        raise
    if process.returncode:
        raise MediaError("无法读取或编码视频")
    return output or b""


async def _probe(
    path: Path, ffprobe: str, *, count_frames: bool = False
) -> tuple[dict[str, Any], tuple[str, ...]]:
    data = await _run(
        ffprobe,
        "-v",
        "error",
        *_MOV,
        *(["-count_frames"] if count_frames else []),
        "-show_entries",
        "stream=codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,"
        "time_base,duration_ts,nb_read_frames:stream_side_data=rotation",
        "-of",
        "json",
        str(path),
        capture=True,
    )
    try:
        streams = json.loads(data)["streams"]
        [video] = [stream for stream in streams if stream["codec_type"] == "video"]
        audio = tuple(
            stream.get("codec_name", "")
            for stream in streams
            if stream["codec_type"] == "audio"
        )
        return video, audio
    except (KeyError, TypeError, ValueError) as error:
        raise MediaError("无法读取独立画面轨规格") from error


def _duration(video: dict[str, Any]) -> Fraction:
    try:
        return Fraction(video["time_base"]) * int(video["duration_ts"])
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
        raise MediaError("无法验证视频时长") from error


def _dimensions(video: dict[str, Any]) -> tuple[int, int]:
    width, height = video.get("width"), video.get("height")
    rotation = next(
        (
            data["rotation"]
            for data in video.get("side_data_list", [])
            if "rotation" in data
        ),
        0,
    )
    if (
        not isinstance(width, int)
        or not isinstance(height, int)
        or not 0 < width * height <= 4096 * 2160
        or width <= 0
        or height <= 0
        or video.get("sample_aspect_ratio") not in {None, "N/A", "1:1"}
        or rotation not in {-270, -180, -90, 0, 90, 180, 270}
    ):
        raise MediaError("视频画幅不符合编辑要求")
    return (height, width) if rotation % 180 else (width, height)


async def inspect_source(
    path: Path,
    start_ms: int,
    end_ms: int,
    *,
    mime_type: str = "video/mp4",
    ffprobe: str = "ffprobe",
) -> Timeline:
    video, audio = await _probe(path, ffprobe)
    seconds = _duration(video)
    duration_ms = math.floor(seconds * 1000 + Fraction(1, 2))
    try:
        frame_rate = Fraction(video["avg_frame_rate"])
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
        raise MediaError("无法验证视频帧率") from error
    width, height = _dimensions(video)
    if (
        not 4_000 <= duration_ms <= 15_000
        or not FPS <= frame_rate <= 60
        or not 300 <= width <= 6000
        or not 300 <= height <= 6000
        or not 407_696 <= width * height <= 8_295_044
        or (width * 16 != height * 9 and width * 9 != height * 16)
    ):
        raise MediaError("原片时长、帧率或画幅尺寸超出支持范围")
    if video.get("codec_name") not in {"h264", "hevc"} or any(
        codec not in {"aac", "mp3"}
        and not (mime_type == "video/quicktime" and codec.startswith("pcm_"))
        for codec in audio
    ):
        raise MediaError("原片编码超出支持范围")
    if not 0 <= start_ms < end_ms <= duration_ms or end_ms - start_ms < 100:
        raise MediaError("替换范围超出视频或短于 0.1 秒")
    frames = math.floor(seconds * FPS + Fraction(1, 2))
    # The requested range is half-open. A normalized frame is used only when
    # its presentation time falls inside the original millisecond range.
    start_frame = (start_ms * FPS + 999) // 1000
    end_frame = min(frames, (end_ms * FPS + 999) // 1000)
    portrait = width < height
    return Timeline(
        duration_ms,
        720 if portrait else 1280,
        1280 if portrait else 720,
        frames,
        start_frame,
        end_frame,
        bool(audio),
    )


async def compose(
    source: Path,
    edited: Path,
    output: Path,
    timeline: Timeline,
    *,
    ffmpeg: str = "ffmpeg",
    ffprobe: str = "ffprobe",
) -> None:
    edited_video, _ = await _probe(edited, ffprobe)
    width, height = _dimensions(edited_video)
    if (
        width * timeline.height != height * timeline.width
        or math.floor(_duration(edited_video) * FPS + Fraction(1, 2)) < timeline.frames
    ):
        raise MediaError("编辑结果未覆盖原片时间线或画幅变化")
    spans = [
        (0, 0, timeline.start_frame),
        (1, timeline.start_frame, timeline.end_frame),
        (0, timeline.end_frame, timeline.frames),
    ]
    filters, labels = [], []
    for index, (stream, start, end) in enumerate(spans):
        if start == end:
            continue
        label = f"[part{index}]"
        filters.append(
            f"[{stream}:v:0]setpts=PTS-STARTPTS,fps={FPS},"
            f"trim=start_frame={start}:end_frame={end},"
            f"scale={timeline.width}:{timeline.height}:flags=lanczos,"
            f"setsar=1,format=yuv420p,settb=1/{FPS},setpts=N{label}"
        )
        labels.append(label)
    filters.append(
        f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0,settb=1/{FPS},setpts=N[out]"
    )
    audio_args = ["-an"]
    if timeline.has_audio:
        samples = timeline.frames * (AUDIO_RATE // FPS)
        filters.append(
            f"[0:a:0]aresample={AUDIO_RATE}:async=1:first_pts=0,apad,atrim=end_sample={samples}[audio]"
        )
        audio_args = ["-map", "[audio]", "-c:a", "aac", "-b:a", "192k"]
    await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        "-y",
        *_MOV,
        "-err_detect",
        "explode",
        "-threads",
        "1",
        "-i",
        str(source),
        *_MOV,
        "-err_detect",
        "explode",
        "-threads",
        "1",
        "-i",
        str(edited),
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[out]",
        *audio_args,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-fps_mode:v",
        "passthrough",
        "-enc_time_base:v",
        f"1/{FPS}",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-video_track_timescale",
        str(FPS),
        "-movflags",
        "+faststart",
        str(output),
    )
    if not 0 < output.stat().st_size <= MAX_OUTPUT_BYTES:
        raise MediaError("输出文件超过大小限制或为空")
    video, audio = await _probe(output, ffprobe, count_frames=True)
    if (
        video.get("codec_name") != "h264"
        or _dimensions(video) != (timeline.width, timeline.height)
        or video.get("nb_read_frames") != str(timeline.frames)
        or video.get("avg_frame_rate") != f"{FPS}/1"
        or _duration(video) != Fraction(timeline.frames, FPS)
        or audio != (("aac",) if timeline.has_audio else ())
    ):
        raise MediaError("输出画面帧数、尺寸或音频与原片时间线不符")
