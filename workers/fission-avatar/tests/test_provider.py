import json
from pathlib import Path

import httpx
import pytest

from fission_avatar.provider import TaskFailure, VolcProvider


async def test_proven_provider_contract_and_credential_boundaries(
    tmp_path: Path,
) -> None:
    audio_url = "https://speech.test.example/audio?signature=ephemeral-fixture"
    output_url = "https://media.test.example/video?signature=ephemeral-fixture"
    upload_url = "https://bucket.volces.com/post?signature=ephemeral-fixture"
    media_id = "mediakit://test-id"
    operation = "dbf50438-199b-48d4-a414-1a81070f984a"
    lip_id = "amk-tool-lip-sync-test-id"
    calls: list[str] = []

    async def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        calls.append(path)
        if path.startswith("/api/v3/"):
            assert req.headers["X-Api-Key"] == "offline-tts-fixture"
            assert "authorization" not in req.headers
        elif path.startswith("/api/v1/"):
            assert req.headers["Authorization"] == "Bearer offline-mediakit-fixture"
            assert "x-api-key" not in req.headers
        else:
            assert "x-api-key" not in req.headers
            assert "authorization" not in req.headers

        if path.endswith("/tts/submit"):
            body = json.loads(req.content)
            assert body["user"]["uid"].isdigit()
            assert body["unique_id"] == operation
            assert body["req_params"]["audio_params"] == {
                "format": "mp3",
                "sample_rate": 24000,
                "enable_timestamp": True,
            }
            assert body["req_params"]["additions"] == "{}"
            return httpx.Response(
                200, json={"code": 20_000_000, "data": {"task_id": operation}}
            )
        if path.endswith("/tts/query"):
            assert json.loads(req.content) == {"task_id": operation}
            return httpx.Response(
                200,
                json={
                    "code": 20_000_000,
                    "data": {
                        "task_id": operation,
                        "task_status": 2,
                        "audio_url": audio_url,
                        "sentences": [
                            {
                                "words": [
                                    {
                                        "word": "例",
                                        "startTime": 0,
                                        "endTime": 0.186,
                                        "confidence": 0.77,
                                    }
                                ]
                            }
                        ],
                    },
                },
            )
        if path.endswith("request-media-upload-url"):
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "result": {
                        "method": "PUT",
                        "file_id": media_id,
                        "upload_url": upload_url,
                        "upload_headers": [
                            {"key": "content-type", "value": "video/mp4"}
                        ],
                    },
                },
            )
        if path == "/post":
            assert req.content == b"silent-media"
            return httpx.Response(200)
        if path.endswith("/tools/lip-sync"):
            assert json.loads(req.content) == {
                "client_token": operation,
                "video_url": media_id,
                "audio_url": audio_url,
                "enable_video_loop": False,
            }
            return httpx.Response(200, json={"success": True, "task_id": lip_id})
        if path.endswith(f"tasks/{lip_id}"):
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "task_id": lip_id,
                    "task_type": "lip-sync",
                    "status": "completed",
                    "result": {"duration": 1.9, "video_url": output_url},
                },
            )
        if path == "/audio":
            return httpx.Response(200, content=b"speech")
        if path == "/video":
            return httpx.Response(200, content=b"result")
        raise AssertionError(path)

    provider = VolcProvider(
        "offline-tts-fixture",
        "offline-mediakit-fixture",
        transport=httpx.MockTransport(handler),
    )
    source, speech_file, video_file = (
        tmp_path / "source.mp4",
        tmp_path / "speech.mp3",
        tmp_path / "video.mp4",
    )
    source.write_bytes(b"silent-media")
    try:
        await provider.submit_tts(operation, "这是例子", "zh_female_vv_uranus_bigtts")
        speech = await provider.get_tts_result(operation)
        assert speech.timings == [
            {"text": "例", "startMs": 0, "endMs": 186, "confidencePermille": 770},
        ]
        await provider.download(speech.url, speech_file, kind="speech")
        file_id = await provider.upload_character(source)
        task_id = await provider.submit_lip_sync(operation, file_id, speech.url)
        rendered = await provider.get_lip_sync_result(task_id)
        assert rendered.duration_ms == 1900
        await provider.download(rendered.url, video_file, kind="lip-sync")
        assert speech_file.read_bytes() == b"speech"
        assert video_file.read_bytes() == b"result"
        assert len(calls) == 8
    finally:
        await provider.close()


async def test_lost_paid_request_becomes_unknown_with_no_retry() -> None:
    attempts = 0

    async def handler(req: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ReadTimeout("simulated provider outage", request=req)

    provider = VolcProvider("tts", "mediakit", transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(TaskFailure) as result:
            await provider.submit_lip_sync(
                "id", "mediakit://file", "https://speech.example.test/audio"
            )
        assert result.value.code == "PROVIDER_CREATION_UNKNOWN"
        assert result.value.retryable is False
        assert attempts == 1
    finally:
        await provider.close()
