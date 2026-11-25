from __future__ import annotations

from collections.abc import Awaitable, Callable
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import pytest

from fission_avatar import long_pipeline, tail_pipeline
from fission_avatar.media import MediaCheck
from fission_avatar.provider import AlignedVideo, Speech, TaskFailure, Timing

MASTER = b"whole voice"
SEED = "cgt-registered-original"
TIMINGS: list[Timing] = [
    {"text": "说", "startMs": 100, "endMs": 200, "confidencePermille": None}
]
SAMPLES = 13 * 24000
PLAN = {
    "masterSha256": sha256(MASTER).hexdigest(),
    "sourceSamples": SAMPLES * 5,
    "segments": [
        {
            "sourceStartSample": i * SAMPLES,
            "sourceEndSample": (i + 1) * SAMPLES,
            "leadingSilenceSamples": 0,
            "durationSeconds": 13,
        }
        for i in range(5)
    ],
}


class FrozenSpeech:
    plan = PLAN

    async def write_segment(
        self, ordinal: int, wav: Path, mp3: Path, ffmpeg: str
    ) -> list[Timing]:
        wav.write_bytes(f"wav {ordinal}".encode())
        mp3.write_bytes(f"mp3 {ordinal}".encode())
        return TIMINGS


class Api:
    token = ""

    def __init__(self) -> None:
        self.snapshot: dict[str, Any] = {
            "schemaVersion": 3,
            "voiceSpeaker": "zh_test_uranus_bigtts",
            "scriptText": "一段完整的测试口播稿。",
            "sourceTaskId": SEED,
            "model": "doubao-seedance-2-0-fast-260128",
            "ttsOperationId": str(uuid4()),
            "ttsStarted": False,
            "plan": None,
            "segments": [],
        }
        self.files: dict[tuple[int, str], bytes] = {}
        self.failures: list[dict[str, Any]] = []
        self.completion: dict[str, Any] | None = None

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        assert method == "POST"
        if path == "claim":
            return {
                "status": "CLAIMED",
                "attemptToken": str(uuid4()),
                "input": deepcopy(self.snapshot),
            }
        if path == "heartbeat":
            return {"active": True}
        assert body is not None
        if path == "fail":
            self.failures.append(body)
            return {}
        kind = body["kind"]
        if path == "continuity/checkpoint":
            if kind == "TTS_STARTED":
                assert not self.snapshot["ttsStarted"]
                self.snapshot["ttsStarted"] = True
            elif kind == "PLAN_READY":
                assert self.snapshot["plan"] is None and body["plan"] == PLAN
                self.snapshot["plan"] = deepcopy(body["plan"])
                self.snapshot["segments"] = [
                    {
                        "ordinal": ordinal,
                        "pictureStarted": False,
                        "pictureTaskId": None,
                        "lipSyncClientToken": str(uuid4()),
                        "lipSyncStarted": False,
                        "lipSyncTaskId": None,
                        "result": None,
                    }
                    for ordinal in range(1, 6)
                ]
                return {"allowed": True, "input": deepcopy(self.snapshot)}
            else:
                segment = self.snapshot["segments"][body["ordinal"] - 1]
                if kind == "PICTURE_STARTED":
                    assert not segment["pictureStarted"]
                    segment["pictureStarted"] = True
                else:
                    assert kind == "PICTURE_ACCEPTED" and segment["pictureStarted"]
                    assert segment["pictureTaskId"] is None
                    segment["pictureTaskId"] = body["providerTaskId"]
        else:
            _, ordinal_str, action = path.split("/")
            assert action == "checkpoint"
            segment = self.snapshot["segments"][int(ordinal_str) - 1]
            assert segment["pictureTaskId"]
            if kind == "LIP_SYNC_SUBMIT":
                assert not segment["lipSyncStarted"]
                segment["lipSyncStarted"] = True
            else:
                assert kind == "LIP_SYNC_ACCEPTED" and segment["lipSyncStarted"]
                assert segment["lipSyncTaskId"] is None
                segment["lipSyncTaskId"] = body["providerTaskId"]
        return {"allowed": True}

    async def download_character(self, path: Path, expected_size: int) -> None:
        pytest.fail("tail chain cannot use the legacy clip substitution")

    async def download_file(
        self, route: str, path: Path, expected_size: int, maximum_size: int
    ) -> None:
        _, ordinal, _, role = route.split("/")
        content = self.files[int(ordinal), role]
        assert len(content) == expected_size <= maximum_size
        path.write_bytes(content)

    async def complete(
        self,
        video: Path,
        audio: Path,
        metadata: dict[str, Any],
        *,
        route: str = "result",
    ) -> None:
        if route == "result":
            self.completion = metadata
            return
        _, ordinal_str, _ = route.split("/")
        ordinal = int(ordinal_str)
        segment = self.snapshot["segments"][ordinal - 1]
        assert segment["result"] is None and segment["lipSyncTaskId"]
        result = {"media": metadata}
        for role, file in (("audio", audio), ("video", video)):
            data = file.read_bytes()
            result[role] = {"sizeBytes": len(data), "sha256": sha256(data).hexdigest()}
            self.files[ordinal, role] = data
        segment["result"] = result


