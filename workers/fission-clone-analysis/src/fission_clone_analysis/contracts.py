from __future__ import annotations

import json
import os
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any, ClassVar, Self

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError as SchemaError
from pydantic import RootModel, model_validator


MOTION_ANALYSIS_VERSION = 2
GROUNDED_ANALYSIS_VERSION = 3
PROP_ANALYSIS_VERSION = 4
GROUNDED_ANALYSIS_VERSIONS = (GROUNDED_ANALYSIS_VERSION, PROP_ANALYSIS_VERSION)
MOTION_ANALYSIS_VERSIONS = (MOTION_ANALYSIS_VERSION, *GROUNDED_ANALYSIS_VERSIONS)


def contracts_directory() -> Path:
    configured = os.getenv("FISSION_CLONE_CONTRACTS_DIR")
    return (
        Path(configured)
        if configured
        else Path(__file__).resolve().parents[4] / "packages/contracts"
    )


@lru_cache(maxsize=6)
def schema(name: str) -> dict[str, Any]:
    allowed = {
        "fission-clone-analysis-report.schema.json",
        "fission-clone-mapping-draft.schema.json",
        "fission-clone-task-result.schema.json",
    }
    if name not in allowed:
        raise ValueError("unknown shared contract")
    value: dict[str, Any] = json.loads(
        (contracts_directory() / "schemas" / name).read_text("utf-8")
    )
    Draft202012Validator.check_schema(value)
    return value


def check_schema(value: Any, name: str) -> None:
    try:
        Draft202012Validator(schema(name)).validate(value)
    except SchemaError as exc:
        # Pydantic/provider error strings must not contain uploaded text.
        raise ValueError("shared clone contract validation failed") from exc


def validate_shot_motion(shot: dict[str, Any]) -> None:
    motion = shot.get("motion")
    if motion is None:
        return
    events = motion["events"]
    if motion["status"] == "OBSERVED":
        if not events:
            raise ValueError("observed motion requires evidence-backed events")
    elif events or not motion["reason"].strip():
        raise ValueError("unobserved motion requires a reason and no events")

    previous_end_ms = shot["startMs"]
    shot_end_ms = shot["endMs"]
    shot_evidence = set(shot["evidenceFramesMs"])
    if motion["status"] == "NO_VISIBLE_MOTION" and len(shot_evidence) < 2:
        raise ValueError(
            "no visible motion requires at least two distinct evidence frames"
        )
    for event in events:
        if not any(
            event[key].strip()
            for key in ("subjectAction", "cameraAction", "contact", "productPose")
        ):
            raise ValueError("motion event is missing an observable action or state")
        start_ms, end_ms = event["startMs"], event["endMs"]
        if not previous_end_ms <= start_ms < end_ms <= shot_end_ms:
            raise ValueError("motion events must be ordered and contained in the shot")
        times = event["evidenceFramesMs"]
        if times != sorted(set(times)) or any(
            not start_ms <= time <= end_ms or time >= shot_end_ms or time not in shot_evidence
            for time in times
        ):
            raise ValueError("motion evidence must belong to its event and shot evidence")
        previous_end_ms = end_ms


