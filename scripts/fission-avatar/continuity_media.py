"""Local media operations for the short Avatar continuation comparison."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
from array import array
from dataclasses import dataclass
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

FPS = 30
RATE = 48_000
SAMPLES_PER_FRAME = RATE // FPS
MAX_SEGMENT_FRAMES = 4 * FPS
MIN_SEGMENT_FRAMES = FPS
MAX_TOTAL_FRAMES = 3 * MAX_SEGMENT_FRAMES
MAX_VIDEO_BYTES = 64 * 1024 * 1024
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MOV = ("-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0")
MP3 = ("-protocol_whitelist", "file,pipe", "-f", "mp3")


class MediaError(ValueError):
    """A local file or its timeline failed the pilot's media constraints."""


@dataclass(frozen=True)
class Tools:
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"

    def encode(
        self, *args: str, capture: bool = False, cwd: Path | None = None
    ) -> bytes:
        return _run(
            (
                self.ffmpeg,
                "-hide_banner",
                "-v",
                "error",
                "-xerror",
                "-nostdin",
                "-n",
                *args,
            ),
            capture,
            cwd,
        )

    def probe(self, *args: str) -> dict[str, Any]:
        value = json.loads(
            _run((self.ffprobe, "-v", "error", *args, "-of", "json"), True)
        )
        if not isinstance(value, dict):
            raise MediaError("ffprobe returned an invalid media description")
        return value


