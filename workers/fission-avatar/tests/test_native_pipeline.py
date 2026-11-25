from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
from pathlib import Path
from shutil import which
from typing import Any

import httpx
import pytest

from fission_avatar.media import MediaError
from fission_avatar.native_media import prepare_native_video
from fission_avatar.native_pipeline import process_native_task
from fission_avatar.native_provider import NATIVE_MODEL, NativeVideoProvider

_ARK = "https://ark.cn-beijing.volces.com/api/v3"
_ATTEMPT = "36d6c635-6016-4c1e-adf6-db0a84c1b24c"
_TASK_ID = "cgt-native-fixture"
_PROMPT = "画面中的人物面向镜头，自然地说：今天介绍一款新品。"
_PNG = b"\x89PNG\r\n\x1a\n-test-bytes"
_BYTES = {
    "kind": "BYTES",
    "mimeType": "image/png",
    "sizeBytes": len(_PNG),
    "sha256": hashlib.sha256(_PNG).hexdigest(),
}
_PORTRAIT = {"kind": "PORTRAIT", "assetId": "asset-verified-portrait"}


def _input(**fields: Any) -> dict[str, Any]:
    return {
        "schemaVersion": 4,
        "prompt": _PROMPT,
        "model": NATIVE_MODEL,
        "durationSeconds": 4,
        "image": _BYTES,
        "nativeStarted": False,
        "nativeTaskId": None,
        **fields,
    }


class _Api:
    token = ""

    def __init__(self, calls: list[str], snapshot: dict[str, Any]) -> None:
        self.calls = calls
        self.snapshot = snapshot
        self.completion: dict[str, Any] | None = None
        self.failure: dict[str, Any] | None = None
        self.cancelled = False

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        assert method == "POST"
        if path == "claim":
            self.calls.append(path)
            return {
                "status": "CLAIMED",
                "attemptToken": _ATTEMPT,
                "input": self.snapshot,
            }
        assert self.token == _ATTEMPT and body is not None
        if path == "heartbeat":
            assert body["phase"] in {"LIP_SYNC", "VALIDATING"}
            return {"active": not self.cancelled}
        if path == "native/checkpoint":
            if body["kind"] == "NATIVE_ACCEPTED":
                assert body["providerTaskId"] == _TASK_ID
            self.calls.append(body["kind"])
            return {"allowed": True}
        if path == "fail":
            self.failure = body
            return {}
        raise AssertionError(path)

    async def download_file(
        self, route: str, path: Path, expected_size: int, maximum_size: int
    ) -> None:
        assert route == "character" and self.token == _ATTEMPT
        assert expected_size == len(_PNG) <= maximum_size == 8 * 1024 * 1024
        self.calls.append(route)
        path.write_bytes(_PNG)

    async def complete(
        self, video: Path, audio: Path, metadata: dict[str, Any]
    ) -> None:
        assert self.token == _ATTEMPT
        assert b"ftyp" in video.read_bytes()[:32]
        assert audio.read_bytes()
        self.calls.append("complete")
        self.completion = metadata


def _ffmpeg_tools() -> tuple[str, str]:
    ffmpeg = os.getenv("FISSION_AVATAR_FFMPEG_PATH") or which("ffmpeg")
    ffprobe = os.getenv("FISSION_AVATAR_FFPROBE_PATH") or which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("FFmpeg and FFprobe are required for media integration test")
    return ffmpeg, ffprobe


def _clip(ffmpeg: str, path: Path, duration: str, *, silent: bool = False) -> bytes:
    audio = (
        f"anullsrc=r=24000:cl=mono:d={duration}"
        if silent
        else f"sine=frequency=311:duration={duration}:sample_rate=24000"
    )
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=green:size=320x568:duration={duration}:rate=24",
            "-f",
            "lavfi",
            "-i",
            audio,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(path),
        ],
        check=True,
        timeout=30,
    )
    return path.read_bytes()