def validate_report(report: dict[str, Any]) -> None:
    check_schema(report, "fission-clone-analysis-report.schema.json")
    duration = report["durationMs"]
    stages, shots, elements = (
        report["structure"]["stages"],
        report["shots"],
        report["elements"],
    )
    for items, key in [(stages, "stageId"), (shots, "shotId"), (elements, "elementId")]:
        if len({item[key] for item in items}) != len(items):
            raise ValueError("duplicate clone timeline identifier")
    for items in [stages, shots]:
        boundary = 0
        for item in items:
            if item["startMs"] != boundary or not boundary < item["endMs"] <= duration:
                raise ValueError(
                    "clone timeline must cover duration without gaps or overlaps"
                )
            boundary = item["endMs"]
        if boundary != duration:
            raise ValueError("incomplete clone timeline")
    stage_map = {stage["stageId"]: stage for stage in stages}
    shot_map = {shot["shotId"]: shot for shot in shots}
    element_map = {element["elementId"]: element for element in elements}
    for stage in stages:
        if (
            abs(stage["proportion"] - (stage["endMs"] - stage["startMs"]) / duration)
            > 0.00001
        ):
            raise ValueError("clone stage proportion disagrees with its timeline")
    for shot in shots:
        stage = stage_map.get(shot["stageId"])
        if (
            stage is None
            or shot["startMs"] < stage["startMs"]
            or shot["endMs"] > stage["endMs"]
        ):
            raise ValueError("clone shot is outside its stage")
        if len(set(shot["elementIds"])) != len(shot["elementIds"]) or any(
            identifier not in element_map
            or shot["shotId"] not in element_map[identifier]["shotIds"]
            for identifier in shot["elementIds"]
        ):
            raise ValueError("clone shot element references disagree")
        if any(
            not shot["startMs"] <= time < shot["endMs"]
            for time in shot["evidenceFramesMs"]
        ):
            raise ValueError("clone evidence frame is outside its shot")
        validate_shot_motion(shot)
    for element in elements:
        if (
            not element["shotIds"]
            or not element["ranges"]
            or len(set(element["shotIds"])) != len(element["shotIds"])
            or any(
                identifier not in shot_map
                or element["elementId"] not in shot_map[identifier]["elementIds"]
                for identifier in element["shotIds"]
            )
        ):
            raise ValueError("clone element shot references disagree")
        if element["type"] == "product" and element["required"] is not True:
            raise ValueError("every clone product must require replacement")
        for item in element["ranges"]:
            if not 0 <= item["startMs"] < item["endMs"] <= duration:
                raise ValueError("clone element range is invalid")
            if not any(
                item["startMs"] < shot_map[key]["endMs"]
                and item["endMs"] > shot_map[key]["startMs"]
                for key in element["shotIds"]
            ):
                raise ValueError("clone element range does not intersect its shots")
        if element["type"] == "prop":
            if (
                element["required"]
                or element["sourceTrack"] != "VISUAL"
                or not element["label"].strip()
                or not element["description"].strip()
            ):
                raise ValueError(
                    "clone prop must be an individually described optional visual element"
                )
            visual_evidence = [
                item for item in element["evidence"] if item["kind"] == "VISUAL"
            ]
            if not visual_evidence or any(
                not item["description"].strip()
                or not any(
                    span["startMs"] <= item["startMs"] < span["endMs"]
                    for span in element["ranges"]
                )
                or not any(
                    item["startMs"] in shot_map[key]["evidenceFramesMs"]
                    for key in element["shotIds"]
                )
                for item in visual_evidence
            ):
                raise ValueError("clone prop must cite visible evidence in its occurrence")
    for subtitle in report["visual"]["subtitles"]:
        if element_map.get(subtitle["elementId"], {}).get("type") != "subtitle":
            raise ValueError("subtitle references an unknown element")
    transcript_ids = [item["transcriptId"] for item in report["audio"]["transcript"]]
    if len(set(transcript_ids)) != len(transcript_ids):
        raise ValueError("duplicate transcript identifier")
    for times in [
        report["audio"]["beatsMs"],
        report["audio"]["soundEffectAnchorsMs"],
        [item["timeMs"] for item in report["structure"]["rhythm"]],
    ]:
        if any(
            time >= duration or (index and time <= times[index - 1])
            for index, time in enumerate(times)
        ):
            raise ValueError("clone rhythm timestamps must increase within duration")
    observations = [
        report["structure"]["overview"],
        report["creativity"]["overview"],
        report["product"]["overview"],
        report["visual"]["overview"],
        *[
            report["audio"][key]
            for key in ["overview", "voiceover", "bgm", "soundEffects"]
        ],
    ]
    if any(
        item["status"] != "OBSERVED" and not item["reason"].strip()
        for item in observations
    ):
        raise ValueError("unassessed observations need an explicit reason")

    def ranges(value: Any) -> None:
        if isinstance(value, list):
            for child in value:
                ranges(child)
        elif isinstance(value, dict):
            if (
                "startMs" in value
                and "endMs" in value
                and not 0 <= value["startMs"] < value["endMs"] <= duration
            ):
                raise ValueError("evidence range lies outside reference duration")
            for child in value.values():
                ranges(child)

    ranges(report)


