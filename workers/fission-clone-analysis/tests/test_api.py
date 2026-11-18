import hashlib

import httpx
import pytest
from ai_runtime.http import InternalApiError
from fission_clone_analysis.api import Api

PROJECT = "11111111-1111-4111-8111-111111111111"
TASK = "22222222-2222-4222-8222-222222222222"
FILE = "33333333-3333-4333-8333-333333333333"


async def make_api(handler):
    api = Api("http://internal.test/api", "test-token", PROJECT, TASK)
    await api.client.aclose()
    api.client = httpx.AsyncClient(
        base_url=f"http://internal.test/api/internal/workers/fission-clone-analysis/tasks/{TASK}/",
        headers={"x-worker-token": "test-token"},
        transport=httpx.MockTransport(handler),
    )
    api.token = "attempt"
    return api


async def test_download_only_uses_scoped_internal_endpoint_and_hash(tmp_path):
    content = b"synthetic"

    def handler(request):
        assert request.url.path.endswith(f"tasks/{TASK}/files/{FILE}/content")
        assert request.url.params["projectId"] == PROJECT
        assert request.headers["x-attempt-token"] == "attempt"
        assert request.headers["x-worker-token"] == "test-token"
        return httpx.Response(200, content=content)

    api = await make_api(handler)
    try:
        await api.download(
            FILE,
            tmp_path / "source",
            expected_size=len(content),
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
        assert (tmp_path / "source").read_bytes() == content
    finally:
        await api.close()


@pytest.mark.parametrize(
    "status,content,size,digest",
    [
        (200, b"too-large", 2, hashlib.sha256(b"to").hexdigest()),
        (200, b"wrong", 5, "a" * 64),
        (200, b"short", 9, "a" * 64),
        (302, b"", 9, "a" * 64),
        (409, b"", 9, "a" * 64),
    ],
)
async def test_download_rejects_redirect_mismatch_and_lease_loss(
    tmp_path, status, content, size, digest
):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status, content=content, headers={"location": "https://untrusted.test/file"}
        )

    api = await make_api(handler)
    try:
        with pytest.raises(InternalApiError):
            await api.download(
                FILE, tmp_path / "source", expected_size=size, expected_sha256=digest
            )
        assert not (tmp_path / "source").exists()
        assert len(calls) == 1
    finally:
        await api.close()
