from __future__ import annotations

import asyncio
import tempfile
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID

from ai_runtime.http import InternalApiError
from ai_runtime.responses import ProviderError

from .contracts import MOTION_ANALYSIS_VERSIONS, PROP_ANALYSIS_VERSION, validate_result
from .media import MOTION_SAMPLE_INTERVAL_MS, MediaError, MediaLimits, sample_video
from .provider import ProviderPort, apply_media_evidence

CHECKPOINT_KEY = "RESULT_V1"


def heartbeat_interval(lease_expires_at: str, now: datetime | None = None) -> float:
    expiry = datetime.fromisoformat(lease_expires_at)
    if expiry.tzinfo is None:
        raise ValueError("lease expiry must include a timezone")
    remaining = (expiry - (now or datetime.now(UTC))).total_seconds()
    return min(20.0, max(1.0, remaining / 3))


class ApiPort(Protocol):
    token: str

    async def call(
        self, method: str, path: str, value: dict[str, Any] | None = None
    ) -> Any: ...
    async def download(
        self,
        file_id: str,
        destination: Path,
        *,
        expected_size: int,
        expected_sha256: str,
        limit: int = 256 * 1024 * 1024,
    ) -> None: ...


def validate_snapshot(snapshot: Any) -> dict[str, Any]:
    if not isinstance(snapshot, dict) or snapshot.get("schemaVersion") != 1:
        raise ValueError("invalid task snapshot")
    if snapshot.get("operation") not in {"ANALYZE", "MAP_SUGGEST"}:
        raise ValueError("unsupported task operation")
    if "analysisInstructionVersion" in snapshot and (
        snapshot["operation"] != "ANALYZE"
        or snapshot["analysisInstructionVersion"] not in MOTION_ANALYSIS_VERSIONS
    ):
        raise ValueError("unsupported analysis instruction version")
    if not isinstance(snapshot.get("model"), str) or not snapshot["model"].strip():
        raise ValueError("frozen model is missing")
    files = snapshot.get("input", {}).get("files")
    if not isinstance(files, list) or not files or len(files) > 21:
        raise ValueError("invalid frozen input files")
    seen = set()
    for file in files:
        identifier = str(UUID(file["fileObjectId"]))
        if identifier in seen:
            raise ValueError("duplicate frozen input file")
        seen.add(identifier)
        if (
            not isinstance(file["sizeBytes"], int)
            or not 0 < file["sizeBytes"] <= 256 * 1024 * 1024
        ):
            raise ValueError("invalid frozen file size")
        if len(file["sha256"]) != 64 or any(
            char not in "0123456789abcdef" for char in file["sha256"]
        ):
            raise ValueError("invalid frozen file hash")
    if len([file for file in files if file["role"] == "REFERENCE"]) != 1:
        raise ValueError("task requires exactly one reference")
    if snapshot["operation"] == "MAP_SUGGEST":
        if snapshot.get("purpose") not in {"SMART_MATCH", "VALIDATE_KEEP_TEXT"}:
            raise ValueError("mapping purpose is missing")
        if not isinstance(snapshot.get("analysis"), dict) or not isinstance(
            snapshot.get("mapping"), dict
        ):
            raise ValueError("mapping source is missing")
    return snapshot


def structure_lock(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "durationMs": report["durationMs"],
        "stages": report["structure"]["stages"],
        "shots": [
            {key: shot[key] for key in ["shotId", "stageId", "startMs", "endMs"]}
            for shot in report["shots"]
        ],
        "beatsMs": report["audio"]["beatsMs"],
        "soundEffectAnchorsMs": report["audio"]["soundEffectAnchorsMs"],
        "hookRanges": report["structure"]["hookRanges"],
        "conversionRanges": report["structure"]["conversionRanges"],
    }


