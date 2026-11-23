import asyncio
import copy
import json
from datetime import UTC, datetime

import pytest
from ai_runtime.http import InternalApiError
from ai_runtime.responses import ProviderError
from fission_clone_analysis.media import (
    Frame,
    MediaLimits,
    Sample,
    frame_times,
    sample_video as probe_and_sample,
)
from fission_clone_analysis.pipeline import (
    CHECKPOINT_KEY,
    Pipeline,
    heartbeat_interval,
    process_task,
)


def test_heartbeat_renews_short_lease_before_expiry():
    now = datetime(2026, 11, 11, tzinfo=UTC)
    assert heartbeat_interval("2026-11-11T00:00:15Z", now) == 5
    assert heartbeat_interval("2026-11-11T00:01:30Z", now) == 20
    assert heartbeat_interval("2026-11-10T00:00:00Z", now) == 1
    with pytest.raises(ValueError):
        heartbeat_interval("2026-11-11T00:00:15", now)


class FakeApi:
    def __init__(self, claim):
        self.claim = claim
        self.token = ""
        self.calls = []
        self.downloads = []

    async def call(self, method, path, value=None):
        self.calls.append((method, path, value))
        return copy.deepcopy(self.claim) if path == "claim" else {}

    async def download(self, file_id, destination, **kwargs):
        self.downloads.append((file_id, destination))
        destination.write_bytes(b"synthetic")


class FakeProvider:
    def __init__(self, report, mapping):
        self.report, self.mapping = report, mapping
        self.calls = []

    async def analyze(self, snapshot, sample):
        self.calls.append("analyze")
        return {"operation": "ANALYZE", "report": copy.deepcopy(self.report)}

    async def suggest(self, snapshot):
        self.calls.append("suggest")
        return {
            "operation": "MAP_SUGGEST",
            "purpose": "SMART_MATCH",
            "mapping": copy.deepcopy(self.mapping),
            "notes": [],
        }

    async def validate_keep_text(self, snapshot):
        self.calls.append("check")
        return {
            "operation": "MAP_SUGGEST",
            "purpose": "VALIDATE_KEEP_TEXT",
            "checks": [],
        }


@pytest.fixture(autouse=True)
def synthetic_media(monkeypatch):
    async def sample_video(source, directory, limits, *, frozen_media):
        assert frozen_media["durationMs"] == 3000
        return Sample(3000, 360, 640, True, (Frame(0, b"jpeg"), Frame(1500, b"jpeg")))

    monkeypatch.setattr("fission_clone_analysis.pipeline.sample_video", sample_video)


async def test_complete_follows_checkpoint_and_temp_cleanup(claim, report, mapping):
    api, provider = FakeApi(claim), FakeProvider(report, mapping)
    await process_task(api, provider, MediaLimits())
    paths = [call[1] for call in api.calls]
    assert paths.index("checkpoints") < paths.index("complete")
    checkpoint = next(value for _, path, value in api.calls if path == "checkpoints")
    assert (
        checkpoint["key"] == CHECKPOINT_KEY
        and checkpoint["inputHash"] == claim["inputHash"]
    )
    assert provider.calls == ["analyze"]
    assert api.downloads and not api.downloads[0][1].parent.exists()
    assert "fail" not in paths


@pytest.mark.parametrize("version", [2, 3, 4])
async def test_motion_task_uses_dense_sampling_without_changing_frozen_frame_budget(
    claim, motion_report, mapping, monkeypatch, version
):
    async def sample_video(source, directory, limits, *, frozen_media):
        assert frozen_media == {"durationMs": 3000, "width": 360, "height": 640, "frameRate": 24}
        assert limits.interval_ms == 500 and limits.max_frames == 12
        assert frame_times(4000, limits) == list(range(0, 3801, 475))
        return Sample(
            3000, 360, 640, True, (Frame(0, b"jpeg"), Frame(500, b"jpeg"), Frame(1500, b"jpeg"))
        )

    monkeypatch.setattr("fission_clone_analysis.pipeline.sample_video", sample_video)
    claim["snapshot"]["analysisInstructionVersion"] = version
    api, provider = FakeApi(claim), FakeProvider(motion_report, mapping)
    await process_task(api, provider, MediaLimits(max_frames=12))
    assert api.calls[-1][1] == "complete"
    assert provider.calls == ["analyze"]


