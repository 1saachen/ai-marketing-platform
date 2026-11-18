from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Protocol
from uuid import UUID

from ai_runtime.http import InternalApiError
from ai_runtime.responses import ProviderError as ReviewError
from ai_runtime.seedance import ProviderError as RenderError
from ai_runtime.seedance import VideoOutput
from pydantic import ValidationError

from .api import Api
from .media import MediaError, compose
from .plan import validate_plan
from .planning import PlanningPort
from .provider import RenderCheckpoint
from .review import review_passed

Renderer = Callable[
    [
        dict[str, Any],
        str,
        str,
        dict[str, bytes],
        RenderCheckpoint,
        Callable[[RenderCheckpoint], Awaitable[None]],
    ],
    Awaitable[VideoOutput],
]


class ReviewPort(Protocol):
    async def evaluate(
        self, plan: dict[str, Any], model: str, final: Path, images: dict[str, Path]
    ) -> dict[str, Any]: ...


class QualityBlocked(RuntimeError):
    pass


async def execute_planning(
    api: Api, context: dict[str, Any], planner: PlanningPort | None
) -> None:
    if planner is None:
        raise ValueError("missing generation planner")
    plan, variants = context["plan"], context["variantIds"]
    validate_plan(plan)
    if plan["projectId"] != api.project or not 3 <= len(variants) <= 20:
        raise ValueError("invalid batch planning scope")
    draft = context["draft"]
    if draft is None:
        await api.call("PUT", "progress", {"progress": 10, "stage": "PLAN", "message": ""})
        draft = await planner.draft(context)
        await api.call("PUT", "planning/draft", draft)
    if context["review"] is None:
        await api.call("PUT", "progress", {"progress": 55, "stage": "PLAN_REVIEW", "message": ""})
        review = await planner.review(context, draft)
        if [check["variantId"] for check in review["checks"]] != variants or any(
            check["verdict"] != "PASSED" for check in review["checks"]
        ):
            raise QualityBlocked()
        await api.call("PUT", "planning/review", review)
    await api.call("POST", "planning/complete")


