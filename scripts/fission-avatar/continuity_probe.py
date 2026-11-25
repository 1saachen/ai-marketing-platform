from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from ai_runtime.seedance import ProviderError, SeedanceTransport
from continuity_media import Tools, check_drive
from continuity_mediakit import download_alignment, upload_audio
from fission_avatar.long_form import AssemblyError, _atomic_json, _directory_lock
from fission_avatar.media import MediaError
from fission_avatar.provider import TaskFailure, VolcProvider

MODEL = "doubao-seedance-2-0-fast-260128"
ARK_URL = "https://ark.cn-beijing.volces.com/api/v3"
SCRIPT = "先看这一步，做起来很简单。再看一个细节，放慢一点。最后试一遍，马上就能记住。"
PICTURE = "虚构的成年女性讲解员，单人半身，正对镜头坐在简洁书桌前，光线均匀，口鼻清楚，背景安静。固定平视机位，衣着、景别和光线连贯，正常呼吸，幅度小的自然讲解手势。仅生成画面。"
PROMPTS = (
    PICTURE + "目光看向镜头，先微笑，慢慢抬起一只手做讲解，手势自然保持。",
    PICTURE + "延续首帧中的人物和手势。手轻缓落回桌面，身体平稳，镜头保持固定。",
    PICTURE + "延续首帧中的人物和动作。保持目光，轻轻点头后自然停住，镜头保持固定。",
)
RESERVE_CENTS = {"tts": 10, "seedance": 210, "lip": 10}
OPERATIONS = {"tts": 1, "seedance": 3, "lip": 5}


class PilotError(RuntimeError):
    pass


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise PilotError(f"缺少本地配置 {name}")
    return value


