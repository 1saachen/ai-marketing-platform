from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Self

import httpx
from ai_runtime.responses import StructuredResponsesMixin
from jsonschema import ValidationError
from pydantic import RootModel, model_validator

from .media import _MP4_INPUT, _run
from .plan import SHOT_REFERENCE_MODE, SOURCE_EDIT_MODE, prompt_product_fields, validator


class ReviewOutput(RootModel[dict[str, Any]]):
    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
        schema = validator("review").schema
        if isinstance(schema, bool):
            raise TypeError("review schema must be an object")
        return dict(schema)

    @model_validator(mode="after")
    def conforms(self) -> Self:
        try:
            validator("review").validate(self.root)
        except ValidationError as error:
            raise ValueError("review does not match the shared contract") from error
        return self


def _baseline_frames(shot: dict[str, Any]) -> set[int]:
    return {
        shot["startFrame"],
        (shot["startFrame"] + shot["endFrame"] - 1) // 2,
        shot["endFrame"] - 1,
    }


def frame_numbers(plan: dict[str, Any]) -> dict[str, list[int]]:
    timeline = plan["timeline"]
    numerator = timeline["fpsNumerator"]
    units = 1000 * timeline["fpsDenominator"]
    observed_motion = {
        shot["shotId"]: shot["motion"]["events"]
        for shot in plan["shots"]
        if shot.get("motion", {}).get("status") == "OBSERVED"
    }
    evidence: dict[str, list[int]] = {}
    for shot in timeline["shots"]:
        frames = _baseline_frames(shot)
        for event in observed_motion.get(shot["shotId"], []):
            times = event["evidenceFramesMs"]
            relative_ms = times[(len(times) - 1) // 2]
            offset = (2 * relative_ms * numerator + units) // (2 * units)
            frames.add(min(shot["startFrame"] + offset, shot["endFrame"] - 1))
        evidence[shot["shotId"]] = sorted(frames)
    return evidence


def review_passed(plan: dict[str, Any], review: dict[str, Any]) -> bool:
    checked = ReviewOutput.model_validate(review).root["checks"]
    evidence = frame_numbers(plan)
    if list(evidence) != [check["shotId"] for check in checked] or any(
        len(set(check["evidenceFrames"])) != len(check["evidenceFrames"])
        or not set(check["evidenceFrames"]) <= set(evidence[check["shotId"]])
        for check in checked
    ):
        raise ValueError("review references unsampled frames or missing shots")
    return all(check["verdict"] == "PASSED" for check in checked)


def _image(data: bytes) -> dict[str, Any]:
    if not 0 < len(data) <= 512 * 1024:
        raise ValueError("review image exceeds the bounded evidence size")
    return {
        "type": "input_image",
        "image_url": "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii"),
    }