def validate_result(result: dict[str, Any]) -> None:
    check_schema(result, "fission-clone-task-result.schema.json")
    if result["operation"] == "ANALYZE":
        validate_report(result["report"])


class ContractModel(RootModel[dict[str, Any]]):
    contract_file: ClassVar[str]

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return schema(cls.contract_file)

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        check_schema(self.root, self.contract_file)
        if self.contract_file == "fission-clone-analysis-report.schema.json":
            validate_report(self.root)
        return self


class ReportOutput(ContractModel):
    contract_file = "fission-clone-analysis-report.schema.json"
    include_motion: ClassVar[bool] = False
    include_props: ClassVar[bool] = False

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
        result = deepcopy(super().model_json_schema(*args, **kwargs))
        shot = result["properties"]["shots"]["items"]
        # Persisted reports accept historical shots. The provider's strict
        # object schema requires every property declared for the task version.
        if cls.include_motion:
            if "motion" not in shot["properties"]:
                raise ValueError("shared shot motion schema is missing")
            shot["required"].append("motion")
        else:
            shot["properties"].pop("motion", None)
        if not cls.include_props:
            types = result["properties"]["elements"]["items"]["properties"]["type"]["enum"]
            types.remove("prop")
        return result

    @model_validator(mode="after")
    def validate_provider_report_version(self) -> Self:
        if any(("motion" in shot) != self.include_motion for shot in self.root["shots"]):
            raise ValueError("shot motion fields must match the analysis version")
        if not self.include_props and any(
            element["type"] == "prop" for element in self.root["elements"]
        ):
            raise ValueError("prop elements must match the analysis version")
        return self


class MotionReportOutput(ReportOutput):
    include_motion = True


class GroundedMotionReportOutput(MotionReportOutput):
    @model_validator(mode="before")
    @classmethod
    def index_shot_evidence(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        check_schema(value, cls.contract_file)
        report = deepcopy(value)
        props_by_id = {
            element["elementId"]: element
            for element in report["elements"]
            if cls.include_props and element["type"] == "prop"
        }
        for shot in report["shots"]:
            times = set(shot["evidenceFramesMs"])
            for event in shot.get("motion", {}).get("events", []):
                times.update(event["evidenceFramesMs"])
            for element_id in shot["elementIds"]:
                for evidence in props_by_id.get(element_id, {}).get("evidence", []):
                    time = evidence["startMs"]
                    if evidence["kind"] == "VISUAL" and shot["startMs"] <= time < shot["endMs"]:
                        times.add(time)
            shot["evidenceFramesMs"] = sorted(times)
        return report


class PropReportOutput(GroundedMotionReportOutput):
    include_props = True


class MappingOutput(ContractModel):
    contract_file = "fission-clone-mapping-draft.schema.json"


class KeepTextOutput(ContractModel):
    contract_file = "fission-clone-task-result.schema.json"

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
        shared = schema(cls.contract_file)
        # Send a single object root to structured-output providers. It remains
        # the exact branch from the shared result contract, not a parallel DTO.
        for branch in shared.get("oneOf", shared.get("anyOf", [])):
            purpose = branch.get("properties", {}).get("purpose", {})
            if purpose.get("const") == "VALIDATE_KEEP_TEXT" or purpose.get("enum") == [
                "VALIDATE_KEEP_TEXT"
            ]:
                return {
                    **branch,
                    **({"$defs": shared["$defs"]} if "$defs" in shared else {}),
                }
        raise ValueError("shared keep-text result schema branch is missing")
