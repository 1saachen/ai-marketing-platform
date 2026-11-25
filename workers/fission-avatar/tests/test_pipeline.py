from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import httpx
import pytest

from fission_avatar import pipeline
from fission_avatar.api import AvatarApi
from fission_avatar.media import MediaCheck
from fission_avatar.provider import AlignedVideo, Speech, TaskFailure

ATTEMPT = "36d6c635-6016-4c1e-adf6-db0a84c1b24c"
OPERATION = "c5caaa44-b993-4afc-951f-d48ac7cded00"
LIP_ID = "amk-tool-lip-sync-sample"


def snapshot(**fields: Any) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "scriptText": "欢迎",
        "voiceSpeaker": "zh_female_vv_uranus_bigtts",
        "characterSizeBytes": 3,
        "ttsOperationId": OPERATION,
        "ttsStarted": False,
        "lipSyncClientToken": "fd04efae-41fd-438e-9763-228bc1657281",
        "lipSyncStarted": False,
        "lipSyncTaskId": None,
        **fields,
    }


class RecordingApi:
    def __init__(
        self, calls: list[str], input_data: dict[str, Any], *, cancelled: bool = False
    ) -> None:
        self.calls = calls
        self.input_data = input_data
        self.token = ""
        self.cancelled = cancelled
        self.failure: dict[str, Any] | None = None

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.calls.append(path)
        assert method == "POST"
        if path == "claim":
            return {
                "status": "CLAIMED",
                "attemptToken": ATTEMPT,
                "input": self.input_data,
            }
        assert self.token == ATTEMPT
        assert body is not None
        if path == "heartbeat":
            assert body["phase"] in {"TTS", "LIP_SYNC", "VALIDATING"}
            return {"active": not self.cancelled}
        if path == "checkpoint":
            self.calls.append(body["kind"])
            return {"allowed": True}
        if path == "fail":
            self.failure = body
            return {}
        raise AssertionError(path)

    async def download_character(self, path: Path, expected_size: int) -> None:
        self.calls.append("character")
        assert expected_size == 3
        path.write_bytes(b"mp4")

    async def complete(
        self, video: Path, audio: Path, metadata: dict[str, Any]
    ) -> None:
        assert video.read_bytes() == b"lip-sync"
        assert audio.read_bytes() == b"speech"
        assert metadata["videoDurationMs"] == 1800
        assert metadata["minimumAudioCorrelationPermille"] == 999
        self.calls.append("complete")


class RecordingProvider:
    def __init__(self, calls: list[str], *, lose_tts_response: bool = False) -> None:
        self.calls = calls
        self.lose_tts_response = lose_tts_response

    async def submit_tts(self, operation_id: str, script: str, speaker: str) -> None:
        self.calls.append("submit-tts")
        assert operation_id == OPERATION
        if self.lose_tts_response:
            raise TaskFailure("PROVIDER_CREATION_UNKNOWN")

    async def get_tts_result(self, operation_id: str) -> Speech:
        self.calls.append("get-tts")
        assert operation_id == OPERATION
        return Speech(
            "https://tts.example.test/file",
            [
                {"text": "欢", "startMs": 0, "endMs": 130, "confidencePermille": 900},
                {"text": "迎", "startMs": 130, "endMs": 420, "confidencePermille": 900},
            ],
        )

    async def upload_character(self, character: Path) -> str:
        assert character.read_bytes() == b"mp4"
        self.calls.append("upload-character")
        return "mediakit://mock-id"

    async def submit_lip_sync(
        self, client_token: str, file_id: str, audio_url: str
    ) -> str:
        assert file_id == "mediakit://mock-id"
        self.calls.append("submit-lip")
        return LIP_ID

    async def get_lip_sync_result(self, task_id: str) -> AlignedVideo:
        assert task_id == LIP_ID
        self.calls.append("get-lip")
        return AlignedVideo("https://media.example.test/output", 1800)

    async def download(
        self, url: str, path: Path, *, kind: Literal["speech", "lip-sync"]
    ) -> None:
        self.calls.append(f"download-{kind}")
        path.write_bytes(kind.encode())