def validate_for_snapshot(result: dict[str, Any], snapshot: dict[str, Any]) -> None:
    validate_result(result)
    if result["operation"] != snapshot["operation"]:
        raise ValueError("result operation does not match task")
    if snapshot["operation"] == "ANALYZE":
        if snapshot.get("analysisInstructionVersion") in MOTION_ANALYSIS_VERSIONS and any(
            "motion" not in shot for shot in result["report"]["shots"]
        ):
            raise ValueError("analysis result is missing shot motion observations")
        if snapshot.get("analysisInstructionVersion") != PROP_ANALYSIS_VERSION and any(
            element["type"] == "prop" for element in result["report"]["elements"]
        ):
            raise ValueError("prop elements must match the analysis version")
        return
    if result["purpose"] != snapshot["purpose"]:
        raise ValueError("result purpose does not match task")
    report = snapshot["analysis"]["report"]
    if result["purpose"] == "SMART_MATCH":
        mapping = result["mapping"]
        if (
            mapping["sourceInput"] != snapshot["input"]["ref"]
            or mapping["sourceAnalysis"] != snapshot["analysis"]["ref"]
        ):
            raise ValueError("mapping changed frozen source references")
        if mapping["structureLock"] != structure_lock(report):
            raise ValueError("mapping changed locked structure")
        elements = {element["elementId"]: element for element in report["elements"]}
        bindings = mapping["bindings"]
        if len(bindings) != len(elements) or {
            binding["elementId"] for binding in bindings
        } != set(elements):
            raise ValueError("mapping must describe all source elements exactly once")
        candidates = {
            (candidate["assetId"], candidate["version"])
            for candidate in snapshot["candidates"]
        }
        prop_bindings = {
            item["elementId"]: item
            for item in snapshot["mapping"]["bindings"]
            if item["type"] == "prop"
        }
        for binding in bindings:
            element = elements[binding["elementId"]]
            if binding["type"] != element["type"] or set(binding["shotIds"]) != set(
                element["shotIds"]
            ):
                raise ValueError("mapping element identity changed")
            if element["type"] == "product" and binding["action"] != "REPLACE":
                raise ValueError("every source product must be replaced")
            target = binding["target"]
            if element["type"] == "prop":
                selected = prop_bindings.get(binding["elementId"])
                if (selected is not None and selected != binding) or (
                    selected is None and (binding["action"] != "KEEP" or target is not None)
                ):
                    raise ValueError("prop suggestions must preserve user selections")
            if target is not None and target["asset"] is not None:
                reference = target["asset"]
                if (reference["assetId"], reference["version"]) not in candidates:
                    raise ValueError("mapping selected an unfrozen asset version")
    else:
        expected = {
            binding["elementId"]
            for binding in snapshot["mapping"]["bindings"]
            if binding["type"] in {"subtitle", "voiceover"}
            and binding["target"] is not None
            and binding["target"]["contentStrategy"] == "KEEP"
        }
        checks = result["checks"]
        if (
            len(checks) != len(expected)
            or {check["elementId"] for check in checks} != expected
        ):
            raise ValueError("keep-text result does not cover the requested elements")


