"""Version-one local storyboard update with stable identities and full source validation."""
from __future__ import annotations
import copy
from typing import Any, Annotated
from pydantic import Field
from .models import Model, Id, Text
from .video_models import VideoPlan, Audit
from .video_domain import validate_plan, validate_audit, fingerprint, identity_prefix


class Change(Model):
    clipId: Id
    reason: Annotated[str, Field(min_length=1, max_length=2000)]


class Update(Model):
    plan: VideoPlan
    changes: Annotated[list[Change], Field(max_length=500)]


def projection(plan: dict[str, Any], clip: dict[str, Any]) -> dict[str, Any]:
    ids = set(clip['shotIds'])
    return {'clip': clip, 'scene': next(s for s in plan['scenes'] if s['id'] == clip['sceneId']),
            'shots': [s for s in plan['shots'] if s['id'] in ids],
            'cues': [c for c in plan['cues'] if any(p['shotId'] in ids for p in c['parts'])]}


def validate_scope(plan: dict[str, Any], changes: list[dict[str, Any]], snapshot: dict[str, Any]) -> None:
    baseline = snapshot['document']['videoPlan']
    old = {c['id']: c for c in baseline['clips']}
    new = {c['id']: c for c in plan['clips']}
    declared = {c['clipId'] for c in changes}
    allowed = set(snapshot['incremental']['targetIds'])
    if len(declared) != len(changes) or any(not c['reason'].strip() for c in changes):
        raise ValueError('invalid update reasons')
    if not declared <= (set(old) | set(new)) or not (declared & set(old)) <= allowed:
        raise ValueError('update exceeded frozen scope')
    if any(not cid.startswith(identity_prefix(snapshot['identitySeed'])) for cid in set(new) - set(old)):
        raise ValueError('new clip identity is not task scoped')
    for cid, clip in old.items():
        if cid not in declared and (cid not in new or fingerprint(projection(baseline, clip)) != fingerprint(projection(plan, new[cid]))):
            raise ValueError('undeclared clip changed')
    if (set(old) ^ set(new)) - declared:
        raise ValueError('structural change has no reason')


async def run(api: Any, provider: Any, claim: dict[str, Any]) -> None:
    snapshot = claim['input']
    if snapshot['incremental']['version'] != 1 or snapshot['document'].get('schemaVersion') != 2:
        raise ValueError('local update requires a current storyboard baseline')
    stored = copy.deepcopy(claim.get('output') or {})

    async def step(node: str, status: str, content: str) -> None:
        await api.call('PUT', 'checkpoint', {'step': {'id': node, 'status': status, 'title': '分镜局部更新', 'content': content}, 'output': stored})

    await step('SNAPSHOT', 'SUCCEEDED', '已固定最新脚本、资产和原分镜，不修改其他分支。')
    await step('PLAN', 'SUCCEEDED', '核对原文变化与实际镜头引用，保留正常镜头；衔接变化逐项说明。')
    if 'localCandidate' not in stored:
        await step('GENERATE', 'RUNNING', '正在更新必要分镜与原文引用。')
        value = await provider.generate('VIDEO_REPAIR', snapshot['models']['creative'], Update,
            {'script': snapshot['script'], 'brief': snapshot['brief'], 'assets': snapshot['document']['assets'],
             'baseline': snapshot['document']['videoPlan'], 'newSourceUnits': snapshot['sourceUnits'], 'newSources': snapshot['sources'],
             'durationPolicy': snapshot['durationPolicy'], 'capability': snapshot['renderCapability'],
             'allowedClipIds': snapshot['incremental']['targetIds'], 'newIdentityPrefix': identity_prefix(snapshot['identitySeed'])},
            '对现有完整分镜做必要的局部更新，不重新创作整片。对比baseline来源原文和newSourceUnits、当前script与brief，保留没有受到影响的镜头、场景、事件、声音和身份。'
            '所有保留镜头沿用原clip和shot的ID；只在确有新增或拆并需要时新增，以newIdentityPrefix开头。'
            '未改变的镜头及关联scene/shot/cue逐字段原样返回。需要调整衔接的邻镜也列入changes并说明reason。'
            '正确同步sourceUnits、sources及所有原文引用和对白时间窗，声音原话完整保留、不重复、不省略。'
            '每clip对应一个完整shot，完整shot使用整数秒且符合capability。durationPolicy、capability原样返回。'
            '产品事实只引用brief，不新增事实；资产绑定只能使用提供的assets，不修改资产定义。'
            'changes覆盖所有实际修改、删除、新增的clipId；每条reason说明来源变化或具体衔接理由，未改变项不列入。')
        stored['localCandidate'] = value.model_dump()
        await step('GENERATE', 'RUNNING', '候选已保存，正在校验身份、原文和未改范围。')
    value = stored['localCandidate']
    plan = value['plan']
    validate_plan(plan, snapshot)
    validate_scope(plan, value['changes'], snapshot)
    stored['value'] = {'schemaVersion': 2, 'assets': snapshot['document']['assets'], 'videoPlan': plan}
    stored['final'] = stored['value']
    stored['changes'] = value['changes']
    await step('GENERATE', 'SUCCEEDED', '\n'.join(c['reason'] for c in value['changes']) or '原有镜头内容可继续使用，仅核对来源。')
    if 'audit' not in stored:
        await step('REVIEW', 'RUNNING', '独立核对完整原稿、产品事实和镜头衔接。')
        audit = await provider.generate('VIDEO_REVIEW', snapshot['models']['creative'], Audit,
            {'script': snapshot['script'], 'brief': snapshot['brief'], 'assets': snapshot['document']['assets'], 'baseline': snapshot['document']['videoPlan'], 'plan': plan, 'changes': value['changes']},
            '独立审校完整分镜的原稿兑现、时间容量、镜头表达、产品事实、动作与空间、素材绑定、模型能力七个维度。'
            '核对局部修改有实际来源依据、未改内容被保留、前后衔接自然；对白与画面文字必须对应准确原文和时间窗。'
            'findings仅引用plan实际实体、字段，列出真实ERROR/WARNING及影响镜头；不存在既有问题时resolutions为空。')
        stored['audit'] = audit.model_dump()
        stored['auditHash'] = fingerprint(plan)
        await step('REVIEW', 'RUNNING', '审校候选已保存，正在校验引用。')
    validate_audit(stored['audit'], plan)
    if stored['auditHash'] != fingerprint(plan) or any(f['severity'] == 'ERROR' for f in stored['audit']['findings']) or any(r['status'] != 'RESOLVED' for r in stored['audit']['resolutions']):
        await step('REVIEW', 'FAILED', '局部更新仍有需要处理的问题，旧内容和候选保留。')
        raise ValueError('local storyboard review unresolved')
    await step('REVIEW', 'SUCCEEDED', stored['audit']['summary'])
    await step('REPAIR', 'SUCCEEDED', '本次候选通过校验，无需额外修改。')
    await api.call('POST', 'complete', {'output': stored['final']})
