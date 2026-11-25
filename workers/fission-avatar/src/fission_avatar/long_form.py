from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import stat
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from typing import Any

from .long_media import (
    FPS,
    MAX_LONG_VIDEO_BYTES,
    SAMPLES_PER_FRAME,
    assemble_candidate,
    frame_ms,
    normalize_segment,
)
from .media import MAX_AUDIO_BYTES, MAX_DURATION_MS, MAX_VIDEO_BYTES, MediaError
from .provider import Timing

_MAX_MANIFEST_BYTES = 512 * 1024
_MAX_REPORT_BYTES = 2 * 1024 * 1024
_MAX_SEGMENTS = 12
_MAX_NORMALIZED_BYTES = 256 * 1024 * 1024
_ASSEMBLY_TIMEOUT_SECONDS = 600
_SHA256 = re.compile(r"[a-f0-9]{64}")


class AssemblyError(ValueError):
    """Input, media, or persisted checkpoint is inconsistent."""


@dataclass(frozen=True)
class Segment:
    video: Path
    audio: Path
    video_sha: str
    audio_sha: str
    timings: list[Timing]


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n"
    ).encode("utf-8")


def _bounded_read(path: Path, maximum: int) -> bytes:
    with path.open("rb") as handle:
        data = handle.read(maximum + 1)
    if not 0 < len(data) <= maximum:
        raise AssemblyError("input document size is invalid")
    return data