async def execute_generation(
    api: Api,
    claim: dict[str, Any],
    render: Renderer,
    reviewer: ReviewPort,
    ffmpeg: str,
    ffprobe: str,
) -> None:
    snapshot, steps = claim["snapshot"], claim["checkpoints"]
    plan = snapshot["plan"]
    validate_plan(plan)
    if (
        plan["projectId"] != api.project
        or not snapshot["model"].strip()
        or not snapshot["reviewModel"].strip()
    ):
        raise ValueError("generation snapshot scope or model is invalid")

    async def progress(percent: int, stage: str) -> None:
        await api.call(
            "PUT", "progress", {"progress": percent, "stage": stage, "message": ""}
        )

    async def download(
        identity: dict[str, Any], path: Path, limit: int = 128 * 1024 * 1024
    ) -> None:
        await api.download(
            identity["fileObjectId"],
            path,
            expected_size=identity["sizeBytes"],
            expected_sha256=identity["sha256"],
            limit=limit,
        )

    if "REVIEW_V1" in steps:
        if not review_passed(plan, steps["REVIEW_V1"]):
            raise QualityBlocked()
        await api.call("POST", "complete")
        return
    with TemporaryDirectory(prefix="clone-generation-") as tmp:
        root = Path(tmp)
        images: dict[str, Path] = {}
        for image in plan["images"]:
            file_id = str(UUID(image["fileObjectId"]))
            source = root / f"{file_id}.image"
            await download(image, source, 4 * 1024 * 1024)
            images[file_id] = source
        final = root / "final.mp4"
        if "FILE:final" in steps:
            await download(steps["FILE:final"], final)
        else:
            clips: dict[str, Path] = {}
            for index, shot in enumerate(plan["shots"]):
                slot = str(index)
                shot_id = shot["shotId"]
                clip = root / f"shot-{index}.mp4"
                await progress(10 + 55 * index // len(plan["shots"]), "RENDER")
                saved = steps.get(f"FILE:{slot}")
                if saved:
                    await download(saved, clip)
                else:
                    identity = steps.get(f"RENDER:{slot}", {"state": "NOT_STARTED"})
                    checkpoint = RenderCheckpoint(
                        identity["state"], identity.get("providerTaskId")
                    )

                    async def persist(
                        value: RenderCheckpoint, current: str = slot
                    ) -> None:
                        payload: dict[str, Any] = {"state": value.state}
                        if value.provider_task_id:
                            payload["providerTaskId"] = value.provider_task_id
                        await api.call("PUT", f"render/{current}", payload)

                    file_ids = {
                        target["imageFileObjectId"]
                        for target in shot["targets"]
                        if target["imageFileObjectId"]
                    }
                    contents = {
                        file_id: images[file_id].read_bytes() for file_id in file_ids
                    }
                    result = await render(
                        plan, shot_id, snapshot["model"], contents, checkpoint, persist
                    )
                    clip.write_bytes(result.content)
                    del result, contents
                    await api.upload(slot, clip)
                clips[shot_id] = clip
            await progress(70, "COMPOSE")
            await compose(plan, clips, final, ffmpeg=ffmpeg, ffprobe=ffprobe)
            await api.upload("final", final)
        await progress(86, "REVIEW")
        review = await reviewer.evaluate(plan, snapshot["reviewModel"], final, images)
        passed = review_passed(plan, review)
        await api.call("PUT", "review", review)
        if not passed:
            raise QualityBlocked()
        await progress(96, "SAVE")
        await api.call("POST", "complete")


async def process_generation(
    api: Api,
    render: Renderer,
    reviewer: ReviewPort,
    ffmpeg: str,
    ffprobe: str,
    planner: PlanningPort | None = None,
) -> None:
    claim = await api.call("POST", "claim")
    if not claim["claimed"]:
        return
    api.token = str(UUID(claim["attemptToken"]))
    expiry = datetime.fromisoformat(claim["leaseExpiresAt"])
    heartbeat_delay = min(20, max(1, (expiry - datetime.now(UTC)).total_seconds() / 3))

    async def pulse() -> None:
        while True:
            await asyncio.sleep(heartbeat_delay)
            await api.call("POST", "heartbeat")

    heartbeat = asyncio.create_task(pulse())
    planning = claim.get("planning")
    work = asyncio.create_task(
        execute_planning(api, planning, planner)
        if planning is not None
        else execute_generation(api, claim, render, reviewer, ffmpeg, ffprobe)
    )
    failure: tuple[str, bool] | None = None
    try:
        done, _ = await asyncio.wait(
            [heartbeat, work], return_when=asyncio.FIRST_COMPLETED
        )
        if work in done:
            await work
        else:
            await heartbeat
    except QualityBlocked:
        failure = ("PLANNING_BLOCKED" if planning else "QUALITY_BLOCKED", False)
    except (RenderError, ReviewError) as error:
        failure = ("PLANNING_FAILED" if planning else "PROVIDER_FAILED", error.retryable)
    except InternalApiError as error:
        if error.status_code not in {404, 409}:
            failure = (
                ("PLANNING_BLOCKED" if planning else "MEDIA_INVALID")
                if error.status_code == 400 else "EXECUTION_FAILED",
                error.retryable,
            )
    except TimeoutError:
        failure = ("EXECUTION_FAILED", True)
    except (MediaError, OSError, ValidationError, ValueError, KeyError, TypeError):
        failure = ("PLANNING_BLOCKED" if planning else "MEDIA_INVALID", False)
    finally:
        for running in (heartbeat, work):
            if not running.done():
                running.cancel()
        await asyncio.gather(heartbeat, work, return_exceptions=True)
    if failure:
        code, retryable = failure
        try:
            await api.call(
                "POST",
                "fail",
                {"code": code, "message": "生成执行未完成", "retryable": retryable},
            )
        except InternalApiError as error:
            if error.status_code not in {404, 409}:
                raise
