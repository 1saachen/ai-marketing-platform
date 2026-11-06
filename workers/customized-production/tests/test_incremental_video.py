import copy
import json
from pathlib import Path
import pytest
from customized_production_runtime.incremental_video import validate_scope


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