@pytest.mark.parametrize("duration,image", [(4, _BYTES), (30, _PORTRAIT)])
async def test_native_generation_and_resume(
    tmp_path: Path, duration: int, image: dict[str, Any]
) -> None:
    ffmpeg, ffprobe = _ffmpeg_tools()
    # 30.04s of source contains the tolerated extra 24fps frame.
    clip = _clip(ffmpeg, tmp_path / "provider.mp4", "30.04" if duration == 30 else "4")
    calls: list[str] = []
    submissions: list[dict[str, Any]] = []

    async def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "fixture.tos.example":
            assert "authorization" not in req.headers
            calls.append("download")
            return httpx.Response(
                200, content=clip, headers={"content-type": "video/mp4"}
            )
        assert req.headers["authorization"] == "Bearer ark-key-fixture"
        if req.method == "POST":
            submissions.append(json.loads(req.content))
            calls.append("create")
            return httpx.Response(200, json={"id": _TASK_ID})
        assert req.url.path.endswith(_TASK_ID)
        calls.append("poll")
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "content": {"video_url": "https://fixture.tos.example/output.mp4"},
            },
        )

    provider = NativeVideoProvider(
        _ARK, "ark-key-fixture", transport=httpx.MockTransport(handler)
    )
    first = _Api(calls, _input(durationSeconds=duration, image=image))
    resumed = _Api(
        calls,
        _input(
            durationSeconds=duration,
            image=image,
            nativeStarted=True,
            nativeTaskId=_TASK_ID,
        ),
    )
    try:
        await process_native_task(first, provider, ffmpeg, ffprobe)
        await process_native_task(resumed, provider, ffmpeg, ffprobe)
    finally:
        await provider.close()
    expected_reference = (
        f"data:image/png;base64,{base64.b64encode(_PNG).decode()}"
        if image == _BYTES
        else f"asset://{_PORTRAIT['assetId']}"
    )
    assert submissions == [
        {
            "model": NATIVE_MODEL,
            "content": [
                {"type": "text", "text": _PROMPT},
                {
                    "type": "image_url",
                    "role": "reference_image",
                    "image_url": {"url": expected_reference},
                },
            ],
            "duration": duration,
            "resolution": "480p",
            "ratio": "9:16",
            "generate_audio": True,
            "omni_reference_task_type": "reference",
        }
    ]
    assert calls == [
        "claim",
        *(["character"] if image == _BYTES else []),
        "NATIVE_STARTED",
        "create",
        "NATIVE_ACCEPTED",
        "poll",
        "download",
        "complete",
        "claim",
        "poll",
        "download",
        "complete",
    ]
    assert first.failure is resumed.failure is None
    assert first.completion == resumed.completion
    assert first.completion is not None
    assert first.completion["wordTimings"] == []
    assert first.completion["schemaVersion"] == 4
    assert duration * 1000 - 100 <= first.completion["videoDurationMs"] <= 30_000
    assert abs(first.completion["audioDurationMs"] - duration * 1000) <= 100


@pytest.mark.parametrize(
    "changes,cancelled,error_code",
    [
        ({"nativeStarted": True}, False, "PROVIDER_CREATION_UNKNOWN"),
        ({"image": {**_BYTES, "sha256": "0" * 64}}, False, "MEDIA_INVALID"),
        ({"durationSeconds": 31}, False, "INVALID_TASK"),
        ({}, True, None),
    ],
)
async def test_unsafe_or_inactive_tasks_never_submit(
    changes: dict[str, Any], cancelled: bool, error_code: str | None
) -> None:
    def reject_request(req: httpx.Request) -> httpx.Response:
        raise AssertionError("attempt reached provider")

    calls: list[str] = []
    api = _Api(calls, _input(**changes))
    api.cancelled = cancelled
    provider = NativeVideoProvider(
        _ARK, "ark-key-fixture", transport=httpx.MockTransport(reject_request)
    )
    try:
        await process_native_task(api, provider, "ffmpeg", "ffprobe")
    finally:
        await provider.close()
    assert "NATIVE_STARTED" not in calls
    assert api.failure == (
        {"code": error_code, "retryable": False} if error_code else None
    )


@pytest.mark.parametrize(
    "status,code,retryable",
    [(429, "PROVIDER_REJECTED", True), (500, "PROVIDER_CREATION_UNKNOWN", False)],
)
async def test_native_submit_failure_distinguishes_paid_uncertainty(
    status: int, code: str, retryable: bool
) -> None:
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "POST"
        calls.append("create")
        return httpx.Response(status)

    api = _Api(calls, _input(image=_PORTRAIT))
    provider = NativeVideoProvider(
        _ARK, "ark-key-fixture", transport=httpx.MockTransport(handler)
    )
    try:
        await process_native_task(api, provider, "ffmpeg", "ffprobe")
    finally:
        await provider.close()
    assert calls == ["claim", "NATIVE_STARTED", "create"]
    assert api.failure == {"code": code, "retryable": retryable}


async def test_media_requires_audible_native_audio(tmp_path: Path) -> None:
    ffmpeg, ffprobe = _ffmpeg_tools()
    video = tmp_path / "silent.mp4"
    _clip(ffmpeg, video, "4", silent=True)
    with pytest.raises(MediaError, match="audio is silent"):
        await prepare_native_video(video, tmp_path / "speech.mp3", 4, ffmpeg, ffprobe)
