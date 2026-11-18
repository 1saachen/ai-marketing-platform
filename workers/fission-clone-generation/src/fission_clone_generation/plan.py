from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, ValidationError


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
            if target["type"] == "product":
                has_product = True
                if file_id is None:
                    raise ValueError("each product must have a frozen image")
            if file_id is not None:
                image_ids.add(file_id)
        if (
            len(target_ids) != len(shot["targets"])
            or len(image_ids) > 4
            or not image_ids <= frozen_images.keys()
        ):
            raise ValueError("shot references invalid targets")
        used.update(image_ids)
    if (
        not has_product
        or used != frozen_images.keys()
        or not plan["productName"].strip()
        or not plan["productFacts"].strip()
    ):
        raise ValueError("generation plan is missing confirmed product facts or images")
