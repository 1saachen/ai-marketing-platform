"""Task-local script patches; an accepted candidate still requires explicit human save."""
from __future__ import annotations
import copy
import re
import hashlib
import json
from typing import Any, Annotated, Self
from pydantic import Field, model_validator
from ai_runtime.responses import ProviderError
from .models import Model, Text, Review


class TextPatch(Model):
    path: Annotated[str, Field(min_length=1, max_length=200)]
    before: Annotated[str, Field(min_length=1, max_length=20000)]
    after: Text
    reason: Annotated[str, Field(min_length=1, max_length=2000)]


class Patches(Model):
    patches: Annotated[list[TextPatch], Field(max_length=100)]


def scoped_patches(script: dict[str, Any]) -> type[Patches]:
    """Expose only exact existing text locations; no fuzzy field or text matching."""
    paths = [key for key in ('name', 'synopsis', 'structure', 'productFocus') if isinstance(script.get(key), str)]
    story = script.get('story')
    if isinstance(story, dict):
        paths += ['story/' + key for key in ('content', 'structure', 'opening', 'development', 'ending', 'dialoguePlan') if isinstance(story.get(key), str)]
        beats = story.get('beats', [])
        if isinstance(beats, list):
            paths += [f'story/beats/{i}/content' for i, beat in enumerate(beats) if isinstance(beat, dict) and isinstance(beat.get('content'), str)]
    allowed = frozenset(paths)

    class ScopedPatches(Patches):
        @classmethod
        def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
            schema = super().model_json_schema(*args, **kwargs)
            schema['$defs']['TextPatch']['properties']['path']['enum'] = sorted(allowed)
            return schema

        @model_validator(mode='after')
        def known_paths(self) -> Self:
            if any(p.path not in allowed for p in self.patches):
                raise ValueError('patch refers to an unavailable text field')
            return self

    return ScopedPatches


class PatchApplicationError(ValueError):
    def __init__(self, index: int, reason: str) -> None:
        self.user_message = f'第 {index + 1} 项脚本修改{reason}，未修改原脚本。已保留改稿结果，可继续本次更新重新核对。'
        super().__init__(self.user_message)


def apply_patches(script: dict[str, Any], patches: list[dict[str, Any]]) -> dict[str, Any]:
    result = copy.deepcopy(script)
    for index, patch in enumerate(patches):
        if not isinstance(patch.get('path'), str) or not re.fullmatch(r"name|synopsis|structure|productFocus|story/(?:content|structure|opening|development|ending|dialoguePlan)|story/beats/\d+/content", patch['path']):
            raise PatchApplicationError(index, '的位置不正确')
        parts = patch['path'].split('/')
        parent: Any = result
        try:
            for part in parts[:-1]:
                parent = parent[int(part)] if isinstance(parent, list) else parent[part]
            value = parent[parts[-1]]
        except (KeyError, IndexError, TypeError):
            raise PatchApplicationError(index, '指定的正文位置不存在') from None
        if not isinstance(value, str) or not isinstance(patch.get('before'), str) or not patch['before']:
            raise PatchApplicationError(index, '缺少有效原文')
        first, last = value.find(patch['before']), value.rfind(patch['before'])
        if first < 0:
            raise PatchApplicationError(index, '引用的原文与当前脚本不一致')
        if first != last:
            raise PatchApplicationError(index, '引用的原文出现多次，无法唯一定位')
        if not isinstance(patch.get('after'), str) or not isinstance(patch.get('reason'), str) or not patch['reason'].strip():
            raise PatchApplicationError(index, '缺少替换内容或修改依据')
        updated = value.replace(patch['before'], patch['after'], 1)
        if len(updated.encode('utf-16-le')) // 2 > 20000:
            raise PatchApplicationError(index, '后的正文超过长度限制')
        parent[parts[-1]] = updated
    return result


