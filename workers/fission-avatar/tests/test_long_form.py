import hashlib
import json
import os
import subprocess
from copy import deepcopy
from pathlib import Path
from shutil import copyfile, which
from typing import Any, Literal
from uuid import uuid4

import pytest

from fission_avatar import long_form
from fission_avatar.long_pipeline import process_long_sync_task
from fission_avatar.media import MediaError
from fission_avatar.provider import AlignedVideo, Speech, TaskFailure


def _digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def _media_tools() -> tuple[str, str]:
    ffmpeg = os.getenv("FISSION_AVATAR_FFMPEG_PATH") or which("ffmpeg")
    ffprobe = os.getenv("FISSION_AVATAR_FFPROBE_PATH") or which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip(
            "FFmpeg and FFprobe are required for segmented assembly integration test"
        )
    return ffmpeg, ffprobe


def _speech_fixtures(tmp_path: Path, ffmpeg: str) -> list[dict[str, Any]]:
    segments = []

    def ff(*args: str) -> None:
        subprocess.run([ffmpeg, "-v", "error", *args], check=True, timeout=30)

    for index, (color, freq) in enumerate(
        (("blue", 310), ("green", 430), ("red", 600)), 1
    ):
        video, audio = tmp_path / f"voice-{index}.mp4", tmp_path / f"voice-{index}.mp3"
        duration = 20.5 + index / 1000
        ff(
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc=0.2*sin(2*PI*{freq}*t+70*sin(2*PI*1.1*t)):s=24000:d={duration}",
            "-c:a",
            "libmp3lame",
            str(audio),
        )
        ff(
            "-f",
            "lavfi",
            "-i",
            f"color={color}:size=240x240:duration={duration}:rate=30",
            "-i",
            str(audio),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(video),
        )
        segments.append(
            {
                "video": video.name,
                "audio": audio.name,
                "videoSha256": _digest(video),
                "audioSha256": _digest(audio),
                "wordTimings": [
                    {
                        "text": f"片段{index}",
                        "startMs": 10,
                        "endMs": 500,
                        "confidencePermille": None,
                    }
                ],
            }
        )
    return segments


async def test_real_long_form_survives_late_failure_and_fences_corrupted_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ffmpeg, ffprobe = _media_tools()
    manifest, state = tmp_path / "input.json", tmp_path / "state"
    segments = _speech_fixtures(tmp_path, ffmpeg)
    serialized = json.dumps(
        {"schemaVersion": 1, "segments": segments}, ensure_ascii=False
    ).encode("utf-8")
    manifest.write_bytes(serialized)
    normalize = long_form.normalize_segment
    calls = []
    interrupt = True

    async def normalize_with_interruption(video: Path, *args: Any) -> dict[str, Any]:
        calls.append(video.name)
        if interrupt and video.stem == "voice-3":
            raise MediaError("intentional late-stage test interruption")
        return await normalize(video, *args)

    monkeypatch.setattr(long_form, "normalize_segment", normalize_with_interruption)
    with pytest.raises(long_form.AssemblyError, match="segment 3"):
        await long_form.assemble_long_form(manifest, state, ffmpeg, ffprobe)
    saved = json.loads((state / "state.json").read_text(encoding="utf-8"))
    assert len(saved["checkpoints"]) == 2 and saved["candidate"] is None
    assert not (state / "candidate.mp4").exists()
    interrupt = False

    report = await long_form.assemble_long_form(manifest, state, ffmpeg, ffprobe)
    assert calls == ["voice-1.mp4", "voice-2.mp4", "voice-3.mp4", "voice-3.mp4"]
    assert report["durationMs"] == 61_600
    assert [seam["frame"] for seam in report["seams"]] == [616, 1232]
    assert [word["startMs"] for word in report["wordTimings"]] == [10, 20_543, 41_077]
    assert len(report["audioWindows"]) == 7
    assert report["minimumAudioCorrelationPermille"] >= 980
    assert report["maxAbsAudioLagMs"] <= 10
    assert report["candidateSha256"] == _digest(state / "candidate.mp4")
    assert await long_form.assemble_long_form(manifest, state, "", "") == report

    manifest.write_bytes(serialized + b"\n")
    with pytest.raises(long_form.AssemblyError, match="different manifest"):
        await long_form.assemble_long_form(manifest, state, "", "")
    manifest.write_bytes(serialized)
    source = tmp_path / "voice-2.mp3"
    frozen_source = source.read_bytes()
    source.write_bytes(frozen_source + b"mutated")
    with pytest.raises(long_form.AssemblyError, match="hash mismatch"):
        await long_form.assemble_long_form(manifest, state, "", "")
    source.write_bytes(frozen_source)
    with (state / "segment-02.mp4").open("ab") as corrupt:
        corrupt.write(b"changed")
    with pytest.raises(
        long_form.AssemblyError, match="segment 2 checkpoint is corrupted"
    ):
        await long_form.assemble_long_form(manifest, state, "", "")


