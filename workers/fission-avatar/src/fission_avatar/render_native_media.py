from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from fractions import Fraction
from hashlib import file_digest
from pathlib import Path
from typing import Any, TypedDict

from .media import (
    _MOV,
    MAX_AUDIO_LAG_MS,
    MAX_DURATION_MS,
    MediaError,
    _run,
    _streams,
    _video_track,
)
from .render_media import (
    HEIGHT,
    MAX_RENDER_BYTES,
    MAX_SUBTITLE_BYTES,
    WIDTH,
    Settings,
    _aspect_ratio,
    _caption_filters,
    _caption_text,
    _image_input,
    _placement,
)

MAX_TIMELINE_DRIFT_US = 2_000
_SHA256 = re.compile(r"SHA256:[0-9a-f]{64}")


class NativeTimelineError(MediaError):
    """The output cannot be shown to preserve the approved native timeline."""


class NativeRenderCompletion(TypedDict):
    schemaVersion: int
    audioDurationMs: int
    videoDurationMs: int
    sourceVideoSha256: str
    outputVideoSha256: str
    videoFrameCount: int
    audioPacketCount: int
    maxTimelineDriftUs: int


@dataclass(frozen=True)
class TrackBounds:
    start: Fraction
    duration: Fraction

    @property
    def end(self) -> Fraction:
        return self.start + self.duration


@dataclass(frozen=True)
class Sample:
    pts: Fraction
    duration: Fraction


@dataclass(frozen=True)
class AudioPacket:
    timing: Sample
    sha256: str
    padding: tuple[int, int] | None


@dataclass(frozen=True)
class NativeTimeline:
    video: TrackBounds
    audio: TrackBounds
    frame_pts: tuple[Fraction, ...]
    audio_packets: tuple[AudioPacket, ...]
    audio_config: tuple[str, str, int]


def _sha256(path: Path) -> str:
    with path.open("rb") as source:
        return file_digest(source, "sha256").hexdigest()


def _stream_time(value: object, time_base: Fraction) -> Fraction:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("missing integer stream timestamp")
    return value * time_base


def _positive_duration(value: object, time_base: Fraction) -> Fraction:
    duration = _stream_time(value, time_base)
    if duration <= 0:
        raise ValueError("invalid stream duration")
    return duration