async def run(pipeline: Any) -> None:
    local = pipeline.input['incremental']
    if local['version'] != 1:
        raise ValueError('unknown script update version')
    sid = local['scriptId']
    await pipeline.step('SNAPSHOT', '', 'SUCCEEDED', {'source': pipeline.input['source']})
    saved = pipeline.checkpoints.get(('STORY', sid))
    if saved and saved['status'] == 'SUCCEEDED':
        patches = saved['output']['patches']
        script = apply_patches(local['baseline'], patches)
        if script != saved['output']['script']:
            raise ValueError('saved patch candidate differs from baseline')
    else:
        stored = saved.get('output') if saved else None
        pending = stored.get('patches') if isinstance(stored, dict) else None
        patches = pending if isinstance(pending, list) else None
        issue = ''
        if patches is not None:
            try:
                script = apply_patches(local['baseline'], patches)
            except PatchApplicationError as error:
                issue = error.user_message
        if patches is None or issue:
            # Retain an earlier response through provider/transport failure. A user-triggered
            # retry can use its precise mechanical error without repurchasing a valid draft.
            previous = {'patches': patches} if patches is not None else None
            await pipeline.step('STORY', sid, 'RUNNING', previous)
            context = {'oldBrief': local['previousBrief'], 'currentScript': local['baseline']}
            if local.get('reviewFeedback'):
                context['reviewFeedback'] = local['reviewFeedback']
            if issue:
                context.update({'previousPatchCandidate': patches, 'mechanicalIssue': issue})
            try:
                value = await pipeline.model('STORY', scoped_patches(local['baseline']), context,
                    '本次只做当前脚本的定向更新，不重新构思故事。比较旧信息卡与当前brief，识别实际影响原文的变化。'
                    '只返回有必要的精确文本补丁；正常正文原样保留，保留人物关系、观看事件和叙事主线，不为新增卖点强加段落。'
                    'path必须逐字采用Schema枚举的斜杠路径，例如story/content、story/beats/0/content；禁止点号路径或概括字段名。'
                    'before必须逐字复制currentScript对应字段中唯一存在的原文；短语重复时包含前后文使其唯一，不自行改标点、换行或空格。'
                    '同字段的多项修改按顺序应用，后项必须基于前项修改后的文本。after给出替换文字，reason说明新资料依据。身份、创作类型、叙事主线和时长不能改变。'
                    '如有previousPatchCandidate及mechanicalIssue，只修正其中无法精确应用的位置或原文，保持其余必要修改。'
                    '如有reviewFeedback，按上次审核指出的ERROR修正候选遗漏，保留此前正确的修改；仍输出相对currentScript原始基线的全部必要补丁，不是只输出相对上次候选的补丁。'
                    '根级structure是叙事结构说明正文，不是类型枚举；其中的产品事实必须与synopsis概要、productFocus产品关联、story正文及各篇章同步核对并按需修改。'
                    '旧稿如另有story/structure，也只核对已有文本，不创建缺失字段。creation/videoType、settings/structureMode等类型配置不可修改。'
                    '不需要修改时返回空patches。')
            except ProviderError as error:
                await pipeline.step('STORY', sid, 'FAILED', previous, error=str(error))
                raise
            patches = value.model_dump()['patches']
            # Save the paid structured response before applying it, including an invalid
            # response. It is a task checkpoint, never a confirmed script publication.
            await pipeline.step('STORY', sid, 'RUNNING', {'patches': patches})
            try:
                script = apply_patches(local['baseline'], patches)
            except PatchApplicationError as error:
                await pipeline.step('STORY', sid, 'FAILED', {'patches': patches}, error=error.user_message)
                raise
        await pipeline.step('STORY', sid, 'SUCCEEDED', {'patches': patches, 'script': script})
    saved_review = pipeline.checkpoints.get(('REVIEW', sid))
    candidate_hash = hashlib.sha256(json.dumps(script, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    if saved_review and saved_review['status'] == 'SUCCEEDED':
        if saved_review['output'].get('candidateHash') != candidate_hash:
            raise ValueError('review belongs to another candidate')
        review = Review.model_validate({k: v for k, v in saved_review['output'].items() if k != 'candidateHash'})
    else:
        await pipeline.step('REVIEW', sid, 'RUNNING')
        # No Script model/timeline projection: this is a full STORY_ONLY script.
        review = await pipeline.provider.generate('REVIEW', pipeline.input['models']['creative'], Review,
            {'brief': pipeline.input['brief'], 'oldBrief': local['previousBrief'], 'before': local['baseline'], 'candidate': script, 'patches': patches},
            '独立审校定向修改后的完整脚本。确认所有商品事实与当前brief一致，人工创作与未受影响正文得到保留，正文与概要连贯。'
            '不得把旧资料当成当前事实。findings列出实际错误、准确引文和可执行的修正建议；无问题返回空findings。'
            '面向运营用户，message/evidence/suggestion使用正文、故事段落、故事结构说明、产品外观等普通中文称呼，不输出JSON字段路径或内部术语。'
            'shotIds为空，当前不是分镜任务。')
        await pipeline.step('REVIEW', sid, 'SUCCEEDED', {**review.model_dump(), 'candidateHash': candidate_hash})
    if any(f.severity == 'ERROR' for f in review.findings):
        raise ValueError('script update review unresolved')
    await pipeline.api.call('POST', 'scripts', {'script': script})
    await pipeline.api.call('POST', 'finish', {})
