from __future__ import annotations

import json
import math
import shutil
import unicodedata
from collections.abc import Iterable, Sequence
from fractions import Fraction
from pathlib import Path
from typing import Literal, TypedDict

from .long_media import (
    MAX_LONG_WORKER_VIDEO_BYTES,
    TICKS,
    seam_frames_for_duration,
    validate_long_delivery,
)
from .media import (
    _MOV,
    _MP3,
    MAX_AUDIO_LAG_MS,
    MediaCheck,
    MediaError,
    _ms,
    _run,
    _streams,
    _video_track,
    validate_output,
)

WIDTH, HEIGHT, FPS = 1080, 1920, 30
MAX_RENDER_BYTES = 96 * 1024 * 1024
MAX_BACKGROUND_BYTES = 12 * 1024 * 1024
MAX_SUBTITLE_BYTES = 16 * 1024
MAX_LONG_SUBTITLE_BYTES = 64 * 1024
MAX_BACKGROUND_PIXELS = 4096 * 4096


class Caption(TypedDict):
    startMs: int
    endMs: int
    text: str


class SolidBackground(TypedDict):
    kind: Literal["SOLID"]
    color: str


class ImageBackground(TypedDict):
    kind: Literal["IMAGE"]
    assetId: str
    version: int


class Settings(TypedDict):
    background: SolidBackground | ImageBackground
    insetPercent: int
    captionMode: Literal["OFF", "SIDECAR", "BURN", "BOTH"]
    captions: list[Caption]


