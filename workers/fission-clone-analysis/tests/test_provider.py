import json

import httpx
import pytest
from ai_runtime.responses import ProviderError
from fission_clone_analysis.media import CutCandidate, Frame, Sample
from fission_clone_analysis.provider import Provider, apply_media_evidence


def sample(has_audio=True):
    return Sample(
        3000, 360, 640, has_audio, (Frame(0, b"jpeg-one"), Frame(1500, b"jpeg-two"))
    )


async def fake_provider(handler):
    provider = Provider("https://provider.test/api/v3", "test-only-key", attempts=2)
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url="https://provider.test/api/v3/", transport=httpx.MockTransport(handler)
    )
    return provider


async def test_real_adapter_sends_timestamped_images_and_shared_schema(
    report, snapshot
):
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert request.url.path == "/api/v3/responses"
        assert payload["store"] is False
        assert (
            payload["text"]["format"]["schema"]["properties"]["schemaVersion"]["const"]
            == 1
        )
        shot = payload["text"]["format"]["schema"]["properties"]["shots"]["items"]
        assert "motion" not in shot["properties"]
        return httpx.Response(
            200, json={"output_text": json.dumps(report, ensure_ascii=False)}
        )

    provider = await fake_provider(handler)
    try:
        source = sample(False)
        result = await provider.analyze(
            snapshot,
            Sample(
                source.duration_ms,
                source.width,
                source.height,
                False,
                source.frames,
                (CutCandidate(1000, 0, 1500),),
            ),
        )
    finally:
        await provider.close()
    content = calls[0]["input"][1]["content"]
    images = [part for part in content if part["type"] == "input_image"]
    assert len(images) == 2
    assert all(
        part["image_url"].startswith("data:image/jpeg;base64,") for part in images
    )
    media = json.loads(content[0]["text"])["media"]
    assert media["cutCandidates"] == [
        {"timeMs": 1000, "beforeMs": 0, "afterMs": 1500}
    ]
    assert media["sampleTimesMs"] == [0, 1500]
    transmitted = json.dumps(calls[0]["input"], ensure_ascii=False)
    target = snapshot["input"]["input"]
    assert target["productName"] not in transmitted
    assert target["productFacts"] not in transmitted
    assert result["report"]["audio"]["hasAudio"] is False
    assert result["report"]["audio"]["voiceover"]["status"] == "UNASSESSED"
    assert result["report"]["audio"]["beatsMs"] == []
    assert any("采样" in item for item in result["report"]["limitations"])


async def test_motion_analysis_sends_required_schema_and_uses_one_model_response(
    motion_report, snapshot
):
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        shot = payload["text"]["format"]["schema"]["properties"]["shots"]["items"]
        assert "motion" in shot["required"]
        prompt = payload["input"][0]["content"]
        assert "contact" in prompt
        assert "并归入镜头自身的证据" in prompt
        assert "后台会自动汇总事件证据" not in prompt
        return httpx.Response(200, json={"output_text": json.dumps(motion_report)})

    snapshot["analysisInstructionVersion"] = 2
    provider = await fake_provider(handler)
    try:
        source = Sample(
            3000,
            360,
            640,
            False,
            (Frame(0, b"jpeg-one"), Frame(500, b"jpeg-two"), Frame(1500, b"jpeg-three")),
        )
        result = await provider.analyze(snapshot, source)
    finally:
        await provider.close()
    assert len(calls) == 1
    assert result["report"]["shots"][0]["motion"] == motion_report["shots"][0]["motion"]


@pytest.mark.parametrize("event_time", [500, 300])
async def test_grounded_prompt_indexes_events_and_rejects_unsampled_times(
    motion_report, snapshot, event_time
):
    shot = motion_report["shots"][0]
    shot["evidenceFramesMs"] = [0]
    shot["motion"]["events"][0]["evidenceFramesMs"] = [0, event_time]
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        prompt = payload["input"][0]["content"]
        assert "禁止补写采样前的进画、伸手或抓起" in prompt
        assert "首次触面、已接触但手仍扶稳、手离开" in prompt
        assert "最后可确认的前态与最早可确认的后态所夹的区间" in prompt
        assert "正面标识转离、侧面或背面转向镜头" in prompt
        assert "后台会自动汇总事件证据" in prompt
        assert (
            [part["type"] for part in payload["input"][1]["content"]].count("input_image")
            == 3
        )
        return httpx.Response(200, json={"output_text": json.dumps(motion_report)})

    snapshot["analysisInstructionVersion"] = 3
    source = Sample(
        3000,
        360,
        640,
        False,
        (Frame(0, b"jpeg-one"), Frame(500, b"jpeg-two"), Frame(1500, b"jpeg-three")),
    )
    provider = await fake_provider(handler)
    try:
        if event_time == 500:
            result = await provider.analyze(snapshot, source)
            assert result["report"]["shots"][0]["evidenceFramesMs"] == [0, 500]
        else:
            with pytest.raises(ValueError, match="unsampled frame"):
                await provider.analyze(snapshot, source)
    finally:
        await provider.close()
    assert len(calls) == 1


