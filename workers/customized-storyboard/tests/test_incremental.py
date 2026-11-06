from copy import deepcopy
import pytest
from customized_storyboard.incremental import apply_patches
from customized_storyboard.incremental import run, Patches
from customized_storyboard.models import Review
from customized_storyboard.incremental import scoped_patches, PatchApplicationError
from ai_runtime.responses import ProviderError


def test_local_patch_preserves_unaffected_story_and_identity():
    old = {'id': 's', 'story': {'content': '蓝杯。雨夜。', 'beats': [{'id': 'p', 'content': '蓝杯'}]}}
    baseline = deepcopy(old)
    updated = apply_patches(old, [{'path': 'story/content', 'before': '蓝杯', 'after': '白杯', 'reason': '新资料'}])
    assert updated['story']['content'] == '白杯。雨夜。'
    assert updated['story']['beats'] == old['story']['beats']
    assert old == baseline


@pytest.mark.parametrize('path', ['id', '__proto__/x', 'story/beats/0/id', 'creation/videoType', 'settings/structureMode', 'story/beats/0/durationSeconds'])
def test_script_patch_cannot_change_identity_or_arbitrary_paths(path):
    with pytest.raises(ValueError):
        apply_patches({'id': 's'}, [{'path': path, 'before': 's', 'after': 'x', 'reason': 'x'}])


def test_ambiguous_or_stale_patch_cannot_be_replayed():
    patch = {'path': 'synopsis', 'before': '杯', 'after': '瓶', 'reason': '新资料'}
    with pytest.raises(ValueError):
        apply_patches({'synopsis': '杯与杯'}, [patch])
    with pytest.raises(ValueError):
        apply_patches({'synopsis': '瓶'}, [patch])


@pytest.mark.asyncio
@pytest.mark.parametrize('information_mode', [None, 'CURRENT'])
async def test_reviewed_candidate_resumes_without_rebuying_model_calls(information_mode):
    class Api:
        def __init__(self):
            self.calls = []

        async def call(self, method, path, body):
            self.calls.append((path, body))

    class Provider:
        def __init__(self):
            self.calls = 0

        async def generate(self, *args):
            self.calls += 1
            return Review(summary='核对通过', findings=[])

    class Pipeline:
        def __init__(self):
            self.api, self.provider = Api(), Provider()
            self.checkpoints = {}
            self.input = {'source': {'artifactId': 'brief', 'revision': 2}, 'brief': {}, 'models': {'creative': 'controlled'},
                          'incremental': {'version': 1, 'scriptId': 's', 'previousBrief': {}, 'baseline': {'id': 's', 'synopsis': '蓝杯与雨夜'}}}
            self.model_calls = 0

        async def step(self, node, sid, status, output=None):
            self.checkpoints[node, sid] = {'status': status, 'output': output}

        async def model(self, *args):
            self.model_calls += 1
            return Patches(patches=[{'path': 'synopsis', 'before': '蓝杯', 'after': '白杯', 'reason': '新外观'}])

    pipeline = Pipeline()
    if information_mode:
        pipeline.input['incremental']['informationMode'] = information_mode
    await run(pipeline)
    await run(pipeline)
    assert pipeline.model_calls == pipeline.provider.calls == 1
    assert pipeline.api.calls[0][1]['script']['synopsis'] == '白杯与雨夜'
    assert pipeline.input['incremental']['baseline']['synopsis'] == '蓝杯与雨夜'
    pipeline.checkpoints['REVIEW', 's']['output']['candidateHash'] = 'stale'
    with pytest.raises(ValueError, match='another candidate'):
        await run(pipeline)


def test_patch_schema_only_exposes_actual_frozen_text_fields():
    schema = scoped_patches({'id': 's', 'name': '杯子', 'structure': '叙事结构说明', 'settings': {'structureMode': 'AI'}, 'story': {'content': '正文', 'beats': [{'id': 'p', 'content': '篇章'}]}})
    paths = schema.model_json_schema()['$defs']['TextPatch']['properties']['path']['enum']
    assert paths == ['name', 'story/beats/0/content', 'story/content', 'structure']
    for path in ['story.content', 'story/beats/9/content', 'id']:
        with pytest.raises(ValueError):
            schema.model_validate({'patches': [{'path': path, 'before': '正文', 'after': '改后', 'reason': '事实改变'}]})


def test_overlapping_matches_and_utf16_size_match_server_guards():
    with pytest.raises(PatchApplicationError, match='出现多次'):
        apply_patches({'synopsis': 'aaa'}, [{'path': 'synopsis', 'before': 'aa', 'after': 'b', 'reason': 'x'}])
    with pytest.raises(PatchApplicationError, match='超过长度'):
        apply_patches({'synopsis': '杯'}, [{'path': 'synopsis', 'before': '杯', 'after': '😀' * 10001, 'reason': 'x'}])


