from __future__ import annotations

import asyncio
import json
import math
import shutil
from array import array
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from sys import byteorder
from typing import Any, Literal

from .media import (
    _AUDIO_RATE,
    _MOV,
    _MP3,
    MAX_AUDIO_LAG_MS,
    MAX_DURATION_MS,
    MAX_VIDEO_BYTES,
    MIN_CORRELATION_PERMILLE,
    MediaCheck,
    MediaError,
    _find_best_offset,
    _ms,
    _require_decodable_video,
    _run,
    _streams,
    _video_track,
    inspect_speech,
    validate_output,
)

FPS = 30
PCM_RATE = 48_000
TICKS = 90_000
SAMPLES_PER_FRAME = PCM_RATE // FPS
MIN_LONG_MS, MAX_LONG_MS = 61_000, 90_000
MAX_LONG_VIDEO_BYTES = 256 * 1024 * 1024
MAX_LONG_WORKER_VIDEO_BYTES = 128 * 1024 * 1024
MAX_LONG_WORKER_AUDIO_BYTES = 16 * 1024 * 1024


def frame_ms(frames: int) -> int:
    return round(Fraction(frames * 1000, FPS))


async def _frame_grid(
    file: Path, frame_count: int, ffprobe: str, seam_frames: tuple[int, ...] = ()
) -> tuple[int, int, int, int]:
    result = await _run(
        ffprobe,
        "-v",
        "error",
        *_MOV,
        "-select_streams",
        "v:0",
        "-show_packets",
        "-show_entries",
        "packet=pts,dts,flags:stream=time_base,width,height",
        "-of",
        "json",
        str(file),
        capture=True,
    )
    try:
        probe = json.loads(result)
        (stream,) = probe["streams"]
        packets = probe["packets"]
        if (
            Fraction(stream["time_base"]) != Fraction(1, TICKS)
            or len(packets) != frame_count
        ):
            raise ValueError("frame grid mismatch")
        step = TICKS // FPS
        for index, packet in enumerate(packets):
            if packet["pts"] != index * step or packet["dts"] != index * step:
                raise ValueError("frame timestamp gap or overlap")
            if (index == 0 or index in seam_frames) and "K" not in packet["flags"]:
                raise ValueError("segment boundary does not start with a keyframe")
        return stream["width"], stream["height"], packets[0]["pts"], packets[-1]["pts"]
    except (KeyError, TypeError, ValueError, IndexError, ZeroDivisionError) as error:
        raise MediaError("invalid normalized picture timeline") from error


async def normalize_segment(
    video: Path, audio: Path, normalized: Path, pcm: Path, ffmpeg: str, ffprobe: str
) -> dict[str, Any]:
    container, streams = await _streams(video, ffprobe)
    picture = _video_track(container, streams)
    video_ms = _ms(picture.get("duration", container.get("duration")))
    audio_ms = await inspect_speech(audio, ffmpeg, ffprobe)
    checked = await validate_output(video, audio, audio_ms, video_ms, ffmpeg, ffprobe)
    picture_start = _ms(picture.get("start_time"))

    await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        *_MP3,
        "-i",
        str(audio),
        "-map",
        "0:a:0",
        "-t",
        "31",
        "-ac",
        "1",
        "-ar",
        str(PCM_RATE),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        str(pcm),
    )
    byte_count = pcm.stat().st_size
    sample_count = byte_count // 2
    if byte_count % 2 or not 1 <= sample_count <= MAX_DURATION_MS * PCM_RATE // 1000:
        raise MediaError("decoded segment audio has invalid sample count")
    if abs(round(Fraction(sample_count * 1000, PCM_RATE)) - audio_ms) > 1:
        raise MediaError("decoded segment audio length changed")
    frame_count = (sample_count + SAMPLES_PER_FRAME - 1) // SAMPLES_PER_FRAME
    padding_samples = frame_count * SAMPLES_PER_FRAME - sample_count
    with pcm.open("ab") as target:
        target.write(b"\0" * (padding_samples * 2))

    await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        "-copyts",
        *_MOV,
        "-threads",
        "2",
        "-i",
        str(video),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        "fps=30:start_time=0,tpad=stop_mode=clone:stop_duration=0.140",
        "-frames:v",
        str(frame_count),
        "-c:v",
        "libx264",
        "-bf",
        "0",
        "-preset",
        "fast",
        "-crf",
        "21",
        "-maxrate",
        "8M",
        "-bufsize",
        "16M",
        "-threads",
        "4",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        str(TICKS),
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-fs",
        str(MAX_VIDEO_BYTES),
        str(normalized),
        timeout=150,
    )
    if not 0 < normalized.stat().st_size <= MAX_VIDEO_BYTES:
        raise MediaError("normalized segment has invalid size")
    width, height, _, _ = await _frame_grid(normalized, frame_count, ffprobe)
    return {
        "width": width,
        "height": height,
        "sampleAspectRatio": picture.get("sample_aspect_ratio") or "1:1",
        "frameCount": frame_count,
        "sampleCount": sample_count,
        "paddingSamples": padding_samples,
        "sourceAudioDurationMs": checked.audio_duration_ms,
        "sourceVideoDurationMs": checked.video_duration_ms,
        "sourcePictureStartMs": picture_start,
        "sourceAudioLagMs": checked.audio_lag_ms,
        "sourceAudioCorrelationPermille": checked.minimum_audio_correlation_permille,
    }


