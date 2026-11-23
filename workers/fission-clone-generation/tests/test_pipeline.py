import base64
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from ai_runtime.seedance import ProviderError

from fission_clone_generation.api import Api
from fission_clone_generation.pipeline import execute_generation, process_generation
from fission_clone_generation.plan import validate_plan
from fission_clone_generation.planning import BatchPlanner, planning_input
from fission_clone_generation.provider import RenderCheckpoint
from fission_clone_generation.review import Reviewer, frame_numbers, review_passed


class CompletedMediaApi:
    def __init__(self, plan, review):
        self.plan = plan
        self.review = review
        self.project = plan["projectId"]
        self.token = ""
        self.calls = []

    async def call(self, method, route, body=None):
        self.calls.append((method, route, body))
        if route == "claim":
            return {
                "claimed": True,
                "attemptToken": self.project,
                "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
                "snapshot": {
                    "plan": self.plan,
                    "model": "fixture",
                    "reviewModel": "fixture",
                },
                "checkpoints": {"REVIEW_V1": self.review},
            }
        return {"accepted": True}

    async def download(self, *_params, **_options):
        raise AssertionError(
            "a persisted review must not re-download or re-render media"
        )


class NoReview:
    async def evaluate(self, *_args):
        raise AssertionError("a persisted review must not call the model again")


async def never_render(*_args):
    raise AssertionError("a persisted review must not re-render a shot")


async def test_review_resume_only_completes_after_all_shots_pass(plan):
    for verdict, terminal in [
        ("PASSED", "complete"),
        ("WARNING", "fail"),
        ("FAILED", "fail"),
    ]:
        review = {
            "checks": [
                {
                    "shotId": shot,
                    "verdict": verdict,
                    "reason": "isolated model fixture",
                    "evidenceFrames": frames,
                }
                for shot, frames in frame_numbers(plan).items()
            ]
        }
        api = CompletedMediaApi(plan, review)
        await process_generation(api, never_render, NoReview(), "ffmpeg", "ffprobe")
        assert [route for _, route, _ in api.calls] == ["claim", terminal]
        if terminal == "fail":
            assert api.calls[-1][2]["code"] == "QUALITY_BLOCKED"
            assert api.calls[-1][2]["retryable"] is False


