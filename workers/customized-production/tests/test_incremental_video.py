import copy
import json
from pathlib import Path
from typing import Any
import pytest
from customized_production_runtime.incremental_video import mark_reference_timing_advisory, normalize_full_unit_offsets, run, validate_scope
from customized_production_runtime.video_domain import fingerprint
from test_video_v2 import FakeApi, clean_audit, snapshot as video_snapshot


def fixture():
    document = json.loads((Path(__file__).resolve().parents[3] / 'packages/contracts/fixtures/customized-video-plan-v2.json').read_text(encoding='utf-8'))['document']
    return document, {'document': document, 'identitySeed': '11111111-1111-4111-8111-111111111111', 'incremental': {'version': 1, 'targetIds': [c['id'] for c in document['videoPlan']['clips']]}}


def test_unchanged_plan_does_not_need_changes():
    doc, snapshot = fixture()
    validate_scope(doc['videoPlan'], [], snapshot)


def test_changes_must_be_declared_and_unrelated_clips_preserved():
    doc, snapshot = fixture()
    plan = copy.deepcopy(doc['videoPlan'])
    plan['shots'][0]['visual'] += ' 展示新外观。'
    with pytest.raises(ValueError, match='undeclared'):
        validate_scope(plan, [], snapshot)
    validate_scope(plan, [{'clipId': plan['clips'][0]['id'], 'reason': '产品外观更新'}], snapshot)
    snapshot['incremental']['targetIds'] = []
    with pytest.raises(ValueError, match='scope'):
        validate_scope(plan, [{'clipId': plan['clips'][0]['id'], 'reason': 'x'}], snapshot)


def test_deletion_requires_a_reason_and_task_scoped_new_identity():
    doc, snapshot = fixture()
    plan = copy.deepcopy(doc['videoPlan'])
    plan['clips'][0]['id'] = 'invented'
    with pytest.raises(ValueError, match='identity'):
        validate_scope(plan, [{'clipId': 'invented', 'reason': 'x'}, {'clipId': doc['videoPlan']['clips'][0]['id'], 'reason': 'x'}], snapshot)


@pytest.mark.asyncio
@pytest.mark.parametrize('exact_whole_unit', [True, False])
async def test_resume_validates_frozen_offsets_before_reusing_candidate(exact_whole_unit: bool) -> None:
    snapshot = video_snapshot()
    baseline = snapshot['document']['videoPlan']
    unit = snapshot['sourceUnits'][1]
    baseline['events'][0]['sourceRefs'].append({'unitId': unit['id'], 'start': 0, 'end': len(unit['text'])})
    snapshot['incremental'] = {'version': 1, 'targetIds': [c['id'] for c in baseline['clips']]}
    candidate = copy.deepcopy(baseline)
    candidate['events'][0]['sourceRefs'][-1].update(start=unit['start'] + int(not exact_whole_unit), end=unit['end'])
    if exact_whole_unit:
        candidate['cues'][0]['sourceRef'].update(start=unit['start'], end=unit['end'])
        changed_units = copy.deepcopy(snapshot['sourceUnits'])
        changed_units[0]['text'] += '有变化'
        assert normalize_full_unit_offsets(candidate, changed_units) == 0

    class AuditOnly:
        calls: list[str] = []

        async def generate(self, stage: str, _model: str, schema: Any, context: dict[str, Any], _instruction: str) -> Any:
            self.calls.append(stage)
            assert stage == 'VIDEO_REVIEW'
            assert context['plan'] == baseline
            return schema.model_validate(clean_audit())

    api, provider = FakeApi(), AuditOnly()
    api.output = {'localCandidate': {'plan': candidate, 'changes': []}}
    if not exact_whole_unit:
        with pytest.raises(ValueError, match='source reference outside immutable text'):
            await run(api, provider, api.claim(snapshot))
        assert provider.calls == [] and api.completed is None
        assert api.output['localCandidate']['plan'] == candidate
        assert api.output['failureReason'] == 'INVALID_CANDIDATE'
        assert next(step for step in api.steps if step['id'] == 'GENERATE')['status'] == 'FAILED'
        return

    await run(api, provider, api.claim(snapshot))
    assert provider.calls == ['VIDEO_REVIEW']
    assert api.completed == snapshot['document']
    assert api.output['localSourceOffsetCount'] == 2
    await run(api, provider, api.claim(snapshot))
    assert provider.calls == ['VIDEO_REVIEW']


def timing_finding() -> dict[str, Any]:
    return {
        'id': 'reference-duration', 'category': 'CAPACITY', 'severity': 'ERROR',
        'title': '总时长与参考值不同', 'impact': '当前分镜时长超过参考时长',
        'evidence': [{'entity': 'TIMING', 'id': 'durationPolicy', 'field': 'seconds'}],
        'affectedShotIds': [], 'affectedClipIds': [], 'suggestedFix': '缩短时长',
        'repairKind': 'INPUT',
    }


@pytest.mark.asyncio
@pytest.mark.parametrize('cite_whole_schedule', [False, True])
async def test_resume_saved_review_without_regeneration_for_unchanged_reference_schedule(cite_whole_schedule: bool) -> None:
    snapshot = video_snapshot()
    plan = snapshot['document']['videoPlan']
    snapshot['incremental'] = {'version': 1, 'targetIds': [c['id'] for c in plan['clips']]}
    audit = clean_audit()
    capability = {
        **timing_finding(), 'id': 'model-check', 'category': 'CAPABILITY', 'severity': 'WARNING',
        'evidence': [{'entity': 'TIMING', 'id': 'capability', 'field': 'status'}],
    }
    timing = timing_finding()
    if cite_whole_schedule:
        timing['evidence'].extend(
            {'entity': 'SHOT', 'id': shot['id'], 'field': 'durationSeconds'} for shot in plan['shots']
        )
    audit['findings'] = [timing, capability]
    api = FakeApi()
    api.output = {'localCandidate': {'plan': plan, 'changes': []}, 'audit': audit,
                  'auditHash': fingerprint(plan), 'failureReason': 'REVIEW_UNRESOLVED'}

    # No provider methods are available in this recovery.
    await run(api, object(), api.claim(snapshot))

    assert api.completed == snapshot['document']
    assert api.output['localReviewPolicyVersion'] == 1
    assert api.output['localOriginalAudit'] == audit
    assert [f['severity'] for f in api.output['audit']['findings']] == ['WARNING', 'WARNING']
    assert api.output['audit']['findings'][1] == capability


@pytest.mark.parametrize('constraint', ['fixed', 'schedule', 'shot-evidence', 'cue-evidence'])
def test_reference_advisory_leaves_real_timing_errors_blocking(constraint: str) -> None:
    doc, _ = fixture()
    baseline = doc['videoPlan']
    plan = copy.deepcopy(baseline)
    finding = timing_finding()
    if constraint == 'fixed':
        plan['durationPolicy']['mode'] = 'FIXED'
    elif constraint == 'schedule':
        plan['shots'][0]['durationSeconds'] += 1
    elif constraint == 'shot-evidence':
        finding['evidence'].append(
            {'entity': 'SHOT', 'id': plan['shots'][0]['id'], 'field': 'durationSeconds'}
        )
    else:
        finding['evidence'].append({'entity': 'CUE', 'id': plan['cues'][0]['id'], 'field': 'parts'})
    audit = {**clean_audit(), 'findings': [finding]}
    assert mark_reference_timing_advisory(audit, plan, baseline) == 0
    assert finding['severity'] == 'ERROR'
