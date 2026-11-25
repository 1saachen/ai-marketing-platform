from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal, Protocol, TypedDict, cast

from ai_runtime.http import InternalApiError

from .lease import (
    UNAVAILABLE,
    Heartbeat,
    LeaseInactive,
    LeasePort,
    claim_task,
    fail_task,
    with_heartbeat,
)
from .long_form import AssemblyError, _file_matches, _file_sha, assemble_long_form
from .long_media import (
    MAX_LONG_WORKER_VIDEO_BYTES,
    encode_long_drive_audio,
    validate_long_delivery,
)
from .media import MAX_AUDIO_BYTES, MAX_VIDEO_BYTES, MediaError, prepare_character
from .pipeline import ProviderPort, Snapshot, execute, validator
from .provider import TaskFailure
from .tail_pipeline import (
    TailPicturePort,
    TailVoicePort,
    execute_tail_segment,
    freeze_tail_speech,
    parse_tail_snapshot,
)


class LongApiPort(LeasePort, Protocol):
    async def download_character(self, path: Path, expected_size: int) -> None: ...
    async def download_file(
        self, route: str, path: Path, expected_size: int, maximum_size: int
    ) -> None: ...
    async def complete(
        self,
        video: Path,
        audio: Path,
        metadata: dict[str, Any],
        *,
        route: str = "result",
    ) -> None: ...


class StoredFile(TypedDict):
    sizeBytes: int
    sha256: str


class SegmentResult(TypedDict):
    media: dict[str, Any]
    audio: StoredFile
    video: StoredFile


class SegmentSnapshot(TypedDict):
    ordinal: int
    scriptText: str
    ttsOperationId: str
    ttsStarted: bool
    lipSyncClientToken: str
    lipSyncStarted: bool
    lipSyncTaskId: str | None
    result: SegmentResult | None


class LongSnapshot(TypedDict):
    schemaVersion: Literal[2]
    voiceSpeaker: str
    characterSizeBytes: int
    segments: list[SegmentSnapshot]


class SegmentApi:
    def __init__(
        self,
        api: LongApiPort,
        beat: Heartbeat,
        ordinal: int,
        count: int,
        directory: Path,
    ) -> None:
        self.api = api
        self.beat = beat
        self.token = api.token
        self.route = f"segments/{ordinal}"
        self.ordinal = ordinal
        self.count = count
        self.video_path = directory / f"segment-{ordinal:02d}.mp4"
        self.audio_path = directory / f"segment-{ordinal:02d}.mp3"
        self.media: dict[str, Any] | None = None

    async def call(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if method == "POST" and path == "checkpoint":
            return await self.api.call(method, f"{self.route}/checkpoint", body)
        if method != "POST" or path != "heartbeat" or body is None:
            raise TaskFailure("INVALID_TASK")
        segment_progress = body["progress"]
        progress = 5 + (80 * (100 * (self.ordinal - 1) + segment_progress)) // (
            100 * self.count
        )
        await self.beat.update("LIP_SYNC", max(self.beat.progress, progress))
        return {"active": True}

    async def download_character(self, path: Path, expected_size: int) -> None:
        # The long attempt prepares its reusable authorized clip outside the segment.
        raise TaskFailure("INVALID_TASK")

    async def complete(
        self, video: Path, audio: Path, metadata: dict[str, Any]
    ) -> None:
        await self.api.complete(video, audio, metadata, route=f"{self.route}/result")
        shutil.copyfile(video, self.video_path)
        shutil.copyfile(audio, self.audio_path)
        self.media = metadata

    async def reuse(self, result: SegmentResult) -> None:
        for role, destination, size_limit in (
            ("video", self.video_path, MAX_VIDEO_BYTES),
            ("audio", self.audio_path, MAX_AUDIO_BYTES),
        ):
            file = result["video"] if role == "video" else result["audio"]
            await self.api.download_file(
                f"{self.route}/files/{role}", destination, file["sizeBytes"], size_limit
            )
            _file_matches(destination, size_limit, file["sha256"])
        self.media = result["media"]

    def assembly_input(self) -> dict[str, Any]:
        if self.media is None:
            raise TaskFailure("INVALID_TASK")
        return {
            "video": self.video_path.name,
            "audio": self.audio_path.name,
            "videoSha256": _file_sha(self.video_path, MAX_VIDEO_BYTES),
            "audioSha256": _file_sha(self.audio_path, MAX_AUDIO_BYTES),
            "wordTimings": self.media["wordTimings"],
        }


