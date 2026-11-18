import json
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest

from fission_clone_generation.pipeline import process_generation
from fission_clone_generation.planning import BatchPlanner
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


async def test_media_review_has_output_budget_beyond_reasoning_and_preserves_quality_gate(plan):
    review = {
        "checks": [
            {
                "shotId": shot,
                "verdict": "WARNING",
                "reason": "画面未提供足够的场景证据",
                "evidenceFrames": frames,
            }
            for shot, frames in frame_numbers(plan).items()
        ]
    }

    def fake_responses(request):
        payload = json.loads(request.content)
        assert payload["max_output_tokens"] == 8192
        assert payload["text"]["format"]["name"] == "clone_generation_review"
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
    try:
        images = {image["fileObjectId"]: Path("reference.png") for image in plan["images"]}
        result = await reviewer.evaluate(plan, "fixture", Path("candidate.mp4"), images)
        assert result == review
        assert not review_passed(plan, result)
    finally:
        await reviewer.close()


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