@pytest.mark.parametrize("prop_sampled", [True, False])
async def test_prop_prompt_exposes_optional_elements_and_checks_their_evidence(
    prop_report, snapshot, prop_sampled
):
    def handler(request):
        payload = json.loads(request.content)
        schema = payload["text"]["format"]["schema"]
        assert "prop" in schema["properties"]["elements"]["items"]["properties"]["type"]["enum"]
        prompt = payload["input"][0]["content"]
        assert "每件道具独立使用一个稳定elementId" in prompt
        assert "required=false" in prompt
        return httpx.Response(200, json={"output_text": json.dumps(prop_report)})

    frames = [Frame(0, b"jpeg"), Frame(500, b"jpeg"), Frame(1500, b"jpeg")]
    if prop_sampled:
        frames.insert(2, Frame(1000, b"jpeg"))
    snapshot["analysisInstructionVersion"] = 4
    source = Sample(3000, 360, 640, False, tuple(frames))
    provider = await fake_provider(handler)
    try:
        if prop_sampled:
            result = await provider.analyze(snapshot, source)
            assert result["report"]["elements"][-1]["type"] == "prop"
            assert result["report"]["shots"][0]["evidenceFramesMs"] == [0, 500, 1000]
        else:
            with pytest.raises(ValueError, match="unsampled frame"):
                await provider.analyze(snapshot, source)
    finally:
        await provider.close()


async def test_transient_provider_error_has_bounded_retry(report, snapshot):
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, json={"message": "rate limited"})
        return httpx.Response(200, json={"output_text": json.dumps(report)})

    provider = await fake_provider(handler)
    try:
        await provider.analyze(snapshot, sample())
        assert len(calls) == 2
    finally:
        await provider.close()


async def test_invalid_output_is_not_returned_as_success(snapshot):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"output_text": '{"fake":true}'})

    provider = await fake_provider(handler)
    try:
        with pytest.raises(ProviderError):
            await provider.analyze(snapshot, sample())
        assert len(calls) == 2
    finally:
        await provider.close()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r.update(durationMs=4000),
        lambda r: r["shots"][0].update(evidenceFramesMs=[100]),
        lambda r: r["elements"][0].update(type="voiceover"),
    ],
)
def test_media_observations_cannot_claim_unsampled_or_unsupported_facts(
    report, mutation
):
    mutation(report)
    with pytest.raises(ValueError):
        apply_media_evidence(report, sample())


async def test_mapping_notes_reveal_metadata_only_scope(mapping, snapshot):
    provider = await fake_provider(
        lambda request: httpx.Response(200, json={"output_text": json.dumps(mapping)})
    )
    snapshot.update(operation="MAP_SUGGEST", purpose="SMART_MATCH")
    try:
        result = await provider.suggest(snapshot)
    finally:
        await provider.close()
    assert "未经视觉核对" in result["notes"][0]
    assert result["mapping"] == mapping


async def test_keep_text_uses_a_single_shared_object_branch(snapshot):
    def handler(request):
        payload = json.loads(request.content)
        assert (
            payload["text"]["format"]["schema"]["properties"]["purpose"]["const"]
            == "VALIDATE_KEEP_TEXT"
        )
        return httpx.Response(
            200,
            json={
                "output_text": json.dumps(
                    {
                        "operation": "MAP_SUGGEST",
                        "purpose": "VALIDATE_KEEP_TEXT",
                        "checks": [],
                    }
                )
            },
        )

    provider = await fake_provider(handler)
    try:
        result = await provider.validate_keep_text(snapshot)
    finally:
        await provider.close()
    assert result["checks"] == []


def test_provider_rejects_missing_key():
    with pytest.raises(ValueError, match="ARK_API_KEY"):
        Provider("https://provider.test", "")