async def _decode_long_audio(
    file: Path, ffmpeg: str, *, source_format: Literal["raw", "mp3", "mp4"]
) -> array[int]:
    source = {
        "raw": ("-f", "s16le", "-ar", str(PCM_RATE), "-ac", "1"),
        "mp3": _MP3,
        "mp4": _MOV,
    }[source_format]
    data = await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        *source,
        "-i",
        str(file),
        "-map",
        "0:a:0",
        "-t",
        "91",
        "-ac",
        "1",
        "-ar",
        str(_AUDIO_RATE),
        "-f",
        "s16le",
        "pipe:1",
        capture=True,
    )
    if not 0 < len(data) <= 91 * _AUDIO_RATE * 2 or len(data) % 2:
        raise MediaError("invalid decoded candidate audio")
    result: array[int] = array("h")
    result.frombytes(data)
    if byteorder != "little":
        result.byteswap()
    return result


def _compare_audio(
    reference: array[int],
    candidate: array[int],
    bounds: list[tuple[str, int, int, bool]],
) -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []
    for label, left, right, require_voice in bounds:
        start, stop = (
            round(Fraction(frame * _AUDIO_RATE, FPS)) for frame in (left, right)
        )
        stop = min(stop, len(reference), len(candidate))
        block_size = min(_AUDIO_RATE // 5, stop - start)
        if block_size <= 0:
            raise MediaError("candidate audio window missing")
        candidates = range(start, stop - block_size + 1, max(1, block_size // 2))
        energy, offset = max(
            (sum(value * value for value in reference[i : i + block_size]), i)
            for i in candidates
        )
        if energy <= 100 * block_size:
            received = candidate[start:stop]
            if require_voice or sum(value * value for value in received) > 150 * len(
                received
            ):
                raise MediaError("candidate audio window mismatched")
            windows.append(
                {
                    "id": label,
                    "kind": "silence",
                    "startMs": frame_ms(left),
                    "endMs": frame_ms(right),
                }
            )
            continue
        correlation, lag = _find_best_offset(reference, candidate, offset, block_size)
        permille = math.floor(correlation * 1000)
        if permille < MIN_CORRELATION_PERMILLE or abs(lag) > MAX_AUDIO_LAG_MS:
            raise MediaError("candidate audio failed local offset check")
        windows.append(
            {
                "id": label,
                "kind": "waveform",
                "startMs": frame_ms(left),
                "endMs": frame_ms(right),
                "lagMs": lag,
                "correlationPermille": permille,
            }
        )
    lags = [item["lagMs"] for item in windows if item["kind"] == "waveform"]
    if not lags or max(lags) - min(lags) > 30:
        raise MediaError("candidate audio offsets drift across segment boundaries")
    return windows


def seam_frames_for_duration(
    duration_ms: int, seam_times_ms: list[int]
) -> tuple[int, tuple[int, ...]]:
    frames = round(Fraction(duration_ms * FPS, 1000))
    seams = tuple(round(Fraction(time * FPS, 1000)) for time in seam_times_ms)
    if (
        not MIN_LONG_MS <= duration_ms <= MAX_LONG_MS
        or frame_ms(frames) != duration_ms
        or not 2 <= len(seams) <= 11
        or list(seams) != sorted(set(seams))
        or seams[0] <= 0
        or seams[-1] >= frames
        or [frame_ms(frame) for frame in seams] != seam_times_ms
    ):
        raise MediaError("long media seams do not match the 30 fps frame grid")
    return frames, seams


async def encode_long_drive_audio(
    checkpoint_dir: Path, output: Path, records: list[dict[str, Any]], ffmpeg: str
) -> None:
    with output.with_suffix(".s16le").open("wb") as joined:
        pcm_file = Path(joined.name)
        samples = 0
        for index, record in enumerate(records, 1):
            segment = checkpoint_dir / f"segment-{index:02d}.s16le"
            expected_size = record["frameCount"] * SAMPLES_PER_FRAME * 2
            if segment.stat().st_size != expected_size:
                raise MediaError("missing or damaged normalized audio")
            samples += expected_size // 2
            with segment.open("rb") as audio:
                shutil.copyfileobj(audio, joined, length=128 * 1024)
    if not MIN_LONG_MS * PCM_RATE <= samples * 1000 <= MAX_LONG_MS * PCM_RATE:
        raise MediaError("invalid long drive audio sample count")
    try:
        await _run(
            ffmpeg,
            "-v",
            "error",
            "-nostdin",
            "-xerror",
            "-f",
            "s16le",
            "-ar",
            str(PCM_RATE),
            "-ac",
            "1",
            "-i",
            str(pcm_file),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "160k",
            "-map_metadata",
            "-1",
            str(output),
        )
    finally:
        pcm_file.unlink(missing_ok=True)
    if not 0 < output.stat().st_size <= MAX_LONG_WORKER_AUDIO_BYTES:
        raise MediaError("long drive audio size is not supported")


async def validate_long_delivery(
    video: Path,
    audio: Path,
    audio_ms: int,
    video_ms: int,
    seam_times_ms: list[int],
    ffmpeg: str,
    ffprobe: str,
) -> MediaCheck:
    frames, seams = seam_frames_for_duration(video_ms, seam_times_ms)
    await _frame_grid(video, frames, ffprobe, seams)
    video_format, video_streams = await _streams(video, ffprobe)
    picture = _video_track(video_format, video_streams)
    voices = [track for track in video_streams if track.get("codec_type") == "audio"]
    _, audio_streams = await _streams(audio, ffprobe, audio_only=True)
    if (
        picture.get("codec_name") != "h264"
        or len(video_streams) != 2
        or len(voices) != 1
        or voices[0].get("codec_name") != "aac"
        or len(audio_streams) != 1
        or audio_streams[0].get("codec_name") != "mp3"
    ):
        raise MediaError("long delivery has invalid audio or picture track")
    encoded_audio_ms = _ms(voices[0].get("duration"))
    audio_start = _ms(voices[0].get("start_time"))
    if (
        abs(_ms(picture.get("duration")) - video_ms) > 1
        or abs(audio_start) > 20
        or abs(audio_start + encoded_audio_ms - video_ms) > 34
    ):
        raise MediaError("long delivery audio and picture endpoints differ")
    await _require_decodable_video(video, ffmpeg)
    original, output = await asyncio.gather(
        _decode_long_audio(audio, ffmpeg, source_format="mp3"),
        _decode_long_audio(video, ffmpeg, source_format="mp4"),
    )
    measured_ms = round(Fraction(len(original) * 1000, _AUDIO_RATE))
    if (
        abs(measured_ms - audio_ms) > 34
        or abs(len(original) - len(output)) > _AUDIO_RATE * 34 // 1000
    ):
        raise MediaError("long delivery decoded voice duration differs")
    bounds: list[tuple[str, int, int, bool]] = []
    boundaries = (0, *seams, frames)
    for index, (left, right) in enumerate(pairwise(boundaries)):
        bounds.append((f"segment-{index + 1}", left, right, True))
        if index:
            bounds.extend(
                (
                    (
                        f"seam-{index}-before",
                        max(boundaries[index - 1], left - FPS),
                        left,
                        False,
                    ),
                    (f"seam-{index}-after", left, min(left + FPS, right), False),
                )
            )
    windows = await asyncio.to_thread(_compare_audio, original, output, bounds)
    matched = [item for item in windows if item["kind"] == "waveform"]
    return MediaCheck(
        measured_ms,
        video_ms,
        max((item["lagMs"] for item in matched), key=abs),
        min(item["correlationPermille"] for item in matched),
    )


async def assemble_candidate(
    checkpoint_dir: Path,
    work_dir: Path,
    checkpoints: list[dict[str, Any]],
    ffmpeg: str,
    ffprobe: str,
) -> tuple[Path, dict[str, Any]]:
    pcm = work_dir / "full.s16le"
    video = work_dir / "candidate.mp4"
    concat = work_dir / "segments.ffconcat"
    # Use only code-generated basenames. The list is written alongside the staged
    # normalized clips and never interpolates a user path into FFmpeg syntax.
    entries = ["ffconcat version 1.0"]
    seam_frames: list[int] = []
    bounds: list[tuple[str, int, int, bool]] = []
    total_frames, source_samples = 0, 0
    with pcm.open("wb") as audio:
        for index, checkpoint in enumerate(checkpoints):
            frame_count = checkpoint["frameCount"]
            source_samples += checkpoint["sampleCount"]
            left, right = total_frames, total_frames + frame_count
            bounds.append((f"segment-{index + 1}", left, right, True))
            if index:
                seam_frames.append(left)
                bounds.extend(
                    (
                        (
                            f"seam-{index}-before",
                            max(
                                left - FPS, left - checkpoints[index - 1]["frameCount"]
                            ),
                            left,
                            False,
                        ),
                        (f"seam-{index}-after", left, min(right, left + FPS), False),
                    )
                )
            total_frames = right
            stem = f"segment-{index + 1:02d}"
            clip_path = checkpoint_dir / f"{stem}.mp4"
            # The list is in work_dir, so give concat a hard link per validated
            # normalized clip on the same local volume instead of relaxing -safe.
            (work_dir / clip_path.name).hardlink_to(clip_path)
            entries.extend(
                (f"file '{clip_path.name}'", f"duration {frame_count / FPS:.6f}")
            )
            with (checkpoint_dir / f"{stem}.s16le").open("rb") as segment_audio:
                shutil.copyfileobj(segment_audio, audio, length=128 * 1024)
    duration_ms = frame_ms(total_frames)
    if (
        source_samples * 1000 < MIN_LONG_MS * PCM_RATE
        or total_frames * 1000 > MAX_LONG_MS * FPS
        or pcm.stat().st_size != total_frames * SAMPLES_PER_FRAME * 2
    ):
        raise MediaError("trial requires 61 to 90 seconds of audio and picture")
    concat.write_text("\n".join(entries) + "\n", encoding="ascii", newline="\n")
    await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        str(concat),
        "-f",
        "s16le",
        "-ar",
        str(PCM_RATE),
        "-ac",
        "1",
        "-i",
        str(pcm),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-video_track_timescale",
        str(TICKS),
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-fs",
        str(MAX_LONG_VIDEO_BYTES),
        str(video),
        timeout=150,
    )
    if not 0 < video.stat().st_size <= MAX_LONG_VIDEO_BYTES:
        raise MediaError("candidate video has invalid size")
    width, height, start_pts, end_pts = await _frame_grid(
        video, total_frames, ffprobe, tuple(seam_frames)
    )
    container, streams = await _streams(video, ffprobe)
    picture = _video_track(container, streams)
    audio_tracks = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if (
        len(streams) != 2
        or len(audio_tracks) != 1
        or audio_tracks[0].get("codec_name") != "aac"
        or picture.get("codec_name") != "h264"
    ):
        raise MediaError("candidate tracks invalid")
    audio_start = _ms(audio_tracks[0].get("start_time"))
    audio_ms = _ms(audio_tracks[0].get("duration"))
    if abs(audio_start) > 20 or abs(audio_start + audio_ms - duration_ms) > 34:
        raise MediaError("candidate audio and picture endpoints differ")
    await _require_decodable_video(video, ffmpeg)
    reference, received = await asyncio.gather(
        _decode_long_audio(pcm, ffmpeg, source_format="raw"),
        _decode_long_audio(video, ffmpeg, source_format="mp4"),
    )
    if abs(len(reference) - len(received)) > _AUDIO_RATE * 34 // 1000:
        raise MediaError("candidate PCM duration differs")
    windows = await asyncio.to_thread(_compare_audio, reference, received, bounds)
    waveform = [item for item in windows if item["kind"] == "waveform"]
    return video, {
        "durationMs": duration_ms,
        "audioDurationMs": audio_ms,
        "audioStartMs": audio_start,
        "width": width,
        "height": height,
        "fps": FPS,
        "frameCount": total_frames,
        "pictureTimeBase": f"1/{TICKS}",
        "pictureFirstPts": start_pts,
        "pictureLastPts": end_pts,
        "seams": [
            {"frame": frame, "pts": frame * (TICKS // FPS), "timeMs": frame_ms(frame)}
            for frame in seam_frames
        ],
        "audioWindows": windows,
        "minimumAudioCorrelationPermille": min(
            window["correlationPermille"] for window in waveform
        ),
        "maxAbsAudioLagMs": max(abs(window["lagMs"]) for window in waveform),
    }