@pytest.mark.parametrize("with_motion", [False, True])
async def test_media_review_has_output_budget_beyond_reasoning_and_preserves_quality_gate(
    plan, shot_motion, with_motion
):
    if with_motion:
        plan.update(renderInstructionVersion=2, productName="", productFacts=" ")
        shot_motion["events"] = [
            {
                **shot_motion["events"][0],
                "startMs": start,
                "endMs": end,
                "evidenceFramesMs": times,
            }
            for start, end, times in (
                (0, 300, [100, 200]),
                (300, 600, [400]),
                (600, 1000, [630, 960]),
                (1000, 1500, [1190, 1230]),
            )
        ]
        plan["shots"][1]["motion"] = shot_motion
        validate_plan(plan)
    expected_evidence = {
        "shot_a": [0, 17, 35],
        "shot_b": [36, 38, 46, 51, 53, 65, 71] if with_motion else [36, 53, 71],
    }
    assert frame_numbers(plan) == expected_evidence
    review = {
        "checks": [
            {
                "shotId": shot,
                "verdict": "WARNING",
                "reason": "画面未提供足够的场景证据",
                "evidenceFrames": frames[-5:],
            }
            for shot, frames in expected_evidence.items()
        ]
    }

    def fake_responses(request):
        payload = json.loads(request.content)
        assert payload["max_output_tokens"] == 8192
        assert payload["text"]["format"]["name"] == "clone_generation_review"
        content = payload["input"][1]["content"]
        instructions = payload["input"][0]["content"]
        brief = json.loads(content[0]["text"])
        assert "motion" not in brief["shots"][0]
        if with_motion:
            assert "product" not in brief and "facts" not in brief
            assert brief["shots"][1]["motion"] == shot_motion
            assert "按相对首帧的毫秒核对 openingState、closingState 与 events" in instructions
            assert "若成片抽样未覆盖已观察的关键接触、动作或姿态，返回 WARNING" in instructions
        else:
            assert "motion" not in brief["shots"][1]
            assert "openingState" not in instructions
        panels = [
            index for index, item in enumerate(content)
            if item.get("type") == "input_text" and item["text"].startswith("同镜头时序对照")
        ]
        groups = [("shot_a", [0, 17, 35])]
        if with_motion:
            groups.extend([("shot_b", [36, 38, 46]), ("shot_b", [51, 53, 65]), ("shot_b", [71])])
        else:
            groups.append(("shot_b", [36, 53, 71]))
        for index, (shot_id, frames) in zip(panels, groups, strict=True):
            assert shot_id in content[index]["text"] and str(frames) in content[index]["text"]
            assert content[index + 1]["type"] == "input_image"
            encoded = content[index + 1]["image_url"].split(",", 1)[1]
            assert json.loads(base64.b64decode(encoded)) == frames
        details = [
            item["text"] for item in content
            if (item.get("text") or "").startswith("成片镜头")
        ]
        first_details = [f"成片镜头 shot_a，输出帧 {frame}" for frame in (0, 17, 35)]
        second_details = [f"成片镜头 shot_b，输出帧 {frame}" for frame in (36, 53, 71)]
        if with_motion:
            assert "距该镜头首帧约 [0, 83, 417] 毫秒" in content[panels[1]]["text"]
            assert "距该镜头首帧约 [625, 708, 1208] 毫秒" in content[panels[2]]["text"]
            assert "距该镜头首帧约 [1458] 毫秒" in content[panels[3]]["text"]
            second_details = [
                caption + f"，距该镜头首帧约 {time} 毫秒"
                for caption, time in zip(second_details, (0, 708, 1458), strict=True)
            ]
        assert details == first_details + second_details
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(review),
                "usage": {
                    "input_tokens": 10525,
                    "output_tokens": 4352,
                    "output_tokens_details": {"reasoning_tokens": 4096},
                    "total_tokens": 14877,
                },
            },
        )

    reviewer = Reviewer("https://provider.test/api/v3", "offline", "ffmpeg")
    await reviewer.close()
    reviewer._client = httpx.AsyncClient(
        base_url="https://provider.test/api/v3/",
        transport=httpx.MockTransport(fake_responses),
    )
    reviewer._jpeg = AsyncMock(return_value=b"test-image")
    reviewer._comparison_jpeg = AsyncMock(
        side_effect=lambda _path, frames: json.dumps(frames).encode()
    )
    try:
        images = {image["fileObjectId"]: Path("reference.png") for image in plan["images"]}
        result = await reviewer.evaluate(plan, "fixture", Path("candidate.mp4"), images)
        assert result == review
        assert not review_passed(plan, result)
    finally:
        await reviewer.close()


def test_motion_evidence_near_a_one_frame_shot_end_does_not_cross_the_cut(
    plan, shot_motion
):
    plan["renderInstructionVersion"] = 2
    shot = plan["timeline"]["shots"][1]
    duration_ms, end_frame = shot["startMs"] + 42, shot["startFrame"] + 1
    shot.update(endMs=duration_ms, endFrame=end_frame)
    plan["timeline"]["stages"][1].update(endMs=duration_ms, endFrame=end_frame)
    plan["timeline"].update(
        durationMs=duration_ms, frameCount=end_frame, conversionRanges=[]
    )
    shot_motion["events"] = [
        {**shot_motion["events"][0], "startMs": 20, "endMs": 42, "evidenceFramesMs": [40]}
    ]
    plan["shots"][1]["motion"] = shot_motion
    validate_plan(plan)
    assert frame_numbers(plan) == {"shot_a": [0, 17, 35], "shot_b": [36]}


