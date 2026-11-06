import copy
from typing import Any
import pytest
from test_structured_assets import Api, Provider, fixture
from customized_production_runtime.asset_pipeline import run_assets


async def baseline() -> dict[str, Any]:
    claim = fixture()
    api = Api(claim)
    await run_assets(api, Provider(), claim)  # type: ignore[arg-type]
    result = fixture()
    result['input'].update(assetUpdateVersion=1, identitySeed='update', incremental={'version': 1, 'targetIds': [a['id'] for a in api.completed['assets']]})
    result['input']['document']['assets'] = api.completed['assets']
    product = result['input']['document']['assets'][0]
    product.update(description='灰色外壳', knownFacts='G65，灰色外壳。', sourceText='G65，灰色外壳。', imageRequirements='灰色基础图', image={'assetId': 'fixed-image', 'version': 1}, manualFields=[])
    product['preparation']['details'][1]['value'] = '灰色外壳'
    return result


FIELDS = ['description', 'knownFacts', 'sourceText', 'imageRequirements', 'preparation']


class UpdateProvider(Provider):
    def __init__(self, claim: dict[str, Any], *, change: bool = False, add: bool = False, fail_patch: bool = False, wrong_patch: bool = False, outside_review: bool = False) -> None:
        super().__init__()
        self.claim, self.change, self.add = claim, change, add
        self.fail_patch, self.wrong_patch, self.outside_review = fail_patch, wrong_patch, outside_review

    async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
        old = self.claim['input']['document']['assets']
        if stage in ('ASSET_UPDATE_SCOPE', 'ASSET_UPDATE_SCOPE_CORRECTION'):
            self.calls.append(stage)
            return schema.model_validate({'decisions': [{'assetId': a['id'], 'fields': FIELDS if self.change and a['kind'] == 'PRODUCT' else [], 'reason': '产品配色变更' if self.change and a['kind'] == 'PRODUCT' else '外观、用途及归属未变'} for a in old],
                'additions': [{'key': 'seat', 'existingId': None, 'name': '座椅', 'kind': 'PROP', 'aliases': [], 'usage': '必要新道具', 'treatment': 'INDEPENDENT', 'parentKey': None, 'sources': [{'source': 'SCRIPT', 'path': '/story/content', 'quote': '周越在候车区使用充电器。', 'field': 'usage'}]}] if self.add else [], 'blockers': []})
        if stage == 'ASSET_UPDATE_PATCHES':
            self.calls.append(stage)
            if self.fail_patch:
                raise RuntimeError('controlled failure')
            product = copy.deepcopy(old[0])
            for key in ['description', 'knownFacts', 'sourceText', 'imageRequirements']:
                product[key] = product[key].replace('灰色', '黑色')
            product['preparation']['details'][1]['value'] = '黑色外壳'
            product['preparation']['sources'][0]['quote'] = 'G65，黑色外壳。'
            patches = [{'assetId': product['id'], 'field': f, 'text': product[f] if f != 'preparation' else None, 'preparation': product[f] if f == 'preparation' else None} for f in FIELDS]
            if self.wrong_patch:
                patches[0]['assetId'] = old[1]['id']
            return schema.model_validate({'patches': patches})
        if stage == 'ASSET_REVIEW' and self.outside_review:
            self.calls.append(stage)
            return schema.model_validate({'summary': '范围遗漏', 'findings': [{'assetId': old[1]['id'], 'field': 'description', 'issue': '人物另有变化', 'basis': '核对新脚本', 'severity': 'REQUIRED'}]})
        return await super().generate(stage, model, schema, context, instruction)


@pytest.mark.asyncio
async def test_small_color_change_only_patches_product_and_preserves_every_other_byte_and_picture() -> None:
    claim = await baseline()
    old = copy.deepcopy(claim['input']['document']['assets'])
    claim['input']['brief']['product'] = 'G65，黑色外壳。'
    api, provider = Api(claim), UpdateProvider(claim, change=True)
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert provider.calls == ['ASSET_UPDATE_SCOPE', 'ASSET_UPDATE_PATCHES', 'ASSET_REVIEW']
    assert api.completed['assets'][0]['description'] == '黑色外壳'
    assert api.completed['assets'][0]['image'] == old[0]['image']
    assert api.completed['assets'][0]['designNotes'] == old[0]['designNotes']
    assert api.completed['assets'][1:] == old[1:]
    assert claim['input']['document']['assets'] == old


@pytest.mark.asyncio
async def test_dialogue_only_change_can_keep_all_assets_without_any_definition_or_patch_call() -> None:
    claim = await baseline()
    claim['input']['script']['story']['content'] += '他笑着说：“走吧。”'
    api, provider = Api(claim), UpdateProvider(claim)
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed['assets'] == claim['input']['document']['assets']
    assert provider.calls == ['ASSET_UPDATE_SCOPE', 'ASSET_REVIEW']
    retry = UpdateProvider(claim)
    await run_assets(api, retry, claim)  # type: ignore[arg-type]
    assert retry.calls == []