@pytest.fixture
def media_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    async def prepare(source: Path, silent: Path, ffmpeg: str, ffprobe: str) -> int:
        silent.write_bytes(source.read_bytes())
        return 8000

    async def speech(path: Path, ffmpeg: str, ffprobe: str) -> int:
        return 1780

    async def result(*args: object) -> MediaCheck:
        return MediaCheck(1780, 1800, 0, 999)

    monkeypatch.setattr(pipeline, "prepare_character", prepare)
    monkeypatch.setattr(pipeline, "inspect_speech", speech)
    monkeypatch.setattr(pipeline, "validate_output", result)


async def test_reserves_both_operations_before_sending_and_commits_once(
    media_tools: None,
) -> None:
    calls: list[str] = []
    api = RecordingApi(calls, snapshot())
    await pipeline.process_task(
        api, RecordingProvider(calls, lose_tts_response=True), "", ""
    )
    assert api.failure is None
    assert (
        calls.index("character") < calls.index("TTS_SUBMIT") < calls.index("submit-tts")
    )
    assert (
        calls.index("submit-tts")
        < calls.index("get-tts")
        < calls.index("LIP_SYNC_SUBMIT")
    )
    assert (
        calls.index("LIP_SYNC_SUBMIT")
        < calls.index("submit-lip")
        < calls.index("LIP_SYNC_ACCEPTED")
    )
    assert (
        calls.index("LIP_SYNC_ACCEPTED")
        < calls.index("get-lip")
        < calls.index("complete")
    )
    assert (
        calls.count("submit-tts")
        == calls.count("submit-lip")
        == calls.count("complete")
        == 1
    )


async def test_resume_only_queries_known_operations(media_tools: None) -> None:
    calls: list[str] = []
    api = RecordingApi(
        calls, snapshot(ttsStarted=True, lipSyncStarted=True, lipSyncTaskId=LIP_ID)
    )
    await pipeline.process_task(api, RecordingProvider(calls), "", "")
    assert "get-tts" in calls
    assert "get-lip" in calls
    assert "complete" in calls
    assert "submit-tts" not in calls
    assert "submit-lip" not in calls
    assert "character" not in calls
    assert "checkpoint" not in calls


async def test_ambiguous_lip_submission_is_not_repeated(media_tools: None) -> None:
    calls: list[str] = []
    api = RecordingApi(calls, snapshot(ttsStarted=True, lipSyncStarted=True))
    await pipeline.process_task(api, RecordingProvider(calls), "", "")
    assert calls == ["claim", "fail"]
    assert api.failure == {"code": "PROVIDER_CREATION_UNKNOWN", "retryable": False}


async def test_inactive_lease_stops_before_transfer_and_provider(
    media_tools: None,
) -> None:
    calls: list[str] = []
    api = RecordingApi(calls, snapshot(), cancelled=True)
    await pipeline.process_task(api, RecordingProvider(calls), "", "")
    assert calls == ["claim", "heartbeat"]


async def test_rejects_invalid_claim_snapshot(media_tools: None) -> None:
    calls: list[str] = []
    api = RecordingApi(calls, snapshot(voiceSpeaker="S_unverified_clone"))
    await pipeline.process_task(api, RecordingProvider(calls), "", "")
    assert calls == ["claim", "fail"]
    assert api.failure == {"code": "INVALID_TASK", "retryable": False}


@pytest.mark.parametrize("checkpoint_route", ["checkpoint", "segments/2/checkpoint"])
async def test_reservation_transport_failure_is_not_retried(
    checkpoint_route: str,
) -> None:
    from uuid import UUID

    from ai_runtime.http import InternalApiError

    count = 0

    async def handler(req: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        assert req.headers["x-worker-token"] == "offline-worker-fixture"
        assert req.headers["x-attempt-token"] == ATTEMPT
        assert req.url.path.endswith(
            f"/{OPERATION}/tasks/{OPERATION}/{checkpoint_route}"
        )
        raise httpx.ReadTimeout("simulated connection interruption", request=req)

    api = AvatarApi(
        "http://internal.example.test/api",
        "offline-worker-fixture",
        UUID(OPERATION),
        UUID(OPERATION),
        UUID(OPERATION),
        transport=httpx.MockTransport(handler),
    )
    api.token = ATTEMPT
    try:
        with pytest.raises(InternalApiError, match="unavailable"):
            await api.call("POST", checkpoint_route, {"kind": "TTS_SUBMIT"})
    finally:
        await api.close()
    assert count == 1
