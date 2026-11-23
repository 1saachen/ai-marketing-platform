from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, ValidationError

SOURCE_EDIT_MODE = "SEEDANCE_2_0_SOURCE_EDIT"
SHOT_REFERENCE_MODE = "SEEDANCE_2_0_SHOT_REFERENCE"
MIN_SHOT_REFERENCE_FRAMES = 48
SOURCE_VIDEO_MAX_BYTES = 200_000_000


def prompt_product_fields(
    plan: dict[str, Any], *, name_key: str = "product", facts_key: str = "facts"
) -> dict[str, str]:
    fields = {name_key: plan["productName"], facts_key: plan["productFacts"]}
    return {key: value for key, value in fields.items() if value.strip()}


@lru_cache(maxsize=5)
def validator(kind: str = "plan") -> Draft202012Validator:
    if kind not in {"plan", "review", "variant-draft", "variant-shot-draft", "variant-review"}:
        raise ValueError("unknown generation contract")
    configured = os.getenv("FISSION_CLONE_CONTRACTS_DIR")
    root = (
        Path(configured)
        if configured
        else Path(__file__).resolve().parents[4] / "packages/contracts"
    )
    schema = json.loads(
        (root / f"schemas/fission-clone-generation-{kind}.schema.json").read_text(
            "utf-8"
        )
    )
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _validate_shot_motion(motion: dict[str, Any], duration_ms: int) -> None:
    events = motion["events"]
    if motion["status"] != "OBSERVED":
        if events or not motion["reason"].strip():
            raise ValueError("invalid status for frozen shot motion")
        return
    if not events:
        raise ValueError("observed shot motion requires events")
    previous_end = 0
    for event in events:
        if not any(
            event[key].strip()
            for key in ("subjectAction", "cameraAction", "contact", "productPose")
        ):
            raise ValueError("motion event is missing an observable action or state")
        start, end = event["startMs"], event["endMs"]
        evidence = event["evidenceFramesMs"]
        if (
            not previous_end <= start < end <= duration_ms
            or evidence != sorted(set(evidence))
            or any(not start <= time <= end or time >= duration_ms for time in evidence)
        ):
            raise ValueError("motion event or evidence is outside its relative shot interval")
        previous_end = end


