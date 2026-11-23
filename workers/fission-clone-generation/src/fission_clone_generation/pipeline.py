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
from .media import (
    MediaError,
    compose,
    compose_source_edit,
    extract_shot_reference,
    normalize_original,
)
from .plan import SHOT_REFERENCE_MODE, SOURCE_EDIT_MODE, SOURCE_VIDEO_MAX_BYTES, validate_plan
from .planning import PlanningPort
from .provider import RenderCheckpoint, render_create_rejected
from .review import review_passed

SaveCheckpoint = Callable[[RenderCheckpoint], Awaitable[None]]
SourceRenderer = Callable[
    [dict[str, Any], str | None, str, dict[str, bytes], RenderCheckpoint, SaveCheckpoint],
    Awaitable[VideoOutput],
]
RenderClip = Callable[[RenderCheckpoint, SaveCheckpoint], Awaitable[VideoOutput]]


class Renderer(Protocol):
    async def __call__(
        self,
        plan: dict[str, Any],
        shot_id: str,
        model: str,
        images: dict[str, bytes],
        checkpoint: RenderCheckpoint,
        save_checkpoint: SaveCheckpoint,
        /,
        *,
        reference_url: str | None = None,
    ) -> VideoOutput: ...


class ReviewPort(Protocol):
    async def evaluate(
        self,
        plan: dict[str, Any],
        model: str,
        final: Path,
        images: dict[str, Path],
        *,
        original: Path | None = None,
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
    *,
    render_source: SourceRenderer | None = None,
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

    async def render_clip(slot: str, clip: Path, provider: RenderClip) -> None:
        saved = steps.get(f"FILE:{slot}")
        if saved is not None:
            await download(saved, clip)
            return
        identity = steps.get(f"RENDER:{slot}", {"state": "NOT_STARTED"})
        checkpoint = RenderCheckpoint(identity["state"], identity.get("providerTaskId"))

        async def persist(value: RenderCheckpoint) -> None:
            payload: dict[str, Any] = {"state": value.state}
            if value.provider_task_id:
                payload["providerTaskId"] = value.provider_task_id
            await api.call("PUT", f"render/{slot}", payload)

        result = await provider(checkpoint, persist)
        clip.write_bytes(result.content)
        del result
        await api.upload(slot, clip)

    if "REVIEW_V1" in steps:
        if not review_passed(plan, steps["REVIEW_V1"]):
            raise QualityBlocked()
        await api.call("POST", "complete")
        return
    source_edit = plan["mode"] == SOURCE_EDIT_MODE
    shot_reference = plan["mode"] == SHOT_REFERENCE_MODE
    render_slots = 1 if source_edit else len(plan["shots"])
    if any(
        steps.get(f"RENDER:{index}", {}).get("state") == "CREATE_REJECTED"
        for index in range(render_slots)
    ):
        raise render_create_rejected()
    with TemporaryDirectory(prefix="clone-generation-") as tmp:
        root = Path(tmp)
        images: dict[str, Path] = {}
        for image in plan["images"]:
            file_id = str(UUID(image["fileObjectId"]))
            source = root / f"{file_id}.image"
            await download(image, source, 4 * 1024 * 1024)
            images[file_id] = source
        original: Path | None = None
        if source_edit or shot_reference:
            raw_original = root / "original-upload.mov"
            original = root / "original.mp4"
            await download(plan["sourceVideo"], raw_original, SOURCE_VIDEO_MAX_BYTES)
            await normalize_original(
                plan, raw_original, original, ffmpeg=ffmpeg, ffprobe=ffprobe
            )
        final = root / "final.mp4"
        if "FILE:final" in steps:
            await download(steps["FILE:final"], final)
        elif source_edit:
            if render_source is None or original is None:
                raise ValueError("missing original-video edit renderer")

            async def edit(
                checkpoint: RenderCheckpoint, persist: SaveCheckpoint
            ) -> VideoOutput:
                url = None
                contents: dict[str, bytes] = {}
                if checkpoint.state == "NOT_STARTED":
                    contents = {file_id: path.read_bytes() for file_id, path in images.items()}
                    url = await api.source_video_url()
                return await render_source(
                    plan, url, snapshot["model"], contents, checkpoint, persist
                )

            edited = root / "edited.mp4"
            await progress(10, "RENDER")
            await render_clip("0", edited, edit)
            await progress(70, "COMPOSE")
            await compose_source_edit(
                plan, original, edited, final, ffmpeg=ffmpeg, ffprobe=ffprobe
            )
            await api.upload("final", final)
        else:
            clips: dict[str, Path] = {}
            for index, shot in enumerate(plan["shots"]):
                slot = str(index)
                shot_id = shot["shotId"]
                clip = root / f"shot-{index}.mp4"

                async def generate_shot(
                    checkpoint: RenderCheckpoint,
                    persist: SaveCheckpoint,
                    current: dict[str, Any] = shot,
                    shot_index: int = index,
                ) -> VideoOutput:
                    contents: dict[str, bytes] = {}
                    reference_url = None
                    if checkpoint.state == "NOT_STARTED":
                        contents = {
                            file_id: images[file_id].read_bytes()
                            for file_id in {
                                target["imageFileObjectId"] for target in current["targets"]
                                if target["imageFileObjectId"]
                            }
                        }
                        if shot_reference:
                            if original is None:
                                raise ValueError("missing original video for shot reference")
                            reference_slot = f"reference-{shot_index}"
                            if f"FILE:{reference_slot}" not in steps:
                                reference = root / f"{reference_slot}.mp4"
                                await extract_shot_reference(
                                    plan, shot_index, original, reference,
                                    ffmpeg=ffmpeg, ffprobe=ffprobe,
                                )
                                await api.upload(reference_slot, reference)
                            reference_url = await api.shot_reference_video_url(str(shot_index))
                    return await render(
                        plan, current["shotId"], snapshot["model"], contents, checkpoint, persist,
                        reference_url=reference_url,
                    )

                await progress(10 + 55 * index // len(plan["shots"]), "RENDER")
                await render_clip(slot, clip, generate_shot)
                clips[shot_id] = clip
            await progress(70, "COMPOSE")
            await compose(plan, clips, final, ffmpeg=ffmpeg, ffprobe=ffprobe)
            await api.upload("final", final)
        await progress(86, "REVIEW")
        if original is not None:
            review = await reviewer.evaluate(
                plan, snapshot["reviewModel"], final, images, original=original
            )
        else:
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
    *,
    render_source: SourceRenderer | None = None,
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
        else execute_generation(
            api, claim, render, reviewer, ffmpeg, ffprobe, render_source=render_source
        )
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
