from __future__ import annotations

import json
import wave
from pathlib import Path

import httpx
import pytest
from fission_avatar.provider import TaskFailure, VolcProvider
from fission_avatar.tail_provider import TailPictureProvider

_ARK = "https://ark.cn-beijing.volces.com/api/v3"
_MODEL = "doubao-seedance-2-0-fast-260128"


async def test_native_tail_and_picture_resume_reuse_one_create(tmp_path: Path) -> None:
    tail = "https://fixture.tos.example/original.jpeg?X-Signature=fixture"
    generated = b"\x00\x00\x00\x18ftypisom-fixture"
    accepted: list[str] = []
    creates: list[dict[str, object]] = []

    async def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/next.mp4":
            assert "authorization" not in req.headers
            return httpx.Response(
                200, content=generated, headers={"content-type": "video/mp4"}
            )
        assert req.headers["authorization"] == "Bearer ark-key-fixture"
        if req.method == "POST":
            creates.append(json.loads(req.content))
            return httpx.Response(200, json={"id": "cgt-next"})
        identifier = req.url.path.rsplit("/", 1)[1]
        return httpx.Response(
            200,
            json={
                "id": identifier if identifier != "cgt-wrong" else "cgt-different",
                "model": _MODEL,
                "status": "succeeded",
                "duration": 12,
                "content": {
                    "video_url": "https://fixture.tos.example/next.mp4?signature=fixture",
                    "last_frame_url": tail,
                },
            },
        )

    async def accept(task_id: str) -> None:
        accepted.append(task_id)

    provider = TailPictureProvider(
        _ARK, "ark-key-fixture", transport=httpx.MockTransport(handler)
    )
    try:
        frame = await provider.native_tail("cgt-source")
        assert frame == tail
        await provider.render(_MODEL, 12, frame, tmp_path / "clip.mp4", accept)
        await provider.render(
            _MODEL, 12, None, tmp_path / "resume.mp4", accept, "cgt-next"
        )
        with pytest.raises(TaskFailure, match="PROVIDER_FAILED"):
            await provider.native_tail("cgt-wrong")
    finally:
        await provider.close()
    assert accepted == ["cgt-next"]
    assert len(creates) == 1
    assert creates[0]["return_last_frame"] is True
    assert creates[0]["generate_audio"] is False
    assert creates[0]["ratio"] == "adaptive"
    assert isinstance(creates[0]["content"], list)
    assert creates[0]["content"][1] == {
        "type": "image_url",
        "role": "first_frame",
        "image_url": {"url": tail},
    }
    assert (
        (tmp_path / "clip.mp4").read_bytes()
        == (tmp_path / "resume.mp4").read_bytes()
        == generated
    )


async def test_long_tts_marks_and_exact_wav_upload(tmp_path: Path) -> None:
    audio = tmp_path / "drive.wav"
    with wave.open(str(audio), "wb") as sound:
        sound.setparams((1, 2, 24_000, 0, "NONE", "not compressed"))
        sound.writeframes(b"\x00" * 24_000 * 4 * 2)
    voice_data = audio.read_bytes()

    async def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/query"):
            return httpx.Response(
                200,
                json={
                    "code": 20_000_000,
                    "data": {
                        "task_id": "tts-fixture",
                        "task_status": 2,
                        "audio_url": "https://fixture.speech.example/read?signature=fixture",
                        "sentences": [
                            {
                                "words": [
                                    {"word": "开", "startTime": 0, "endTime": 1},
                                    {"word": "尾", "startTime": 70.1, "endTime": 71.1},
                                ]
                            }
                        ],
                    },
                },
            )
        if req.url.path.endswith("/request-media-upload-url"):
            assert req.headers["authorization"] == "Bearer media-key-fixture"
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "result": {
                        "method": "PUT",
                        "file_id": "mediakit://test-audio",
                        "upload_url": "https://fixture.tos.volces.com/upload?signature=fixture",
                        "upload_headers": [],
                    },
                },
            )
        assert req.url.path == "/upload"
        assert req.content == voice_data
        assert req.headers["content-type"] == "audio/wav"
        assert "authorization" not in req.headers
        return httpx.Response(200)

    provider = VolcProvider(
        "tts-key-fixture", "media-key-fixture", transport=httpx.MockTransport(handler)
    )
    try:
        assert [
            word["endMs"]
            for word in (await provider.get_tts_result("tts-fixture")).timings
        ] == [1000]
        assert [
            word["endMs"]
            for word in (await provider.get_long_tts_result("tts-fixture")).timings
        ] == [1000, 71_100]
        assert await provider.upload_drive_audio(audio) == "mediakit://test-audio"
    finally:
        await provider.close()


async def test_accepted_lip_sync_tolerates_read_visibility_lag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task = "amk-tool-lip-sync-accepted-fixture"
    retries = [404, 503]
    requests = []

    async def skip_delay(delay: float) -> None:
        assert 0 < delay <= 5

    async def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "GET"
        assert req.url.path.endswith(f"/tasks/{task}")
        requests.append(req.url.path)
        if retries:
            return httpx.Response(retries.pop(0))
        return httpx.Response(
            200,
            json={
                "success": True,
                "task_id": task,
                "status": "completed",
                "result": {
                    "duration": 4,
                    "video_url": "https://fixture.volces.com/result",
                },
            },
        )

    monkeypatch.setattr("fission_avatar.provider.asyncio.sleep", skip_delay)
    provider = VolcProvider(
        "tts-key-fixture", "media-key-fixture", transport=httpx.MockTransport(handler)
    )
    try:
        assert (await provider.get_lip_sync_result(task)).duration_ms == 4000
    finally:
        await provider.close()
    assert len(requests) == 3