def validate_plan(plan: dict[str, Any]) -> None:
    try:
        validator().validate(plan)
    except ValidationError as error:
        raise ValueError(
            "generation plan does not match the shared contract"
        ) from error
    timeline = plan["timeline"]
    duration = int(timeline["durationMs"])
    numerator = int(timeline["fpsNumerator"])
    denominator = int(timeline["fpsDenominator"])
    units = denominator * 1000
    source_edit = plan["mode"] == SOURCE_EDIT_MODE
    shot_reference = plan["mode"] == SHOT_REFERENCE_MODE
    source = plan.get("sourceVideo")
    if source_edit:
        if (
            source is None
            or duration < 4000
            or source.get("renderSeconds") != (duration + 999) // 1000
            or source["sizeBytes"] > SOURCE_VIDEO_MAX_BYTES
            or len(plan["images"]) > 9
            or plan.get("renderInstructionVersion") != 2
        ):
            raise ValueError("source edit requires a frozen original and full render interval")
    elif shot_reference:
        if (
            source is None
            or "renderSeconds" in source
            or source["sizeBytes"] > SOURCE_VIDEO_MAX_BYTES
            or plan.get("renderInstructionVersion") != 2
        ):
            raise ValueError("shot reference requires a frozen original and current instructions")
    elif source is not None:
        raise ValueError("legacy render cannot use a source video")

    def frame(time_ms: int) -> int:
        return (2 * time_ms * numerator + units) // (2 * units)

    def validate_span(span: dict[str, Any]) -> None:
        start, end = span["startMs"], span["endMs"]
        first, last = span["startFrame"], span["endFrame"]
        if not (
            0 <= start < end <= duration and first == frame(start) < frame(end) == last
        ):
            raise ValueError("invalid absolute frame interval")

    if timeline["frameCount"] != frame(duration):
        raise ValueError("duration and frame count disagree")
    for key in ("stages", "shots"):
        previous = 0
        for span in timeline[key]:
            validate_span(span)
            if span["startMs"] != previous:
                raise ValueError("frame intervals must be contiguous")
            previous = span["endMs"]
        if previous != duration:
            raise ValueError("frame intervals must cover the full duration")
    for span in timeline["hookRanges"] + timeline["conversionRanges"]:
        validate_span(span)
    stages = {stage["stageId"]: stage for stage in timeline["stages"]}
    if len(stages) != len(timeline["stages"]):
        raise ValueError("duplicate stage identity")
    dimensions = (720, 1280) if plan["ratio"] == "9:16" else (1280, 720)
    if dimensions != (plan["width"], plan["height"]):
        raise ValueError("dimensions disagree with output aspect ratio")

    frozen_images = {image["fileObjectId"]: image for image in plan["images"]}
    if len(frozen_images) != len(plan["images"]) or any(
        not 2 * image["height"] <= 5 * image["width"]
        or not 2 * image["width"] <= 5 * image["height"]
        for image in plan["images"]
    ):
        raise ValueError("invalid frozen image identity or aspect ratio")
    if source is not None and source["fileObjectId"] in frozen_images:
        raise ValueError("source video cannot also serve as a target image")
    used = set()
    ids = set()
    has_product = False
    for shot, span in zip(plan["shots"], timeline["shots"], strict=True):
        stage = stages.get(span["stageId"])
        count = span["endFrame"] - span["startFrame"]
        seconds = max(4, (count * denominator + numerator - 1) // numerator)
        if (
            shot["shotId"] != span["shotId"]
            or shot["shotId"] in ids
            or shot["renderSeconds"] != seconds
            or not stage
            or not stage["startMs"] <= span["startMs"] < span["endMs"] <= stage["endMs"]
        ):
            raise ValueError("shot differs from the locked timeline")
        expected_reference_frames = max(MIN_SHOT_REFERENCE_FRAMES, count)
        if shot_reference:
            if shot.get("referenceFrames") != expected_reference_frames:
                raise ValueError("shot reference length differs from the locked timeline")
        elif "referenceFrames" in shot:
            raise ValueError("historical render cannot use shot reference frames")
        if "motion" in shot:
            if plan.get("renderInstructionVersion") != 2:
                raise ValueError("frozen shot motion requires the current render instructions")
            _validate_shot_motion(shot["motion"], span["endMs"] - span["startMs"])
        ids.add(shot["shotId"])
        target_ids = {target["elementId"] for target in shot["targets"]}
        image_ids = set()
        for target in shot["targets"]:
            file_id = target["imageFileObjectId"]
            variation = target.get("variation")
            if variation and (
                target["type"] != "scene"
                or variation["dimension"] not in target["allowedVariations"]
                or not variation["direction"].strip()
            ):
                raise ValueError("scene direction exceeds confirmed mapping scope")
            if source_edit or shot_reference:
                if not target.get("sourceDescription", "").strip():
                    raise ValueError("each video reference target requires an original object description")
                if shot_reference and target["type"] == "prop":
                    raise ValueError("shot reference accepts only product and scene targets")
            elif target["type"] == "prop" or "sourceDescription" in target:
                raise ValueError("legacy render accepts only legacy targets")
            if target["type"] == "product":
                has_product = True
            if target["type"] in {"product", "prop"} and file_id is None:
                raise ValueError("each product or prop must have a frozen image")
            if file_id is not None:
                image_ids.add(file_id)
        if (
            len(target_ids) != len(shot["targets"])
            or len(image_ids) > 4
            or not image_ids <= frozen_images.keys()
        ):
            raise ValueError("shot references invalid targets")
        used.update(image_ids)
    if not has_product or used != frozen_images.keys():
        raise ValueError("generation plan is missing confirmed product or images")