def sha(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def https_tail(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 4096:
        raise PilotError("方舟回执缺少原始尾帧地址")
    try:
        url = urlsplit(value)
    except ValueError as error:
        raise PilotError("方舟尾帧地址格式无效") from error
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.fragment
    ):
        raise PilotError("方舟尾帧地址格式无效")
    return value


def seedance_payload(ordinal: int, first: str | None) -> dict[str, Any]:
    if not 1 <= ordinal <= 3 or (ordinal == 1) != (first is None):
        raise PilotError("Seedance 段序与首帧不一致")
    content: list[dict[str, Any]] = [{"type": "text", "text": PROMPTS[ordinal - 1]}]
    if first is not None:
        content.append(
            {
                "type": "image_url",
                "role": "first_frame",
                "image_url": {"url": https_tail(first)},
            }
        )
    return {
        "model": MODEL,
        "duration": 4,
        "resolution": "480p",
        "ratio": "16:9",
        "generate_audio": False,
        "return_last_frame": ordinal < 3,
        "content": content,
    }


class Ledger:
    def __init__(self, root: Path, fingerprint: str, cap_cents: int) -> None:
        self.path = root / "continuity-state.json"
        self.cap_cents = cap_cents
        if self.path.exists():
            value = json.loads(self.path.read_text(encoding="utf-8"))
            if (
                value.get("fingerprint") != fingerprint
                or value.get("capCents") != cap_cents
            ):
                raise PilotError("原稿、账号、参数或预算与现有样片状态不一致")
            self.entries: dict[str, dict[str, Any]] = value["operations"]
        else:
            self.entries = {}
        self.fingerprint = fingerprint

    def save(self) -> None:
        _atomic_json(
            self.path,
            {
                "fingerprint": self.fingerprint,
                "capCents": self.cap_cents,
                "operations": self.entries,
            },
        )

    def reserve(
        self, kind: str, name: str, *, client_id: str | None = None
    ) -> dict[str, Any]:
        if name in self.entries:
            raise PilotError("本操作已有提交意图，须沿原任务恢复")
        counted = sum(item["kind"] == kind for item in self.entries.values())
        used = sum(
            item.get("costCents", item["reservedCents"])
            for item in self.entries.values()
        )
        reserve = RESERVE_CENTS[kind]
        if counted >= OPERATIONS[kind] or used + reserve > self.cap_cents:
            raise PilotError("达到本次样片的提交次数或预算")
        entry = {"kind": kind, "reservedCents": reserve}
        if client_id:
            entry["clientId"] = client_id
        self.entries[name] = entry
        self.save()
        return entry

    def finish(
        self, entry: dict[str, Any], path: Path, *, cost_cents: int | None = None
    ) -> None:
        entry["sha256"] = sha(path)
        if cost_cents is not None:
            entry["costCents"] = cost_cents
        self.save()

    @staticmethod
    def verified(entry: dict[str, Any] | None, path: Path) -> bool:
        if not entry or "sha256" not in entry:
            return False
        if not path.is_file() or sha(path) != entry["sha256"]:
            raise PilotError("已完成文件与保存的摘要不一致")
        return True


async def make_voice(
    provider: VolcProvider, ledger: Ledger, root: Path, speaker: str
) -> tuple[Path, Path]:
    audio, timings = root / "whole-speech.mp3", root / "word-times.json"
    entry = ledger.entries.get("speech")
    if not ledger.verified(entry, audio):
        if entry is None:
            entry = ledger.reserve("tts", "speech", client_id=str(uuid4()))
            await provider.submit_tts(entry["clientId"], SCRIPT, speaker)
        utterance = await provider.get_tts_result(entry["clientId"])
        await provider.download(utterance.url, audio, kind="speech")
        _atomic_json(timings, {"wordTimings": utterance.timings})
        entry["timingsSha256"] = sha(timings)
        ledger.finish(entry, audio)
    elif (
        entry is None
        or not timings.is_file()
        or sha(timings) != entry.get("timingsSha256")
    ):
        raise PilotError("配音的时间标注与保存状态不一致")
    return audio, timings


async def make_scene(
    ark: SeedanceTransport, ledger: Ledger, root: Path, ordinal: int, tail: str | None
) -> tuple[Path, str | None]:
    name = f"seedance-{ordinal}"
    path = root / f"{name}.mp4"
    entry = ledger.entries.get(name)
    if entry is None:
        entry = ledger.reserve("seedance", name)
    elif not entry.get("taskId"):
        raise PilotError(f"第 {ordinal} 段方舟受理状态未知，需核对原任务")

    async def checkpoint(progress: int, task_id: str | None) -> None:
        if progress == 10 and task_id and entry.get("taskId") != task_id:
            entry["taskId"] = task_id
            ledger.save()
            print(f"方舟已受理第 {ordinal} 段", flush=True)

    ready = ledger.verified(entry, path)
    if not ready:
        result = await ark.render_request(
            seedance_payload(ordinal, tail), path.name, checkpoint, entry.get("taskId")
        )
        temporary = path.with_suffix(".partial")
        temporary.write_bytes(result.content)
        os.replace(temporary, path)
    receipt = await ark._request("GET", "contents/generations/tasks/" + entry["taskId"])
    if str(receipt.get("status", "")).casefold() not in {
        "succeeded",
        "success",
        "completed",
    }:
        raise PilotError(f"第 {ordinal} 段方舟回执未完成")
    content = receipt.get("content")
    if not isinstance(content, dict):
        raise PilotError("方舟回执缺少视频内容")
    usage = receipt.get("usage")
    tokens = usage.get("completion_tokens") if isinstance(usage, dict) else None
    cost = (
        ((tokens * 3700 + 999_999) // 1_000_000)
        if type(tokens) is int and tokens >= 0
        else None
    )
    ledger.finish(entry, path, cost_cents=cost)
    next_tail = https_tail(content.get("last_frame_url")) if ordinal < 3 else None
    print(f"第 {ordinal} 段方舟画面已下载", flush=True)
    return path, next_tail


async def align(
    provider: VolcProvider,
    ledger: Ledger,
    root: Path,
    name: str,
    video: Path,
    audio: Path,
    audio_id: str,
    ffmpeg: str,
    ffprobe: str,
) -> Path:
    output = root / f"{name}.mp4"
    entry = ledger.entries.get(name)
    if ledger.verified(entry, output):
        return output
    if entry is None:
        video_id = await provider.upload_character(video)
        entry = ledger.reserve("lip", name, client_id=str(uuid4()))
        entry["taskId"] = await provider.submit_lip_sync(
            entry["clientId"], video_id, audio_id
        )
        ledger.save()
    elif not entry.get("taskId"):
        raise PilotError(f"{name} 的 MediaKit 受理状态未知，需核对原任务")
    with TemporaryDirectory(prefix=".checked-alignment-", dir=root) as scratch:
        checked = Path(scratch) / "aligned.mp4"
        await download_alignment(
            provider, entry["taskId"], audio, checked, ffmpeg=ffmpeg, ffprobe=ffprobe
        )
        if output.exists() and sha(output) != sha(checked):
            raise PilotError("本地已存片段与原对齐任务输出不一致")
        if not output.exists():
            os.replace(checked, output)
    ledger.finish(entry, output, cost_cents=7)
    print(f"{name} 口型对齐已保存", flush=True)
    return output


async def media_cli(ffmpeg: str, ffprobe: str, *args: object) -> dict[str, Any]:
    executable = Path(__file__).with_name("continuity_media.py")
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-X",
        "utf8",
        str(executable),
        "--ffmpeg",
        ffmpeg,
        "--ffprobe",
        ffprobe,
        *(str(arg) for arg in args),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await process.communicate()
    if process.returncode != 0:
        raise PilotError(f"本地媒体预检失败（{args[0]}）")
    value = json.loads(stdout)
    if not isinstance(value, dict):
        raise PilotError("本地媒体工具回执格式无效")
    return value


async def prepare_audio(
    ledger: Ledger, root: Path, audio: Path, timings: Path, ffmpeg: str, ffprobe: str
) -> tuple[Path, Path, list[Path]]:
    plan_path = root / "slice-plan.json"
    if plan_path.exists():
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    else:
        plan = await media_cli(
            ffmpeg,
            ffprobe,
            "slice-audio",
            "--master",
            audio,
            "--timings",
            timings,
            "--out-dir",
            root / "audio",
            "--pad-to-four-seconds",
        )
        _atomic_json(plan_path, plan)
    segments = plan["segments"]
    if (
        plan["durationMs"] != 12_000
        or len(segments) != 3
        or plan["seamTimesMs"] != [4000, 8000]
    ):
        raise PilotError("样片需恰好三段 4 秒音轨")
    cuts = plan["cuts"]
    if len(cuts) != 2 or any(
        cut["insideTimedWord"] or cut["basis"] not in {"TIMING_PAUSE", "QUIET_PCM"}
        for cut in cuts
    ):
        raise PilotError("整条配音缺少两个可以安全切分的停顿")
    master = Path(plan["masterPath"]).resolve(strict=True)
    drives = [Path(segment["audioPath"]).resolve(strict=True) for segment in segments]
    if any(not file.is_relative_to(root / "audio") for file in [master, *drives]):
        raise PilotError("样片音轨超出已确认的目录")
    entry = ledger.entries["speech"]
    hashes = [sha(file) for file in [plan_path, master, *drives]]
    if "sliceHashes" in entry and hashes != entry["sliceHashes"]:
        raise PilotError("已冻结的整段音轨或切片发生变化")
    if "sliceHashes" not in entry:
        for drive in drives:
            await asyncio.to_thread(check_drive, drive, Tools(ffmpeg, ffprobe))
        entry["sliceHashes"] = hashes
        ledger.save()
    return plan_path, master, drives


async def upload_exact_audio(
    provider: VolcProvider, drive: Path, root: Path, ffmpeg: str
) -> str:
    # MP3 packet duration can include encoder padding. A PCM WAV exposes exactly
    # four seconds to MediaKit without changing the decoded driving samples.
    with TemporaryDirectory(prefix=".exact-audio-", dir=root) as scratch:
        output = Path(scratch) / "drive.wav"
        process = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-v",
            "error",
            "-nostdin",
            "-i",
            str(drive),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
            str(output),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        if await process.wait() != 0:
            raise PilotError("无法准备精确时长的驱动音频")
        with wave.open(str(output), "rb") as sound:
            if sound.getframerate() != 24_000 or sound.getnframes() != 96_000:
                raise PilotError("驱动音频解码后未达到 4 秒")
        return await upload_audio(provider, output)


async def execute(root: Path, cap_cents: int, ffmpeg: str, ffprobe: str) -> None:
    keys = [
        required(key)
        for key in ("ARK_API_KEY", "VOLC_TTS_API_KEY", "VOLC_MEDIAKIT_API_KEY")
    ]
    speaker = required("VOLC_TTS_SPEAKER")
    if not re.fullmatch(r"zh_[a-z0-9_]{1,80}_uranus_bigtts", speaker):
        raise PilotError("本次试验使用已配置的普通话预置音色")
    fingerprint = hashlib.sha256(
        json.dumps([MODEL, SCRIPT, PROMPTS, keys, speaker]).encode()
    ).hexdigest()
    ledger = Ledger(root, fingerprint, cap_cents)
    ark = SeedanceTransport(
        base_url=ARK_URL,
        api_key=keys[0],
        timeout_seconds=600,
        poll_interval_seconds=4,
        create_qps=0.2,
        download_concurrency=1,
        max_download_bytes=24 * 1024 * 1024,
    )
    voice = VolcProvider(keys[1], keys[2], lip_timeout=360)
    try:
        audio, timings = await make_voice(voice, ledger, root, speaker)
        plan_path, master, drives = await prepare_audio(
            ledger, root, audio, timings, ffmpeg, ffprobe
        )
        pictures: list[Path] = []
        tail = None
        for ordinal in range(1, 4):
            picture, tail = await make_scene(ark, ledger, root, ordinal, tail)
            pictures.append(picture)
        a, b = [], []
        speech = ledger.entries["speech"]
        uploaded: dict[str, str] = speech.setdefault("audioIds", {})
        for index, drive in enumerate(drives):
            ordinal = index + 1
            key = str(ordinal)
            if key not in uploaded:
                uploaded[key] = await upload_exact_audio(voice, drive, root, ffmpeg)
                ledger.save()
            audio_id = uploaded[key]
            restart = await align(
                voice,
                ledger,
                root,
                f"restart-{ordinal}",
                pictures[0],
                drive,
                audio_id,
                ffmpeg,
                ffprobe,
            )
            a.append(restart)
            b.append(
                restart
                if index == 0
                else await align(
                    voice,
                    ledger,
                    root,
                    f"continued-{ordinal}",
                    pictures[index],
                    drive,
                    audio_id,
                    ffmpeg,
                    ffprobe,
                )
            )
        for label, videos in (("restart", a), ("continued", b)):
            target = root / f"{label}.mp4"
            if not target.exists():
                await media_cli(
                    ffmpeg,
                    ffprobe,
                    "assemble",
                    "--master",
                    master,
                    "--plan",
                    plan_path,
                    "--videos",
                    *videos,
                    "--output",
                    target,
                )
        contact = root / "seam-comparison.jpg"
        if not contact.exists():
            await media_cli(
                ffmpeg,
                ffprobe,
                "compare",
                "--left",
                root / "restart.mp4",
                "--right",
                root / "continued.mp4",
                "--plan",
                plan_path,
                "--output",
                contact,
            )
        print("两版对照已合成，接缝为 4 秒和 8 秒。", flush=True)
    finally:
        await voice.close()
        await ark.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(description="数字人口播三段尾帧接续对照")
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--budget-yuan", type=int)
    parser.add_argument(
        "--ffmpeg", default=os.environ.get("FISSION_AVATAR_FFMPEG_PATH") or "ffmpeg"
    )
    parser.add_argument(
        "--ffprobe", default=os.environ.get("FISSION_AVATAR_FFPROBE_PATH") or "ffprobe"
    )
    args = parser.parse_args()
    if not args.execute:
        print(
            json.dumps(
                {
                    "model": MODEL,
                    "resolution": "480p",
                    "segmentCount": 3,
                    "secondsPerSegment": 4,
                    "maxOperations": OPERATIONS,
                },
                ensure_ascii=False,
            )
        )
        return
    if (
        args.state_dir is None
        or args.budget_yuan is None
        or args.budget_yuan * 100 < 690
    ):
        parser.error("真实试验需私有状态目录和足以覆盖本次计划的已授权预算")
    try:
        root = args.state_dir.resolve()
        root.mkdir(parents=True, exist_ok=True)
        with _directory_lock(root):
            asyncio.run(
                execute(root, args.budget_yuan * 100, args.ffmpeg, args.ffprobe)
            )
    except (PilotError, AssemblyError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except (ProviderError, TaskFailure) as error:
        code = (
            error.code
            if re.fullmatch(r"[a-zA-Z0-9_.-]{1,120}", error.code)
            else "PROVIDER_FAILED"
        )
        print(f"供应商阶段停止（{code}）。已记录的任务保留。", file=sys.stderr)
        raise SystemExit(1) from None
    except (MediaError, OSError, ValueError, KeyError, TypeError) as error:
        print(
            f"样片阶段停止（{type(error).__name__}）。已记录的任务保留。",
            file=sys.stderr,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