@pytest.mark.parametrize("per_shot", [False, True])
async def test_batch_planning_uses_separate_review_and_resumes_saved_steps(plan, per_shot):
    ids = [str(uuid4()) for _ in range(3)]
    variants = [
        {"variantId": key, "elementId": "scene", "dimension": "背景色调"}
        for key in ids
    ]
    shot_ids = [shot["shotId"] for shot in plan["shots"]]
    if per_shot:
        draft = {"version": 2, "variants": [
            {**variant, "shotDirections": [
                {"shotId": shot_id, "direction": f"布景 {index} {shot_id}"} for shot_id in shot_ids
            ]} for index, variant in enumerate(variants)
        ]}
    else:
        draft = {"variants": [
            {**variant, "direction": f"布景 {index}"} for index, variant in enumerate(variants)
        ]}
    draft_name = "clone_variant_shot_draft" if per_shot else "clone_variant_draft"
    review = {"checks": [
        {"variantId": key, "verdict": "PASSED", "reason": "隔离差异审查"} for key in ids
    ]}
    requests = []

    def fake_responses(request):
        payload = json.loads(request.content)
        name = payload["text"]["format"]["name"]
        requests.append(name)
        constraints = payload["input"][0]["content"]
        brief = json.loads(payload["input"][1]["content"])
        assert brief["variantIds"] == ids
        if name == "clone_variant_review":
            assert brief["draft"] == draft
            assert "分镜切换或景别变化的条目判 FAILED" in constraints
        elif per_shot:
            assert "shotDirections 按给定顺序" in constraints
            assert "stages" not in brief
            assert all("renderSeconds" not in shot for shot in brief["shots"])
            assert payload["text"]["format"]["schema"]["properties"]["version"]["const"] == 2
        else:
            assert "只描述一个静态布景安排" in constraints
        return httpx.Response(
            200, json={"output_text": json.dumps(draft if name == draft_name else review)}
        )

    class PlanningApi(CompletedMediaApi):
        async def call(self, method, route, body=None):
            reply = await super().call(method, route, body)
            if route == "claim":
                reply["snapshot"] = None
                reply["planning"] = self.planning
            return reply

    planner = BatchPlanner("https://provider.test/api/v3", "offline")
    await planner.close()
    planner._client = httpx.AsyncClient(
        base_url="https://provider.test/api/v3/", transport=httpx.MockTransport(fake_responses)
    )
    try:
        api = PlanningApi(plan, {})
        api.planning = {
            "plan": plan, "model": "fixture", "variantIds": ids, "draft": None, "review": None
        }
        if per_shot:
            api.planning["version"] = 2
        await process_generation(api, never_render, NoReview(), "ffmpeg", "ffprobe", planner)
        assert requests == [draft_name, "clone_variant_review"]
        assert [route for _, route, _ in api.calls if route != "progress"] == [
            "claim", "planning/draft", "planning/review", "planning/complete"
        ]
        api.calls.clear()
        requests.clear()
        api.planning.update(draft=draft, review=review)
        await process_generation(api, never_render, NoReview(), "ffmpeg", "ffprobe", planner)
        assert requests == []
        assert [route for _, route, _ in api.calls] == ["claim", "planning/complete"]
    finally:
        await planner.close()


