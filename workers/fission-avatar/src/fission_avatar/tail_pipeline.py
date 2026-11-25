from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import (
    TYPE_CHECKING,
    Any,
    Literal,
    Protocol,
    TypedDict,
    cast,
    runtime_checkable,
)

from ai_runtime.http import InternalApiError

from .lease import LeasePort
from .media import MAX_AUDIO_LAG_MS, validate_output
from .pipeline import ApiPort, ProviderPort, _checkpoint, validator
from .provider import Speech, TaskFailure
from .tail_media import TailPlan, TailSpeech, prepare_tail_speech

if TYPE_CHECKING:
    from .long_pipeline import SegmentResult


class TailSegmentSnapshot(TypedDict):
    ordinal: int
    pictureStarted: bool
    pictureTaskId: str | None
    lipSyncClientToken: str
    lipSyncStarted: bool
    lipSyncTaskId: str | None
    result: SegmentResult | None


class TailSnapshot(TypedDict):
    schemaVersion: Literal[3]
    voiceSpeaker: str
    scriptText: str
    sourceTaskId: str
    model: str
    ttsOperationId: str
    ttsStarted: bool
    plan: TailPlan | None
    segments: list[TailSegmentSnapshot]


@runtime_checkable
class TailVoicePort(ProviderPort, Protocol):
    async def get_long_tts_result(self, operation_id: str) -> Speech: ...

    async def upload_drive_audio(self, wav: Path) -> str: ...


class TailPicturePort(Protocol):
    async def native_tail(self, task_id: str) -> str: ...

    async def render(
        self,
        model: str,
        duration_seconds: int,
        first_frame: str | None,
        output: Path,
        accept: Callable[[str], Awaitable[None]],
        task_id: str | None = None,
    ) -> None: ...

    async def close(self) -> None: ...


def parse_tail_snapshot(value: object) -> TailSnapshot:
    if not isinstance(value, dict) or not validator(
        "worker-input", step="tail-chain"
    ).is_valid(value):
        raise TaskFailure("INVALID_TASK")
    snapshot = cast(TailSnapshot, value)
    plan, segments = snapshot["plan"], snapshot["segments"]
    if (
        not snapshot["scriptText"].strip()
        or (plan is None and segments)
        or (
            plan is not None
            and (not snapshot["ttsStarted"] or len(segments) != len(plan["segments"]))
        )
    ):
        raise TaskFailure("INVALID_TASK")
    unfinished = False
    for ordinal, segment in enumerate(segments, 1):
        if (
            segment["ordinal"] != ordinal
            or (unfinished and segment["pictureStarted"])
            or (segment["pictureTaskId"] is not None and not segment["pictureStarted"])
            or (segment["lipSyncStarted"] and segment["pictureTaskId"] is None)
            or (segment["lipSyncTaskId"] is not None and not segment["lipSyncStarted"])
            or (segment["result"] is not None and segment["lipSyncTaskId"] is None)
        ):
            raise TaskFailure("INVALID_TASK")
        if (segment["pictureStarted"] and segment["pictureTaskId"] is None) or (
            segment["lipSyncStarted"] and segment["lipSyncTaskId"] is None
        ):
            raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
        if not segment["result"]:
            unfinished = True
    return snapshot


async def _tail_checkpoint(api: LeasePort, body: dict[str, Any]) -> dict[str, Any]:
    if not validator("checkpoint", step="tail-chain").is_valid(body):
        raise TaskFailure("INVALID_TASK")
    reply = await api.call("POST", "continuity/checkpoint", body)
    if not isinstance(reply.get("allowed"), bool):
        raise InternalApiError("invalid continuation checkpoint", retryable=False)
    return reply


async def freeze_tail_speech(
    api: LeasePort,
    provider: TailVoicePort,
    snapshot: TailSnapshot,
    root: Path,
    ffmpeg: str,
) -> tuple[TailSnapshot, TailSpeech]:
    operation_id = snapshot["ttsOperationId"]
    if not snapshot["ttsStarted"]:
        reservation = await _tail_checkpoint(api, {"kind": "TTS_STARTED"})
        if reservation["allowed"]:
            try:
                await provider.submit_tts(
                    operation_id, snapshot["scriptText"], snapshot["voiceSpeaker"]
                )
            except TaskFailure as error:
                if error.code != "PROVIDER_CREATION_UNKNOWN":
                    raise
                # The fixed TTS operation ID supports lookup after ambiguous submit.
    voice = await provider.get_long_tts_result(operation_id)
    master = root / "master.mp3"
    await provider.download(voice.url, master, kind="speech")
    speech = await prepare_tail_speech(master, voice.timings, ffmpeg, snapshot["plan"])
    if snapshot["plan"] is not None:
        if speech.plan != snapshot["plan"]:
            raise TaskFailure("MEDIA_INVALID")
        return snapshot, speech

    reply = await _tail_checkpoint(api, {"kind": "PLAN_READY", "plan": speech.plan})
    if not reply["allowed"]:
        raise InternalApiError("continuation plan was not frozen", retryable=False)
    current = parse_tail_snapshot(reply.get("input"))
    if (
        current["ttsOperationId"] != operation_id
        or current["scriptText"] != snapshot["scriptText"]
        or current["voiceSpeaker"] != snapshot["voiceSpeaker"]
        or current["sourceTaskId"] != snapshot["sourceTaskId"]
        or current["model"] != snapshot["model"]
        or current["plan"] != speech.plan
    ):
        raise TaskFailure("INVALID_TASK")
    return current, speech