def test_local_assembly_lock_excludes_other_writers(tmp_path: Path) -> None:
    with (
        long_form._directory_lock(tmp_path),
        pytest.raises(long_form.AssemblyError, match="locked"),
        long_form._directory_lock(tmp_path),
    ):
        pytest.fail("parallel writer acquired assembly lock")
    with long_form._directory_lock(tmp_path):
        assert (tmp_path / "assembly.lock").exists()


class ResumeApi:
    def __init__(self, directory: Path, character: Path) -> None:
        self.directory = directory
        self.character = character
        self.token = ""
        self.segments = [
            {
                "ordinal": ordinal,
                "scriptText": f"片段{ordinal}",
                "ttsOperationId": str(uuid4()),
                "ttsStarted": False,
                "lipSyncClientToken": str(uuid4()),
                "lipSyncStarted": False,
                "lipSyncTaskId": None,
                "result": None,
            }
            for ordinal in range(1, 4)
        ]
        self.checkpoints: list[tuple[int, str]] = []
        self.reused: list[str] = []
        self.failure: dict[str, Any] | None = None
        self.complete_proof: dict[str, Any] | None = None

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        assert method == "POST"
        if path == "claim":
            return {
                "status": "CLAIMED",
                "attemptToken": str(uuid4()),
                "input": {
                    "schemaVersion": 2,
                    "voiceSpeaker": "zh_test_uranus_bigtts",
                    "characterSizeBytes": self.character.stat().st_size,
                    "segments": deepcopy(self.segments),
                },
            }
        assert self.token and body is not None
        if path == "heartbeat":
            return {"active": True}
        if path == "fail":
            self.failure = body
            return {"accepted": True}
        _, ordinal, name = path.split("/")
        assert name == "checkpoint"
        segment = self.segments[int(ordinal) - 1]
        kind = body["kind"]
        self.checkpoints.append((int(ordinal), kind))
        if kind == "TTS_SUBMIT":
            assert not segment["ttsStarted"]
            segment["ttsStarted"] = True
        elif kind == "LIP_SYNC_SUBMIT":
            assert segment["ttsStarted"] and not segment["lipSyncStarted"]
            segment["lipSyncStarted"] = True
        else:
            assert kind == "LIP_SYNC_ACCEPTED" and segment["lipSyncStarted"]
            segment["lipSyncTaskId"] = body["providerTaskId"]
        return {"allowed": True}

    async def download_character(self, path: Path, expected_size: int) -> None:
        assert self.character.stat().st_size == expected_size
        copyfile(self.character, path)

    async def download_file(
        self, route: str, path: Path, expected_size: int, maximum_size: int
    ) -> None:
        self.reused.append(route)
        _, ordinal, _, role = route.split("/")
        source = self.directory / f"saved-{ordinal}-{role}"
        assert source.stat().st_size == expected_size <= maximum_size
        copyfile(source, path)

    async def complete(
        self,
        video: Path,
        audio: Path,
        metadata: dict[str, Any],
        *,
        route: str = "result",
    ) -> None:
        if route == "result":
            self.complete_proof = metadata
            copyfile(video, self.directory / "result.mp4")
            copyfile(audio, self.directory / "result.mp3")
            return
        _, ordinal, suffix = route.split("/")
        assert suffix == "result"
        result = {"media": metadata}
        for role, source in (("video", video), ("audio", audio)):
            copyfile(source, self.directory / f"saved-{ordinal}-{role}")
            result[role] = {
                "sha256": _digest(source),
                "sizeBytes": source.stat().st_size,
            }
        self.segments[int(ordinal) - 1]["result"] = result