@pytest.mark.parametrize("checkpoint", ["new", "created", "rendered", "final"])
async def test_edit_pipeline_locks_single_checkpoint_and_reuses_media(
    source_edit_plan, monkeypatch, checkpoint
):
    plan = source_edit_plan
    events = []
    source_url = "https://media.invalid/original.mp4?signature=test"
    source_identity = plan["sourceVideo"]
    raw_provider = {"fileObjectId": "edited", "sizeBytes": 6, "sha256": "edited-hash"}
    final_identity = {"fileObjectId": "final", "sizeBytes": 5, "sha256": "final-hash"}
    original_bytes = b"frozen original"
    edited_bytes = b"full edit returned by provider"
    output_bytes = b"original stills and edited spans"

    class EditApi:
        project = plan["projectId"]

        async def call(self, method, route, body=None):
            events.append((method, route, body))

        async def source_video_url(self):
            events.append("signed")
            return source_url

        async def download(self, file_id, path, **options):
            if file_id == source_identity["fileObjectId"]:
                assert options["expected_sha256"] == source_identity["sha256"]
                assert options["expected_size"] == source_identity["sizeBytes"]
                path.write_bytes(original_bytes)
            elif file_id == "edited":
                path.write_bytes(edited_bytes)
            elif file_id == "final":
                path.write_bytes(output_bytes)
            else:
                assert file_id == plan["images"][0]["fileObjectId"]
                path.write_bytes(b"image")

        async def upload(self, slot, path):
            assert path.read_bytes() == {"0": edited_bytes, "final": output_bytes}[slot]
            events.append(("upload", slot))

    async def normalize(edit_plan, source, target, **options):
        assert edit_plan is plan and source.read_bytes() == original_bytes
        target.write_bytes(b"aligned source")

    async def compose(edit_plan, source, edited, target, **options):
        assert edit_plan is plan and source.read_bytes() == b"aligned source"
        assert edited.read_bytes() == edited_bytes
        target.write_bytes(output_bytes)

    async def edit(edit_plan, url, model, images, saved, save):
        assert edit_plan is plan and model == "fixture"
        events.append("render")
        if checkpoint == "new":
            assert url == source_url and images == {plan["images"][0]["fileObjectId"]: b"image"}
            assert saved == RenderCheckpoint("NOT_STARTED")
            assert events[-2] == "signed"
            await save(RenderCheckpoint("CREATE_PENDING"))
            await save(RenderCheckpoint("CREATED", "cgt-fixture"))
        else:
            assert checkpoint == "created"
            assert saved == RenderCheckpoint("CREATED", "cgt-fixture")
            assert url is None and images == {}
        return SimpleNamespace(content=edited_bytes)

    async def review(review_plan, model, final, images, *, original):
        assert review_plan is plan and model == "fixture-review"
        assert original.read_bytes() == b"aligned source"
        assert final.read_bytes() == output_bytes
        assert list(images) == [plan["images"][0]["fileObjectId"]]
        return {
            "checks": [
                {
                    "shotId": shot,
                    "verdict": "PASSED",
                    "reason": "画面证据核对完成",
                    "evidenceFrames": frames,
                }
                for shot, frames in frame_numbers(plan).items()
            ]
        }

    monkeypatch.setattr("fission_clone_generation.pipeline.normalize_original", normalize)
    monkeypatch.setattr("fission_clone_generation.pipeline.compose_source_edit", compose)
    steps = {
        "new": {},
        "created": {"RENDER:0": {"providerTaskId": "cgt-fixture", "state": "CREATED"}},
        "rendered": {"FILE:0": raw_provider},
        "final": {"FILE:final": final_identity},
    }[checkpoint]
    await execute_generation(
        EditApi(),
        {
            "snapshot": {"plan": plan, "model": "fixture", "reviewModel": "fixture-review"},
            "checkpoints": steps,
        },
        never_render,
        SimpleNamespace(evaluate=review),
        "ffmpeg",
        "ffprobe",
        render_source=edit,
    )
    assert ("signed" in events) is (checkpoint == "new")
    assert ("render" in events) is (checkpoint in {"new", "created"})
    assert [event[1] for event in events if isinstance(event, tuple) and event[0] == "upload"] == {
        "new": ["0", "final"], "created": ["0", "final"], "rendered": ["final"], "final": [],
    }[checkpoint]
    assert events[-1] == ("POST", "complete", None)


