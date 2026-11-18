import copy

import pytest
from fission_clone_analysis.contracts import (
    KeepTextOutput,
    MappingOutput,
    ReportOutput,
    schema,
    validate_report,
    validate_result,
)
from fission_clone_analysis.pipeline import validate_for_snapshot


def test_models_consume_the_published_contract_and_shared_fixtures(report, mapping):
    assert ReportOutput.model_validate(report).root == report
    assert MappingOutput.model_validate(mapping).root == mapping
    assert ReportOutput.model_json_schema() == schema(
        "fission-clone-analysis-report.schema.json"
    )
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
