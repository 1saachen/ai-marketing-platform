import json

import httpx
import pytest
from ai_runtime.seedance import ProviderError, SeedanceTransport

from fission_clone_generation.plan import validate_plan
from fission_clone_generation.provider import (
    RenderCheckpoint,
    compile_request,
    render_shot,
)


@pytest.mark.parametrize(
    "field", ["frames", "shot", "source", "mime", "product", "image"]
)
def test_contract_rejects_changed_plan(plan, field):
    if field == "frames":
        plan["timeline"]["shots"][1]["startFrame"] += 1
    elif field == "shot":
        plan["shots"][0]["renderSeconds"] = 5
    elif field == "source":
        del plan["sources"]["mapping"]["revision"]
    elif field == "mime":
        plan["images"][0]["mimeType"] = "video/mp4"
    elif field == "product":
        plan["shots"][1]["targets"][0]["imageFileObjectId"] = None
    else:
        plan["images"][0]["width"] = 5500
    with pytest.raises(ValueError):
        validate_plan(plan)


def fixture_images(plan):
    return {plan["images"][0]["fileObjectId"]: b"local-fixture-image"}


def test_request_binds_only_frozen_references_and_silent_output(plan):
    shot = plan["shots"][0]
    images = fixture_images(plan)
    result = compile_request(plan, shot["shotId"], "test-model", images)
    assert set(result) == {
        "model",
        "content",
        "ratio",
        "resolution",
        "duration",
        "generate_audio",
    }
    assert result["duration"] == 4
    assert result["ratio"] == "9:16" and result["resolution"] == "720p"
    assert result["generate_audio"] is False
    assert [item["type"] for item in result["content"]] == ["text", "image_url"]
    assert result["content"][1]["role"] == "reference_image"
    assert '"参考素材": "图片1"' in result["content"][0]["text"]
    assert "前 1.500 秒" in result["content"][0]["text"]
    assert plan["productFacts"] in result["content"][0]["text"]
    images[plan["images"][0]["fileObjectId"]] = b"wrong-reference-img"
    with pytest.raises(ValueError, match="identity"):
        compile_request(plan, shot["shotId"], "test-model", images)


@pytest.mark.parametrize("scope", [None, "SHOT"])
def test_planned_scene_controls_background_without_replacing_product_reference(plan, scope):
    shot = plan["shots"][0]
    variation = {"dimension": "背景色调", "direction": "主体周围为纯蓝色背景"}
    if scope:
        variation["scope"] = scope
    scene_target = {
        "elementId": "scene_a",
        "type": "scene",
        "imageFileObjectId": None,
        "description": "简洁摄影台",
        "style": "棚拍",
        "lockedAttributes": ["光线方向"],
        "allowedVariations": ["背景色调"],
        "variation": variation,
    }
    shot["targets"].append(scene_target)
    next_shot = plan["shots"][1]
    next_shot["targets"].append({
        **scene_target,
        "variation": {**variation, "direction": "主体后方为橙色圆形墙饰"},
    })
    result = compile_request(plan, shot["shotId"], "test-model", fixture_images(plan))
    instructions, facts = result["content"][0]["text"].split("\n", 1)
    assert "商品参考图只用于商品本体" in instructions
    assert "背景和台面以本版本安排为准" in instructions
    if scope:
        assert "当前镜头在整片中的区间" not in instructions
    else:
        assert "当前镜头在整片中的区间为 0.000–1.500 秒" in instructions
    assert "橙色圆形墙饰" not in facts
    next_result = compile_request(plan, next_shot["shotId"], "test-model", fixture_images(plan))
    assert "橙色圆形墙饰" in next_result["content"][0]["text"]
    assert "纯蓝色背景" not in next_result["content"][0]["text"]
    product, scene = json.loads(facts)["目标元素"]
    assert product["参考素材"] == "图片1"
    assert scene["本版本场景安排"] == variation
    assert scene["保持"] == ["光线方向"]
    assert "可调整" not in scene
    assert len(result["content"]) == 2


@pytest.mark.parametrize("recovering", [False, True])
async def test_create_intent_before_post_and_resume_only_existing_id(plan, recovering):
    events = []
    task_id = "cgt-local-test"

    async def save(checkpoint):
        events.append(checkpoint)

    def respond(request):
        events.append(request.method + " " + request.url.path)
        if request.method == "POST":
            assert events[0] == RenderCheckpoint("CREATE_PENDING")
            body = json.loads(request.content)
            assert body["generate_audio"] is False
            assert "omni_reference_task_type" not in body
            assert body["content"][1]["role"] == "reference_image"
            return httpx.Response(200, json={"id": task_id})
        if request.url.host == "media.invalid":
            assert "authorization" not in request.headers
            return httpx.Response(
                200, content=b"video bytes", headers={"content-type": "video/mp4"}
            )
        if not recovering:
            assert events[2] == RenderCheckpoint("CREATED", task_id)
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "content": {"video_url": "https://media.invalid/result.mp4"},
            },
        )

    transport = SeedanceTransport(
        base_url="https://provider.invalid/api/v3",
        api_key="local-fixture",
        timeout_seconds=10,
        poll_interval_seconds=1,
        create_qps=1,
        download_concurrency=1,
        max_download_bytes=1024,
        transport=httpx.MockTransport(respond),
    )
    try:
        state = (
            RenderCheckpoint("CREATED", task_id)
            if recovering
            else RenderCheckpoint("NOT_STARTED")
        )
        result = await render_shot(
            transport,
            plan,
            plan["shots"][0]["shotId"],
            "test-model",
            fixture_images(plan),
            state,
            save,
        )
        assert result.content == b"video bytes"
        posts = [
            event
            for event in events
            if isinstance(event, str) and event.startswith("POST")
        ]
        assert len(posts) == (0 if recovering else 1)
    finally:
        await transport.aclose()


async def test_lost_create_response_blocks_second_post(plan):
    count = 0
    state = RenderCheckpoint("NOT_STARTED")

    async def save(checkpoint):
        nonlocal state
        state = checkpoint

    def lost_response(request):
        nonlocal count
        count += 1
        raise httpx.ReadTimeout("synthetic lost response", request=request)

    transport = SeedanceTransport(
        base_url="https://provider.invalid/api/v3",
        api_key="local-fixture",
        timeout_seconds=10,
        poll_interval_seconds=1,
        create_qps=1,
        download_concurrency=1,
        max_download_bytes=1024,
        transport=httpx.MockTransport(lost_response),
    )
    try:
        for _ in range(2):
            with pytest.raises(ProviderError) as error:
                await render_shot(
                    transport,
                    plan,
                    plan["shots"][0]["shotId"],
                    "test-model",
                    fixture_images(plan),
                    state,
                    save,
                )
            assert error.value.code == "SEEDANCE_CREATE_RESULT_UNKNOWN"
            assert error.value.retryable is False
        assert count == 1
    finally:
        await transport.aclose()