async def _timestamp_probe(
    path: Path, ffprobe: str, *, audio: bool
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    streams = "stream=codec_name,time_base,start_pts,duration_ts"
    options: tuple[str, ...]
    if audio:
        options = (
            "-show_packets",
            "-show_data_hash",
            "sha256",
            "-show_entries",
            f"{streams},sample_rate,channels,extradata_hash:"
            "packet=pts,duration,data_hash:"
            "packet_side_data=side_data_type,skip_samples,discard_padding",
        )
    else:
        options = (
            "-show_frames",
            "-show_entries",
            f"{streams}:frame=pts",
        )
    try:
        data = json.loads(
            await _run(
                ffprobe,
                "-v",
                "error",
                *_MOV,
                "-select_streams",
                "a:0" if audio else "v:0",
                *options,
                "-of",
                "json",
                str(path),
                capture=True,
            )
        )
        (track,) = data["streams"]
        samples = data["packets" if audio else "frames"]
        if not isinstance(track, dict) or not isinstance(samples, list) or not samples:
            raise ValueError("missing native track samples")
        return track, samples
    except (KeyError, MediaError, TypeError, ValueError) as error:
        raise NativeTimelineError("unreadable native media timestamps") from error


def _bounds(track: dict[str, Any]) -> tuple[Fraction, TrackBounds]:
    base = Fraction(track["time_base"])
    if not 0 < base <= 1:
        raise ValueError("invalid track time base")
    return base, TrackBounds(
        _stream_time(track["start_pts"], base),
        _positive_duration(track["duration_ts"], base),
    )


def _sample(entry: dict[str, Any], base: Fraction) -> Sample:
    return Sample(
        _stream_time(entry["pts"], base),
        _positive_duration(entry["duration"], base),
    )


def _padding(entry: dict[str, Any]) -> tuple[int, int] | None:
    side_data = entry.get("side_data_list", [])
    if not side_data:
        return None
    (side,) = side_data
    if side["side_data_type"] != "Skip Samples":
        raise ValueError("unsupported AAC packet side data")
    skip, discard = side["skip_samples"], side["discard_padding"]
    if any(not isinstance(value, int) or value < 0 for value in (skip, discard)):
        raise ValueError("invalid AAC packet padding")
    return skip, discard


def _packet(entry: dict[str, Any], base: Fraction) -> AudioPacket:
    sha = entry["data_hash"]
    if not _SHA256.fullmatch(sha):
        raise ValueError("missing AAC packet hash")
    return AudioPacket(_sample(entry, base), sha, _padding(entry))


async def probe_native_timeline(path: Path, ffprobe: str) -> NativeTimeline:
    video_track, video = await _timestamp_probe(path, ffprobe, audio=False)
    audio_track, audio = await _timestamp_probe(path, ffprobe, audio=True)
    try:
        if video_track["codec_name"] != "h264" or audio_track["codec_name"] != "aac":
            raise ValueError("native timeline must contain H.264 and AAC")
        config = audio_track["extradata_hash"]
        if not _SHA256.fullmatch(config):
            raise ValueError("missing AAC codec config hash")
        video_base, video_bounds = _bounds(video_track)
        audio_base, audio_bounds = _bounds(audio_track)
        frame_pts = tuple(_stream_time(entry["pts"], video_base) for entry in video)
        packets = tuple(_packet(entry, audio_base) for entry in audio)
        for samples in (frame_pts, tuple(packet.timing.pts for packet in packets)):
            if any(next_pts <= pts for pts, next_pts in zip(samples, samples[1:])):
                raise ValueError("non-increasing presentation timestamps")
        return NativeTimeline(
            video_bounds,
            audio_bounds,
            frame_pts,
            packets,
            (config, audio_track["sample_rate"], audio_track["channels"]),
        )
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
        raise NativeTimelineError("invalid native media timeline") from error


def compare_native_timelines(source: NativeTimeline, output: NativeTimeline) -> int:
    if (
        len(source.frame_pts) != len(output.frame_pts)
        or len(source.audio_packets) != len(output.audio_packets)
        or source.audio_config != output.audio_config
    ):
        raise NativeTimelineError("native frame count or AAC stream changed")

    # Anchor to the first presented video frame. Any muxer-origin shift must
    # move both streams together, including AAC priming and track edit bounds.
    shift = output.frame_pts[0] - source.frame_pts[0]
    drift = max(
        abs(output.video.start - source.video.start - shift),
        abs(output.video.end - source.video.end - shift),
        abs(output.audio.start - source.audio.start - shift),
        abs(output.audio.end - source.audio.end - shift),
    )
    for before_pts, after_pts in zip(source.frame_pts, output.frame_pts, strict=True):
        drift = max(drift, abs(after_pts - before_pts - shift))
    for before_packet, after_packet in zip(
        source.audio_packets, output.audio_packets, strict=True
    ):
        if (
            before_packet.sha256 != after_packet.sha256
            or before_packet.padding != after_packet.padding
        ):
            raise NativeTimelineError("native AAC packet payload or padding changed")
        before, after = before_packet.timing, after_packet.timing
        drift = max(
            drift,
            abs(after.pts - before.pts - shift),
            abs(after.duration - before.duration),
        )
    drift_us = math.ceil(drift * 1_000_000)
    if drift_us > MAX_TIMELINE_DRIFT_US:
        raise NativeTimelineError("native audio and video timeline drifted")
    return drift_us


def _composition_graph(
    settings: Settings, width: int, height: int, filters: list[str]
) -> str:
    size = f"{WIDTH}:{HEIGHT}"
    subject = f"scale={width}:{height},setsar=1"
    if settings["background"]["kind"] == "IMAGE":
        # Each overlay advances on the source's clock. The still has a single
        # frame before the first video PTS and repeats without supplying a clock.
        compose = (
            "[0:v:0]split=2[base][picture];"
            f"[base]scale=2:2,scale={size},setsar=1[clock];"
            "[1:v:0]trim=end_frame=1,"
            f"crop=w='max(2,trunc(min(iw,ih*{WIDTH}/{HEIGHT})/2)*2)':"
            f"h='max(2,trunc(min(ih,iw*{HEIGHT}/{WIDTH})/2)*2)',"
            f"scale={size},setsar=1,setpts=PTS-STARTPTS-1/TB[image];"
            "[clock][image]overlay=eof_action=repeat[canvas];"
            f"[picture]{subject}[subject];"
            "[canvas][subject]overlay=(W-w)/2:(H-h)/2:shortest=1:repeatlast=0"
        )
    else:
        color = settings["background"]["color"][1:]
        compose = f"[0:v:0]{subject},pad={size}:(ow-iw)/2:(oh-ih)/2:color=0x{color}"
    return ",".join((compose, *filters, "format=yuv420p[v]"))


async def render_native_video(
    *,
    source_video: Path,
    source_video_sha256: str,
    expected_video_duration_ms: int,
    background: Path | None,
    output_video: Path,
    output_subtitles: Path,
    settings: Settings,
    ffmpeg: str,
    ffprobe: str,
    font: Path,
) -> NativeRenderCompletion:
    source_sha = _sha256(source_video)
    if source_sha != source_video_sha256:
        raise NativeTimelineError("native source content does not match the approved revision")
    source_media, source_streams = await _streams(source_video, ffprobe)
    track = _video_track(source_media, source_streams)
    if len(source_streams) != 2:
        raise NativeTimelineError("native source requires exactly two streams")
    source = await probe_native_timeline(source_video, ffprobe)
    if (
        abs(source.video.duration * 1_000 - expected_video_duration_ms)
        > MAX_AUDIO_LAG_MS
        or round(source.audio.duration * 1_000) > MAX_DURATION_MS
        or round(source.video.duration * 1_000) > MAX_DURATION_MS
    ):
        raise NativeTimelineError("native source duration does not match the approved revision")

    if (background is not None) != (settings["background"]["kind"] == "IMAGE"):
        raise MediaError("frozen background did not match the composition")
    background_options = await _image_input(background, ffprobe) if background else ()
    width, height = _placement(_aspect_ratio(track), settings["insetPercent"])
    captions = settings["captions"]
    burn = settings["captionMode"] in {"BURN", "BOTH"}
    filters = _caption_filters(output_video.parent, captions, font) if burn and captions else []

    await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        "-filter_complex_threads",
        "2",
        "-copyts",
        "-start_at_zero",
        *_MOV,
        "-err_detect",
        "explode",
        "-threads",
        "2",
        "-i",
        str(source_video),
        *background_options,
        "-filter_complex",
        _composition_graph(settings, width, height, filters),
        "-map",
        "[v]",
        "-map",
        "0:a:0",
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
        "-enc_time_base:v",
        "demux",
        "-fps_mode:v",
        "passthrough",
        "-c:a",
        "copy",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-movflags",
        "+faststart",
        "-fs",
        str(MAX_RENDER_BYTES),
        str(output_video),
        timeout=150,
        cwd=output_video.parent,
    )
    if not 0 < output_video.stat().st_size <= MAX_RENDER_BYTES:
        raise MediaError("invalid final native video size")
    output_media, output_streams = await _streams(output_video, ffprobe)
    video = _video_track(output_media, output_streams)
    if (
        len(output_streams) != 2
        or (video["width"], video["height"]) != (WIDTH, HEIGHT)
        or video["pix_fmt"] != "yuv420p"
    ):
        raise MediaError("invalid native output geometry")

    output = await probe_native_timeline(output_video, ffprobe)
    drift = compare_native_timelines(source, output)
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
        str(output_video),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
    )
    if settings["captionMode"] in {"SIDECAR", "BOTH"}:
        sidecar = _caption_text(captions)
        if not 0 < len(sidecar) <= MAX_SUBTITLE_BYTES:
            raise MediaError("invalid subtitle file size")
        output_subtitles.write_bytes(sidecar)
    return {
        "schemaVersion": 3,
        "audioDurationMs": round(output.audio.duration * 1_000),
        "videoDurationMs": round(output.video.duration * 1_000),
        "sourceVideoSha256": source_sha,
        "outputVideoSha256": _sha256(output_video),
        "videoFrameCount": len(output.frame_pts),
        "audioPacketCount": len(output.audio_packets),
        "maxTimelineDriftUs": drift,
    }
