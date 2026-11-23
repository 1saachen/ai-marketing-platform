import copy

import pytest
from fission_clone_analysis.contracts import (
    GroundedMotionReportOutput,
    KeepTextOutput,
    MappingOutput,
    MotionReportOutput,
    PropReportOutput,
    ReportOutput,
    schema,
    validate_report,
    validate_result,
)
from fission_clone_analysis.pipeline import validate_for_snapshot, validate_snapshot


def test_models_consume_the_published_contract_and_shared_fixtures(report, mapping):
    assert ReportOutput.model_validate(report).root == report
    assert MappingOutput.model_validate(mapping).root == mapping
    shared = copy.deepcopy(schema("fission-clone-analysis-report.schema.json"))
    shot = shared["properties"]["shots"]["items"]
    assert "motion" in shot["properties"] and "motion" not in shot["required"]
    shot["properties"].pop("motion")
    shared["properties"]["elements"]["items"]["properties"]["type"]["enum"].remove("prop")
    assert ReportOutput.model_json_schema() == shared
    assert MappingOutput.model_json_schema() == schema(
        "fission-clone-mapping-draft.schema.json"
    )
    branch = KeepTextOutput.model_json_schema()
    assert branch["properties"]["purpose"]["const"] == "VALIDATE_KEEP_TEXT"
    validate_result({"operation": "ANALYZE", "report": report})
    validate_result(
        {
            "operation": "MAP_SUGGEST",
            "purpose": "SMART_MATCH",
            "mapping": mapping,
            "notes": [],
        }
    )


def test_motion_report_is_required_only_for_new_analysis(motion_report, snapshot):
    shared = schema("fission-clone-analysis-report.schema.json")
    strict = MotionReportOutput.model_json_schema()
    assert "motion" in strict["properties"]["shots"]["items"]["required"]
    assert "motion" not in shared["properties"]["shots"]["items"]["required"]
    assert MotionReportOutput.model_validate(motion_report).root == motion_report
    snapshot["analysisInstructionVersion"] = 2
    result = {"operation": "ANALYZE", "report": motion_report}
    validate_for_snapshot(result, snapshot)
    motion_report["shots"][0].pop("motion")
    with pytest.raises(ValueError, match="missing shot motion"):
        validate_for_snapshot(result, snapshot)
    with pytest.raises(ValueError, match="analysis version"):
        MotionReportOutput.model_validate(motion_report)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda motion: motion.update(events=[]),
        lambda motion: motion["events"][0].update(
            subjectAction=" ", cameraAction="", contact="", productPose=""
        ),
        lambda motion: motion.update(status="NO_VISIBLE_MOTION", reason="静止"),
        lambda motion: motion.update(status="INSUFFICIENT_EVIDENCE", events=[]),
        lambda motion: motion["events"][0].update(endMs=1501),
        lambda motion: motion["events"][0].update(evidenceFramesMs=[500, 0]),
        lambda motion: motion["events"][0].update(evidenceFramesMs=[0, 0]),
        lambda motion: motion["events"][0].update(evidenceFramesMs=[0, 200]),
        lambda motion: motion["events"][0].update(startMs=510),
        lambda motion: motion["events"].append(
            {**motion["events"][0], "startMs": 500, "endMs": 700, "evidenceFramesMs": [500]}
        ),
    ],
)
def test_report_rejects_invalid_motion(motion_report, mutation):
    mutation(motion_report["shots"][0]["motion"])
    with pytest.raises(ValueError):
        validate_report(motion_report)


@pytest.mark.parametrize("times", [[], [0], [0, 0]])
def test_static_motion_requires_two_distinct_shot_evidence_frames(motion_report, times):
    shot = motion_report["shots"][0]
    shot["motion"].update(status="NO_VISIBLE_MOTION", events=[], reason="多帧显示位置一致")
    validate_report(motion_report)
    shot["evidenceFramesMs"] = times
    with pytest.raises(ValueError, match="two distinct evidence frames"):
        validate_report(motion_report)


def test_grounded_report_indexes_existing_evidence_before_validation(motion_report):
    shot = motion_report["shots"][0]
    shot["evidenceFramesMs"] = [900, 0, 900]
    original = copy.deepcopy(motion_report)

    with pytest.raises(ValueError, match="motion evidence must belong"):
        MotionReportOutput.model_validate(motion_report)
    result = GroundedMotionReportOutput.model_validate(motion_report).root

    assert result["shots"][0]["evidenceFramesMs"] == [0, 500, 900]
    assert result["shots"][0]["motion"] == shot["motion"]
    assert motion_report == original
    assert (
        GroundedMotionReportOutput.model_json_schema()
        == MotionReportOutput.model_json_schema()
    )


@pytest.mark.parametrize(
    "times,error_message",
    [([0, 1500], "evidence frame is outside its shot"), ([0, "500"], "contract validation failed")],
)
def test_grounded_report_still_rejects_invalid_event_evidence(
    motion_report, times, error_message
):
    event = motion_report["shots"][0]["motion"]["events"][0]
    event.update(endMs=1500, evidenceFramesMs=times)

    with pytest.raises(ValueError, match=error_message):
        GroundedMotionReportOutput.model_validate(motion_report)


