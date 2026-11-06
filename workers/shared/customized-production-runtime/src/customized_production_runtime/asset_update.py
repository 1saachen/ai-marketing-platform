"""AI-selected fields within the existing ASSETS task and checkpoint boundary."""
from __future__ import annotations
import copy
from typing import Any, Awaitable, Callable
from .provider import Provider
from .asset_models import AssetUpdatePlan, AssetRepair, AssetDefinition
from .asset_pipeline import align_inventory, apply_repair, check_evidence, evidence_index, protected_fields, validate_definitions

Checkpoint = Callable[[str, str, str, str], Awaitable[None]]


def validate_plan(plan: dict[str, Any], snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    AssetUpdatePlan.model_validate(plan)
    existing = {a['id']: a for a in snapshot['document']['assets']}
    decisions = plan['decisions']
    if len(decisions) != len(existing) or {d['assetId'] for d in decisions} != set(existing):
        raise ValueError('判断结果必须逐项覆盖当前资产，不能遗漏、重复或引用其他资产')
    index = evidence_index(snapshot)
    for decision in decisions:
        fields = decision['fields']
        old = existing[decision['assetId']]
        if len(fields) != len(set(fields)):
            raise ValueError('同一资产不能重复指定修改字段')
        if not fields:
            try:
                check_evidence(old.get('preparation', {}).get('sources', []), index, old['kind'])
            except ValueError:
                raise ValueError('保留的资产依据已失效，应仅将其分类定义纳入核对并同步准确原文依据') from None
    return align_inventory({'objects': plan['additions']}, snapshot, additions_only=True) if plan['additions'] else []


def validate_scope(assets: list[dict[str, Any]], plan: dict[str, Any], snapshot: dict[str, Any], inventory: list[dict[str, Any]]) -> None:
    before = {a['id']: a for a in snapshot['document']['assets']}
    after = {a['id']: a for a in assets}
    allowed = {d['assetId']: set(d['fields']) for d in plan['decisions']}
    if len(after) != len(assets) or set(after) != set(before) | {a['id'] for a in inventory}:
        raise ValueError('局部更新不能删除资产或新增判断范围外的对象')
    for aid, old in before.items():
        current = after[aid]
        for field in set(old) | set(current):
            if field not in allowed[aid] and (field in old) != (field in current):
                raise ValueError('局部更新新增或删除了范围外的字段')
            if field not in allowed[aid] and old.get(field) != current.get(field):
                raise ValueError('局部更新改写了应保留的资产内容')
        if any(old.get(field) != current.get(field) for field in protected_fields(old)):
            raise ValueError('局部更新不能覆盖人工修改')


def validate_candidate(assets: list[dict[str, Any]], inventory: list[dict[str, Any]], snapshot: dict[str, Any], plan: dict[str, Any]) -> None:
    validate_scope(assets, plan, snapshot, inventory)
    new_ids = {a['id'] for a in inventory}
    expected = inventory + [{'id': a['id'], 'kind': a['kind'], 'treatment': a.get('preparation', {}).get('treatment'),
        'parentId': a.get('preparation', {}).get('parentId')} for a in assets if a['id'] not in new_ids]
    # File bindings and edit metadata are retained verbatim, not model output fields.
    definitions = [{k: a.get(k, '') for k in AssetDefinition.model_fields} for a in assets]
    validate_definitions(definitions, expected, snapshot)


async def prepare_update(provider: Provider, snapshot: dict[str, Any], stored: dict[str, Any], context: dict[str, Any], checkpoint: Checkpoint) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    instruction = (
        '判断当前脚本与信息卡对已有资产的实际影响，不重新设计整份目录。逐项返回decisions，assetId必须准确且每个已有对象恰好一次。'
        'fields为空表示原样保留；有实质影响时只列必要修改字段并用普通中文说明依据。不得因脚本版本变化而全部重做。'
        '仅改台词、措辞、动作顺序且不影响公共外观/用途/归属的，保留资产；改产品配色通常只影响产品及确实写入该配色的关联定义。'
        '若仅原文引用失效，只修改preparation中的sources，保持其中其他内容。已有美术设计没有冲突时不优化、不换形象、不重命名。'
        '同时核对description、knownFacts、designNotes、sourceText、imageRequirements及preparation，避免只修改一处留下相同错误。'
        'additions只包含确实缺少的必要新对象，existingId必须为null；复用已有父对象准确id，不把同一对象作为新增。'
        '不隐式删除资产；未再出场的旧对象保留。人工内容与新事实冲突或不能可靠判断时放入blockers，说明用户需要核对什么，不能静默覆盖。'
        '来源引用必须是sources准确path和连续原文；保留对象的已有引用也必须仍然有效。只核对文字，不生成或替换图片。')
    if 'assetUpdatePlan' not in stored:
        await checkpoint('INVENTORY', 'RUNNING', '判断必要修改范围', '正在核对哪些资产需要修改，其他资产将原样保留。')
        result = await provider.generate('ASSET_UPDATE_SCOPE', snapshot['models']['creative'], AssetUpdatePlan, context, instruction)
        stored['assetUpdatePlan'] = result.model_dump()
        await checkpoint('INVENTORY', 'RUNNING', '核对判断范围', '判断结果已保留，正在校验对象身份和原文依据。')
    try:
        inventory = validate_plan(stored['assetUpdatePlan'], snapshot)
    except ValueError as error:
        if stored.get('assetUpdateScopeCorrectionAttempted'):
            await checkpoint('INVENTORY', 'FAILED', '更新范围需要核对', str(error))
            raise
        stored['assetUpdateScopeCorrectionAttempted'] = True
        await checkpoint('INVENTORY', 'RUNNING', '核对范围与引用', '正在对判断结果进行一次身份和原文校验修正。')
        result = await provider.generate('ASSET_UPDATE_SCOPE_CORRECTION', snapshot['models']['creative'], AssetUpdatePlan,
            {**context, 'candidate': stored['assetUpdatePlan'], 'validationError': str(error)}, instruction + '只纠正机械校验问题，不能扩大为全量重新整理。')
        stored['assetUpdatePlan'] = result.model_dump()
        await checkpoint('INVENTORY', 'RUNNING', '核对修正后的范围', '已保留范围修正结果。')
        try:
            inventory = validate_plan(stored['assetUpdatePlan'], snapshot)
        except ValueError:
            await checkpoint('INVENTORY', 'FAILED', '更新范围需要重新判断', '对象身份或原文引用校正后仍不可靠，请重新发起局部更新或人工核对资产；原内容保留。')
            raise
    plan = stored['assetUpdatePlan']
    names = {a['id']: a['name'] for a in snapshot['document']['assets']}
    summary = '\n'.join(names[d['assetId']] + ('：需更新；' if d['fields'] else '：原样保留；') + d['reason'] for d in plan['decisions'])
    if plan['blockers']:
        await checkpoint('INVENTORY', 'FAILED', '需要人工核对', '\n'.join(plan['blockers']))
        raise ValueError('资产更新存在需要人工核对的问题，请查看更新范围')
    stored['inventory'] = inventory
    await checkpoint('INVENTORY', 'SUCCEEDED', '实际更新范围', summary + f'\n必要新增对象：{len(inventory)} 项。')
    findings = [{'assetId': d['assetId'], 'field': field, 'issue': d['reason'], 'basis': d['reason'], 'severity': 'REQUIRED'} for d in plan['decisions'] for field in d['fields']]
    existing = snapshot['document']['assets']
    if any(f['field'] in protected_fields(next(a for a in existing if a['id'] == f['assetId'])) for f in findings):
        await checkpoint('IDENTITY', 'FAILED', '人工内容需要核对', '必要修改涉及人工保存的资产字段，请查看判断依据并在资产编辑中核对。')
        raise ValueError('必要修改涉及人工字段，未覆盖原内容')
    if 'assetUpdateBase' not in stored:
        if findings:
            await checkpoint('IDENTITY', 'RUNNING', '定向修改已有资产', summary)
            if 'assetUpdatePatches' not in stored:
                patch = await provider.generate('ASSET_UPDATE_PATCHES', snapshot['models']['detail'], AssetRepair,
                    {**context, 'assets': existing, 'findings': findings},
                    '只返回findings指定的准确assetId及field补丁，每个指定字段一次，正常字段不改。以已有定义为基线做最小必要修改，不重设计、不改身份，不替换图片。'
                    'preparation字段返回完整结构且text为null；如果只是引用变化，仅调整sources，保留其余属性。其他字段填text且preparation为null。人工字段不覆盖，产品事实只引用当前BRIEF。')
                stored['assetUpdatePatches'] = patch.model_dump()
                await checkpoint('IDENTITY', 'RUNNING', '核对定向修改结果', '已保留修改结果，正在校验实际字段。')
            try:
                base = apply_repair(existing, stored['assetUpdatePatches'], {'findings': findings}, snapshot)
            except ValueError:
                await checkpoint('IDENTITY', 'FAILED', '定向修改范围需要核对', '修改结果未通过字段范围校验。已保留结果，原内容不变；请重新发起局部更新或人工核对资产。')
                raise
        else:
            base = copy.deepcopy(existing)
        validate_scope(base + [dict(a) for a in inventory], plan, snapshot, inventory)
        stored['assetUpdateBase'] = base
        await checkpoint('IDENTITY', 'SUCCEEDED', '保留身份与无关内容', summary)
    return inventory, copy.deepcopy(stored['assetUpdateBase'])