def _run(args: tuple[str, ...], capture: bool, cwd: Path | None = None) -> bytes:
    try:
        process = subprocess.run(
            args,
            check=True,
            timeout=90,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=cwd,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise MediaError(
            f"local media command failed ({type(error).__name__})"
        ) from error
    return process.stdout or b""


def _ms(frames: int) -> int:
    return round(Fraction(frames * 1000, FPS))


def _file(path: Path, maximum: int) -> Path:
    value = path.resolve(strict=True)
    if not value.is_file() or not 0 < value.stat().st_size <= maximum:
        raise MediaError("local media file missing or outside the size limit")
    return value


def _output(path: Path) -> Path:
    path = path.absolute()
    if path.exists() or path.is_symlink():
        raise MediaError("output already exists")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _digest(file: Path) -> str:
    with file.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _pick_track(data: dict[str, Any], kind: str) -> dict[str, Any]:
    tracks = [
        item
        for item in data.get("streams", [])
        if isinstance(item, dict) and item.get("codec_type") == kind
    ]
    if len(tracks) != 1:
        raise MediaError(f"expected one {kind} track")
    return tracks[0]


def _time_ms(value: object) -> int:
    try:
        return round(Fraction(str(value)) * 1000)
    except (ValueError, ZeroDivisionError) as error:
        raise MediaError("invalid media timestamp") from error


def _picture(
    path: Path, tools: Tools, *, count: bool = False
) -> tuple[dict[str, Any], dict[str, Any]]:
    path = _file(path, MAX_VIDEO_BYTES)
    data = tools.probe(
        *MOV,
        *(["-count_frames"] if count else []),
        "-show_entries",
        "stream=codec_type,codec_name,width,height,pix_fmt,color_transfer,"
        "sample_aspect_ratio,avg_frame_rate,duration,start_time,nb_read_frames:"
        "stream_side_data=rotation:format=duration,format_name:format_tags=major_brand",
        str(path),
    )
    picture = _pick_track(data, "video")
    container = data.get("format", {})
    width, height = picture.get("width", 0), picture.get("height", 0)
    duration = _time_ms(picture.get("duration", container.get("duration")))
    try:
        fps = Fraction(picture["avg_frame_rate"])
    except (KeyError, ValueError, ZeroDivisionError) as error:
        raise MediaError("invalid source frame rate") from error
    if (
        not container.get("tags", {}).get("major_brand")
        or container["tags"]["major_brand"].strip() == "qt"
        or picture.get("codec_name") not in {"h264", "hevc"}
        or not (
            240 <= width <= 4096
            and 240 <= height <= 4096
            and width * height <= 1920 * 1080
        )
        or not 12 <= fps <= 60
        or not 200 <= duration <= 12_100
        or picture.get("pix_fmt") not in {"yuv420p", "yuvj420p"}
        or picture.get("color_transfer") in {"smpte2084", "arib-std-b67"}
        or any(item.get("rotation", 0) for item in picture.get("side_data_list", []))
    ):
        raise MediaError(
            "picture does not meet SDR MP4 size, frame rate or duration limits"
        )
    return picture, data


def _pcm(file: Path, tools: Tools, *, mov: bool = False, rate: int = RATE) -> bytes:
    data = tools.encode(
        *(MOV if mov else MP3),
        "-threads",
        "1",
        "-i",
        str(file),
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        "12.2",
        "-ar",
        str(rate),
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
        capture=True,
    )
    if not data or len(data) % 2 or len(data) > 25 * rate:
        raise MediaError("audio is empty or could not be decoded completely")
    return data


def _samples(data: bytes) -> array[int]:
    samples: array[int] = array("h")
    samples.frombytes(data)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _word_ranges(timings: Path, duration_ms: int) -> list[tuple[int, int]]:
    if not 0 < timings.stat().st_size <= 128 * 1024:
        raise MediaError("invalid word timing file size")
    raw = json.loads(timings.read_text(encoding="utf-8-sig"))
    rows = raw.get("wordTimings") if isinstance(raw, dict) else raw
    if not isinstance(rows, list) or len(rows) > 512:
        raise MediaError("word timings must be an array")
    result: list[tuple[int, int]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise MediaError("invalid word timing row")
        start, end = row.get("startMs"), row.get("endMs")
        if (
            type(start) is not int
            or type(end) is not int
            or not 0 <= start < end <= duration_ms
        ):
            raise MediaError("word timing extends beyond decoded master audio")
        result.append((start, end))
    return sorted(result)


def _choose_cuts(
    pcm: bytes, ranges: list[tuple[int, int]], total_frames: int
) -> list[dict[str, Any]]:
    samples = _samples(pcm)
    overall_energy = sum(i * i for i in samples) / len(samples)
    quiet_limit = max(16**2, overall_energy * 0.15**2)

    def evidence(frame: int) -> tuple[int, float, dict[str, Any]]:
        time = _ms(frame)
        half_window = RATE // 50
        position = frame * SAMPLES_PER_FRAME
        window = samples[position - half_window : position + half_window]
        energy = sum(i * i for i in window) / len(window)
        overlaps = any(start - 10 < time < end + 10 for start, end in ranges)
        before = max((end for _, end in ranges if end <= time), default=None)
        after = min((start for start, _ in ranges if start >= time), default=None)
        gap = (
            before is not None
            and after is not None
            and before + 15 <= time <= after - 15
        )
        kind = (
            "TIMING_PAUSE"
            if not overlaps and gap and energy <= quiet_limit
            else (
                "QUIET_PCM"
                if not overlaps and energy <= quiet_limit
                else ("TIMING_GAP" if not overlaps and gap else "FIXED_FALLBACK")
            )
        )
        rank = {
            "TIMING_PAUSE": 0,
            "QUIET_PCM": 1,
            "TIMING_GAP": 2,
            "FIXED_FALLBACK": 3,
        }[kind]
        if overlaps:
            rank += 2
        return (
            rank,
            energy,
            {
                "frame": frame,
                "timeMs": time,
                "basis": kind,
                "insideTimedWord": overlaps,
            },
        )

    measured = {
        frame: evidence(frame)
        for frame in range(MIN_SEGMENT_FRAMES, total_frames - MIN_SEGMENT_FRAMES + 1)
    }
    candidates = []
    for first in range(
        max(MIN_SEGMENT_FRAMES, total_frames - 2 * MAX_SEGMENT_FRAMES),
        min(MAX_SEGMENT_FRAMES, total_frames - 2 * MIN_SEGMENT_FRAMES) + 1,
    ):
        for second in range(
            max(first + MIN_SEGMENT_FRAMES, total_frames - MAX_SEGMENT_FRAMES),
            min(first + MAX_SEGMENT_FRAMES, total_frames - MIN_SEGMENT_FRAMES) + 1,
        ):
            rank_a, energy_a, cut_a = measured[first]
            rank_b, energy_b, cut_b = measured[second]
            distance = abs(first - 4 * FPS) + abs(second - 8 * FPS)
            score = (
                max(rank_a, rank_b),
                rank_a + rank_b,
                distance,
                energy_a + energy_b,
                first,
                second,
            )
            candidates.append((score, cut_a, cut_b))
    if not candidates:
        raise MediaError("master cannot be divided into three 1–4 second media slots")
    _, first_cut, second_cut = min(candidates, key=lambda item: item[0])
    return [first_cut, second_cut]


def _encode_audio(pcm: bytes, raw_path: Path, mp3: Path, tools: Tools) -> None:
    raw_path.write_bytes(pcm)
    tools.encode(
        "-f",
        "s16le",
        "-ar",
        str(RATE),
        "-ac",
        "1",
        "-i",
        str(raw_path),
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        str(mp3),
    )
    if len(_pcm(mp3, tools)) != len(pcm):
        raise MediaError("MP3 encoding changed its decoded sample length")


def slice_audio(
    master: Path,
    timings: Path,
    out_dir: Path,
    tools: Tools = Tools(),
    *,
    pad_to_four_seconds: bool = False,
) -> dict[str, Any]:
    master = _file(master, MAX_AUDIO_BYTES)
    pcm = _pcm(master, tools)
    sample_count = len(pcm) // 2
    duration_ms = round(Fraction(sample_count * 1000, RATE))
    frames = (sample_count + SAMPLES_PER_FRAME - 1) // SAMPLES_PER_FRAME
    if not 3 * MIN_SEGMENT_FRAMES <= frames <= MAX_TOTAL_FRAMES:
        raise MediaError("master speech must fit three slots of at most four seconds")
    cuts = _choose_cuts(pcm, _word_ranges(timings, duration_ms), frames)
    boundaries = [0, *(item["frame"] for item in cuts), frames]
    output_frames = MAX_TOTAL_FRAMES if pad_to_four_seconds else frames
    target_boundaries = (
        [0, MAX_SEGMENT_FRAMES, 2 * MAX_SEGMENT_FRAMES, MAX_TOTAL_FRAMES]
        if pad_to_four_seconds
        else boundaries
    )
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    destinations = [
        _output(out_dir / f"audio-{ordinal:02d}.mp3") for ordinal in range(1, 4)
    ]
    output_master = (
        _output(out_dir / "master-padded.mp3") if pad_to_four_seconds else master
    )
    segments = []
    padded_slices = []
    with TemporaryDirectory(prefix=".continuity-audio-", dir=out_dir) as directory:
        for index, (start, end) in enumerate(pairwise(boundaries)):
            start_sample, end_sample = (
                start * SAMPLES_PER_FRAME,
                min(end * SAMPLES_PER_FRAME, sample_count),
            )
            scene_start, scene_end = target_boundaries[index : index + 2]
            scene_frames = scene_end - scene_start
            source = pcm[start_sample * 2 : end_sample * 2]
            padding = (
                scene_frames * SAMPLES_PER_FRAME - len(source) // 2
                if pad_to_four_seconds
                else 0
            )
            leading = padding // 2
            trailing = padding - leading
            driving = b"\0" * (leading * 2) + source + b"\0" * (trailing * 2)
            if pad_to_four_seconds:
                padded_slices.append(driving)
            raw_path = Path(directory) / f"audio-{index + 1:02d}.pcm"
            mp3 = raw_path.with_suffix(".mp3")
            _encode_audio(driving, raw_path, mp3, tools)
            segments.append(
                {
                    "ordinal": index + 1,
                    "startMs": _ms(scene_start),
                    "endMs": _ms(scene_end),
                    "sourceStartMs": _ms(start),
                    "sourceEndMs": round(Fraction(end_sample * 1000, RATE)),
                    "durationMs": _ms(scene_frames),
                    "audioDurationMs": round(Fraction(len(driving) * 500, RATE)),
                    "paddingMs": round(Fraction(padding * 1000, RATE)),
                    "leadingPaddingMs": round(Fraction(leading * 1000, RATE)),
                    "trailingPaddingMs": round(Fraction(trailing * 1000, RATE)),
                    "speechStartMs": _ms(scene_start)
                    + round(Fraction(leading * 1000, RATE)),
                    "speechEndMs": _ms(scene_start)
                    + round(Fraction((leading + len(source) // 2) * 1000, RATE)),
                    "frameCount": scene_frames,
                    "audioPath": str(destinations[index]),
                    "audioSha256": _digest(mp3),
                }
            )
        if pad_to_four_seconds:
            staged_master = Path(directory) / output_master.name
            _encode_audio(
                b"".join(padded_slices),
                staged_master.with_suffix(".pcm"),
                staged_master,
                tools,
            )
            os.link(staged_master, output_master)
        for destination in destinations:
            os.link(Path(directory) / destination.name, destination)
    return {
        "schemaVersion": 1,
        "masterPath": str(output_master),
        "masterSha256": _digest(output_master),
        "sourceMasterSha256": _digest(master),
        "sourceMasterDurationMs": duration_ms,
        "masterDurationMs": _ms(output_frames) if pad_to_four_seconds else duration_ms,
        "masterSampleCount": output_frames * SAMPLES_PER_FRAME
        if pad_to_four_seconds
        else sample_count,
        "durationMs": _ms(output_frames),
        "seamTimesMs": [_ms(frame) for frame in target_boundaries[1:-1]],
        "cuts": cuts,
        "frameCount": output_frames,
        "segments": segments,
    }


def prepare_video(
    source: Path,
    output: Path,
    duration_ms: int,
    tools: Tools = Tools(),
    *,
    width: int | None = None,
    height: int | None = None,
) -> dict[str, Any]:
    source, output = source.resolve(strict=True), _output(output)
    picture, _ = _picture(source, tools)
    frames = round(Fraction(duration_ms * FPS, 1000))
    if (
        not MIN_SEGMENT_FRAMES <= frames <= MAX_SEGMENT_FRAMES
        or _ms(frames) != duration_ms
    ):
        raise MediaError("prepared segment duration must lie on the 30 fps timeline")
    if (width is None) != (height is None):
        raise MediaError("crop width and height must be provided together")
    filters = [f"fps={FPS}:start_time=0"]
    if width is not None and height is not None:
        if not (
            240 <= width <= 4096
            and 240 <= height <= 4096
            and width * height <= 1920 * 1080
            and not (width % 2 or height % 2)
        ):
            raise MediaError("crop output dimensions are invalid")
        filters.extend(
            (
                f"scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2",
                f"crop={width}:{height}",
                "setsar=1",
            )
        )
    with TemporaryDirectory(
        prefix=".continuity-video-", dir=output.parent
    ) as directory:
        staged = Path(directory) / "prepared.mp4"
        _encode_picture(source, staged, frames, filters, tools)
        result, metadata = _picture(staged, tools, count=True)
        if (
            int(result.get("nb_read_frames", 0)) != frames
            or len(metadata["streams"]) != 1
        ):
            raise MediaError("visual source is shorter than the requested segment")
        os.link(staged, output)
    return {
        "outputPath": str(output),
        "sourceWidth": picture["width"],
        "sourceHeight": picture["height"],
        "width": result["width"],
        "height": result["height"],
        "durationMs": _ms(frames),
        "frameCount": frames,
        "sha256": _digest(output),
    }


def _encode_picture(
    source: Path, output: Path, frames: int, filters: list[str], tools: Tools
) -> None:
    tools.encode(
        *MOV,
        "-threads",
        "2",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        ",".join(filters),
        "-frames:v",
        str(frames),
        "-c:v",
        "libx264",
        "-bf",
        "0",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-threads",
        "4",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "90000",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        str(output),
    )


def last_frame(source: Path, output: Path, tools: Tools = Tools()) -> dict[str, Any]:
    source, output = source.resolve(strict=True), _output(output)
    picture, _ = _picture(source, tools, count=True)
    index = int(picture.get("nb_read_frames", 0)) - 1
    if index < 0:
        raise MediaError("source contains no complete picture frame")
    tools.encode(
        *MOV,
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-vf",
        f"select=eq(n\\,{index})",
        "-frames:v",
        "1",
        "-threads",
        "1",
        "-update",
        "1",
        str(output),
    )
    return {"outputPath": str(output), "frameIndex": index, "sha256": _digest(output)}


def _plan_frames(plan: dict[str, Any]) -> list[int]:
    segments = plan.get("segments")
    if (
        plan.get("schemaVersion") != 1
        or not isinstance(segments, list)
        or len(segments) != 3
        or any(not isinstance(entry, dict) for entry in segments)
    ):
        raise MediaError("invalid three-part audio plan")
    frames = [entry.get("frameCount") for entry in segments]
    if any(
        type(item) is not int or not MIN_SEGMENT_FRAMES <= item <= MAX_SEGMENT_FRAMES
        for item in frames
    ):
        raise MediaError("invalid source segment length")
    if (
        plan.get("frameCount") != sum(frames)
        or plan.get("durationMs") != _ms(sum(frames))
        or plan.get("seamTimesMs") != [_ms(frames[0]), _ms(frames[0] + frames[1])]
    ):
        raise MediaError("source plan durations or seams are inconsistent")
    return frames


def _audio_match(reference: bytes, returned: bytes) -> dict[str, int]:
    rate = 4000
    left, right = _samples(reference), _samples(returned)
    if (
        min(len(left), len(right)) < rate // 5
        or abs(len(left) - len(right)) > rate // 10
    ):
        raise MediaError("drive audio duration differs from provider result")
    size = min(rate // 5, len(left) // 3)
    windows = []
    for region in range(3):
        start, end = region * len(left) // 3, (region + 1) * len(left) // 3
        lengths = range(start, max(start + 1, end - size + 1), max(1, size // 2))
        offset = max(
            lengths, key=lambda index: sum(x * x for x in left[index : index + size])
        )
        sample = left[offset : offset + size]
        energy = sum(x * x for x in sample)
        if energy <= size * 100:
            other = right[offset : offset + size]
            if sum(x * x for x in other) > size * 250:
                raise MediaError(
                    "silence in drive audio is missing from provider result"
                )
            continue
        best_score, best_lag = -1.0, 0
        for lag in range(-rate // 10, rate // 10 + 1):
            pos = offset + lag
            if pos < 0 or pos + size > len(right):
                continue
            candidate = right[pos : pos + size]
            received_energy = sum(x * x for x in candidate)
            if received_energy == 0:
                continue
            dot = sum(a * b for a, b in zip(sample, candidate, strict=True))
            score = dot / math.sqrt(energy * received_energy)
            if score > best_score or (score == best_score and abs(lag) < abs(best_lag)):
                best_score, best_lag = score, lag
        windows.append((math.floor(best_score * 1000), round(best_lag * 1000 / rate)))
    if not windows:
        raise MediaError("drive audio contains no measurable speech")
    correlation = min(value for value, _ in windows)
    lags = [lag for _, lag in windows]
    if correlation < 980 or max(lags) - min(lags) > 30:
        raise MediaError("provider audio waveform does not match the requested drive")
    return {
        "minimumAudioCorrelationPermille": correlation,
        "maxAbsAudioLagMs": max(abs(lag) for lag in lags),
    }


def _segment_audio(
    source: Path,
    picture: dict[str, Any],
    data: dict[str, Any],
    duration_ms: int,
    drive: bytes,
    tools: Tools,
) -> dict[str, int]:
    track = _pick_track(data, "audio")
    video_ms = _time_ms(picture.get("duration"))
    audio_ms = _time_ms(track.get("duration"))
    if (
        track.get("codec_name") != "aac"
        or abs(_time_ms(track.get("start_time"))) > 50
        or abs(_time_ms(picture.get("start_time"))) > 50
        or max(
            abs(video_ms - duration_ms),
            abs(audio_ms - duration_ms),
            abs(video_ms - audio_ms),
        )
        > 100
    ):
        raise MediaError("provider result has mismatched audio or picture endpoints")
    return _audio_match(drive, _pcm(source, tools, mov=True, rate=4000))


def check_drive(drive: Path, tools: Tools) -> None:
    decoded = _pcm(_file(drive, MAX_AUDIO_BYTES), tools, rate=4000)
    if len(decoded) != 32_000:
        raise MediaError("pilot drive must decode to exactly four seconds")
    _audio_match(decoded, decoded)


def check_alignment(
    source: Path, drive: Path, provider_ms: int, tools: Tools
) -> tuple[int, int, dict[str, int]]:
    decoded = _pcm(_file(drive, MAX_AUDIO_BYTES), tools, rate=4000)
    picture, data = _picture(source, tools, count=True)
    duration_ms = round(Fraction(len(decoded) * 1000, 8000))
    video_ms = _time_ms(picture.get("duration"))
    if (
        picture.get("codec_name") != "h264"
        or len(data.get("streams", [])) != 2
        or abs(video_ms - provider_ms) > 100
    ):
        raise MediaError("provider alignment tracks or task duration changed")
    proof = _segment_audio(source, picture, data, duration_ms, decoded, tools)
    return duration_ms, video_ms, proof


def _assert_grid(source: Path, frames: int, cuts: list[int], tools: Tools) -> None:
    data = tools.probe(
        *MOV,
        "-select_streams",
        "v:0",
        "-show_packets",
        "-show_entries",
        "stream=time_base:packet=pts,dts,flags",
        str(source),
    )
    packets = data.get("packets", [])
    tracks = data.get("streams", [])
    if (
        len(packets) != frames
        or len(tracks) != 1
        or tracks[0].get("time_base") != "1/90000"
    ):
        raise MediaError("candidate picture does not match the exact frame grid")
    for frame, packet in enumerate(packets):
        if packet.get("pts") != frame * 3000 or packet.get("dts") != frame * 3000:
            raise MediaError("candidate contains a picture timestamp gap or overlap")
        if frame in cuts and "K" not in packet.get("flags", ""):
            raise MediaError("candidate is missing a keyframe at its source seam")


def assemble(
    master: Path,
    plan: dict[str, Any],
    videos: list[Path],
    output: Path,
    tools: Tools = Tools(),
) -> dict[str, Any]:
    durations = _plan_frames(plan)
    master, output = _file(master, MAX_AUDIO_BYTES), _output(output)
    if len(videos) != len(durations) or _digest(master) != plan.get("masterSha256"):
        raise MediaError(
            "assembled routes must use the same three-part plan and master audio"
        )
    decoded = _pcm(master, tools, rate=4000)
    expected_audio_ms = plan.get("masterDurationMs")
    if (
        type(expected_audio_ms) is not int
        or abs(round(len(decoded) / 8) - expected_audio_ms) > 1
    ):
        raise MediaError("master audio duration does not match the frozen plan")
    segment_proofs = []
    with TemporaryDirectory(
        prefix=".continuity-assemble-", dir=output.parent
    ) as directory:
        root = Path(directory)
        entries = ["ffconcat version 1.0"]
        previous = 0
        shape = None
        for index, (source, frames) in enumerate(
            zip(videos, durations, strict=True), 1
        ):
            source = source.resolve(strict=True)
            picture, data = _picture(source, tools)
            geometry = (
                picture["width"],
                picture["height"],
                picture.get("sample_aspect_ratio", "1:1"),
            )
            if shape is not None and shape != geometry:
                raise MediaError("provider segment picture dimensions differ")
            shape = geometry
            left = 2 * round(Fraction(previous * 4000, FPS))
            right = 2 * round(Fraction((previous + frames) * 4000, FPS))
            expected = round(Fraction(len(decoded[left:right]) * 1000, 8000))
            proof = _segment_audio(
                source, picture, data, expected, decoded[left:right], tools
            )
            mode = f"segment-{index:02d}.mp4"
            normalized = root / mode
            _encode_picture(
                source,
                normalized,
                frames,
                [f"fps={FPS}:start_time=0", "tpad=stop_mode=clone:stop_duration=0.12"],
                tools,
            )
            _assert_grid(normalized, frames, [0], tools)
            entries.extend((f"file '{mode}'", f"duration {frames / FPS:.6f}"))
            segment_proofs.append(
                {"ordinal": index, "videoSha256": _digest(source), **proof}
            )
            previous += frames
        listing, candidate = root / "segments.ffconcat", root / "candidate.mp4"
        listing.write_text("\n".join(entries) + "\n", encoding="ascii", newline="\n")
        tools.encode(
            "-protocol_whitelist",
            "file,pipe",
            "-f",
            "concat",
            "-safe",
            "1",
            "-i",
            str(listing),
            *MP3,
            "-i",
            str(master),
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
            "90000",
            "-movflags",
            "+faststart",
            str(candidate),
        )
        picture, data = _picture(candidate, tools, count=True)
        _assert_grid(
            candidate, sum(durations), [0, durations[0], sum(durations[:2])], tools
        )
        voice = _pick_track(data, "audio")
        audio_ms, video_ms = (
            _time_ms(voice.get("duration")),
            _time_ms(picture.get("duration")),
        )
        if abs(audio_ms - expected_audio_ms) > 34 or abs(audio_ms - video_ms) > 34:
            raise MediaError("final mux changed the continuous master timeline")
        final_proof = _audio_match(decoded, _pcm(candidate, tools, mov=True, rate=4000))
        os.link(candidate, output)
    return {
        "outputPath": str(output),
        "sha256": _digest(output),
        "durationMs": video_ms,
        "audioDurationMs": audio_ms,
        "width": picture["width"],
        "height": picture["height"],
        "frameCount": sum(durations),
        "seamTimesMs": plan["seamTimesMs"],
        "masterSha256": plan["masterSha256"],
        "segments": segment_proofs,
        **final_proof,
    }


def compare(
    left: Path, right: Path, plan: dict[str, Any], output: Path, tools: Tools = Tools()
) -> dict[str, Any]:
    durations = _plan_frames(plan)
    left, right, output = (
        left.resolve(strict=True),
        right.resolve(strict=True),
        _output(output),
    )
    geometry = None
    keyframes = [0, durations[0], sum(durations[:2])]
    for path in (left, right):
        picture, _ = _picture(path, tools, count=True)
        if int(picture["nb_read_frames"]) != sum(durations):
            raise MediaError("comparison candidate does not cover the master timeline")
        current = (
            picture["width"],
            picture["height"],
            picture.get("sample_aspect_ratio"),
        )
        if geometry is not None and geometry != current:
            raise MediaError("comparison candidates have different picture dimensions")
        geometry = current
        _assert_grid(path, sum(durations), keyframes, tools)
    samples = [min(6, durations[0] - 1)]
    for seam in (durations[0], sum(durations[:2])):
        samples.extend((seam - 5, seam, seam + 5))
    samples.append(sum(durations) - 6)
    tile_width, tile_height = 288, 512
    with TemporaryDirectory(
        prefix=".continuity-sheet-", dir=output.parent
    ) as directory:
        root = Path(directory)
        panels = []
        for row, frame in enumerate(samples):
            for col, source in enumerate((left, right)):
                label = f"{'A' if col == 0 else 'B'}  {_ms(frame)} ms"
                filters = (
                    f"select=eq(n\\,{frame}),scale={tile_width}:{tile_height}:force_original_aspect_ratio=decrease,"
                    f"pad={tile_width}:{tile_height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,"
                    f"drawtext=text={label}:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=5:x=8:y=8"
                )
                tile = root / f"tile-{row:02d}-{col}.png"
                tools.encode(
                    *MOV,
                    "-threads",
                    "2",
                    "-i",
                    str(source),
                    "-map",
                    "0:v:0",
                    "-vf",
                    filters,
                    "-frames:v",
                    "1",
                    "-threads",
                    "1",
                    "-update",
                    "1",
                    str(tile),
                )
                panels.append(tile)
        args = [option for tile in panels for option in ("-i", str(tile))]
        layout = "|".join(
            f"{(i % 2) * tile_width}_{(i // 2) * tile_height}"
            for i in range(len(panels))
        )
        staged = root / f"comparison{output.suffix.lower()}"
        tools.encode(
            *args,
            "-filter_complex_threads",
            "2",
            "-filter_complex",
            f"xstack=inputs={len(panels)}:layout={layout}:fill=black",
            "-frames:v",
            "1",
            "-threads",
            "1",
            "-update",
            "1",
            str(staged),
        )
        os.link(staged, output)
    return {
        "outputPath": str(output),
        "sampleTimesMs": [_ms(frame) for frame in samples],
        "columns": ["left", "right"],
    }


def _read_plan(path: Path) -> dict[str, Any]:
    plan = json.loads(_file(path, 128 * 1024).read_text(encoding="utf-8-sig"))
    if not isinstance(plan, dict):
        raise MediaError("invalid audio plan document")
    return plan


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ffmpeg", default=os.getenv("FISSION_AVATAR_FFMPEG_PATH") or "ffmpeg"
    )
    parser.add_argument(
        "--ffprobe", default=os.getenv("FISSION_AVATAR_FFPROBE_PATH") or "ffprobe"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    slice_parser = commands.add_parser("slice-audio")
    slice_parser.add_argument("--master", type=Path, required=True)
    slice_parser.add_argument("--timings", type=Path, required=True)
    slice_parser.add_argument("--out-dir", type=Path, required=True)
    slice_parser.add_argument("--pad-to-four-seconds", action="store_true")
    candidate_parser = commands.add_parser("prepare-video")
    candidate_parser.add_argument("--input", type=Path, required=True)
    candidate_parser.add_argument("--output", type=Path, required=True)
    candidate_parser.add_argument("--duration-ms", type=int, required=True)
    candidate_parser.add_argument("--width", type=int)
    candidate_parser.add_argument("--height", type=int)
    frame_parser = commands.add_parser("last-frame")
    frame_parser.add_argument("--input", type=Path, required=True)
    frame_parser.add_argument("--output", type=Path, required=True)
    assemble_parser = commands.add_parser("assemble")
    assemble_parser.add_argument("--master", type=Path, required=True)
    assemble_parser.add_argument("--plan", type=Path, required=True)
    assemble_parser.add_argument("--videos", required=True, nargs=3, type=Path)
    assemble_parser.add_argument("--output", type=Path, required=True)
    compare_parser = commands.add_parser("compare")
    compare_parser.add_argument("--left", type=Path, required=True)
    compare_parser.add_argument("--right", type=Path, required=True)
    compare_parser.add_argument("--plan", type=Path, required=True)
    compare_parser.add_argument("--output", type=Path, required=True)
    for command in (
        slice_parser,
        candidate_parser,
        frame_parser,
        assemble_parser,
        compare_parser,
    ):
        command.add_argument("--ffmpeg", default=argparse.SUPPRESS)
        command.add_argument("--ffprobe", default=argparse.SUPPRESS)
    args = parser.parse_args()
    tools = Tools(args.ffmpeg, args.ffprobe)
    try:
        if args.command == "slice-audio":
            result = slice_audio(
                args.master,
                args.timings,
                args.out_dir,
                tools,
                pad_to_four_seconds=args.pad_to_four_seconds,
            )
        elif args.command == "prepare-video":
            result = prepare_video(
                args.input,
                args.output,
                args.duration_ms,
                tools,
                width=args.width,
                height=args.height,
            )
        elif args.command == "last-frame":
            result = last_frame(args.input, args.output, tools)
        elif args.command == "assemble":
            result = assemble(
                args.master, _read_plan(args.plan), args.videos, args.output, tools
            )
        else:
            result = compare(
                args.left, args.right, _read_plan(args.plan), args.output, tools
            )
    except (OSError, MediaError, json.JSONDecodeError) as error:
        print(f"continuity media: {error}", file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))


if __name__ == "__main__":
    main()