@pytest.mark.parametrize("resume", ["new", "reference-saved", "created", "rendered"])
async def test_shot_reference_pipeline_uses_each_frozen_clip_once(
    shot_reference_plan, monkeypatch, resume,
):
    plan = shot_reference_plan
    events = []
    originals = plan["sourceVideo"]
    source_image = plan["images"][0]["fileObjectId"]
    steps = {
        "new": {},
        "reference-saved": {
            "FILE:reference-0": {"fileObjectId": "reference-file", "sizeBytes": 5, "sha256": "sha"},
        },
        "created": {"RENDER:0": {"state": "CREATED", "providerTaskId": "cgt-fixture"}},
        "rendered": {"FILE:0": {"fileObjectId": "rendered-a", "sizeBytes": 5, "sha256": "sha"}},
    }[resume]

    class ShotApi:
        project = plan["projectId"]

        async def call(self, method, route, body=None):
            events.append((method, route, body))

        async def shot_reference_video_url(self, slot):
            events.append(("sign", slot))
            return f"https://media.invalid/reference-{slot}.mp4"

        async def download(self, file_id, path, **options):
            if file_id == originals["fileObjectId"]:
                assert options["expected_sha256"] == originals["sha256"]
                assert options["expected_size"] == originals["sizeBytes"]
                events.append("original")
                path.write_bytes(b"frozen original")
            else:
                path.write_bytes({source_image: b"image", "rendered-a": b"shot_a"}[file_id])

        async def upload(self, slot, path):
            content = {
                "reference-0": b"source-0", "reference-1": b"source-1",
                "0": b"shot_a", "1": b"shot_b", "final": b"stitched",
            }
            assert path.read_bytes() == content[slot]
            events.append(("upload", slot))

    async def normalize(frozen_plan, source, target, **options):
        assert frozen_plan is plan and source.read_bytes() == b"frozen original"
        target.write_bytes(b"aligned original")

    async def extract(frozen_plan, index, source, target, **options):
        assert frozen_plan is plan and source.read_bytes() == b"aligned original"
        events.append(("extract", index))
        target.write_bytes(f"source-{index}".encode())

    async def compose(frozen_plan, clips, output, **options):
        assert frozen_plan is plan
        assert {key: path.read_bytes() for key, path in clips.items()} == {
            "shot_a": b"shot_a", "shot_b": b"shot_b",
        }
        output.write_bytes(b"stitched")

    async def render(frozen_plan, shot_id, model, images, saved, save, *, reference_url):
        assert model == "fixture" and frozen_plan is plan
        if shot_id == "shot_a" and resume == "created":
            assert saved == RenderCheckpoint("CREATED", "cgt-fixture")
            assert reference_url is None and images == {}
        else:
            slot = "0" if shot_id == "shot_a" else "1"
            assert saved == RenderCheckpoint("NOT_STARTED")
            assert reference_url == f"https://media.invalid/reference-{slot}.mp4"
            assert events[-1] == ("sign", slot)
            assert images == ({source_image: b"image"} if slot == "1" else {})
            await save(RenderCheckpoint("CREATE_PENDING"))
            await save(RenderCheckpoint("CREATED", "cgt-new"))
        return SimpleNamespace(content=shot_id.encode())

    async def review(frozen_plan, model, final, images, *, original):
        assert frozen_plan is plan and model == "fixture-review"
        assert original.read_bytes() == b"aligned original"
        assert final.read_bytes() == b"stitched"
        return {
            "checks": [
                {
                    "shotId": shot,
                    "verdict": "PASSED",
                    "reason": "同时间点比对通过",
                    "evidenceFrames": frames,
                }
                for shot, frames in frame_numbers(plan).items()
            ],
        }

    monkeypatch.setattr("fission_clone_generation.pipeline.normalize_original", normalize)
    monkeypatch.setattr("fission_clone_generation.pipeline.extract_shot_reference", extract)
    monkeypatch.setattr("fission_clone_generation.pipeline.compose", compose)
    await execute_generation(
        ShotApi(),
        {
            "snapshot": {"plan": plan, "model": "fixture", "reviewModel": "fixture-review"},
            "checkpoints": steps,
        },
        render,
        SimpleNamespace(evaluate=review),
        "ffmpeg",
        "ffprobe",
    )
    assert events.count("original") == 1
    assert (("extract", 0) in events) is (resume == "new")
    assert (("upload", "reference-0") in events) is (resume == "new")
    assert (("sign", "0") in events) is (resume in {"new", "reference-saved"})
    assert ("extract", 1) in events and ("sign", "1") in events
    assert events[-1] == ("POST", "complete", None)


@pytest.mark.parametrize("mode", ["source_edit", "shot_reference"])
async def test_video_reference_review_uses_paired_original_frames(request, mode):
    plan = request.getfixturevalue(f"{mode}_plan")
    plan.update(productName="", productFacts="")
    original = Path("aligned-source.mp4")
    final = Path("final.mp4")
    evidence = frame_numbers(plan)
    review = {
        "checks": [
            {
                "shotId": shot,
                "verdict": "FAILED" if shot == "shot_b" else "PASSED",
                "reason": "替换镜头中原片手部位置明显改变",
                "evidenceFrames": frames,
            }
            for shot, frames in evidence.items()
        ]
    }

    def respond(request):
        payload = json.loads(request.content)
        system = payload["input"][0]["content"]
        if mode == "source_edit":
            assert "逐项保留其他可见人物、商品、道具和背景" in system
            assert "以同时间点对照图的原片为准" in system
            assert "正反面朝向仅依据可辨识的标记、图案或不对称轮廓核对" in system
            assert "对无可辨识标记的对称目标，核对可见的倾斜、移动和接触状态" in system
            label = "原片编辑同时间点对照"
        else:
            assert "固定镜头通过远近背景锚点核对机位稳定性" in system
            assert "用 sourceDescription 定位被替换的原片对象" in system
            assert "以已确认的场景映射和 variation 核对允许的布景变化" in system
            label = "逐镜参考同时间点对照"
        content = payload["input"][1]["content"]
        brief = json.loads(content[0]["text"])
        assert "product" not in brief and "facts" not in brief
        comparisons = [
            index for index, item in enumerate(content)
            if item.get("text", "").startswith(label)
        ]
        for index, (shot_id, frames) in zip(comparisons, evidence.items(), strict=True):
            assert shot_id in content[index]["text"]
            for item, media in zip(content[index+1:index+3], (original, final), strict=True):
                encoded = item["image_url"].split(",", 1)[1]
                assert json.loads(base64.b64decode(encoded)) == [str(media), frames]
        return httpx.Response(200, json={
            "status": "completed",
            "output_text": json.dumps(review),
            "usage": {"input_tokens": 200, "output_tokens": 100, "total_tokens": 300},
        })

    reviewer = Reviewer("https://provider.test/api/v3", "offline", "ffmpeg")
    await reviewer.close()
    reviewer._client = httpx.AsyncClient(
        base_url="https://provider.test/api/v3",
        transport=httpx.MockTransport(respond),
    )
    reviewer._jpeg = AsyncMock(return_value=b"detail-image")
    reviewer._comparison_jpeg = AsyncMock(
        side_effect=lambda path, frames: json.dumps([str(path), frames]).encode()
    )
    try:
        images = {plan["images"][0]["fileObjectId"]: Path("target.png")}
        result = await reviewer.evaluate(plan, "fixture", final, images, original=original)
        assert result == review
        assert not review_passed(plan, result)
        with pytest.raises(ValueError, match="aligned original"):
            await reviewer.evaluate(plan, "fixture", final, images)
    finally:
        await reviewer.close()


