from typing import Any

import pytest
from test_structured_assets import Api, Provider, fixture
from test_asset_update import UpdateProvider, baseline

from customized_production_runtime.asset_pipeline import run_assets


class ClarificationApi(Api):
    async def call(self, method: str, path: str, value: Any = None) -> Any:
        if path == 'checkpoint' and 'output' not in value:
            value = {**value, 'output': self.claim['output']}
        return await super().call(method, path, value)


class ClarificationProvider(Provider):
    async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
        assert stage == 'ASSET_CLARIFICATION'
        assert context['confirmedInformation']['productAppearance'] == '燕麦白'
        assert context['operatorExplanation'] == '杯身改黑色，不展示容量'
        self.calls.append(stage)
        return schema.model_validate({
            'changes': [{'field': 'productAppearance', 'value': '黑色'}],
            'productionNote': '本次不展示容量',
            'questions': [],
        })


@pytest.mark.asyncio
async def test_clarification_completes_only_a_proposal_and_reuses_checkpoint() -> None:
    claim = fixture()
    claim['input']['brief'] = {'productAppearance': '燕麦白'}
    claim['input']['assetClarification'] = {
        'version': 1, 'priorTaskId': 'previous', 'questions': ['请确认颜色'],
        'explanation': '杯身改黑色，不展示容量',
    }
    claim['steps'] = [{'id': 'INVENTORY', 'status': 'PENDING'}]
    api, provider = ClarificationApi(claim), ClarificationProvider()
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed['changes'] == [{'field': 'productAppearance', 'value': '黑色'}]
    assert api.completed['productionNote'] == '本次不展示容量'
    assert claim['input']['brief'] == {'productAppearance': '燕麦白'}
    assert claim['input']['document'] == {'assets': [], 'shots': []}
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert provider.calls == ['ASSET_CLARIFICATION']


@pytest.mark.asyncio
async def test_adopted_note_is_visible_to_scope_and_audit_but_not_added_to_fact_sources() -> None:
    claim = await baseline()
    note = '本次画面不展示尺寸'
    claim['input']['assetProductionNote'] = note

    class WithNote(UpdateProvider):
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            assert context['confirmedProductionRequirement']['text'] == note
            assert all(note not in s['text'] for s in context['sources'])
            return await super().generate(stage, model, schema, context, instruction)

    api, provider = Api(claim), WithNote(claim)
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert provider.calls == ['ASSET_UPDATE_SCOPE', 'ASSET_REVIEW']
    assert api.completed['assets'] == claim['input']['document']['assets']


@pytest.mark.asyncio
async def test_old_image_is_outside_text_review_and_remains_bound_after_color_update() -> None:
    claim = await baseline()
    snapshot = claim['input']
    snapshot['assetTextUpdateVersion'] = 1
    snapshot['assetProductionNote'] = '黑色款；旧参考图暂不替换'
    snapshot['brief']['product'] = 'G65，黑色外壳。'
    product = snapshot['document']['assets'][0]
    product['imageBasis'] = 'old-definition'

    class TextOnly(UpdateProvider):
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            assert all('image' not in a and 'imageBasis' not in a
                       for a in context['localUpdate']['existingDefinitions'] + context.get('assets', []))
            assert 'imageRequirements' in context['localUpdate']['existingDefinitions'][0]
            if stage == 'ASSET_UPDATE_SCOPE':
                assert '不要把图片后续事项写入blockers' in instruction
            if stage == 'ASSET_REVIEW':
                assert '仅因既有图片需要核对，不得产生REQUIRED' in instruction
            return await super().generate(stage, model, schema, context, instruction)

    api, provider = Api(claim), TextOnly(claim, change=True)
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed['assets'][0]['description'] == '黑色外壳'
    assert api.completed['assets'][0]['image'] == product['image']
    assert api.completed['assets'][0]['imageBasis'] == 'old-definition'
