from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal, Protocol, TypedDict, cast

from ai_runtime.http import InternalApiError
from jsonschema import Draft202012Validator

from .lease import (
    UNAVAILABLE,
    Heartbeat,
    LeaseInactive,
    LeasePort,
    claim_task,
    fail_task,
    with_heartbeat,
)
from .media import (
    MAX_AUDIO_LAG_MS,
    MediaError,
    inspect_speech,
    prepare_character,
    validate_output,
)
from .provider import AlignedVideo, Speech, TaskFailure

Schema = Literal["worker-input", "checkpoint", "completion"]


class Snapshot(TypedDict):
    schemaVersion: Literal[1]
    scriptText: str
    voiceSpeaker: str
    characterSizeBytes: int
    ttsOperationId: str
    ttsStarted: bool
    lipSyncClientToken: str
    lipSyncStarted: bool
    lipSyncTaskId: str | None


class ApiPort(LeasePort, Protocol):
    async def download_character(self, path: Path, expected_size: int) -> None: ...
    async def complete(
        self, video: Path, audio: Path, metadata: dict[str, Any]
    ) -> None: ...


class ProviderPort(Protocol):
    async def submit_tts(
        self, operation_id: str, script: str, speaker: str
    ) -> None: ...
    async def get_tts_result(self, operation_id: str) -> Speech: ...
    async def upload_character(self, character: Path) -> str: ...
    async def submit_lip_sync(
        self, client_token: str, file_id: str, audio_url: str
    ) -> str: ...
    async def get_lip_sync_result(self, task_id: str) -> AlignedVideo: ...
    async def download(
        self, url: str, path: Path, *, kind: Literal["speech", "lip-sync"]
    ) -> None: ...


@lru_cache(maxsize=12)
def validator(
    name: Schema,
    *,
    step: Literal["sync", "render", "long-sync", "long-render", "tail-chain"] = "sync",
) -> Draft202012Validator:
    configured = os.getenv("FISSION_AVATAR_CONTRACTS_DIR")
    directory = (
        Path(configured)
        if configured
        else Path(__file__).resolve().parents[4] / "packages/contracts"
    )
    with (directory / "schemas" / f"fission-avatar-{step}-{name}.schema.json").open(
        encoding="utf-8"
    ) as file:
        schema = json.load(file)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _snapshot(value: object) -> Snapshot:
    if not isinstance(value, dict) or not validator("worker-input").is_valid(value):
        raise TaskFailure("INVALID_TASK")
    snapshot = cast(Snapshot, value)
    if (
        not snapshot["scriptText"].strip()
        or snapshot["lipSyncStarted"]
        and not snapshot["ttsStarted"]
        or snapshot["lipSyncTaskId"] is not None
        and not snapshot["lipSyncStarted"]
    ):
        raise TaskFailure("INVALID_TASK")
    return snapshot


async def _checkpoint(
    api: ApiPort,
    kind: Literal["TTS_SUBMIT", "LIP_SYNC_SUBMIT", "LIP_SYNC_ACCEPTED"],
    provider_task_id: str | None = None,
) -> None:
    body: dict[str, str] = {"kind": kind}
    if provider_task_id is not None:
        body["providerTaskId"] = provider_task_id
    if not validator("checkpoint").is_valid(body):
        raise TaskFailure("INVALID_TASK")
    response = await api.call("POST", "checkpoint", body)
    if response.get("allowed") is False:
        # Reservation already consumed, or the attempt was revoked. Caller may
        # only reconcile known provider IDs and never receives a second grant.
        raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
    if response.get("allowed") is not True:
        raise InternalApiError("invalid reservation response", retryable=False)


async def execute(
    api: ApiPort,
    provider: ProviderPort,
    beat: Heartbeat,
    claimed_input: object,
    ffmpeg: str,
    ffprobe: str,
    *,
    prepared_character: tuple[Path, int] | None = None,
) -> None:
    snapshot = _snapshot(claimed_input)
    lip_id = snapshot["lipSyncTaskId"]
    if snapshot["lipSyncStarted"] and lip_id is None:
        raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
    if lip_id is not None:
        beat.phase, beat.progress = "LIP_SYNC", 55

    with TemporaryDirectory(prefix="fission-avatar-") as directory:
        root = Path(directory)
        fresh_input, silent = root / "character.mp4", root / "silent.mp4"
        voice, picture = root / "speech.mp3", root / "sync.mp4"
        await beat.update()
        source_ms = None
        if lip_id is None:
            if prepared_character is None:
                await api.download_character(
                    fresh_input, snapshot["characterSizeBytes"]
                )
                source_ms = await prepare_character(
                    fresh_input, silent, ffmpeg, ffprobe
                )
            else:
                silent, source_ms = prepared_character

        if not snapshot["ttsStarted"]:
            await _checkpoint(api, "TTS_SUBMIT")
            try:
                await provider.submit_tts(
                    snapshot["ttsOperationId"],
                    snapshot["scriptText"],
                    snapshot["voiceSpeaker"],
                )
            except TaskFailure as error:
                if error.code != "PROVIDER_CREATION_UNKNOWN":
                    raise
                # TTS has a preassigned queryable ID. An ambiguous submission
                # is followed by lookup of that ID, never by another submit.
        speech = await provider.get_tts_result(snapshot["ttsOperationId"])
        await provider.download(speech.url, voice, kind="speech")
        speech_ms = await inspect_speech(voice, ffmpeg, ffprobe)
        exceeds_source = source_ms is not None and speech_ms > source_ms
        if exceeds_source or any(item["endMs"] > speech_ms for item in speech.timings):
            raise TaskFailure("MEDIA_INVALID")

        await beat.update("LIP_SYNC", 55)
        if lip_id is None:
            file_id = await provider.upload_character(silent)
            await _checkpoint(api, "LIP_SYNC_SUBMIT")
            lip_id = await provider.submit_lip_sync(
                snapshot["lipSyncClientToken"], file_id, speech.url
            )
            await _checkpoint(api, "LIP_SYNC_ACCEPTED", lip_id)

        aligned = await provider.get_lip_sync_result(lip_id)
        await beat.update("VALIDATING", 84)
        await provider.download(aligned.url, picture, kind="lip-sync")
        checked = await validate_output(
            picture, voice, speech_ms, aligned.duration_ms, ffmpeg, ffprobe
        )
        completion = {
            "audioDurationMs": checked.audio_duration_ms,
            "videoDurationMs": checked.video_duration_ms,
            "audioLagMs": checked.audio_lag_ms,
            "minimumAudioCorrelationPermille": checked.minimum_audio_correlation_permille,
            "wordTimings": speech.timings,
        }
        if abs(
            checked.audio_duration_ms - checked.video_duration_ms
        ) > MAX_AUDIO_LAG_MS or (not validator("completion").is_valid(completion)):
            raise TaskFailure("MEDIA_INVALID")
        await beat.update("VALIDATING", 97)
        await api.complete(picture, voice, completion)


async def process_task(
    api: ApiPort,
    provider: ProviderPort,
    ffmpeg: str,
    ffprobe: str,
    *,
    timeout: int = 900,
) -> None:
    claim = await claim_task(api)
    if claim is None:
        return
    beat = Heartbeat(api, "TTS")
    try:
        await with_heartbeat(
            beat,
            lambda: execute(api, provider, beat, claim.get("input"), ffmpeg, ffprobe),
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
    except (MediaError, OSError) as error:
        await fail_task(api, "MEDIA_INVALID", retryable=isinstance(error, OSError))