@pytest.mark.parametrize("plan_fixture", ["plan", "source_edit_plan"])
def test_batch_planning_omits_blank_product_fields(request, plan_fixture):
    plan = request.getfixturevalue(plan_fixture)
    plan.update(renderInstructionVersion=2, productName=" ", productFacts="")
    brief = planning_input({"plan": plan, "variantIds": [str(uuid4())], "version": 2})
    assert "product" not in brief and "facts" not in brief
    assert brief["shots"][1]["targets"] == plan["shots"][1]["targets"]


@pytest.mark.parametrize("slot", [None, "2"])
async def test_signed_video_url_uses_worker_and_attempt_scope(source_edit_plan, slot):
    project = source_edit_plan["projectId"]
    task_id = str(uuid4())
    attempt_token = str(uuid4())
    signed_url = "https://media.invalid/source.mp4?signature=offline"

    def respond(request):
        assert request.method == "GET"
        route = "source-video-url" if slot is None else f"shot-reference/{slot}/url"
        assert request.url.path.endswith(f"/tasks/{task_id}/{route}")
        assert dict(request.url.params) == {"projectId": project}
        assert request.headers["x-worker-token"] == "offline"
        assert request.headers["x-attempt-token"] == attempt_token
        assert request.content == b""
        return httpx.Response(200, json={"success": True, "data": {"url": signed_url}})

    api = Api("https://internal.invalid/api", "offline", project, task_id)
    base_url = api.client.base_url
    await api.close()
    api.client = httpx.AsyncClient(
        base_url=base_url,
        headers={"x-worker-token": "offline"},
        transport=httpx.MockTransport(respond),
    )
    try:
        async def sign():
            if slot is None:
                return await api.source_video_url()
            return await api.shot_reference_video_url(slot)

        with pytest.raises(ValueError, match="active attempt"):
            await sign()
        api.token = attempt_token
        assert await sign() == signed_url
    finally:
        await api.close()


@pytest.mark.parametrize(("plan_fixture", "slot"), [("source_edit_plan", 0), ("plan", 1)])
async def test_rejected_render_create_stops_before_loading_any_media(
    request, plan_fixture, slot,
):
    plan = request.getfixturevalue(plan_fixture)
    api = CompletedMediaApi(plan, {})
    with pytest.raises(ProviderError) as error:
        await execute_generation(
            api,
            {
                "snapshot": {
                    "plan": plan, "model": "fixture", "reviewModel": "fixture",
                },
                "checkpoints": {f"RENDER:{slot}": {"state": "CREATE_REJECTED"}},
            },
            never_render,
            NoReview(),
            "ffmpeg",
            "ffprobe",
            render_source=never_render,
        )
    assert error.value.code == "SEEDANCE_CREATE_REJECTED"
    assert error.value.retryable is False
    assert api.calls == []
