import asyncio
from uuid import uuid4

import httpx
import pytest
from ai_runtime.seedance import SeedanceTransport
from ai_runtime.http import InternalApiError

from fission_local_replace.media import Timeline
from fission_local_replace.pipeline import process_task


@pytest.fixture
def media(monkeypatch):
    async def inspect_source(*args, **kwargs):
        return Timeline(5000, 720, 1280, 120, 24, 72, True)

    async def compose(source, edited, output, timeline, **kwargs):
        assert source.read_bytes() == b"source"
        assert edited.read_bytes() == b"edited"
        assert timeline.end_frame == 72
        output.write_bytes(b"output")

    monkeypatch.setattr("fission_local_replace.pipeline.inspect_source", inspect_source)
    monkeypatch.setattr("fission_local_replace.pipeline.compose", compose)


class FakeApi:
    def __init__(self, *, known=None, pending=False, reservation=None):
        self.token = ""
        self.calls = []
        self.results = []
        self.reservation = reservation or {"state": "RESERVED"}
        self.claim = {
            "status": "CLAIMED",
            "attemptToken": str(uuid4()),
            "creationPending": pending,
            "providerTaskId": known,
            "input": {
                "schemaVersion": 1,
                "model": "test-only",
                "sourceMimeType": "video/mp4",
                "sourceSizeBytes": len(b"source"),
                "targetMimeType": "image/png",
                "targetSizeBytes": len(b"\x89PNG\r\n\x1a\n"),
                "startMs": 1001,
                "endMs": 3000,
                "objectType": "PRODUCT",
                "objectDescription": "手里的小瓶",
                "instruction": "保留小瓶旁的方盒",
            },
        }

    async def call(self, method, path, value=None):
        self.calls.append((method, path, value))
        if path == "claim":
            return self.claim
        assert self.token == self.claim["attemptToken"]
        if path == "provider/create":
            return self.reservation
        if path == "source-url":
            return {"url": "https://source.test/input.mp4"}
        return {"accepted": True}

    async def download(self, slot, destination, size):
        self.calls.append(("GET", slot, None))
        content = b"source" if slot == "source" else b"\x89PNG\r\n\x1a\n"
        assert len(content) == size
        destination.write_bytes(content)

    async def upload(self, path):
        self.results.append(path.read_bytes())


def fake_transport(handler):
    return SeedanceTransport(
        base_url="https://provider.test/api/v3",
        api_key="test-only",
        timeout_seconds=1,
        poll_interval_seconds=0,
        create_qps=1,
        download_concurrency=1,
        max_download_bytes=1024,
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.parametrize("known", [None, "vendor-task"])
async def test_saves_provider_identity_before_poll_and_recovers_known_job(media, known):
    import json

    api = FakeApi(known=known)
    methods = []

    def handler(request):
        if request.url.host == "storage.test":
            assert "authorization" not in request.headers
            return httpx.Response(200, content=b"edited")
        methods.append(request.method)
        if request.method == "POST":
            assert (
                "POST",
                "provider/create",
                {"frameCount": 120, "ratio": "9:16", "hasAudio": True},
            ) in api.calls
            payload = json.loads(request.content)
            assert payload["duration"] == 5 and payload["ratio"] == "9:16"
            assert payload["generate_audio"] is False
            assert payload["content"][1]["role"] == "reference_image"
            assert payload["content"][2]["role"] == "reference_video"
            assert "手里的小瓶" in payload["content"][0]["text"]
            return httpx.Response(200, json={"id": "vendor-task"})
        assert request.url.path.endswith("/vendor-task")
        if not known:
            assert (
                "PUT",
                "provider/task",
                {"providerTaskId": "vendor-task"},
            ) in api.calls
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "content": {"video_url": "https://storage.test/edit.mp4"},
            },
        )

    transport = fake_transport(handler)
    try:
        await process_task(api, transport, "ffmpeg", "ffprobe")
    finally:
        await transport.aclose()
    assert methods == (["GET"] if known else ["POST", "GET"])
    assert api.results == [b"output"]
    if known:
        assert not {
            "target",
            "source-url",
            "provider/create",
            "provider/task",
        }.intersection(path for _, path, _ in api.calls)


@pytest.mark.parametrize("pending", [False, True])
async def test_unknown_creation_is_never_sent_to_provider(media, pending):
    api = FakeApi(pending=pending, reservation={"state": "UNKNOWN"})

    def handler(request):
        pytest.fail("unknown state must never submit or poll a provider job")

    transport = fake_transport(handler)
    try:
        await process_task(api, transport, "ffmpeg", "ffprobe")
    finally:
        await transport.aclose()
    assert api.calls[-1] == (
        "POST",
        "fail",
        {"code": "PROVIDER_CREATION_UNKNOWN", "retryable": False},
    )


@pytest.mark.parametrize(
    "status,code,retryable",
    [
        (200, "PROVIDER_CREATION_UNKNOWN", False),
        (429, "PROVIDER_REJECTED", True),
        (503, "PROVIDER_CREATION_UNKNOWN", False),
    ],
)
async def test_only_definite_provider_rejection_releases_reservation(
    media, status, code, retryable
):
    api = FakeApi()
    transport = fake_transport(lambda request: httpx.Response(status, json={}))
    try:
        await process_task(api, transport, "ffmpeg", "ffprobe")
    finally:
        await transport.aclose()
    assert api.calls[-1] == ("POST", "fail", {"code": code, "retryable": retryable})


async def test_expired_lease_cancels_active_render_without_fail_callback(monkeypatch):
    api = FakeApi(known="vendor-task")
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def render(*args):
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    async def heartbeat(*args):
        await started.wait()
        raise InternalApiError("expired", retryable=False, status_code=409)

    monkeypatch.setattr("fission_local_replace.pipeline.render", render)
    monkeypatch.setattr("fission_local_replace.pipeline.heartbeat", heartbeat)
    transport = fake_transport(lambda request: pytest.fail("no provider traffic"))
    try:
        await process_task(api, transport, "ffmpeg", "ffprobe")
    finally:
        await transport.aclose()
    assert cancelled.is_set()
    assert api.calls == [("POST", "claim", None)]