class Voice:
    def __init__(self, api: Api) -> None:
        self.api = api
        self.tts_calls = 0
        self.lip_calls = 0

    async def submit_tts(self, operation_id: str, script: str, speaker: str) -> None:
        assert self.api.snapshot["ttsStarted"]
        assert (operation_id, script, speaker) == tuple(
            self.api.snapshot[key]
            for key in ("ttsOperationId", "scriptText", "voiceSpeaker")
        )
        self.tts_calls += 1

    async def get_tts_result(self, operation_id: str) -> Speech:
        pytest.fail("tail chain cannot use the short timing limits")

    async def get_long_tts_result(self, operation_id: str) -> Speech:
        assert (
            self.tts_calls == 1 and operation_id == self.api.snapshot["ttsOperationId"]
        )
        return Speech("voice-url", TIMINGS)

    async def download(
        self, url: str, output: Path, *, kind: Literal["speech", "lip-sync"]
    ) -> None:
        output.write_bytes(MASTER if kind == "speech" else url.encode())

    async def upload_character(self, file: Path) -> str:
        return file.read_bytes().decode()

    async def upload_drive_audio(self, file: Path) -> str:
        return file.read_bytes().decode()

    async def submit_lip_sync(
        self, client_token: str, file_id: str, audio_url: str
    ) -> str:
        self.lip_calls += 1
        assert (
            file_id == f"cgt-test-{self.lip_calls}"
            and audio_url == f"wav {self.lip_calls}"
        )
        segment = self.api.snapshot["segments"][self.lip_calls - 1]
        assert (
            segment["lipSyncStarted"] and segment["lipSyncClientToken"] == client_token
        )
        return f"amk-tool-lip-sync-test-{self.lip_calls}"

    async def get_lip_sync_result(self, task_id: str) -> AlignedVideo:
        return AlignedVideo(task_id, 13000)


class Picture:
    def __init__(self, api: Api) -> None:
        self.api = api
        self.references: list[str] = []
        self.creations: list[str] = []
        self.resumes: list[str] = []
        self.closed = 0

    async def native_tail(self, task_id: str) -> str:
        self.references.append(task_id)
        return f"https://fixture.invalid/{task_id}/native-tail"

    async def render(
        self,
        model: str,
        duration_seconds: int,
        first_frame: str | None,
        output: Path,
        accept: Callable[[str], Awaitable[None]],
        task_id: str | None = None,
    ) -> None:
        assert model == self.api.snapshot["model"] and duration_seconds == 13
        if task_id is None:
            ordinal = len(self.creations) + 1
            segment = self.api.snapshot["segments"][ordinal - 1]
            assert self.api.snapshot["plan"] == PLAN and segment["pictureStarted"]
            assert (
                first_frame
                == f"https://fixture.invalid/{self.references[-1]}/native-tail"
            )
            task_id = f"cgt-test-{ordinal}"
            self.creations.append(task_id)
            await accept(task_id)
            if ordinal == 2:
                raise TaskFailure("PROVIDER_FAILED", retryable=True)
        else:
            assert first_frame is None
            self.resumes.append(task_id)
            await accept(task_id)
        output.write_bytes(task_id.encode())

    async def close(self) -> None:
        self.closed += 1