def _snapshot(value: object) -> LongSnapshot:
    if not isinstance(value, dict) or not validator(
        "worker-input", step="long-sync"
    ).is_valid(value):
        raise TaskFailure("INVALID_TASK")
    snapshot = cast(LongSnapshot, value)
    if any(
        segment["ordinal"] != ordinal or not segment["scriptText"].strip()
        for ordinal, segment in enumerate(snapshot["segments"], 1)
    ):
        raise TaskFailure("INVALID_TASK")
    return snapshot


async def _legacy_segments(
    api: LongApiPort,
    provider: ProviderPort,
    beat: Heartbeat,
    claimed_input: object,
    root: Path,
    ffmpeg: str,
    ffprobe: str,
) -> list[dict[str, Any]]:
    snapshot = _snapshot(claimed_input)
    segments = snapshot["segments"]
    prepared = None
    if any(
        not segment["lipSyncStarted"] and segment["result"] is None
        for segment in segments
    ):
        character, silent = root / "character.mp4", root / "silent.mp4"
        await api.download_character(character, snapshot["characterSizeBytes"])
        prepared = (
            silent,
            await prepare_character(character, silent, ffmpeg, ffprobe),
        )

    assembly_inputs = []
    for segment in segments:
        io = SegmentApi(api, beat, segment["ordinal"], len(segments), root)
        result = segment["result"]
        if result is not None:
            await io.reuse(result)
        else:
            short_snapshot: Snapshot = {
                "schemaVersion": 1,
                "scriptText": segment["scriptText"],
                "voiceSpeaker": snapshot["voiceSpeaker"],
                "characterSizeBytes": snapshot["characterSizeBytes"],
                "ttsOperationId": segment["ttsOperationId"],
                "ttsStarted": segment["ttsStarted"],
                "lipSyncClientToken": segment["lipSyncClientToken"],
                "lipSyncStarted": segment["lipSyncStarted"],
                "lipSyncTaskId": segment["lipSyncTaskId"],
            }
            await execute(
                io,
                provider,
                Heartbeat(io, "TTS"),
                short_snapshot,
                ffmpeg,
                ffprobe,
                prepared_character=prepared,
            )
        assembly_inputs.append(io.assembly_input())
    return assembly_inputs


