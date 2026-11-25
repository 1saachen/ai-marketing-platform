from __future__ import annotations

import unicodedata
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal, NotRequired, Protocol, TypedDict, cast

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
from .long_media import (
    MAX_LONG_WORKER_AUDIO_BYTES,
    MAX_LONG_WORKER_VIDEO_BYTES,
    seam_frames_for_duration,
)
from .media import MAX_AUDIO_BYTES, MAX_AUDIO_LAG_MS, MAX_VIDEO_BYTES, MediaError
from .pipeline import validator
from .render_media import MAX_BACKGROUND_BYTES, Settings, render_video


class RenderApiPort(LeasePort, Protocol):
    async def download_file(
        self, route: str, path: Path, expected_size: int, maximum_size: int
    ) -> None: ...

    async def complete_render(
        self, video: Path, subtitles: Path | None, metadata: dict[str, Any]
    ) -> None: ...


class RenderSnapshot(TypedDict):
    schemaVersion: Literal[1, 2]
    settings: Settings
    videoSizeBytes: int
    audioSizeBytes: int
    backgroundSizeBytes: int | None
    audioDurationMs: int
    videoDurationMs: int
    seamTimesMs: NotRequired[list[int]]


class InvalidRenderTask(ValueError):
    """Frozen input does not match the published Avatar render contract."""


def _snapshot(value: object, long_form: bool = False) -> RenderSnapshot:
    if not isinstance(value, dict) or not validator(
        "worker-input", step="long-render" if long_form else "render"
    ).is_valid(value):
        raise InvalidRenderTask
    snapshot = cast(RenderSnapshot, value)
    settings = snapshot["settings"]
    audio_ms, video_ms = snapshot["audioDurationMs"], snapshot["videoDurationMs"]
    if long_form:
        try:
            seam_frames_for_duration(video_ms, snapshot["seamTimesMs"])
        except MediaError as error:
            raise InvalidRenderTask from error
    if (
        abs(audio_ms - video_ms) > MAX_AUDIO_LAG_MS
        or (settings["background"]["kind"] == "IMAGE")
        != (snapshot["backgroundSizeBytes"] is not None)
        or (settings["captionMode"] != "OFF" and not settings["captions"])
    ):
        raise InvalidRenderTask
    previous_end = 0
    for cue in settings["captions"]:
        start, end = cue["startMs"], cue["endMs"]
        lines = cue["text"].split("\n")
        if (
            not previous_end <= start < end <= audio_ms
            or len(lines) > 2
            or any(
                not line.strip()
                or any(
                    unicodedata.category(char) in {"Cc", "Cs", "Zl", "Zp"}
                    for char in line
                )
                for line in lines
            )
        ):
            raise InvalidRenderTask
        previous_end = end
    return snapshot


async def _execute(
    api: RenderApiPort,
    beat: Heartbeat,
    claimed_input: object,
    ffmpeg: str,
    ffprobe: str,
    font: Path,
    long_form: bool,
) -> None:
    snapshot = _snapshot(claimed_input, long_form)
    with TemporaryDirectory(prefix="fission-avatar-render-") as directory:
        root = Path(directory)
        video, audio = root / "source.mp4", root / "source.mp3"
        output, subtitles = root / "avatar.mp4", root / "avatar.srt"
        background = None
        await beat.update()
        await api.download_file(
            "files/video",
            video,
            snapshot["videoSizeBytes"],
            MAX_LONG_WORKER_VIDEO_BYTES if long_form else MAX_VIDEO_BYTES,
        )
        await api.download_file(
            "files/audio",
            audio,
            snapshot["audioSizeBytes"],
            MAX_LONG_WORKER_AUDIO_BYTES if long_form else MAX_AUDIO_BYTES,
        )
        size = snapshot["backgroundSizeBytes"]
        if size is not None:
            background = root / "background.img"
            await api.download_file(
                "files/background", background, size, MAX_BACKGROUND_BYTES
            )
        await beat.update("ENCODING", 30)
        check = await render_video(
            source_video=video,
            source_audio=audio,
            background=background,
            output_video=output,
            output_subtitles=subtitles,
            settings=snapshot["settings"],
            audio_duration_ms=snapshot["audioDurationMs"],
            video_duration_ms=snapshot["videoDurationMs"],
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
            font=font,
            seam_times_ms=snapshot.get("seamTimesMs"),
        )
        metadata: dict[str, Any] = {
            "audioDurationMs": check.audio_duration_ms,
            "videoDurationMs": check.video_duration_ms,
            "audioLagMs": check.audio_lag_ms,
            "minimumAudioCorrelationPermille": check.minimum_audio_correlation_permille,
        }
        if long_form:
            metadata.update(schemaVersion=2, seamTimesMs=snapshot["seamTimesMs"])
        if abs(
            check.audio_duration_ms - check.video_duration_ms
        ) > MAX_AUDIO_LAG_MS or not validator(
            "completion", step="long-render" if long_form else "render"
        ).is_valid(metadata):
            raise MediaError("render result does not match the completion contract")
        await beat.update("VALIDATING", 95)
        includes_srt = snapshot["settings"]["captionMode"] in {"SIDECAR", "BOTH"}
        await api.complete_render(output, subtitles if includes_srt else None, metadata)


async def process_render_task(
    api: RenderApiPort,
    ffmpeg: str,
    ffprobe: str,
    *,
    font: Path,
    timeout: int = 180,
    long_form: bool = False,
) -> None:
    claim = await claim_task(api)
    if claim is None:
        return
    beat = Heartbeat(api, "ENCODING")
    try:
        await with_heartbeat(
            beat,
            lambda: _execute(
                api, beat, claim.get("input"), ffmpeg, ffprobe, font, long_form
            ),
            timeout,
        )
    except LeaseInactive:
        return
    except InvalidRenderTask:
        await fail_task(api, "INVALID_TASK", retryable=False)
    except InternalApiError as error:
        if error.status_code not in UNAVAILABLE:
            await fail_task(api, "INTERNAL_API_FAILED", retryable=error.retryable)
    except MediaError:
        await fail_task(api, "MEDIA_INVALID", retryable=False)
    except (OSError, TimeoutError):
        await fail_task(api, "RENDER_FAILED", retryable=True)
