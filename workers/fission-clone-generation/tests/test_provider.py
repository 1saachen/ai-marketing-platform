import hashlib
import json

import httpx
import pytest
from ai_runtime.seedance import ProviderError, SeedanceTransport

from fission_clone_generation.plan import validate_plan
from fission_clone_generation.provider import (
    RenderCheckpoint,
    compile_request,
    compile_source_edit_request,
    render_shot,
    render_source_edit,
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


@pytest.mark.parametrize(
    "change", ["outside", "overlap", "duplicate", "late", "empty", "blank", "status", "reason", "legacy"]
)
def test_contract_rejects_invalid_relative_motion(plan, shot_motion, change):
    plan["renderInstructionVersion"] = 2
    plan["shots"][1]["motion"] = shot_motion
    # The second shot starts at 1500 ms in the source, but starts at zero in this plan.
    validate_plan(plan)
    first_event = shot_motion["events"][0]
    if change == "outside":
        first_event["evidenceFramesMs"] = [199, 820]
    elif change == "overlap":
        first_event["endMs"] = 841
    elif change == "duplicate":
        first_event["evidenceFramesMs"] = [230, 230]
    elif change == "late":
        shot_motion["events"][1].update(endMs=1500, evidenceFramesMs=[1500])
    elif change == "empty":
        shot_motion["events"] = []
    elif change == "blank":
        first_event.update(subjectAction=" ", cameraAction="", contact="", productPose="")
    elif change == "status":
        shot_motion.update(status="NO_VISIBLE_MOTION", reason="静态证据")
    elif change == "reason":
        shot_motion.update(status="INSUFFICIENT_EVIDENCE", events=[], reason=" ")
    else:
        del plan["renderInstructionVersion"]
    with pytest.raises(ValueError, match="motion"):
        validate_plan(plan)


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
    assert "请在该区间内完成画面动作" in result["content"][0]["text"]
    assert '"阶段作用"' in result["content"][0]["text"]
    assert plan["productFacts"] in result["content"][0]["text"]
    images[plan["images"][0]["fileObjectId"]] = b"wrong-reference-img"
    with pytest.raises(ValueError, match="identity"):
        compile_request(plan, shot["shotId"], "test-model", images)


@pytest.mark.parametrize("status", ["OBSERVED", "NO_VISIBLE_MOTION", "INSUFFICIENT_EVIDENCE"])
def test_request_uses_only_the_current_shots_motion(plan, shot_motion, status):
    shot_a, shot_b = plan["shots"]
    plan["renderInstructionVersion"] = 2
    if status != "OBSERVED":
        shot_motion.update(status=status, events=[], reason="动作证据需要如实说明")
    shot_b["motion"] = shot_motion
    payload = compile_request(plan, shot_b["shotId"], "fixture", fixture_images(plan))
    instructions, encoded_facts = payload["content"][0]["text"].split("\n", 1)
    assert json.loads(encoded_facts)["原片镜头内动作"] == shot_motion
    assert "startMs 和 endMs 从本镜头首帧起算，单位为毫秒" in instructions
    assert "依 events 的先后和区间分别复现主体动作、运镜、接触或遮挡及商品姿态" in instructions
    assert "呈现 closingState" in instructions
    assert "不从证据缺口推断静止或新增动作" in instructions
    assert "商品身份与可见包装始终以绑定目标图和锁定特征为准" in instructions
    assert len(payload["content"]) == 2
    text = compile_request(plan, shot_a["shotId"], "fixture", fixture_images(plan))["content"][0]["text"]
    assert "原片镜头内动作" not in text and "openingState" not in text


@pytest.mark.parametrize(
    ("name", "facts", "expected"),
    [
        ("", " ", {}),
        ("白盖小瓶", "", {"商品": "白盖小瓶"}),
        ("", "青绿色瓶身", {"已确认商品事实": "青绿色瓶身"}),
    ],
)
def test_shot_request_preserves_motion_and_reference_with_optional_product_text(
    plan, shot_motion, name, facts, expected,
):
    plan.update(renderInstructionVersion=2, productName=name, productFacts=facts)
    shot = plan["shots"][1]
    shot["motion"] = shot_motion
    payload = compile_request(plan, shot["shotId"], "fixture", fixture_images(plan))
    instructions, encoded = payload["content"][0]["text"].split("\n", 1)
    brief = json.loads(encoded)
    assert {key: brief[key] for key in ("商品", "已确认商品事实") if key in brief} == expected
    assert brief["原片当前镜头观察"] == {
        "景别": shot["framing"],
        "运镜": shot["cameraMovement"],
        "构图": shot["composition"],
    }
    assert brief["原片镜头内动作"] == shot_motion
    assert brief["目标元素"][0]["参考素材"] == "图片1"
    assert payload["content"][1]["role"] == "reference_image"
    assert "从首帧起取用 1.500 秒" in instructions


@pytest.mark.parametrize(
    ("camera_movement", "composition"),
    [
        ("固定机位，无运镜", "商品静置于台面"),
        ("固定机位", "手从右侧进入画面，将纸盒转至侧面"),
        ("在当前镜头内向右缓慢横移", "商品静置，相机横移时露出右侧台面"),
    ],
)
def test_new_instruction_separates_cut_from_motion_and_binds_package(
    plan, camera_movement, composition
):
    other_shot, shot = plan["shots"]
    other_shot["composition"] = "只属于另一镜头的水杯"
    timeline = plan["timeline"]["shots"][1]
    stage = next(
        stage for stage in plan["timeline"]["stages"] if stage["stageId"] == timeline["stageId"]
    )
    stage["role"] = "切换背景并放大强调"
    shot.update(
        framing="相较前镜头更近的特写",
        cameraMovement=camera_movement,
        composition=composition,
    )
    plan["renderInstructionVersion"] = 2
    payload = compile_request(plan, shot["shotId"], "test-model", fixture_images(plan))
    instructions, serialized_facts = payload["content"][0]["text"].split("\n", 1)
    facts = json.loads(serialized_facts)
    assert "阶段作用" not in facts
    assert stage["role"] not in serialized_facts
    assert other_shot["composition"] not in serialized_facts
    assert facts["原片当前镜头观察"] == {
        "景别": shot["framing"],
        "运镜": camera_movement,
        "构图": composition,
    }
    assert "首帧直接呈现本镜头起始景别" in instructions
    assert "镜头之间的变化由平台剪辑" in instructions
    assert "保留明确属于当前镜头的相机运动、主体动作和环境变化" in instructions
    assert "没有运镜要求时保持相机位置、朝向和焦距，仍保留当前镜头已有的主体动作" in instructions
    assert "未说明的动作不添加" in instructions
    assert "明确要求的动作应在取用区间内可见" in instructions
    assert "完成画面动作" not in instructions
    assert "包装结构、色块布局、材质纹理和已有标记" in instructions
    assert "同一包装细节再次可见时保持原样" in instructions
    product = facts["目标元素"][0]
    assert product["保持"] == shot["targets"][0]["lockedAttributes"]
    assert product["参考素材"] == "图片1"
    assert payload["content"][1]["role"] == "reference_image"
    assert payload["duration"] == shot["renderSeconds"] and not payload["generate_audio"]


@pytest.mark.parametrize(("scope", "version"), [(None, None), ("SHOT", None), ("SHOT", 2)])
def test_planned_scene_controls_background_without_replacing_product_reference(plan, scope, version):
    if version is not None:
        plan["renderInstructionVersion"] = version
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
    if version:
        assert "本版本安排只覆盖选定的场景变化维度" in instructions
    else:
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


@pytest.mark.parametrize("mode", ["silent", "shot_reference"])
@pytest.mark.parametrize("recovering", [False, True])
async def test_create_intent_before_post_and_resume_only_existing_id(request, mode, recovering):
    plan = request.getfixturevalue("shot_reference_plan" if mode == "shot_reference" else "plan")
    shot_id = plan["shots"][1]["shotId"]
    reference_url = (
        "https://media.invalid/reference-1.mp4" if mode == "shot_reference" else None
    )
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
            if reference_url is not None:
                assert body["content"][2:] == [{
                    "type": "video_url",
                    "role": "reference_video",
                    "video_url": {"url": reference_url},
                }]
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
            shot_id,
            "test-model",
            {} if recovering else fixture_images(plan),
            state,
            save,
            reference_url=reference_url if not recovering else None,
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


@pytest.mark.parametrize("problem", ["source", "whole", "length", "description", "history"])
def test_shot_reference_plan_rejects_changed_scope(shot_reference_plan, problem):
    plan = shot_reference_plan
    if problem == "source":
        del plan["sourceVideo"]
    elif problem == "whole":
        plan["sourceVideo"]["renderSeconds"] = 4
    elif problem == "length":
        plan["shots"][0]["referenceFrames"] += 1
    elif problem == "description":
        plan["shots"][1]["targets"][0]["sourceDescription"] = " "
    else:
        plan["mode"] = "SEEDANCE_2_0_SILENT_CUT"
        del plan["sourceVideo"]
    with pytest.raises(ValueError):
        validate_plan(plan)


def test_shot_reference_prompt_uses_corresponding_video_and_mapped_targets(shot_reference_plan):
    plan = shot_reference_plan
    video = "https://media.invalid/reference-1.mp4?signature=fixture"
    target = plan["shots"][1]["targets"][0]
    target_image = fixture_images(plan)
    with pytest.raises(ValueError, match="corresponding shot"):
        compile_request(plan, "shot_b", "fixture", target_image)
    moving = compile_request(plan, "shot_b", "fixture", target_image, reference_url=video)
    short = compile_request(
        plan, "shot_a", "fixture", {}, reference_url="https://media.invalid/reference-0.mp4"
    )
    prompt, brief = moving["content"][0]["text"].split("\n", 1)
    description = json.loads(brief)["目标元素"][0]
    assert description["原片对象"] == target["sourceDescription"]
    assert description["参考素材"] == "图片1"
    assert "已确认的场景安排可覆盖原有布景" in prompt
    assert "首帧" in prompt and "逐时点" in prompt and video not in prompt
    assert moving["content"][-1]["video_url"]["url"] == video
    assert [item["role"] for item in short["content"][1:]] == ["reference_video"]
    assert "视频1前 1.500 秒为实际镜头" in short["content"][0]["text"]


@pytest.mark.parametrize("mode", ["source", "shot"])
@pytest.mark.parametrize(
    ("status", "expected_code", "saved_state"),
    [
        *[
            (status, "SEEDANCE_CREATE_REJECTED", "CREATE_REJECTED")
            for status in (400, 401, 403, 404, 422, 429)
        ],
        (500, "SEEDANCE_CREATE_RESULT_UNKNOWN", "CREATE_PENDING"),
        (None, "SEEDANCE_CREATE_RESULT_UNKNOWN", "CREATE_PENDING"),
        (200, "SEEDANCE_INVALID_RESPONSE", "CREATE_PENDING"),
    ],
)
async def test_render_distinguishes_definite_create_rejection(
    request, mode, status, expected_code, saved_state,
):
    calls = []
    saved = []

    def respond(request):
        calls.append(request.method)
        if status is None:
            raise httpx.ReadTimeout("synthetic lost response", request=request)
        return httpx.Response(status, json={"error": {"code": "offline_fixture"}})

    async def persist(value):
        saved.append(value)

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
    if mode == "source":
        renderer = render_source_edit
        active_plan = request.getfixturevalue("source_edit_plan")
        reference = "https://media.invalid/source.mp4?signature=offline"
        resumed_reference = None
        resumed_images = {}
    else:
        renderer = render_shot
        active_plan = request.getfixturevalue("plan")
        active_plan["renderInstructionVersion"] = 2
        reference = resumed_reference = active_plan["shots"][1]["shotId"]
        resumed_images = fixture_images(active_plan)
    try:
        with pytest.raises(ProviderError) as original:
            await renderer(
                transport, active_plan, reference, "fixture", fixture_images(active_plan),
                RenderCheckpoint("NOT_STARTED"), persist,
            )
        assert original.value.code == expected_code
        assert original.value.retryable is False
        expected = [RenderCheckpoint("CREATE_PENDING")]
        if saved_state == "CREATE_REJECTED":
            expected.append(RenderCheckpoint("CREATE_REJECTED"))
            assert original.value.service_code is None
        assert saved == expected
        with pytest.raises(ProviderError) as resumed:
            await renderer(
                transport, active_plan, resumed_reference, "fixture", resumed_images,
                saved[-1], persist,
            )
        assert resumed.value.code == (
            "SEEDANCE_CREATE_REJECTED"
            if saved_state == "CREATE_REJECTED"
            else "SEEDANCE_CREATE_RESULT_UNKNOWN"
        )
        assert calls == ["POST"] and saved == expected
    finally:
        await transport.aclose()


@pytest.mark.parametrize("mode", ["source", "shot"])
async def test_known_provider_task_poll_error_does_not_mark_create_rejected(
    request, mode,
):
    calls = []
    checkpoints = []

    def respond(request):
        calls.append(request.method)
        if request.method == "POST":
            return httpx.Response(200, json={"id": "cgt-test-created"})
        return httpx.Response(404, json={"error": {"code": "offline_fixture"}})

    async def persist(value):
        checkpoints.append(value)

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
    if mode == "source":
        renderer = render_source_edit
        active_plan = request.getfixturevalue("source_edit_plan")
        reference = "https://media.invalid/source.mp4"
    else:
        renderer = render_shot
        active_plan = request.getfixturevalue("plan")
        reference = active_plan["shots"][1]["shotId"]
    try:
        with pytest.raises(ProviderError) as error:
            await renderer(
                transport, active_plan, reference, "fixture", fixture_images(active_plan),
                RenderCheckpoint("NOT_STARTED"), persist,
            )
        assert error.value.code == "SEEDANCE_HTTP_404"
        assert calls == ["POST", "GET"]
        assert checkpoints == [
            RenderCheckpoint("CREATE_PENDING"),
            RenderCheckpoint("CREATED", "cgt-test-created"),
        ]
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


def test_source_edit_maps_objects_to_reference_images_and_locked_intervals(source_edit_plan):
    plan = source_edit_plan
    images = fixture_images(plan)
    sample = b"independent prop image"
    file_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    plan["images"].append({
        **plan["images"][0],
        "fileObjectId": file_id,
        "sizeBytes": len(sample),
        "sha256": hashlib.sha256(sample).hexdigest(),
    })
    images[file_id] = sample
    plan["shots"][1]["targets"].append({
        "elementId": "prop_case",
        "type": "prop",
        "sourceDescription": "右上角橙色方盒",
        "imageFileObjectId": file_id,
        "description": "蓝色方盒",
        "style": "",
        "lockedAttributes": ["盒身标记"],
        "allowedVariations": [],
    })
    source_url = "https://media.invalid/original.mp4?signature=offline"
    request = compile_source_edit_request(plan, "fixture", source_url, images)
    assert request["duration"] == 4
    assert request["generate_audio"] is False and request["resolution"] == "720p"
    assert [entry.get("role") for entry in request["content"]] == [
        None, "reference_image", "reference_image", "reference_video",
    ]
    assert request["content"][-1]["video_url"] == {"url": source_url}
    instructions, brief = request["content"][0]["text"].split("\n", 1)
    assert instructions.startswith("严格编辑视频1")
    assert "手指接触" in instructions and "未指定的对象" in instructions
    assert source_url not in instructions + brief
    edits = json.loads(brief)["定向修改"]
    assert [edit["原片镜头"] for edit in edits] == ["shot_b"]
    assert edits[0]["原片起止毫秒"] == [2000, 4000]
    assert [
        (target["原片对象"], target["目标图"]) for target in edits[0]["替换"]
    ] == [("手里握着的白盖粉色小瓶", "图片1"), ("右上角橙色方盒", "图片2")]


@pytest.mark.parametrize(
    ("name", "facts", "expected"),
    [
        ("", " ", {}),
        ("白盖小瓶", "", {"商品": "白盖小瓶"}),
        ("", "青绿色瓶身", {"已确认商品事实": "青绿色瓶身"}),
    ],
)
def test_source_edit_uses_only_provided_product_metadata(source_edit_plan, name, facts, expected):
    plan = source_edit_plan
    plan.update(productName=name, productFacts=facts)
    result = compile_source_edit_request(
        plan, "fixture", "https://media.invalid/source.mp4", fixture_images(plan)
    )
    brief = json.loads(result["content"][0]["text"].split("\n", 1)[1])
    assert {key: brief[key] for key in ("商品", "已确认商品事实") if key in brief} == expected
    assert brief["定向修改"][0]["替换"][0]["目标图"] == "图片1"


@pytest.mark.parametrize("problem", ["source", "seconds", "description", "mode", "alias", "image"])
def test_source_edit_rejects_mismatched_source_and_selection(source_edit_plan, problem):
    plan = source_edit_plan
    plan.update(productName="", productFacts="")
    if problem == "source":
        del plan["sourceVideo"]
    elif problem == "seconds":
        plan["sourceVideo"]["renderSeconds"] = 5
    elif problem == "description":
        plan["shots"][1]["targets"][0]["sourceDescription"] = " "
    elif problem == "alias":
        plan["sourceVideo"]["fileObjectId"] = plan["images"][0]["fileObjectId"]
    elif problem == "image":
        plan["shots"][1]["targets"][0]["imageFileObjectId"] = None
    else:
        plan["mode"] = "SEEDANCE_2_0_SILENT_CUT"
    with pytest.raises(ValueError):
        validate_plan(plan)


@pytest.mark.parametrize("state", ["NOT_STARTED", "CREATED", "CREATE_PENDING"])
async def test_source_edit_creates_once_or_resumes_without_source_url(source_edit_plan, state):
    events = []
    task_id = "cgt-edit-test"
    source_url = "https://media.invalid/source.mp4?signature=offline"

    async def save(checkpoint):
        events.append(checkpoint)

    def respond(request):
        events.append(request.method + " " + request.url.path)
        if request.method == "POST":
            assert events[0] == RenderCheckpoint("CREATE_PENDING")
            body = json.loads(request.content)
            assert body["content"][-1]["video_url"] == {"url": source_url}
            return httpx.Response(200, json={"id": task_id})
        if request.url.host == "media.invalid":
            assert "authorization" not in request.headers
            return httpx.Response(
                200, content=b"edited output", headers={"content-type": "video/mp4"}
            )
        if state == "NOT_STARTED":
            assert events[2] == RenderCheckpoint("CREATED", task_id)
        return httpx.Response(200, json={
            "status": "succeeded",
            "content": {"video_url": "https://media.invalid/result.mp4"},
        })

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
        arguments = (
            transport,
            source_edit_plan,
            source_url if state == "NOT_STARTED" else None,
            "test-model",
            fixture_images(source_edit_plan) if state == "NOT_STARTED" else {},
            RenderCheckpoint(state, task_id if state == "CREATED" else None),
            save,
        )
        if state == "CREATE_PENDING":
            with pytest.raises(ProviderError, match="创建结果未知"):
                await render_source_edit(*arguments)
            assert events == []
            return
        result = await render_source_edit(*arguments)
        assert result.content == b"edited output"
        posts = [event for event in events if isinstance(event, str) and event.startswith("POST")]
        assert len(posts) == (1 if state == "NOT_STARTED" else 0)
    finally:
        await transport.aclose()
