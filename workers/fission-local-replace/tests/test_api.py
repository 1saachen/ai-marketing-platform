from uuid import uuid4

import httpx
import pytest
from ai_runtime.http import InternalApiError

from fission_local_replace.api import Api


async def test_scoped_internal_routes_and_file_identity(tmp_path):
    project, run, task, attempt = uuid4(), uuid4(), uuid4(), str(uuid4())
    api = Api("https://api.test/api", "worker-test", project, run, task)
    url = api.client.base_url
    requests = []

    def handler(request):
        requests.append(request)
        assert request.url.path.startswith(
            f"/api/internal/workers/fission-local-replace/{project}/{run}/tasks/{task}/"
        )
        assert request.headers["x-worker-token"] == "worker-test"
        if request.url.path.endswith("/claim"):
            assert request.headers["x-attempt-token"] == ""
            return httpx.Response(
                200, json={"success": True, "data": {"attemptToken": attempt}}
            )
        assert request.headers["x-attempt-token"] == attempt
        if request.url.path.endswith("/source"):
            return httpx.Response(200, content=b"abc")
        assert request.method == "PUT" and request.url.path.endswith("/result")
        assert "multipart/form-data" in request.headers["content-type"]
        assert b'name="file"; filename="video.mp4"' in request.read()
        return httpx.Response(200, json={"success": True, "data": {}})

    await api.close()
    api.client = httpx.AsyncClient(
        base_url=url,
        headers={"x-worker-token": "worker-test"},
        transport=httpx.MockTransport(handler),
    )
    try:
        api.token = (await api.call("POST", "claim"))["attemptToken"]
        file = tmp_path / "test.mp4"
        with pytest.raises(InternalApiError, match="exceeds"):
            await api.download("source", file, 2)
        await api.download("source", file, 3)
        assert file.read_bytes() == b"abc"
        await api.upload(file)
    finally:
        await api.close()
    assert len(requests) == 4