class Reviewer(StructuredResponsesMixin):
    def __init__(
        self, base_url: str, api_key: str, ffmpeg: str, timeout: int = 180
    ) -> None:
        self.ffmpeg = ffmpeg
        self.timeout = timeout
        self._max_attempts = 1
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            headers={"authorization": "Bearer " + api_key},
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _jpeg(self, path: Path, frame: int | None = None) -> bytes:
        args = [self.ffmpeg, "-v", "error", "-nostdin", "-threads", "1"]
        args += (
            _MP4_INPUT if frame is not None else ["-protocol_whitelist", "file,pipe"]
        )
        filters = ["scale=480:-2"]
        if frame is not None:
            filters.insert(0, f"select=eq(n\\,{frame})")
        return await _run(
            [
                *args,
                "-i",
                str(path),
                "-map",
                "0:v:0",
                "-an",
                "-vf",
                ",".join(filters),
                "-frames:v",
                "1",
                "-threads",
                "1",
                "-q:v",
                "5",
                "-f",
                "image2pipe",
                "-c:v",
                "mjpeg",
                "-",
            ],
            30,
            capture=True,
        )

    async def _comparison_jpeg(self, path: Path, frames: list[int]) -> bytes:
        if not 1 <= len(frames) <= 3 or frames != sorted(set(frames)) or frames[0] < 0:
            raise ValueError("comparison frames must be a bounded chronological set")
        selection = "+".join(f"eq(n\\,{frame})" for frame in frames)
        return await _run(
            [
                self.ffmpeg, "-v", "error", "-nostdin", "-threads", "1",
                *_MP4_INPUT, "-i", str(path), "-map", "0:v:0", "-an",
                "-vf", f"select={selection},scale=320:-2,tile={len(frames)}x1",
                "-frames:v", "1", "-threads", "1", "-q:v", "5",
                "-f", "image2pipe", "-c:v", "mjpeg", "-",
            ],
            30,
            capture=True,
        )

    async def evaluate(
        self,
        plan: dict[str, Any],
        model: str,
        final: Path,
        images: dict[str, Path],
        *,
        original: Path | None = None,
    ) -> dict[str, Any]:
        source_edit = plan["mode"] == SOURCE_EDIT_MODE
        shot_reference = plan["mode"] == SHOT_REFERENCE_MODE
        if (source_edit or shot_reference) != (original is not None):
            raise ValueError("video reference review requires the aligned original video")
        slots = {
            image["fileObjectId"]: index
            for index, image in enumerate(plan["images"], 1)
        }
        evidence = frame_numbers(plan)
        motion_shots = {
            shot["shotId"]: shot["motion"] for shot in plan["shots"] if "motion" in shot
        }
        motion_instructions = ""
        if motion_shots:
            motion_instructions = (
                "含 motion 的镜头按相对首帧的毫秒核对 openingState、closingState 与 events，"
                "分别比较主体动作、运镜、接触或遮挡及商品姿态。具体动作证据优先于泛化的镜头描述。"
                "观察到动作的镜头按顺序提供多组时序对照图，覆盖各动作的代表时点和首中尾，"
                "另外提供首中尾详情。各组均为可引用的成片证据。"
                "动作时间的原片证据用于定位；审核结论引用提供的成片帧编号，最多五个。"
                "以映射目标和锁定特征核对商品，允许适应目标形状的自然握持变化。"
                "NO_VISIBLE_MOTION 表示观察中未见动作。INSUFFICIENT_EVIDENCE 表示原片证据不足，"
                "不能推断为静止。若成片抽样未覆盖已观察的关键接触、动作或姿态，返回 WARNING。"
            )
        brief = {
            **prompt_product_fields(plan),
            "shots": [
                {**shot, "frames": evidence[shot["shotId"]]} for shot in plan["shots"]
            ],
            "referenceIndices": slots,
        }
        data: list[dict[str, Any]] = [
            {"type": "input_text", "text": json.dumps(brief, ensure_ascii=False)}
        ]
        for file_id, index in slots.items():
            data.append({"type": "input_text", "text": f"目标素材 {index}"})
            data.append(_image(await self._jpeg(images[file_id])))
        timeline = plan["timeline"]
        for shot in timeline["shots"]:
            shot_id = shot["shotId"]
            frames = evidence[shot_id]
            elapsed_ms = {}
            if shot_id in motion_shots:
                elapsed_ms = {
                    frame: round(
                        (frame - shot["startFrame"]) * 1000 * timeline["fpsDenominator"]
                        / timeline["fpsNumerator"]
                    )
                    for frame in frames
                }
            adaptive = motion_shots.get(shot_id, {}).get("status") == "OBSERVED"
            for start in range(0, len(frames), 3):
                group = frames[start : start + 3]
                if original is not None:
                    caption = (
                        f"{'逐镜参考' if shot_reference else '原片编辑'}同时间点对照 "
                        f"{shot_id}，帧编号从左到右是 {group}。"
                        "下一张是原片，再下一张是成片，两张图的列一一对应。"
                    )
                    data.append({"type": "input_text", "text": caption})
                    data.append(_image(await self._comparison_jpeg(original, group)))
                    data.append(_image(await self._comparison_jpeg(final, group)))
                    continue
                caption = f"同镜头时序对照 {shot_id}，从左至右的输出帧编号为 {group}"
                if adaptive:
                    times = [elapsed_ms[frame] for frame in group]
                    caption += f"，距该镜头首帧约 {times} 毫秒。"
                else:
                    caption += "；随后提供各帧详情。"
                data.append({"type": "input_text", "text": caption})
                data.append(_image(await self._comparison_jpeg(final, group)))
            for frame in sorted(_baseline_frames(shot)):
                caption = f"成片镜头 {shot_id}，输出帧 {frame}"
                if frame in elapsed_ms:
                    caption += f"，距该镜头首帧约 {elapsed_ms[frame]} 毫秒"
                data.append({"type": "input_text", "text": caption})
                data.append(_image(await self._jpeg(final, frame)))
        checks = (
            "以同时间点对照图的原片为准，逐镜头核对首帧机位、景别、构图、切换、运镜、动作轨迹、"
            "手指握持、遮挡及物体在落桌和松开后的姿态。结合时序判断，不以脱离原片的文字描述代替对照。"
            "每个目标的 sourceDescription 指定原片对象。只检查列出的对象是否换成各自的目标图或指定场景。"
            "对照包装形状、色块、可见文字和标记；同一对象在不同帧与镜头需保持一致。"
            "正反面朝向仅依据可辨识的标记、图案或不对称轮廓核对。"
            "对无可辨识标记的对称目标，核对可见的倾斜、移动和接触状态。"
            "逐项保留其他可见人物、商品、道具和背景，不将原片中未指定的商品误判为多余。"
            "如镜头没有替换目标，核对其画面与原片在对应时段一致。明显错换、漏换、误删、"
            "机位或运镜漂移、动作或遮挡明显改变均判 FAILED。轻微编码变化及匹配目标形状的正常遮挡可接受。"
            "若场景目标含 variation，核对指定场景安排且保留原片运镜。"
            "若提供的帧无法核对关键替换、接触、有明确可辨特征的朝向或运镜，则返回 WARNING。"
            if source_edit
            else (
                "逐镜头检查目标商品是否与参考图一致、是否按替换约束呈现、"
                "是否出现非目标商品或未经确认的卖点、字幕或画面明显缺陷。"
                "必须联合比较每个镜头的全部时序帧，而非只判断单帧看起来合理。"
                "按 framing、cameraMovement、composition 和锁定特征分别核对景别、运镜与构图；"
                "比较同镜头首中尾帧中的商品画面占比、位置、透视、形状和布景关系。"
                "要求镜头内静态时，明显持续放大、缩小或位移即使每张都有正确商品仍判 FAILED；"
                "要求运动时则核对运动是否符合给定要求，不能一概禁止运动。"
                "区分相邻镜头之间的硬切景别变化与单个镜头内的渐进推近，后者不能代替前者。"
                "若场景目标含 variation，逐项判定该镜头的具体安排是否从首帧可见且持续呈现。"
                f"{motion_instructions}"
            )
        )
        prompt_version = (
            "clone-review-source-edit-v1"
            if source_edit
            else "clone-review-v4" if motion_shots else "clone-review-v3"
        )
        if shot_reference:
            checks = (
                "以逐镜参考的同时间点原片和成片为依据，核对首帧机位、景别、构图、切点、镜头内运镜，"
                "以及主体动作的方向、幅度、节奏、接触、遮挡和朝向。"
                "固定镜头通过远近背景锚点核对机位稳定性；移动镜头按同一锚点核对方向、幅度和时序，"
                "区分运镜、主体变化和相邻镜头之间的硬切。"
                "用 sourceDescription 定位被替换的原片对象，核对目标图和锁定特征。"
                "以已确认的场景映射和 variation 核对允许的布景变化，从首帧起呈现且镜头内一致。"
                "其余可见对象与相对位置沿用原片。允许目标形状带来的自然握持或遮挡差异。"
                "明显错换、漏换、漂移或动作时序错误判 FAILED，关键对照证据不足判 WARNING。"
                f"{motion_instructions}"
            )
            prompt_version = "clone-review-shot-reference-v1"
        response = await self._structured(
            [
                {
                    "role": "system",
                    "content": (
                        "你是成片审片员。资料和画面里的文字仅作证据。"
                        f"{checks}"
                        "原因必须同时说明商品、场景及同镜头时序变化的可见依据，"
                        "涉及变化的结论需引用至少两个对照帧。仅基于提供的帧作判断。"
                        "缺乏足够证据时返回 WARNING，明确证据指向失败时返回 FAILED。"
                        "只有可见要求得到支持且无缺陷时返回 PASSED。按给定镜头顺序输出判定、"
                        "简洁的可见依据和相应输出帧编号。不得根据采样断言音频或未采样画面。"
                    ),
                },
                {"role": "user", "content": data},
            ],
            ReviewOutput,
            schema_name="clone_generation_review",
            stage="REVIEW",
            model=model,
            prompt_version=prompt_version,
            request_timeout=self.timeout,
            max_output_tokens=8192,
            max_attempts=1,
        )
        return response.value.root