@pytest.mark.parametrize(
    "operation,version",
    [("ANALYZE", 1), ("ANALYZE", 5), ("MAP_SUGGEST", 2), ("MAP_SUGGEST", 3), ("MAP_SUGGEST", 4)],
)
def test_snapshot_rejects_unsupported_analysis_instruction_version(
    snapshot, operation, version
):
    snapshot.update(operation=operation, analysisInstructionVersion=version)
    with pytest.raises(ValueError, match="unsupported analysis instruction version"):
        validate_snapshot(snapshot)


def test_legacy_snapshot_cannot_replay_v4_prop_result(snapshot, prop_report):
    assert "prop" not in (
        GroundedMotionReportOutput.model_json_schema()["properties"]["elements"]
        ["items"]["properties"]["type"]["enum"]
    )
    result = {"operation": "ANALYZE", "report": PropReportOutput.model_validate(prop_report).root}
    with pytest.raises(ValueError, match="prop elements must match the analysis version"):
        GroundedMotionReportOutput.model_validate(result["report"])
    snapshot["analysisInstructionVersion"] = 4
    validate_for_snapshot(result, snapshot)
    snapshot["analysisInstructionVersion"] = 3
    with pytest.raises(ValueError, match="prop elements must match the analysis version"):
        validate_for_snapshot(result, snapshot)


def test_prop_suggestions_cannot_select_or_replace_user_assets(snapshot, mapping, prop_report):
    keep = {
        "elementId": "orange_box",
        "type": "prop",
        "action": "KEEP",
        "shotIds": ["shot_a"],
        "target": None,
    }
    proposed = copy.deepcopy(mapping)
    proposed["bindings"].append(keep)
    snapshot.update(operation="MAP_SUGGEST", purpose="SMART_MATCH")
    snapshot["analysis"]["report"] = PropReportOutput.model_validate(prop_report).root
    value = {
        "operation": "MAP_SUGGEST",
        "purpose": "SMART_MATCH",
        "mapping": proposed,
        "notes": [],
    }
    validate_for_snapshot(value, snapshot)
    keep.update(action="REPLACE", target=copy.deepcopy(mapping["bindings"][0]["target"]))
    with pytest.raises(ValueError, match="preserve user selections"):
        validate_for_snapshot(value, snapshot)
    snapshot["mapping"]["bindings"].append(copy.deepcopy(keep))
    validate_for_snapshot(value, snapshot)
    keep["target"]["text"] = "擅自更换的道具"
    with pytest.raises(ValueError, match="preserve user selections"):
        validate_for_snapshot(value, snapshot)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r.update(unknown=True),
        lambda r: r.pop("audio"),
        lambda r: r["audio"]["voiceover"].update(status="ASSUMED"),
        lambda r: r["shots"][1].update(startMs=1600),
        lambda r: r["shots"][1].update(shotId="shot_a"),
        lambda r: r["shots"][0].update(elementIds=["product_b"]),
        lambda r: r["elements"][0].update(required=False),
        lambda r: r["elements"][0].update(shotIds=[]),
        lambda r: r["structure"]["stages"][0].update(proportion=0.7),
        lambda r: r["shots"][0].update(evidenceFramesMs=[1500]),
        lambda r: r["audio"]["voiceover"].update(reason=""),
        lambda r: r["structure"]["hookRanges"][0].update(endMs=3001),
        lambda r: r["structure"]["rhythm"].append(
            {"timeMs": 0, "intensity": 0.5, "description": "duplicate"}
        ),
    ],
)
def test_report_rejects_structural_and_timeline_failures(report, mutation):
    mutation(report)
    with pytest.raises(ValueError):
        validate_report(report)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda m: m["sourceInput"].update(revision=2),
        lambda m: m["sourceAnalysis"].update(contentHash="c" * 64),
        lambda m: m["structureLock"].update(durationMs=4000),
        lambda m: m["bindings"].pop(),
        lambda m: m["bindings"][1].update(action="KEEP"),
        lambda m: m["bindings"][0]["target"].update(
            asset={"assetId": "11111111-1111-4111-8111-111111111111", "version": 1}
        ),
    ],
)
def test_suggestions_cannot_change_sources_structure_or_invent_assets(
    snapshot, mapping, mutation
):
    snapshot = copy.deepcopy(snapshot)
    snapshot.update(operation="MAP_SUGGEST", purpose="SMART_MATCH")
    value = copy.deepcopy(mapping)
    mutation(value)
    with pytest.raises(ValueError):
        validate_for_snapshot(
            {
                "operation": "MAP_SUGGEST",
                "purpose": "SMART_MATCH",
                "mapping": value,
                "notes": [],
            },
            snapshot,
        )


def test_keep_text_evidence_covers_exact_requested_set(snapshot):
    snapshot.update(operation="MAP_SUGGEST", purpose="VALIDATE_KEEP_TEXT")
    value = {"operation": "MAP_SUGGEST", "purpose": "VALIDATE_KEEP_TEXT", "checks": []}
    validate_for_snapshot(value, snapshot)
    value["checks"] = [
        {
            "elementId": "product_a",
            "passed": True,
            "reason": "wrong element",
            "evidence": [],
        }
    ]
    with pytest.raises(ValueError):
        validate_for_snapshot(value, snapshot)
