"""Version-one local storyboard update with stable identities and full source validation."""
from __future__ import annotations
import copy
from typing import Any, Annotated
from pydantic import Field
from .models import Model, Id
from .video_models import VideoPlan, Audit
from .video_domain import validate_plan, validate_audit, fingerprint, identity_prefix, ms


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


def normalize_full_unit_offsets(plan: dict[str, Any], frozen_units: list[dict[str, Any]]) -> int:
    """Convert only an exact whole-unit source range on the frozen script."""
    if plan['sourceUnits'] != frozen_units:
        return 0
    units = {unit['id']: unit for unit in frozen_units}
    refs = [ref for event in plan['events'] for ref in event['sourceRefs']]
    refs.extend(cue['sourceRef'] for cue in plan['cues'])
    count = 0
    for ref in refs:
        unit = units.get(ref['unitId'])
        if not unit or unit['start'] == 0:
            continue
        length = len(unit['text'])
        if unit['end'] == unit['start'] + length and (ref['start'], ref['end']) == (unit['start'], unit['end']):
            ref.update(start=0, end=length)
            count += 1
    return count


def mark_reference_timing_advisory(audit: dict[str, Any], plan: dict[str, Any], baseline: dict[str, Any]) -> int:
    """An unchanged shot schedule is not infeasible solely because of a reference value."""
    def schedule(value: dict[str, Any]) -> list[tuple[str, list[tuple[str, float]]]]:
        seconds = {shot['id']: shot['durationSeconds'] for shot in value['shots']}
        return [(clip['id'], [(shot_id, seconds[shot_id]) for shot_id in clip['shotIds']]) for clip in value['clips']]

    policy = plan['durationPolicy']
    if (policy['mode'] != 'REFERENCE' or schedule(plan) != schedule(baseline)
            or sum(ms(shot['durationSeconds']) for shot in plan['shots']) == ms(policy['seconds'])):
        return 0
    reference = ('TIMING', 'durationPolicy', 'seconds')
    shot_durations = {('SHOT', shot['id'], 'durationSeconds') for shot in plan['shots']}
    count = 0
    for finding in audit['findings']:
        evidence = {(item['entity'], item['id'], item['field']) for item in finding['evidence']}
        if (finding['severity'] == 'ERROR' and finding['category'] == 'CAPACITY'
                and (evidence == {reference} or evidence == shot_durations | {reference})):
            finding.update(severity='WARNING', title='现有镜头时长与参考值有差异',
                           impact='本次沿用已确认的镜头时长，参考时长用于对照。', suggestedFix='保留本次分镜时长。')
            count += 1
    if count and not any(f['severity'] == 'ERROR' for f in audit['findings']):
        audit['summary'] = '已核对局部分镜。本次沿用既有镜头时长，与参考值的差异已列为提示。'
    return count


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
            'sourceUnits的start/end是全文坐标。每条sourceRef的start/end从所引用原句的开头计数，整句用start=0和end=该句字符数。'
            '每clip对应一个完整shot，完整shot使用整数秒且符合capability。durationPolicy、capability原样返回。'
            '产品事实只引用brief，不新增事实；资产绑定只能使用提供的assets，不修改资产定义。'
            'changes覆盖所有实际修改、删除、新增的clipId；每条reason说明来源变化或具体衔接理由，未改变项不列入。')
        stored['localCandidate'] = value.model_dump()
        await step('GENERATE', 'RUNNING', '候选已保存，正在校验身份、原文和未改范围。')
    try:
        value = Update.model_validate(stored['localCandidate']).model_dump()
        plan = value['plan']
        converted = normalize_full_unit_offsets(plan, snapshot['sourceUnits'])
        validate_plan(plan, snapshot)
        validate_scope(plan, value['changes'], snapshot)
    except ValueError:
        stored['failureReason'] = 'INVALID_CANDIDATE'
        await step('GENERATE', 'FAILED', '候选分镜的原文引用、时长或修改范围未通过核对。请重新查看局部更新范围，原分镜仍可使用。')
        raise
    stored.pop('failureReason', None)
    stored['localCandidate'] = value
    if converted:
        stored['localSourceOffsetCount'] = converted
    stored['value'] = {'schemaVersion': 2, 'assets': snapshot['document']['assets'], 'videoPlan': plan}
    stored['final'] = stored['value']
    stored['changes'] = value['changes']
    changes = '\n'.join(c['reason'] for c in value['changes']) or '原有镜头内容可继续使用，仅核对来源。'
    if stored.get('localSourceOffsetCount'):
        changes = f"已按原句校正 {stored['localSourceOffsetCount']} 处引用位置。\n" + changes
    await step('GENERATE', 'SUCCEEDED', changes)
    if 'audit' not in stored:
        await step('REVIEW', 'RUNNING', '独立核对完整原稿、产品事实和镜头衔接。')
        audit = await provider.generate('VIDEO_REVIEW', snapshot['models']['creative'], Audit,
            {'script': snapshot['script'], 'brief': snapshot['brief'], 'assets': snapshot['document']['assets'], 'baseline': snapshot['document']['videoPlan'], 'plan': plan, 'changes': value['changes']},
            '独立审校完整分镜的原稿兑现、时间容量、镜头表达、产品事实、动作与空间、素材绑定、模型能力七个维度。'
            '核对局部修改有实际来源依据、未改内容被保留、前后衔接自然；对白与画面文字必须对应准确原文和时间窗。'
            'REFERENCE只是参考值，原有镜头时长未变时与参考值的差异属于WARNING。真正的容量错误须引用实际受影响镜头、动作或对白时间窗。'
            '时长政策用TIMING/durationPolicy及mode或seconds字段，能力配置用TIMING/capability及实际字段。'
            'findings仅引用plan实际实体、字段，列出真实ERROR/WARNING及影响镜头；不存在既有问题时resolutions为空。')
        stored['audit'] = audit.model_dump()
        stored['auditHash'] = fingerprint(plan)
        await step('REVIEW', 'RUNNING', '审校候选已保存，正在校验引用。')
    try:
        stored['localReviewPolicyVersion'] = 1
        if stored['auditHash'] != fingerprint(plan):
            raise ValueError('local review belongs to another storyboard')
        checked_review = Audit.model_validate(stored['audit']).model_dump()
        if mark_reference_timing_advisory(checked_review, plan, snapshot['document']['videoPlan']):
            stored.setdefault('localOriginalAudit', stored['audit'])
            stored['audit'] = checked_review
        validate_audit(checked_review, plan)
        if any(f['severity'] == 'ERROR' for f in checked_review['findings']) or any(r['status'] != 'RESOLVED' for r in checked_review['resolutions']):
            raise ValueError('local storyboard review unresolved')
    except ValueError:
        stored['failureReason'] = 'REVIEW_UNRESOLVED'
        await step('REVIEW', 'FAILED', '分镜审校仍有待核对的内容。请查看原因后重新发起分镜局部更新，原分镜和候选已保留。')
        raise
    await step('REVIEW', 'SUCCEEDED', stored['audit']['summary'])
    await step('REPAIR', 'SUCCEEDED', '本次候选通过校验，无需额外修改。')
    await api.call('POST', 'complete', {'output': stored['final']})
