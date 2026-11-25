from __future__ import annotations

import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal, NotRequired, Protocol, TypedDict, cast

from ai_runtime.http import InternalApiError
from ai_runtime.seedance import image_reference

from .lease import (
    UNAVAILABLE,
    Heartbeat,
    LeaseInactive,
    LeasePort,
    claim_task,
    fail_task,
    with_heartbeat,
)
from .media import MediaError
from .native_media import inspect_native_reference_audio, prepare_native_video
from .native_provider import NativeVideoProvider
from .pipeline import validator
from .provider import TaskFailure

_MAX_IMAGE_BYTES = 8 * 1024 * 1024
_MAX_REFERENCE_AUDIO_BYTES = 15 * 1024 * 1024
_IMAGE_SIGNATURES = {"image/png": b"\x89PNG\r\n\x1a\n", "image/jpeg": b"\xff\xd8\xff"}


class ImageBytes(TypedDict):
    kind: Literal["BYTES"]
    mimeType: Literal["image/png", "image/jpeg"]
    sizeBytes: int
    sha256: str | None


class Portrait(TypedDict):
    kind: Literal["PORTRAIT"]
    assetId: str


class ReferenceAudio(TypedDict):
    mimeType: Literal["audio/mpeg", "audio/wav"]
    sizeBytes: int
    sha256: str | None


class NativeSnapshot(TypedDict):
    schemaVersion: Literal[4]
    prompt: str
    model: str
    durationSeconds: int
    image: ImageBytes | Portrait
    referenceAudio: NotRequired[ReferenceAudio]
    nativeStarted: bool
    nativeTaskId: str | None


class NativeApiPort(LeasePort, Protocol):
    async def download_file(
        self, route: str, path: Path, expected_size: int, maximum_size: int
    ) -> None: ...

    async def complete(
        self, video: Path, audio: Path, metadata: dict[str, Any]
    ) -> None: ...


def _snapshot(value: object) -> NativeSnapshot:
    if not isinstance(value, dict) or not validator(
        "worker-input", step="native"
    ).is_valid(value):
        raise TaskFailure("INVALID_TASK")
    snapshot = cast(NativeSnapshot, value)
    if (
        not snapshot["prompt"].strip()
        or snapshot["nativeTaskId"]
        and not snapshot["nativeStarted"]
    ):
        raise TaskFailure("INVALID_TASK")
    return snapshot


async def _reference(
    api: NativeApiPort, image: ImageBytes | Portrait, directory: Path
) -> dict[str, Any]:
    if image["kind"] == "PORTRAIT":
        return {
            "type": "image_url",
            "role": "reference_image",
            "image_url": {"url": f"asset://{image['assetId']}"},
        }
    local = directory / "reference"
    await api.download_file("character", local, image["sizeBytes"], _MAX_IMAGE_BYTES)
    data = local.read_bytes()
    digest = image["sha256"]
    if (
        not data.startswith(_IMAGE_SIGNATURES[image["mimeType"]])
        or digest is not None
        and hashlib.sha256(data).hexdigest() != digest
    ):
        raise TaskFailure("MEDIA_INVALID")
    return image_reference(image["mimeType"], data)


async def _reference_audio(
    api: NativeApiPort,
    audio: ReferenceAudio,
    directory: Path,
    ffmpeg: str,
    ffprobe: str,
) -> tuple[Literal["audio/mpeg", "audio/wav"], bytes]:
    local = directory / "reference-audio"
    await api.download_file(
        "files/reference-audio", local, audio["sizeBytes"], _MAX_REFERENCE_AUDIO_BYTES
    )
    data = local.read_bytes()
    digest = audio["sha256"]
    if len(data) != audio["sizeBytes"] or (
        digest is not None and hashlib.sha256(data).hexdigest() != digest
    ):
        raise TaskFailure("MEDIA_INVALID")
    mime_type = audio["mimeType"]
    await inspect_native_reference_audio(local, mime_type, ffmpeg, ffprobe)
    return mime_type, data


async def _checkpoint(
    api: NativeApiPort,
    kind: Literal["NATIVE_STARTED", "NATIVE_ACCEPTED"],
    provider_task_id: str | None = None,
) -> None:
    body: dict[str, str] = {"kind": kind}
    if provider_task_id is not None:
        body["providerTaskId"] = provider_task_id
    if not validator("checkpoint", step="native").is_valid(body):
        raise TaskFailure("INVALID_TASK")
    response = await api.call("POST", "native/checkpoint", body)
    if response.get("allowed") is False:
        raise TaskFailure("PROVIDER_CREATION_UNKNOWN")
    if response.get("allowed") is not True:
        raise InternalApiError("invalid native checkpoint response", retryable=False)


async def _execute(
    api: NativeApiPort,
    provider: NativeVideoProvider,
    beat: Heartbeat,
    claimed_input: object,
    ffmpeg: str,
    ffprobe: str,
) -> None:
    snapshot = _snapshot(claimed_input)
    task_id = snapshot["nativeTaskId"]
    if snapshot["nativeStarted"] and task_id is None:
        raise TaskFailure("PROVIDER_CREATION_UNKNOWN")

    async def accept(provider_task_id: str) -> None:
        await _checkpoint(api, "NATIVE_ACCEPTED", provider_task_id)

    async def show_progress(progress: int) -> None:
        if progress > beat.progress:
            await beat.update(progress=progress)

    with TemporaryDirectory(prefix="fission-avatar-native-") as directory:
        root = Path(directory)
        await beat.update()
        reference = None
        reference_audio = None
        if task_id is None:
            reference = await _reference(api, snapshot["image"], root)
            if audio_spec := snapshot.get("referenceAudio"):
                reference_audio = await _reference_audio(
                    api, audio_spec, root, ffmpeg, ffprobe
                )
            await _checkpoint(api, "NATIVE_STARTED")

        source, audio = root / "native.mp4", root / "speech.mp3"
        await provider.render(
            snapshot["model"],
            snapshot["prompt"],
            snapshot["durationSeconds"],
            reference,
            source,
            accept,
            show_progress,
            task_id,
            **({"reference_audio": reference_audio} if reference_audio else {}),
        )
        await beat.update("VALIDATING", 95)
        video, metadata = await prepare_native_video(
            source, audio, snapshot["durationSeconds"], ffmpeg, ffprobe
        )
        if not validator("completion", step="native").is_valid(metadata):
            raise TaskFailure("MEDIA_INVALID")
        await beat.update(progress=97)
        await api.complete(video, audio, metadata)


async def process_native_task(
    api: NativeApiPort,
    provider: NativeVideoProvider,
    ffmpeg: str,
    ffprobe: str,
    *,
    timeout: int = 900,
) -> None:
    claim = await claim_task(api)
    if claim is None:
        return
    beat = Heartbeat(api, "LIP_SYNC")
    try:
        await with_heartbeat(
            beat,
            lambda: _execute(api, provider, beat, claim.get("input"), ffmpeg, ffprobe),
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