def stub_media(monkeypatch: pytest.MonkeyPatch) -> None:
    async def prepare(
        file: Path, timings: list[Timing], ffmpeg: str, plan: dict[str, Any] | None
    ) -> FrozenSpeech:
        assert (
            file.read_bytes() == MASTER and timings == TIMINGS and plan in (None, PLAN)
        )
        return FrozenSpeech()

    async def measure(*args: object) -> MediaCheck:
        return MediaCheck(13000, 13000, 0, 1000)

    async def assemble(manifest: Path, state: Path, *args: object) -> dict[str, Any]:
        state.mkdir()
        candidate = state / "candidate.mp4"
        candidate.write_bytes(b"combined video")
        return {
            "candidateSha256": sha256(candidate.read_bytes()).hexdigest(),
            "durationMs": 65000,
            "wordTimings": TIMINGS,
            "segments": [],
            "seams": [{"timeMs": 13000 * n} for n in range(1, 5)],
        }

    async def encode(state: Path, out: Path, *args: object) -> None:
        out.write_bytes(b"combined audio")

    async def validate(*args: object) -> MediaCheck:
        return MediaCheck(65000, 65000, 0, 1000)

    monkeypatch.setattr(tail_pipeline, "prepare_tail_speech", prepare)
    monkeypatch.setattr(tail_pipeline, "validate_output", measure)
    monkeypatch.setattr(long_pipeline, "assemble_long_form", assemble)
    monkeypatch.setattr(long_pipeline, "encode_long_drive_audio", encode)
    monkeypatch.setattr(long_pipeline, "validate_long_delivery", validate)


async def test_tail_chain_resumes_original_picture_and_reuses_first_segment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stub_media(monkeypatch)
    api = Api()
    voice, picture = Voice(api), Picture(api)

    await long_pipeline.process_long_sync_task(
        api, voice, "ffmpeg", "ffprobe", picture_factory=lambda: picture
    )
    assert api.failures == [{"code": "PROVIDER_FAILED", "retryable": True}]
    before = api.snapshot["segments"][0]["result"]
    assert before is not None and api.completion is None and voice.lip_calls == 1

    await long_pipeline.process_long_sync_task(
        api, voice, "ffmpeg", "ffprobe", picture_factory=lambda: picture
    )
    assert api.snapshot["segments"][0]["result"] == before
    assert voice.tts_calls == 1 and voice.lip_calls == 5 and picture.closed == 2
    assert picture.creations == [f"cgt-test-{n}" for n in range(1, 6)]
    assert picture.references == [SEED, *(f"cgt-test-{n}" for n in range(1, 5))]
    assert picture.resumes == ["cgt-test-2"]
    assert api.completion is not None and api.completion["seamTimesMs"] == [
        13000,
        26000,
        39000,
        52000,
    ]


async def test_unknown_picture_submission_stops_before_resuming_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stub_media(monkeypatch)
    api = Api()
    voice, picture = Voice(api), Picture(api)
    await api.call("POST", "continuity/checkpoint", {"kind": "TTS_STARTED"})
    await api.call(
        "POST", "continuity/checkpoint", {"kind": "PLAN_READY", "plan": PLAN}
    )
    await api.call(
        "POST", "continuity/checkpoint", {"kind": "PICTURE_STARTED", "ordinal": 1}
    )

    await long_pipeline.process_long_sync_task(
        api, voice, "ffmpeg", "ffprobe", picture_factory=lambda: picture
    )
    assert api.failures == [{"code": "PROVIDER_CREATION_UNKNOWN", "retryable": False}]
    assert not picture.references and not picture.creations and not voice.tts_calls
