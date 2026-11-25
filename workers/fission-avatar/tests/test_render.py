from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from shutil import which
from typing import Any
from uuid import uuid4

import httpx
import pytest

from fission_avatar.api import AvatarApi
from fission_avatar.main import RENDER_FONT
from fission_avatar.media import inspect_speech
from fission_avatar.render_pipeline import (
    InvalidRenderTask,
    _snapshot,
    process_render_task,
)


def _ok(data: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data})


def _snapshot_fixture() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "settings": {
            "background": {"kind": "SOLID", "color": "#0000FF"},
            "insetPercent": 10,
            "captionMode": "BOTH",
            "captions": [
                {
                    "startMs": 0,
                    "endMs": 800,
                    "text": "中文字幕 %{literal}\\path\n第二行",
                }
            ],
        },
        "videoSizeBytes": 100,
        "audioSizeBytes": 100,
        "backgroundSizeBytes": None,
        "audioDurationMs": 1000,
        "videoDurationMs": 1000,
    }


def test_render_snapshot_rejects_unknown_background_and_bad_subtitle_timing() -> None:
    broken = _snapshot_fixture()
    broken["backgroundSizeBytes"] = 200
    with pytest.raises(InvalidRenderTask):
        _snapshot(broken)

    broken = _snapshot_fixture()
    broken["settings"]["captions"].append(
        {"startMs": 750, "endMs": 950, "text": "重叠"}
    )
    with pytest.raises(InvalidRenderTask):
        _snapshot(broken)

    broken = _snapshot_fixture()
    broken["settings"]["captions"][0]["text"] = "非法\x00字幕"
    with pytest.raises(InvalidRenderTask):
        _snapshot(broken)


async def test_cancelled_render_attempt_does_not_read_sources_or_complete() -> None:
    project, run, task, attempt = (uuid4() for _ in range(4))
    paths = []

    def handle(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path.rsplit("/", 1)[-1])
        if paths[-1] == "claim":
            return _ok(
                {
                    "status": "CLAIMED",
                    "attemptToken": str(attempt),
                    "input": _snapshot_fixture(),
                }
            )
        assert paths[-1] == "heartbeat"
        assert request.headers["x-attempt-token"] == str(attempt)
        return _ok({"active": False})

    api = AvatarApi(
        "http://avatar.test/api",
        "token",
        project,
        run,
        task,
        render=True,
        transport=httpx.MockTransport(handle),
    )
    try:
        await process_render_task(api, "", "", font=Path(RENDER_FONT))
    finally:
        await api.close()
    assert paths == ["claim", "heartbeat"]