@pytest.mark.parametrize(
    "media_update, message",
    [
        ({"durationMs": 4043}, "参考视频时长与已确认来源不一致"),
        ({"durationMs": 4000, "width": 361}, "参考视频尺寸与已确认来源不一致"),
        ({"durationMs": None}, "已确认的参考视频媒体信息无效"),
    ],
)
async def test_frozen_media_mismatch_fails_before_sampling_or_provider(
    claim, report, mapping, monkeypatch, media_update, message
):
    reference = claim["snapshot"]["input"]["files"][0]
    reference["media"].update(media_update)

    async def probe(args, timeout):
        assert args[0] == "ffprobe"
        return json.dumps(
            {
                "streams": [
                    {"codec_type": "video", "width": 360, "height": 640, "duration": "4"}
                ],
                "format": {"duration": "4.042"},
            }
        ).encode()

    monkeypatch.setattr("fission_clone_analysis.pipeline.sample_video", probe_and_sample)
    monkeypatch.setattr("fission_clone_analysis.media.run_process", probe)
    api, provider = FakeApi(claim), FakeProvider(report, mapping)
    await process_task(api, provider, MediaLimits())
    assert api.downloads and not provider.calls
    assert not {"checkpoints", "complete"}.intersection(path for _, path, _ in api.calls)
    assert api.calls[-1] == (
        "POST",
        "fail",
        {"code": "CLONE_RESULT_INVALID", "message": message, "retryable": False},
    )


async def test_valid_checkpoint_skips_model_and_media_calls(claim, report, mapping):
    claim["checkpoints"] = [
        {
            "key": CHECKPOINT_KEY,
            "inputHash": claim["inputHash"],
            "output": {"operation": "ANALYZE", "report": report},
        }
    ]
    api, provider = FakeApi(claim), FakeProvider(report, mapping)
    await process_task(api, provider, MediaLimits())
    assert not provider.calls and not api.downloads
    assert api.calls[-1][1] == "complete"


@pytest.mark.parametrize(
    "path,status,resumed",
    [("checkpoints", 409, False), ("complete", 400, False), ("complete", 409, True)],
)
async def test_rejected_analysis_result_marks_live_attempt_failed(
    claim, report, mapping, path, status, resumed
):
    class RejectResult(FakeApi):
        async def call(self, method, route, value=None):
            result = await super().call(method, route, value)
            if route == path:
                raise InternalApiError("invalid report", retryable=False, status_code=status)
            if route == "fail":
                assert self.token == claim["attemptToken"]
            return result

    if resumed:
        claim["checkpoints"] = [
            {
                "key": CHECKPOINT_KEY,
                "inputHash": claim["inputHash"],
                "output": {"operation": "ANALYZE", "report": report},
            }
        ]
    api, provider = RejectResult(claim), FakeProvider(report, mapping)
    await process_task(api, provider, MediaLimits())
    assert [route for _, route, _ in api.calls][-2:] == [path, "fail"]
    assert api.calls[-1][2]["code"] == "CLONE_RESULT_INVALID"
    assert api.calls[-1][2]["retryable"] is False
    assert provider.calls == ([] if resumed else ["analyze"])


@pytest.mark.parametrize("failure_status", [404, 409])
async def test_result_conflict_cannot_fail_an_expired_or_cancelled_attempt(
    claim, report, mapping, failure_status
):
    class LostLease(FakeApi):
        async def call(self, method, path, value=None):
            result = await super().call(method, path, value)
            if path == "checkpoints":
                raise InternalApiError("lost lease", retryable=False, status_code=409)
            if path == "fail":
                assert self.token == claim["attemptToken"]
                raise InternalApiError(
                    "inactive attempt", retryable=False, status_code=failure_status
                )
            return result

    api = LostLease(claim)
    await process_task(api, FakeProvider(report, mapping), MediaLimits())
    assert [path for _, path, _ in api.calls][-2:] == ["checkpoints", "fail"]
    assert "complete" not in [path for _, path, _ in api.calls]