@pytest.mark.asyncio
async def test_review_feedback_repairs_actual_root_description_and_all_prior_patches_against_original_baseline():
    patches = [{'path':path,'before':'燕麦白杯子','after':'黑色杯子','reason':'审核发现旧配色残留'} for path in ['structure', 'synopsis', 'story/content']]
    pipeline = CheckpointPipeline([patches])
    baseline={'id':'s','structure':'把燕麦白杯子放到会议桌中央。大家继续讨论。', 'synopsis':'拿起燕麦白杯子', 'creation':{'videoType':'DRAMA'}, 'settings':{'structureMode':'AI'}, 'story':{'content':'她拿起燕麦白杯子。', 'beats':[{'id':'b', 'durationSeconds':15, 'content':'继续讨论'}]}}
    pipeline.input['incremental']['baseline']=deepcopy(baseline)
    feedback={'candidate':deepcopy(baseline),'findings':[{'severity':'ERROR','message':'故事结构说明仍有旧配色'}]}
    pipeline.input['incremental']['reviewFeedback']=feedback
    paths = scoped_patches(baseline).model_json_schema()['$defs']['TextPatch']['properties']['path']['enum']
    assert 'structure' in paths and 'story/structure' not in paths and 'settings/structureMode' not in paths
    await run(pipeline)
    assert pipeline.model_calls[0]['reviewFeedback']==feedback
    result=pipeline.calls[0][1]['script']
    assert result['structure']=='把黑色杯子放到会议桌中央。大家继续讨论。'
    assert result['story']['content']=='她拿起黑色杯子。' and result['synopsis']=='拿起黑色杯子'
    assert result['creation']==baseline['creation'] and result['settings']==baseline['settings']
    assert result['story']['beats']==baseline['story']['beats'] and result['id']==baseline['id']
    assert pipeline.input['incremental']['baseline']==baseline
    assert len(pipeline.model_calls)==pipeline.review_calls==1


class CheckpointPipeline:
    def __init__(self, responses):
        self.input = {'source': {'artifactId': 'brief', 'revision': 2}, 'brief': {}, 'models': {'creative': 'controlled'},
            'incremental': {'version': 1, 'scriptId': 's', 'previousBrief': {}, 'baseline': {'id': 's', 'synopsis': '杯与杯'}}}
        self.checkpoints = {}
        self.steps = []
        self.model_calls = []
        self.responses = iter(responses)
        self.api = self.provider = self
        self.calls = []
        self.review_calls = 0

    async def call(self, method, path, body):
        self.calls.append((path, deepcopy(body)))

    async def generate(self, *args):
        self.review_calls += 1
        return Review(summary='通过', findings=[])

    async def step(self, node, sid, status, output=None, error=None):
        self.steps.append((node, status, deepcopy(output), error))
        self.checkpoints[node, sid] = {'status': status, 'output': deepcopy(output), 'errorMessage': error}

    async def model(self, stage, schema, context, instruction):
        self.model_calls.append(deepcopy(context))
        value = next(self.responses)
        if isinstance(value, Exception):
            raise value
        return Patches(patches=value)


BAD = [{'path': 'synopsis', 'before': '杯', 'after': '黑杯', 'reason': '改色'}]
GOOD = [{'path': 'synopsis', 'before': '杯与杯', 'after': '黑杯与黑杯', 'reason': '改色'}]


@pytest.mark.asyncio
async def test_invalid_paid_response_is_saved_before_failure_and_explicit_retry_has_exact_feedback():
    pipeline = CheckpointPipeline([BAD, GOOD])
    baseline = deepcopy(pipeline.input['incremental']['baseline'])
    with pytest.raises(PatchApplicationError, match='出现多次'):
        await run(pipeline)
    checkpoint = pipeline.checkpoints['STORY', 's']
    assert checkpoint['status'] == 'FAILED'
    assert checkpoint['output']['patches'] == BAD
    assert any(step[:3] == ('STORY', 'RUNNING', {'patches': BAD}) for step in pipeline.steps)
    assert pipeline.review_calls == 0 and pipeline.calls == []
    assert len(pipeline.model_calls) == 1  # no automatic additional model repair
    await run(pipeline)  # controlled explicit retry, not automatic generation
    assert len(pipeline.model_calls) == 2
    assert pipeline.model_calls[1]['previousPatchCandidate'] == BAD
    assert '出现多次' in pipeline.model_calls[1]['mechanicalIssue']
    assert pipeline.checkpoints['STORY', 's']['output']['script']['synopsis'] == '黑杯与黑杯'
    assert pipeline.input['incremental']['baseline'] == baseline
    assert pipeline.review_calls == 1


@pytest.mark.asyncio
async def test_resume_reuses_received_valid_patches_without_another_generation_call():
    pipeline = CheckpointPipeline([])
    pipeline.checkpoints['STORY', 's'] = {'status': 'RUNNING', 'output': {'patches': GOOD}}
    await run(pipeline)
    assert pipeline.model_calls == []
    assert pipeline.review_calls == 1
    assert pipeline.calls[0][1]['script']['synopsis'] == '黑杯与黑杯'


@pytest.mark.asyncio
async def test_failed_retry_retains_prior_response_and_does_not_run_a_repair_loop():
    pipeline = CheckpointPipeline([BAD, BAD])
    for _ in range(2):
        with pytest.raises(PatchApplicationError):
            await run(pipeline)
    assert len(pipeline.model_calls) == 2 and not pipeline.calls
    assert pipeline.checkpoints['STORY', 's']['output']['patches'] == BAD


@pytest.mark.asyncio
async def test_provider_failure_retains_invalid_draft_and_records_a_safe_step_error():
    pipeline = CheckpointPipeline([ProviderError('模型鉴权未通过', retryable=False)])
    pipeline.checkpoints['STORY', 's'] = {'status': 'FAILED', 'output': {'patches': BAD}}
    with pytest.raises(ProviderError):
        await run(pipeline)
    checkpoint = pipeline.checkpoints['STORY', 's']
    assert checkpoint['output']['patches'] == BAD
    assert checkpoint['errorMessage'] == '模型鉴权未通过'
    assert checkpoint['status'] == 'FAILED'