def _file_sha(path: Path, maximum: int) -> str:
    if path.is_symlink() or not path.is_file():
        raise AssemblyError("media file is missing or exceeds its size limit")
    with path.open("rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= maximum:
            raise AssemblyError("media file is missing or exceeds its size limit")
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
        after = os.fstat(handle.fileno())
        live = path.stat()
    attributes = (before.st_size, before.st_mtime_ns, before.st_dev, before.st_ino)
    if any(
        attributes != (item.st_size, item.st_mtime_ns, item.st_dev, item.st_ino)
        for item in (after, live)
    ):
        raise AssemblyError("media file changed while it was being checked")
    return digest


def _file_matches(path: Path, maximum: int, expected: str) -> None:
    if _file_sha(path, maximum) != expected:
        raise AssemblyError("source or checkpoint hash mismatch")


def _read_manifest(path: Path) -> tuple[str, list[Segment]]:
    raw = _bounded_read(path, _MAX_MANIFEST_BYTES)
    try:
        value = json.loads(raw)
        if (
            set(value) != {"schemaVersion", "segments"}
            or type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
        ):
            raise ValueError("invalid manifest schema")
        rows = value["segments"]
        if not isinstance(rows, list) or not 3 <= len(rows) <= _MAX_SEGMENTS:
            raise ValueError("invalid segment count")
        segments = []
        for row in rows:
            if set(row) != {
                "audio",
                "video",
                "audioSha256",
                "videoSha256",
                "wordTimings",
            }:
                raise ValueError("invalid segment fields")
            audio, video = row["audio"], row["video"]
            audio_sha, video_sha = row["audioSha256"], row["videoSha256"]
            if any(
                not isinstance(item, str) or not item.strip() or "\0" in item
                for item in (audio, video)
            ):
                raise ValueError("invalid media path")
            if not _SHA256.fullmatch(audio_sha) or not _SHA256.fullmatch(video_sha):
                raise ValueError("invalid source digest")
            words = row["wordTimings"]
            if not isinstance(words, list) or not 1 <= len(words) <= 240:
                raise ValueError("invalid timing count")
            previous = -1
            for cue in words:
                if set(cue) != {"text", "startMs", "endMs", "confidencePermille"}:
                    raise ValueError("invalid timing fields")
                text, start, end = cue["text"], cue["startMs"], cue["endMs"]
                confidence = cue["confidencePermille"]
                if (
                    not isinstance(text, str)
                    or not 1 <= len(text.strip()) <= 80
                    or any(ord(char) < 32 or ord(char) == 127 for char in text)
                    or type(start) is not int
                    or type(end) is not int
                    or not previous <= start < end <= MAX_DURATION_MS
                    or start < 0
                    or (
                        confidence is not None
                        and (type(confidence) is not int or not 0 <= confidence <= 1000)
                    )
                ):
                    raise ValueError("invalid word timing")
                text.encode("utf-8")
                previous = start
            segments.append(
                Segment(
                    (path.parent / video).resolve(strict=True),
                    (path.parent / audio).resolve(strict=True),
                    video_sha,
                    audio_sha,
                    words,
                )
            )
    except (TypeError, ValueError, OSError, KeyError) as error:
        raise AssemblyError(
            "manifest is invalid or a media path is unavailable"
        ) from error
    return _sha(raw), segments


@contextmanager
def _directory_lock(root: Path) -> Iterator[None]:
    with (root / "assembly.lock").open("a+b") as handle:
        try:
            if sys.platform == "win32":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise AssemblyError(
                "assembly state is locked by another process"
            ) from error
        # The OS releases the lock on close, including process interruption.
        yield


def _atomic_json(path: Path, value: object) -> None:
    data = _json(value)
    temporary = None
    try:
        with NamedTemporaryFile(
            prefix=".assembly-", dir=path.parent, delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _load_state(path: Path, fingerprint: str) -> dict[str, Any]:
    if not path.exists():
        if any(
            item.name != "assembly.lock" and not item.name.startswith(".assembly-")
            for item in path.parent.iterdir()
        ):
            raise AssemblyError("select an empty state directory for the first run")
        initial: dict[str, Any] = {
            "schemaVersion": 1,
            "manifestSha256": fingerprint,
            "checkpoints": [],
            "candidate": None,
        }
        _atomic_json(path, initial)
        return initial
    try:
        state = json.loads(_bounded_read(path, _MAX_MANIFEST_BYTES))
        if (
            set(state)
            != {"schemaVersion", "manifestSha256", "checkpoints", "candidate"}
            or type(state["schemaVersion"]) is not int
            or state["schemaVersion"] != 1
        ):
            raise ValueError("invalid state schema")
        if (
            not isinstance(state["checkpoints"], list)
            or len(state["checkpoints"]) > _MAX_SEGMENTS
        ):
            raise ValueError("invalid checkpoint list")
        if state["manifestSha256"] != fingerprint:
            raise AssemblyError("saved state belongs to a different manifest")
    except AssemblyError:
        raise
    except (TypeError, ValueError, KeyError) as error:
        raise AssemblyError("assembly state is corrupted") from error
    return state  # type: ignore[no-any-return]


def _paths(root: Path, index: int) -> tuple[Path, Path]:
    stem = f"segment-{index + 1:02d}"
    return root / f"{stem}.mp4", root / f"{stem}.s16le"


def _checked_segment(
    root: Path, index: int, segment: Segment, saved: dict[str, Any]
) -> None:
    try:
        record = saved["record"]
        expected = saved["recordSha256"]
        frames, samples, padding = (
            record[field] for field in ("frameCount", "sampleCount", "paddingSamples")
        )
        if (
            _sha(_json(record)) != expected
            or record["index"] != index + 1
            or record["sourceVideoSha256"] != segment.video_sha
            or record["sourceAudioSha256"] != segment.audio_sha
            or type(frames) is not int
            or not 1 <= frames <= FPS * MAX_DURATION_MS // 1000
            or type(samples) is not int
            or samples < 1
            or type(padding) is not int
            or not 0 <= padding < SAMPLES_PER_FRAME
            or samples + padding != frames * SAMPLES_PER_FRAME
        ):
            raise ValueError("checkpoint digest or content changed")
        picture, pcm = _paths(root, index)
        _file_matches(picture, MAX_VIDEO_BYTES, record["normalizedVideoSha256"])
        _file_matches(
            pcm, frames * SAMPLES_PER_FRAME * 2, record["normalizedPcmSha256"]
        )
        if pcm.stat().st_size != frames * SAMPLES_PER_FRAME * 2:
            raise ValueError("checkpoint PCM sample count changed")
    except (KeyError, TypeError, ValueError, OSError) as error:
        raise AssemblyError(f"segment {index + 1} checkpoint is corrupted") from error


async def _checkpoint(
    root: Path, index: int, segment: Segment, ffmpeg: str, ffprobe: str
) -> dict[str, Any]:
    with TemporaryDirectory(prefix=".segment-", dir=root) as scratch:
        picture, pcm = _paths(Path(scratch), index)
        try:
            record = await normalize_segment(
                segment.video, segment.audio, picture, pcm, ffmpeg, ffprobe
            )
            if any(
                word["endMs"] > record["sourceAudioDurationMs"]
                for word in segment.timings
            ):
                raise AssemblyError("word timing exceeds decoded segment audio")
            _file_matches(segment.video, MAX_VIDEO_BYTES, segment.video_sha)
            _file_matches(segment.audio, MAX_AUDIO_BYTES, segment.audio_sha)
        except (MediaError, AssemblyError, OSError) as error:
            raise AssemblyError(
                f"segment {index + 1} could not be verified: {error}"
            ) from error
        record.update(
            index=index + 1,
            sourceVideoSha256=segment.video_sha,
            sourceAudioSha256=segment.audio_sha,
            normalizedVideoSha256=_file_sha(picture, MAX_VIDEO_BYTES),
            normalizedPcmSha256=_file_sha(
                pcm, record["frameCount"] * SAMPLES_PER_FRAME * 2
            ),
        )
        checkpoint_picture, checkpoint_audio = _paths(root, index)
        os.replace(picture, checkpoint_picture)
        os.replace(pcm, checkpoint_audio)
    return {"record": record, "recordSha256": _sha(_json(record))}


async def assemble_long_form(
    manifest: Path, root: Path, ffmpeg: str, ffprobe: str
) -> dict[str, Any]:
    manifest, root = manifest.resolve(strict=True), root.resolve()
    fingerprint, segments = _read_manifest(manifest)
    if any(
        file.is_relative_to(root)
        for segment in segments
        for file in (segment.video, segment.audio)
    ):
        raise AssemblyError("state directory must not contain source media")
    root.mkdir(parents=True, exist_ok=True)
    with _directory_lock(root):
        state_path = root / "state.json"
        state = _load_state(state_path, fingerprint)
        checkpoints = state["checkpoints"]
        if len(checkpoints) > len(segments):
            raise AssemblyError("saved checkpoint count exceeds manifest")
        # Do not resume a checkpoint if any frozen source was edited or lost.
        checked: set[tuple[Path, str]] = set()
        for segment in segments:
            for file, maximum, digest in (
                (segment.video, MAX_VIDEO_BYTES, segment.video_sha),
                (segment.audio, MAX_AUDIO_BYTES, segment.audio_sha),
            ):
                if (file, digest) not in checked:
                    _file_matches(file, maximum, digest)
                    checked.add((file, digest))
        for index, saved in enumerate(checkpoints):
            _checked_segment(root, index, segments[index], saved)
        output, report_path = root / "candidate.mp4", root / "report.json"
        candidate = state["candidate"]
        if candidate is not None:
            try:
                if len(checkpoints) != len(segments):
                    raise ValueError("missing checkpoints")
                _file_matches(output, MAX_LONG_VIDEO_BYTES, candidate["sha256"])
                saved_report = _bounded_read(report_path, _MAX_REPORT_BYTES)
                if _sha(saved_report) != candidate["reportSha256"]:
                    raise ValueError("unexpected report hash")
                report: dict[str, Any] = json.loads(saved_report)
                return report
            except (TypeError, ValueError, KeyError, OSError) as error:
                raise AssemblyError(
                    "saved candidate or its report is corrupted"
                ) from error

        for index in range(len(checkpoints), len(segments)):
            saved = await _checkpoint(root, index, segments[index], ffmpeg, ffprobe)
            record = saved["record"]
            if checkpoints:
                previous = checkpoints[0]["record"]
                if any(
                    record[key] != previous[key]
                    for key in ("width", "height", "sampleAspectRatio")
                ):
                    raise AssemblyError(
                        f"segment {index + 1} picture geometry differs from earlier segments"
                    )
            if (
                sum(_paths(root, clip)[0].stat().st_size for clip in range(index + 1))
                > _MAX_NORMALIZED_BYTES
            ):
                raise AssemblyError(
                    "normalized segments exceed the cumulative size limit"
                )
            checkpoints.append(saved)
            _atomic_json(state_path, state)

        records = [entry["record"] for entry in checkpoints]
        cues: list[Timing] = []
        frames = 0
        for segment, record in zip(segments, records, strict=True):
            start = frame_ms(frames)
            cues.extend(
                {
                    **word,
                    "startMs": start + word["startMs"],
                    "endMs": start + word["endMs"],
                }
                for word in segment.timings
            )
            frames += record["frameCount"]
        with TemporaryDirectory(prefix=".candidate-", dir=root) as scratch:
            media, proof = await assemble_candidate(
                root, Path(scratch), records, ffmpeg, ffprobe
            )
            report = {
                "schemaVersion": 1,
                "manifestSha256": fingerprint,
                "candidateSha256": _file_sha(media, MAX_LONG_VIDEO_BYTES),
                "segments": records,
                "wordTimings": cues,
                **proof,
            }
            report_data = _json(report)
            if len(report_data) > _MAX_REPORT_BYTES:
                raise AssemblyError("assembled report exceeds its size limit")
            os.replace(media, output)
            _atomic_json(report_path, report)
        state["candidate"] = {
            "sha256": report["candidateSha256"],
            "reportSha256": _sha(report_data),
        }
        _atomic_json(state_path, state)
        return report


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Assemble verified local Avatar short segments without external calls."
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument(
        "--ffmpeg", default=os.getenv("FISSION_AVATAR_FFMPEG_PATH") or "ffmpeg"
    )
    parser.add_argument(
        "--ffprobe", default=os.getenv("FISSION_AVATAR_FFPROBE_PATH") or "ffprobe"
    )
    args = parser.parse_args()
    try:
        report = asyncio.run(
            asyncio.wait_for(
                assemble_long_form(
                    args.manifest, args.state_dir, args.ffmpeg, args.ffprobe
                ),
                timeout=_ASSEMBLY_TIMEOUT_SECONDS,
            )
        )
    except (AssemblyError, MediaError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except TimeoutError:
        print("assembly timed out, verified checkpoints were kept", file=sys.stderr)
        raise SystemExit(1) from None
    except OSError:
        print("assembly files could not be read or written", file=sys.stderr)
        raise SystemExit(1) from None
    print(
        json.dumps(
            {
                key: report[key]
                for key in (
                    "candidateSha256",
                    "durationMs",
                    "maxAbsAudioLagMs",
                    "minimumAudioCorrelationPermille",
                )
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