class Pipeline:
    def __init__(
        self,
        api: ApiPort,
        provider: ProviderPort,
        claim: dict[str, Any],
        limits: MediaLimits,
    ) -> None:
        self.api, self.provider, self.limits = api, provider, limits
        self.snapshot = validate_snapshot(claim["snapshot"])
        self.input_hash = claim["inputHash"]
        if not isinstance(self.input_hash, str) or len(self.input_hash) != 64:
            raise ValueError("invalid task input hash")
        self.checkpoints = claim["checkpoints"]
        self.heartbeat_interval = heartbeat_interval(claim["leaseExpiresAt"])

    async def heartbeat(self) -> None:
        while True:
            await asyncio.sleep(self.heartbeat_interval)
            await self.api.call("POST", "heartbeat")

    async def progress(self, value: int, stage: str, message: str) -> None:
        await self.api.call(
            "PUT", "progress", {"progress": value, "stage": stage, "message": message}
        )

    async def save_result(self, method: str, path: str, body: dict[str, Any]) -> None:
        try:
            await self.api.call(method, path, body)
        except InternalApiError as error:
            if (
                self.snapshot["operation"] == "ANALYZE"
                and not error.retryable
                and error.status_code in {400, 409}
            ):
                # A conflict can also mean lease loss. The failure endpoint checks
                # the same attempt token before accepting any terminal write.
                raise ValueError("analysis report rejected by API") from error
            raise

    async def run(self) -> None:
        for checkpoint in self.checkpoints:
            if (
                checkpoint["key"] == CHECKPOINT_KEY
                and checkpoint["inputHash"] == self.input_hash
            ):
                result = checkpoint["output"]
                validate_for_snapshot(result, self.snapshot)
                await self.progress(95, "SAVE", "恢复已完成结果，正在提交")
                await self.save_result("POST", "complete", {"result": result})
                return
        if self.snapshot["operation"] == "ANALYZE":
            await self.progress(5, "DOWNLOAD", "读取已确认参考视频")
            reference = next(
                file
                for file in self.snapshot["input"]["files"]
                if file["role"] == "REFERENCE"
            )
            with tempfile.TemporaryDirectory(prefix="fission-clone-") as temporary:
                directory = Path(temporary)
                source = directory / "reference.media"
                await self.api.download(
                    reference["fileObjectId"],
                    source,
                    expected_size=reference["sizeBytes"],
                    expected_sha256=reference["sha256"],
                )
                frozen_media = reference.get("media")
                if not isinstance(frozen_media, dict):
                    raise MediaError("已确认的参考视频媒体信息无效")
                await self.progress(15, "SAMPLE", "采集有时间依据的参考画面")
                limits = self.limits
                if self.snapshot.get("analysisInstructionVersion") in MOTION_ANALYSIS_VERSIONS:
                    limits = replace(limits, interval_ms=MOTION_SAMPLE_INTERVAL_MS)
                sample = await sample_video(
                    source, directory, limits, frozen_media=frozen_media
                )
                await self.progress(
                    40, "ANALYZE", "分析结构、创意、产品、镜头与视觉证据"
                )
                result = await self.provider.analyze(self.snapshot, sample)
                apply_media_evidence(result["report"], sample)
        elif self.snapshot["purpose"] == "SMART_MATCH":
            await self.progress(
                25, "SMART_MATCH", "依据确认报告与项目候选资产提出映射建议"
            )
            result = await self.provider.suggest(self.snapshot)
        else:
            await self.progress(
                25, "VALIDATE_KEEP_TEXT", "逐项核对保留文本与当前商品事实"
            )
            result = await self.provider.validate_keep_text(self.snapshot)
        validate_for_snapshot(result, self.snapshot)
        await self.progress(85, "VALIDATE", "结果结构校验通过，正在保存检查点")
        await self.save_result(
            "PUT",
            "checkpoints",
            {"key": CHECKPOINT_KEY, "inputHash": self.input_hash, "output": result},
        )
        await self.progress(95, "SAVE", "正在提交完整结果")
        await self.save_result("POST", "complete", {"result": result})


async def process_task(
    api: ApiPort, provider: ProviderPort, limits: MediaLimits
) -> None:
    active: list[asyncio.Task[None]] = []
    try:
        claim = await api.call("POST", "claim")
        if not claim.get("claimed"):
            return
        api.token = str(UUID(claim["attemptToken"]))
        pipeline = Pipeline(api, provider, claim, limits)
        active = [
            asyncio.create_task(pipeline.heartbeat()),
            asyncio.create_task(pipeline.run()),
        ]
        done, _ = await asyncio.wait(active, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            await task
    except InternalApiError as error:
        if error.retryable or error.status_code not in {404, 409}:
            raise
    except (ProviderError, MediaError, ValueError, KeyError, TypeError) as error:
        if api.token:
            provider_error = isinstance(error, ProviderError)
            message = "媒体或任务结果不符合当前契约，请检查后重试"
            if provider_error:
                message = "分析服务暂时失败，请重试"
            elif isinstance(error, MediaError):
                message = str(error)
            try:
                await api.call(
                    "POST",
                    "fail",
                    {
                        "code": "CLONE_PROVIDER_FAILED"
                        if provider_error
                        else "CLONE_RESULT_INVALID",
                        "message": message,
                        "retryable": isinstance(error, ProviderError) and error.retryable,
                    },
                )
            except InternalApiError as failure:
                if failure.retryable or failure.status_code not in {404, 409}:
                    raise
    finally:
        for task in active:
            if not task.done():
                task.cancel()
        await asyncio.gather(*active, return_exceptions=True)