def _srt_time(ms: int) -> str:
    seconds, milliseconds = divmod(ms, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def _seconds(ms: int) -> str:
    return f"{ms / 1000:.3f}"


def _caption_text(captions: Sequence[Caption]) -> bytes:
    return "".join(
        f"{index}\n{_srt_time(cue['startMs'])} --> {_srt_time(cue['endMs'])}\n{cue['text']}\n\n"
        for index, cue in enumerate(captions, start=1)
    ).encode("utf-8")


def _wrapped_lines(text: str) -> Iterable[str]:
    # A row fits 19 full-width glyphs at the default size. Combining marks share
    # the preceding character's cell. Keep user-entered line breaks as well.
    for line in text.split("\n"):
        start, cells = 0, 0
        for index, character in enumerate(line):
            if unicodedata.combining(character):
                continue
            cell = 2 if unicodedata.east_asian_width(character) in "WFA" else 1
            if cells + cell > 38:
                yield line[start:index]
                start, cells = index, 0
            cells += cell
        yield line[start:]


def _caption_filters(root: Path, captions: Sequence[Caption], font: Path) -> list[str]:
    shutil.copyfile(font, root / "caption-font.ttf")
    filters = []
    for index, cue in enumerate(captions):
        text_file = f"caption-{index}.txt"
        (root / text_file).write_text(
            "\n".join(_wrapped_lines(cue["text"])), encoding="utf-8", newline="\n"
        )
        start, end = _seconds(cue["startMs"]), _seconds(cue["endMs"])
        filters.append(
            "drawtext=fontfile=caption-font.ttf:"
            f"textfile={text_file}:expansion=none:"
            "fontcolor=white:fontsize=48:borderw=3:bordercolor=black:"
            "line_spacing=8:x=(w-text_w)/2:y=h-text_h-90:"
            f"enable='gte(t,{start})*lt(t,{end})'"
        )
    return filters


async def _image_input(path: Path, ffprobe: str) -> tuple[str, ...]:
    with path.open("rb") as source:
        signature = source.read(8)
    if signature == b"\x89PNG\r\n\x1a\n":
        demuxer = "png_pipe"
    elif signature.startswith(b"\xff\xd8\xff"):
        demuxer = "jpeg_pipe"
    else:
        raise MediaError("background must be a JPEG or PNG image")
    options = ("-protocol_whitelist", "file,pipe", "-f", demuxer)
    raw = await _run(
        ffprobe,
        "-v",
        "error",
        *options,
        "-show_entries",
        "stream=codec_name,width,height",
        "-of",
        "json",
        str(path),
        capture=True,
    )
    try:
        streams = json.loads(raw)["streams"]
        if len(streams) != 1:
            raise ValueError("unexpected image stream count")
        info = streams[0]
        width, height = info["width"], info["height"]
        if (
            info["codec_name"] != ("png" if demuxer == "png_pipe" else "mjpeg")
            or not 2 <= width <= 4096
            or not 2 <= height <= 4096
        ):
            raise ValueError("invalid image dimensions")
    except (KeyError, TypeError, ValueError) as error:
        raise MediaError("invalid background image") from error
    return (
        *options,
        "-threads",
        "1",
        "-max_pixels",
        str(MAX_BACKGROUND_PIXELS),
        "-i",
        str(path),
    )


def _aspect_ratio(track: dict[str, object]) -> Fraction:
    width, height = int(str(track["width"])), int(str(track["height"]))
    raw = track.get("sample_aspect_ratio")
    if raw in {None, "N/A", "0:1"}:
        return Fraction(width, height)
    try:
        ratio = Fraction(str(raw).replace(":", "/"))
        if not Fraction(1, 8) <= ratio <= 8:
            raise ValueError("unsupported pixel aspect ratio")
    except (ValueError, ZeroDivisionError) as error:
        raise MediaError("invalid pixel aspect ratio") from error
    return Fraction(width, height) * ratio


def _placement(ratio: Fraction, inset: int) -> tuple[int, int]:
    active = Fraction(100 - 2 * inset, 100)
    max_width, max_height = WIDTH * active, HEIGHT * active
    width = min(max_width, max_height * ratio)
    height = min(max_height, max_width / ratio)
    return max(2, math.floor(width / 2) * 2), max(2, math.floor(height / 2) * 2)


async def render_video(
    *,
    source_video: Path,
    source_audio: Path,
    background: Path | None,
    output_video: Path,
    output_subtitles: Path,
    settings: Settings,
    audio_duration_ms: int,
    video_duration_ms: int,
    ffmpeg: str,
    ffprobe: str,
    font: Path,
    seam_times_ms: list[int] | None = None,
) -> MediaCheck:
    # Inspect the already-confirmed picture and its exact driving voice before
    # using them. This is a transport check of G2's inputs, not an event review.
    long_form = seam_times_ms is not None
    video_limit = MAX_LONG_WORKER_VIDEO_BYTES if long_form else MAX_RENDER_BYTES
    subtitle_limit = MAX_LONG_SUBTITLE_BYTES if long_form else MAX_SUBTITLE_BYTES
    canvas_seconds = 91 if long_form else 31
    codec_options: tuple[str, ...] = ()
    if seam_times_ms is None:
        await validate_output(
            source_video,
            source_audio,
            audio_duration_ms,
            video_duration_ms,
            ffmpeg,
            ffprobe,
        )
    else:
        _, seam_frames = seam_frames_for_duration(video_duration_ms, seam_times_ms)
        await validate_long_delivery(
            source_video,
            source_audio,
            audio_duration_ms,
            video_duration_ms,
            seam_times_ms,
            ffmpeg,
            ffprobe,
        )
        frame_expression = "+".join(f"eq(n,{frame})" for frame in seam_frames)
        codec_options = (
            "-bf",
            "0",
            "-video_track_timescale",
            str(TICKS),
            "-force_key_frames",
            f"expr:{frame_expression}",
        )
    container, streams = await _streams(source_video, ffprobe)
    track = _video_track(container, streams)
    width, height = _placement(_aspect_ratio(track), settings["insetPercent"])
    root = output_video.parent
    if settings["background"]["kind"] == "IMAGE":
        if background is None:
            raise MediaError("frozen background missing")
        input_options = await _image_input(background, ffprobe)
        # Center crop before resizing to bound intermediates even for very
        # narrow images. Consume only the first decoded image frame.
        canvas = (
            "[2:v]trim=end_frame=1,"
            f"crop=w='max(2,trunc(min(iw,ih*{WIDTH}/{HEIGHT})/2)*2)':"
            f"h='max(2,trunc(min(ih,iw*{HEIGHT}/{WIDTH})/2)*2)',"
            f"scale={WIDTH}:{HEIGHT},setsar=1,format=yuv420p,"
            f"tpad=stop_mode=clone:stop_duration={canvas_seconds},fps={FPS}[canvas]"
        )
    else:
        if background is not None:
            raise MediaError("unexpected background image")
        input_options = ()
        color = settings["background"]["color"][1:]
        canvas = f"color=c=0x{color}:size={WIDTH}x{HEIGHT}:rate={FPS}[canvas]"

    picture = f"[0:v:0]scale={width}:{height},setsar=1,fps={FPS}[source]"
    overlay = "[canvas][source]overlay=(W-w)/2:(H-h)/2:shortest=1:repeatlast=0"
    burn = settings["captionMode"] in {"BURN", "BOTH"}
    captions = settings["captions"]
    filters = _caption_filters(root, captions, font) if burn and captions else []
    graph = ";\n".join(
        (canvas, picture, ",".join((overlay, *filters, "format=yuv420p[v]")))
    )
    (root / "render-filter.txt").write_text(graph, encoding="utf-8", newline="\n")

    await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        "-filter_complex_threads",
        "2",
        *_MOV,
        "-threads",
        "2",
        "-i",
        str(source_video),
        *_MP3,
        "-i",
        str(source_audio),
        *input_options,
        "-filter_complex_script",
        "render-filter.txt",
        "-map",
        "[v]",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "21",
        "-maxrate",
        "8M",
        "-bufsize",
        "16M",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "4",
        *codec_options,
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ar",
        "48000",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-movflags",
        "+faststart",
        "-fs",
        str(video_limit),
        str(output_video),
        timeout=300 if long_form else 150,
        cwd=root,
    )
    if not 0 < output_video.stat().st_size <= video_limit:
        raise MediaError("invalid final video size")
    output_media, output_streams = await _streams(output_video, ffprobe)
    final_track = _video_track(output_media, output_streams)
    final_audio = next(
        (stream for stream in output_streams if stream.get("codec_type") == "audio"),
        None,
    )
    if final_audio is None:
        raise MediaError("final audio track missing")
    video_start = _ms(final_track.get("start_time"))
    audio_start = _ms(final_audio.get("start_time"))
    video_ms = _ms(final_track.get("duration"))
    audio_ms = _ms(final_audio.get("duration"))
    if (
        (final_track["width"], final_track["height"]) != (WIDTH, HEIGHT)
        or final_track["pix_fmt"] != "yuv420p"
        or Fraction(final_track["avg_frame_rate"]) != FPS
        or max(abs(video_start), abs(audio_start)) > 50
        or abs(video_start - _ms(track.get("start_time"))) > MAX_AUDIO_LAG_MS
        or abs((video_start + video_ms) - (audio_start + audio_ms)) > MAX_AUDIO_LAG_MS
    ):
        raise MediaError("invalid final video geometry or timeline")
    if seam_times_ms is None:
        result = await validate_output(
            output_video,
            source_audio,
            audio_duration_ms,
            video_duration_ms,
            ffmpeg,
            ffprobe,
        )
    else:
        result = await validate_long_delivery(
            output_video,
            source_audio,
            audio_duration_ms,
            video_duration_ms,
            seam_times_ms,
            ffmpeg,
            ffprobe,
        )
    if settings["captionMode"] in {"SIDECAR", "BOTH"}:
        sidecar = _caption_text(captions)
        if not 0 < len(sidecar) <= subtitle_limit:
            raise MediaError("invalid subtitle file size")
        output_subtitles.write_bytes(sidecar)
    return MediaCheck(
        audio_ms,
        result.video_duration_ms,
        result.audio_lag_ms,
        result.minimum_audio_correlation_permille,
    )