@pytest.mark.parametrize("image_background", [False, True])
async def test_render_actual_media_with_background_and_literal_subtitles(
    tmp_path: Path, image_background: bool
) -> None:
    ffmpeg = os.getenv("FISSION_AVATAR_FFMPEG_PATH") or which("ffmpeg")
    ffprobe = os.getenv("FISSION_AVATAR_FFPROBE_PATH") or which("ffprobe")
    font = Path(os.getenv("FISSION_AVATAR_RENDER_FONT_PATH") or RENDER_FONT)
    if not font.is_file() and os.name == "nt":
        font = Path("C:/Windows/Fonts/msyh.ttc")
    if not ffmpeg or not ffprobe or not font.is_file():
        pytest.skip(
            "FFmpeg, FFprobe and a Chinese font are required for media integration test"
        )
    video, audio, background = (
        tmp_path / "sync.mp4",
        tmp_path / "voice.mp3",
        tmp_path / "background.png",
    )
    output = tmp_path / "result.mp4"

    def ff(*args: str, capture: bool = False) -> bytes:
        run = subprocess.run(
            [ffmpeg, "-v", "error", *args],
            check=True,
            timeout=45,
            capture_output=capture,
        )
        return run.stdout if capture else b""

    ff(
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.2*sin(2*PI*330*t+70*sin(2*PI*1.1*t)):s=24000:d=2",
        "-c:a",
        "libmp3lame",
        str(audio),
    )
    ff(
        "-f",
        "lavfi",
        "-i",
        "color=green:size=320x320:duration=2:rate=30",
        "-i",
        str(audio),
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        str(video),
    )
    expected_files = {"video": video.read_bytes(), "audio": audio.read_bytes()}
    snapshot = _snapshot_fixture()
    snapshot.update(
        videoSizeBytes=video.stat().st_size,
        audioSizeBytes=audio.stat().st_size,
        audioDurationMs=await inspect_speech(audio, ffmpeg, ffprobe),
        videoDurationMs=2000,
    )
    if image_background:
        ff(
            "-f",
            "lavfi",
            "-i",
            "color=blue:size=320x240:rate=1",
            "-frames:v",
            "1",
            "-threads",
            "1",
            "-update",
            "1",
            str(background),
        )
        expected_files["background"] = background.read_bytes()
        snapshot["backgroundSizeBytes"] = background.stat().st_size
        snapshot["settings"]["background"] = {
            "kind": "IMAGE",
            "assetId": str(uuid4()),
            "version": 1,
        }
        snapshot["settings"]["captionMode"] = "SIDECAR"

    project, run, task, attempt = (uuid4() for _ in range(4))
    api_path = (
        f"/api/internal/workers/fission-avatar/{project}/{run}/render/tasks/{task}/"
    )
    reads = []
    multipart: bytes | None = None

    async def handle(request: httpx.Request) -> httpx.Response:
        nonlocal multipart
        assert request.url.path.startswith(api_path)
        assert request.headers["x-worker-token"] == "token"
        endpoint = request.url.path.removeprefix(api_path)
        if endpoint == "claim":
            return _ok(
                {"status": "CLAIMED", "attemptToken": str(attempt), "input": snapshot}
            )
        assert request.headers["x-attempt-token"] == str(attempt)
        if endpoint.startswith("files/"):
            role = endpoint.removeprefix("files/")
            reads.append(role)
            return httpx.Response(200, stream=httpx.ByteStream(expected_files[role]))
        if endpoint == "heartbeat":
            assert json.loads(await request.aread())["phase"] in {
                "ENCODING",
                "VALIDATING",
            }
            return _ok({"active": True})
        assert request.method == "PUT" and endpoint == "result"
        multipart = await request.aread()
        # Extract just the uploaded picture for decoded pixel inspection.
        start = multipart.index(b"Content-Type: video/mp4\r\n\r\n") + len(
            b"Content-Type: video/mp4\r\n\r\n"
        )
        boundary = request.headers["content-type"].split("boundary=", 1)[1].encode()
        end = multipart.index(b"\r\n--" + boundary, start)
        output.write_bytes(multipart[start:end])
        return _ok({})

    api = AvatarApi(
        "http://avatar.test/api",
        "token",
        project,
        run,
        task,
        render=True,
        transport=httpx.MockTransport(handle),
    )
    try:
        await process_render_task(api, ffmpeg, ffprobe, font=font)
    finally:
        await api.close()
    expected_srt = (
        "1\n00:00:00,000 --> 00:00:00,800\n中文字幕 %{literal}\\path\n第二行\n\n"
    )
    assert reads == list(expected_files)
    assert multipart is not None and expected_srt.encode("utf-8") in multipart
    assert b'name="metadata"' in multipart

    frame = ff(
        "-ss",
        "0.5",
        "-i",
        str(output),
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-",
        capture=True,
    )
    assert len(frame) == 1080 * 1920 * 3
    assert frame[2] > 230 and frame[0] < 15  # canvas
    center = (960 * 1080 + 540) * 3
    assert frame[center + 1] > 100 and frame[center + 2] < 15  # source picture
    subtitle_region = frame[(1920 - 260) * 1080 * 3 : -60 * 1080 * 3]
    white_pixels = sum(
        min(subtitle_region[i : i + 3]) > 230 for i in range(0, len(subtitle_region), 3)
    )
    if image_background:
        assert white_pixels == 0
    else:
        assert white_pixels > 200