async def _tail_segments(
    api: LongApiPort,
    provider: ProviderPort,
    beat: Heartbeat,
    claimed_input: object,
    root: Path,
    ffmpeg: str,
    ffprobe: str,
    picture_factory: Callable[[], TailPicturePort] | None,
) -> list[dict[str, Any]]:
    snapshot = parse_tail_snapshot(claimed_input)
    segments = snapshot["segments"]
    needs_speech = snapshot["plan"] is None or any(
        segment["result"] is None for segment in segments
    )
    needs_picture = snapshot["plan"] is None or any(
        segment["result"] is None and segment["lipSyncTaskId"] is None
        for segment in segments
    )
    if not isinstance(provider, TailVoicePort):
        raise TaskFailure("PROVIDER_FAILED", retryable=True)
    if needs_picture and picture_factory is None:
        raise TaskFailure("PROVIDER_FAILED", retryable=True)
    picture = picture_factory() if needs_picture and picture_factory else None
    speech, seed_tail = None, None
    try:
        if snapshot["plan"] is None and picture is not None:
            # Verify the exact authorized source on the worker's Ark account
            # before paying for voice synthesis on a fresh task.
            seed_tail = await picture.native_tail(snapshot["sourceTaskId"])
        if needs_speech:
            snapshot, speech = await freeze_tail_speech(
                api, provider, snapshot, root, ffmpeg
            )
            segments = snapshot["segments"]

        assembly_inputs = []
        predecessor = snapshot["sourceTaskId"]
        for segment in segments:
            ordinal = segment["ordinal"]
            io = SegmentApi(api, beat, ordinal, len(segments), root)
            await beat.update("LIP_SYNC", 5 + 80 * (ordinal - 1) // len(segments))
            result = segment["result"]
            if result is not None:
                picture_id = segment["pictureTaskId"]
                await io.reuse(result)
            else:
                if speech is None:
                    raise TaskFailure("INVALID_TASK")
                segment_root = root / f"drive-{ordinal:02d}"
                segment_root.mkdir()
                picture_id = await execute_tail_segment(
                    api,
                    io,
                    provider,
                    picture,
                    snapshot,
                    segment,
                    predecessor,
                    seed_tail if ordinal == 1 else None,
                    speech,
                    segment_root,
                    ffmpeg,
                    ffprobe,
                )
            if picture_id is None:
                raise TaskFailure("INVALID_TASK")
            predecessor = picture_id
            assembly_inputs.append(io.assembly_input())
        return assembly_inputs
    finally:
        if picture is not None:
            await picture.close()


async def execute_long_sync(
    api: LongApiPort,
    provider: ProviderPort,
    beat: Heartbeat,
    claimed_input: object,
    ffmpeg: str,
    ffprobe: str,
    *,
    picture_factory: Callable[[], TailPicturePort] | None = None,
) -> None:
    with TemporaryDirectory(prefix="fission-avatar-long-sync-") as directory:
        root = Path(directory)
        await beat.update()
        if isinstance(claimed_input, dict) and claimed_input.get("schemaVersion") == 3:
            assembly_inputs = await _tail_segments(
                api,
                provider,
                beat,
                claimed_input,
                root,
                ffmpeg,
                ffprobe,
                picture_factory,
            )
        else:
            assembly_inputs = await _legacy_segments(
                api, provider, beat, claimed_input, root, ffmpeg, ffprobe
            )

        await beat.update("VALIDATING", 86)
        manifest, state = root / "manifest.json", root / "assembly"
        manifest.write_text(
            json.dumps(
                {"schemaVersion": 1, "segments": assembly_inputs}, ensure_ascii=False
            ),
            encoding="utf-8",
        )
        report = await assemble_long_form(manifest, state, ffmpeg, ffprobe)
        video, audio = state / "candidate.mp4", root / "speech.mp3"
        _file_matches(video, MAX_LONG_WORKER_VIDEO_BYTES, report["candidateSha256"])
        await encode_long_drive_audio(state, audio, report["segments"], ffmpeg)
        seam_times = [item["timeMs"] for item in report["seams"]]
        media = await validate_long_delivery(
            video,
            audio,
            report["durationMs"],
            report["durationMs"],
            seam_times,
            ffmpeg,
            ffprobe,
        )
        metadata = {
            "schemaVersion": 2,
            "audioDurationMs": media.audio_duration_ms,
            "videoDurationMs": media.video_duration_ms,
            "audioLagMs": media.audio_lag_ms,
            "minimumAudioCorrelationPermille": media.minimum_audio_correlation_permille,
            "wordTimings": report["wordTimings"],
            "seamTimesMs": seam_times,
        }
        if not validator("completion", step="long-sync").is_valid(metadata):
            raise TaskFailure("MEDIA_INVALID")
        await beat.update("VALIDATING", 98)
        await api.complete(video, audio, metadata)


async def process_long_sync_task(
    api: LongApiPort,
    provider: ProviderPort,
    ffmpeg: str,
    ffprobe: str,
    *,
    timeout: int = 2400,
    picture_factory: Callable[[], TailPicturePort] | None = None,
) -> None:
    claim = await claim_task(api)
    if claim is None:
        return
    beat = Heartbeat(api, "TTS")
    try:
        await with_heartbeat(
            beat,
            lambda: execute_long_sync(
                api,
                provider,
                beat,
                claim.get("input"),
                ffmpeg,
                ffprobe,
                picture_factory=picture_factory,
            ),
            timeout,
        )
    except LeaseInactive:
        return
    except InternalApiError as error:
        if error.status_code not in UNAVAILABLE:
            await fail_task(api, "INTERNAL_API_FAILED", retryable=error.retryable)
    except TaskFailure as error:
        await fail_task(api, error.code, retryable=error.retryable)
    except TimeoutError:
        await fail_task(api, "PROVIDER_FAILED", retryable=True)
    except (AssemblyError, MediaError, OSError) as error:
        await fail_task(api, "MEDIA_INVALID", retryable=isinstance(error, OSError))