class InterruptedProvider:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.tts: dict[str, int] = {}
        self.lip: dict[str, str] = {}
        self.interrupted = False

    async def submit_tts(self, operation_id: str, script: str, speaker: str) -> None:
        assert operation_id not in self.tts
        self.tts[operation_id] = int(script[-1])

    async def get_tts_result(self, operation_id: str) -> Speech:
        ordinal = self.tts[operation_id]
        return Speech(
            f"voice-{ordinal}.mp3",
            [
                {
                    "text": f"片段{ordinal}",
                    "startMs": 10,
                    "endMs": 500,
                    "confidencePermille": None,
                }
            ],
        )

    async def upload_character(self, character: Path) -> str:
        assert character.is_file()
        return "fixture-character"

    async def submit_lip_sync(
        self, client_token: str, file_id: str, audio_url: str
    ) -> str:
        assert file_id == "fixture-character" and client_token not in self.lip
        task = f"amk-tool-lip-sync-fixture-{audio_url.removeprefix('voice-').removesuffix('.mp3')}"
        self.lip[client_token] = task
        return task

    async def get_lip_sync_result(self, task_id: str) -> AlignedVideo:
        ordinal = int(task_id[-1])
        if ordinal == 2 and not self.interrupted:
            self.interrupted = True
            raise TaskFailure("PROVIDER_FAILED", retryable=True)
        return AlignedVideo(f"voice-{ordinal}.mp4", 20_533)

    async def download(
        self, url: str, path: Path, *, kind: Literal["speech", "lip-sync"]
    ) -> None:
        copyfile(self.directory / url, path)


async def test_long_sync_resumes_persisted_segment_and_known_provider_attempt(
    tmp_path: Path,
) -> None:
    ffmpeg, ffprobe = _media_tools()
    _speech_fixtures(tmp_path, ffmpeg)
    api = ResumeApi(tmp_path, tmp_path / "voice-1.mp4")
    provider = InterruptedProvider(tmp_path)
    await process_long_sync_task(api, provider, ffmpeg, ffprobe)
    assert api.failure == {"code": "PROVIDER_FAILED", "retryable": True}
    assert api.segments[0]["result"] is not None and api.segments[1]["result"] is None
    assert api.complete_proof is None
    assert len(provider.tts) == len(provider.lip) == 2

    await process_long_sync_task(api, provider, ffmpeg, ffprobe)
    assert len(provider.tts) == len(provider.lip) == 3
    assert api.reused == ["segments/1/files/video", "segments/1/files/audio"]
    assert api.checkpoints == [
        (ordinal, kind)
        for ordinal in (1, 2, 3)
        for kind in ("TTS_SUBMIT", "LIP_SYNC_SUBMIT", "LIP_SYNC_ACCEPTED")
    ]
    assert api.complete_proof is not None and api.complete_proof["schemaVersion"] == 2
    assert api.complete_proof["videoDurationMs"] == 61_600
    assert api.complete_proof["seamTimesMs"] == [20_533, 41_067]
    assert api.complete_proof["minimumAudioCorrelationPermille"] >= 980