async def _segment_picture(
    api: LeasePort,
    picture: TailPicturePort,
    snapshot: TailSnapshot,
    segment: TailSegmentSnapshot,
    predecessor: str,
    seed_tail: str | None,
    duration: int,
    output: Path,
) -> str:
    ordinal = segment["ordinal"]
    picture_id = segment["pictureTaskId"]
    first_frame = None
    if picture_id is None:
        if segment["pictureStarted"]:
            raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
        first_frame = seed_tail or await picture.native_tail(predecessor)
        reservation = await _tail_checkpoint(
            api, {"kind": "PICTURE_STARTED", "ordinal": ordinal}
        )
        if not reservation["allowed"]:
            raise TaskFailure("PROVIDER_CREATION_UNKNOWN")

    async def accept(task_id: str) -> None:
        nonlocal picture_id
        if picture_id is not None:
            if picture_id != task_id:
                raise TaskFailure("INVALID_TASK")
            return
        reply = await _tail_checkpoint(
            api,
            {"kind": "PICTURE_ACCEPTED", "ordinal": ordinal, "providerTaskId": task_id},
        )
        if not reply["allowed"]:
            raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
        picture_id = task_id

    await picture.render(
        snapshot["model"], duration, first_frame, output, accept, picture_id
    )
    if picture_id is None:
        raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
    return picture_id


async def execute_tail_segment(
    api: LeasePort,
    segment_api: ApiPort,
    voice: TailVoicePort,
    picture: TailPicturePort | None,
    snapshot: TailSnapshot,
    segment: TailSegmentSnapshot,
    predecessor: str,
    seed_tail: str | None,
    speech: TailSpeech,
    root: Path,
    ffmpeg: str,
    ffprobe: str,
) -> str:
    ordinal = segment["ordinal"]
    duration: int = speech.plan["segments"][ordinal - 1]["durationSeconds"]
    duration_ms = duration * 1000
    wav, drive = root / "drive.wav", root / "drive.mp3"
    timings = await speech.write_segment(ordinal, wav, drive, ffmpeg)
    lip_id, picture_id = segment["lipSyncTaskId"], segment["pictureTaskId"]
    if lip_id is None:
        if picture is None:
            raise TaskFailure("INVALID_TASK")
        clip = root / "ark.mp4"
        picture_id = await _segment_picture(
            api, picture, snapshot, segment, predecessor, seed_tail, duration, clip
        )
        file_id = await voice.upload_character(clip)
        audio_id = await voice.upload_drive_audio(wav)
        await _checkpoint(segment_api, "LIP_SYNC_SUBMIT")
        lip_id = await voice.submit_lip_sync(
            segment["lipSyncClientToken"], file_id, audio_id
        )
        await _checkpoint(segment_api, "LIP_SYNC_ACCEPTED", lip_id)

    if picture_id is None:
        raise TaskFailure("INVALID_TASK")
    aligned = await voice.get_lip_sync_result(lip_id)
    if abs(aligned.duration_ms - duration_ms) > MAX_AUDIO_LAG_MS:
        raise TaskFailure("MEDIA_INVALID")
    video = root / "aligned.mp4"
    await voice.download(aligned.url, video, kind="lip-sync")
    checked = await validate_output(
        video, drive, duration_ms, duration_ms, ffmpeg, ffprobe
    )
    completion = {
        "audioDurationMs": checked.audio_duration_ms,
        "videoDurationMs": checked.video_duration_ms,
        "audioLagMs": checked.audio_lag_ms,
        "minimumAudioCorrelationPermille": checked.minimum_audio_correlation_permille,
        "wordTimings": timings,
    }
    if not validator("completion").is_valid(completion):
        raise TaskFailure("MEDIA_INVALID")
    await segment_api.complete(video, drive, completion)
    return picture_id