@pytest.mark.parametrize("version", [2, 3, 4])
async def test_new_task_cannot_restore_checkpoint_without_motion(claim, report, mapping, version):
    claim["snapshot"]["analysisInstructionVersion"] = version
    claim["checkpoints"] = [
        {
            "key": CHECKPOINT_KEY,
            "inputHash": claim["inputHash"],
            "output": {"operation": "ANALYZE", "report": report},
        }
    ]
    api, provider = FakeApi(claim), FakeProvider(report, mapping)
    await process_task(api, provider, MediaLimits())
    assert not provider.calls and not api.downloads
    assert "complete" not in [path for _, path, _ in api.calls]
    assert api.calls[-1][1] == "fail"


async def test_checkpoint_from_other_input_is_not_reused(claim, report, mapping):
    claim["checkpoints"] = [
        {
            "key": CHECKPOINT_KEY,
            "inputHash": "a" * 64,
            "output": {"operation": "ANALYZE", "report": report},
        }
    ]
    api, provider = FakeApi(claim), FakeProvider(report, mapping)
    await process_task(api, provider, MediaLimits())
    assert provider.calls == ["analyze"]


async def test_terminal_or_busy_claim_is_a_noop(claim, report, mapping):
    api, provider = FakeApi({**claim, "claimed": False}), FakeProvider(report, mapping)
    await process_task(api, provider, MediaLimits())
    assert [call[1] for call in api.calls] == ["claim"]
    assert not api.token and not provider.calls


@pytest.mark.parametrize(
    "purpose,expected", [("SMART_MATCH", "suggest"), ("VALIDATE_KEEP_TEXT", "check")]
)
async def test_mapping_operations_do_not_download_reference(
    claim, report, mapping, purpose, expected
):
    claim["snapshot"].update(operation="MAP_SUGGEST", purpose=purpose)
    api, provider = FakeApi(claim), FakeProvider(report, mapping)
    await process_task(api, provider, MediaLimits())
    assert provider.calls == [expected]
    assert not api.downloads and api.calls[-1][1] == "complete"


async def test_provider_failure_is_safe_and_keeps_partial_results_uncommitted(
    claim, report, mapping
):
    class Failing(FakeProvider):
        async def analyze(self, snapshot, sample):
            raise ProviderError("sensitive provider text must not leak", retryable=True)

    api = FakeApi(claim)
    await process_task(api, Failing(report, mapping), MediaLimits())
    assert "complete" not in [path for _, path, _ in api.calls]
    failure = next(value for _, path, value in api.calls if path == "fail")
    assert failure["retryable"] is True
    assert "sensitive" not in str(failure)
    assert not api.downloads[0][1].parent.exists()


async def test_lease_loss_cancels_active_provider_without_failure_write(
    claim, report, mapping, monkeypatch
):
    started, cancelled = asyncio.Event(), asyncio.Event()

    class Blocking(FakeProvider):
        async def analyze(self, snapshot, sample):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

    async def lose_lease(self):
        await started.wait()
        raise InternalApiError("lease lost", retryable=False, status_code=409)

    monkeypatch.setattr(Pipeline, "heartbeat", lose_lease)
    api = FakeApi(claim)
    await process_task(api, Blocking(report, mapping), MediaLimits())
    assert cancelled.is_set()
    assert not {"complete", "fail"}.intersection(path for _, path, _ in api.calls)
    assert not api.downloads[0][1].parent.exists()


@pytest.mark.parametrize("offline_path", ["claim", "checkpoints"])
async def test_transient_internal_api_failure_is_not_turned_into_model_failure(
    claim, report, mapping, offline_path
):
    class Offline(FakeApi):
        async def call(self, method, path, value=None):
            result = await super().call(method, path, value)
            if path == offline_path:
                raise InternalApiError("offline", retryable=True, status_code=503)
            return result

    api = Offline(claim)
    with pytest.raises(InternalApiError):
        await process_task(api, FakeProvider(report, mapping), MediaLimits())
    assert "fail" not in [path for _, path, _ in api.calls]