@pytest.mark.asyncio
async def test_needed_new_prop_only_defines_the_prop_and_preserves_existing_objects() -> None:
    claim = await baseline()
    api, provider = Api(claim), UpdateProvider(claim, add=True)
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed['assets'][:-1] == claim['input']['document']['assets']
    assert api.completed['assets'][-1]['id'] == 'asset-update-1'
    assert provider.calls == ['ASSET_UPDATE_SCOPE', 'ASSET_DEFINE_PROP', 'ASSET_REVIEW']


@pytest.mark.asyncio
async def test_update_resume_keeps_the_scope_and_does_not_repurchase_it() -> None:
    claim = await baseline()
    claim['input']['brief']['product'] = 'G65，黑色外壳。'
    api, provider = Api(claim), UpdateProvider(claim, change=True, fail_patch=True)
    with pytest.raises(RuntimeError):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert claim['output']['assetUpdatePlan'] and api.completed is None
    retry = UpdateProvider(claim, change=True)
    await run_assets(api, retry, claim)  # type: ignore[arg-type]
    assert retry.calls == ['ASSET_UPDATE_PATCHES', 'ASSET_REVIEW']


@pytest.mark.asyncio
async def test_manual_conflict_stops_before_patch_and_does_not_overwrite_original() -> None:
    claim = await baseline()
    claim['input']['document']['assets'][0]['manualFields'] = ['description']
    claim['input']['brief']['product'] = 'G65，黑色外壳。'
    api, provider = Api(claim), UpdateProvider(claim, change=True)
    with pytest.raises(ValueError, match='人工字段'):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert provider.calls == ['ASSET_UPDATE_SCOPE'] and api.completed is None


@pytest.mark.asyncio
async def test_cross_asset_patch_is_saved_then_rejected_without_adoption() -> None:
    claim = await baseline()
    claim['input']['brief']['product'] = 'G65，黑色外壳。'
    api, provider = Api(claim), UpdateProvider(claim, change=True, wrong_patch=True)
    with pytest.raises(ValueError, match='outside'):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert claim['output']['assetUpdatePatches'] and api.completed is None
    assert claim['input']['document']['assets'][0]['description'] == '灰色外壳'


@pytest.mark.asyncio
async def test_independent_review_cannot_silently_expand_the_planned_scope() -> None:
    claim = await baseline()
    api, provider = Api(claim), UpdateProvider(claim, outside_review=True)
    with pytest.raises(ValueError, match='超出'):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert provider.calls == ['ASSET_UPDATE_SCOPE', 'ASSET_REVIEW'] and api.completed is None
    assert next(s for s in claim['steps'] if s['id'] == 'REPAIR')['status'] == 'FAILED'


@pytest.mark.asyncio
async def test_invalid_keep_evidence_has_one_bounded_correction_and_preserves_the_failed_plan() -> None:
    claim = await baseline()
    claim['input']['brief']['product'] = 'G65，黑色外壳。'
    api, provider = Api(claim), UpdateProvider(claim)
    with pytest.raises(ValueError, match='依据'):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert provider.calls == ['ASSET_UPDATE_SCOPE', 'ASSET_UPDATE_SCOPE_CORRECTION']
    assert claim['output']['assetUpdatePlan'] and api.completed is None
    retry = UpdateProvider(claim)
    with pytest.raises(ValueError):
        await run_assets(api, retry, claim)  # type: ignore[arg-type]
    assert retry.calls == []


@pytest.mark.asyncio
async def test_source_quote_refresh_preserves_every_visual_and_manual_attribute() -> None:
    claim = await baseline()
    person = claim['input']['document']['assets'][1]
    claim['input']['script']['story']['content'] = '周越在候车区等车时使用充电器。'

    class QuoteProvider(UpdateProvider):
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            if stage == 'ASSET_UPDATE_SCOPE':
                value = (await super().generate(stage, model, schema, context, instruction)).model_dump()
                # Both source quotes need refreshing, while every public definition is stable.
                for decision in value['decisions'][1:]:
                    decision.update(fields=['preparation'], reason='仅同步原文引用')
                return schema.model_validate(value)
            if stage == 'ASSET_UPDATE_PATCHES':
                self.calls.append(stage)
                patches = []
                for old in claim['input']['document']['assets'][1:]:
                    prep = copy.deepcopy(old['preparation'])
                    prep['sources'][0]['quote'] = claim['input']['script']['story']['content']
                    patches.append({'assetId': old['id'], 'field': 'preparation', 'text': None, 'preparation': prep})
                return schema.model_validate({'patches': patches})
            return await super().generate(stage, model, schema, context, instruction)

    api, provider = Api(claim), QuoteProvider(claim)
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    actual = copy.deepcopy(api.completed['assets'][1])
    actual['preparation']['sources'] = person['preparation']['sources']
    assert actual == person
    assert provider.calls == ['ASSET_UPDATE_SCOPE', 'ASSET_UPDATE_PATCHES', 'ASSET_REVIEW']
