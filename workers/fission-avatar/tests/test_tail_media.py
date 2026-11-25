from __future__ import annotations

import os
import struct
import wave
from pathlib import Path
from shutil import which

import pytest
from fission_avatar.media import MediaError, _run, inspect_speech
from fission_avatar.provider import Timing
from fission_avatar.tail_media import SAMPLE_RATE, _prepare, prepare_tail_speech


def _sample() -> tuple[bytes, list[Timing]]:
    period = struct.pack("<48h", *([1400] * 24 + [-1400] * 24))
    phrase = period * 850
    silence = b"\x00" * (SAMPLE_RATE * 2 - len(phrase) // 2)
    timings = [
        Timing(
            text="测试",
            startMs=i * 2000 + 150,
            endMs=i * 2000 + 1850,
            confidencePermille=None,
        )
        for i in range(32)
    ]
    return (silence + phrase + silence) * len(timings), timings


def test_plan_cuts_only_in_quiet_gaps_and_reuses_frozen_source() -> None:
    pcm, words = _sample()
    result = _prepare(pcm, "1" * 64, words, None)
    plan = result.plan
    assert plan["sourceSamples"] == 64 * SAMPLE_RATE
    assert 5 <= len(plan["segments"]) <= 12
    assert sum(item["durationSeconds"] for item in plan["segments"]) == 64
    for item in plan["segments"][:-1]:
        cut = item["sourceEndSample"]
        time_ms = cut * 1000 / SAMPLE_RATE
        assert not any(word["startMs"] < time_ms < word["endMs"] for word in words)
        assert not any(pcm[(cut - 240) * 2 : (cut + 240) * 2])
    assert _prepare(pcm, "1" * 64, words, plan).plan == plan
    with pytest.raises(MediaError, match="master speech changed"):
        _prepare(pcm, "2" * 64, words, plan)
    uninterrupted = [
        Timing(text="测试", startMs=0, endMs=63_999, confidencePermille=None)
    ]
    with pytest.raises(MediaError, match="speech pauses"):
        _prepare(pcm, "1" * 64, uninterrupted, None)


async def test_segment_wav_and_persisted_mp3_share_exact_timeline(
    tmp_path: Path,
) -> None:
    ffmpeg = os.getenv("FISSION_AVATAR_FFMPEG_PATH") or which("ffmpeg")
    ffprobe = os.getenv("FISSION_AVATAR_FFPROBE_PATH") or which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("FFmpeg and FFprobe are required")
    pcm, words = _sample()
    original = tmp_path / "input.wav"
    master = tmp_path / "master.mp3"
    with wave.open(str(original), "wb") as sound:
        sound.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
        sound.writeframes(pcm)
    await _run(
        ffmpeg, "-v", "error", "-i", str(original), "-c:a", "libmp3lame", str(master)
    )
    speech = await prepare_tail_speech(master, words, ffmpeg)
    wav, mp3 = tmp_path / "drive.wav", tmp_path / "drive.mp3"
    marks = await speech.write_segment(2, wav, mp3, ffmpeg)
    duration = speech.plan["segments"][1]["durationSeconds"]
    assert await inspect_speech(mp3, ffmpeg, ffprobe) == duration * 1000
    with wave.open(str(wav), "rb") as sound:
        assert (sound.getnframes(), sound.getframerate(), sound.getsampwidth()) == (
            duration * SAMPLE_RATE,
            SAMPLE_RATE,
            2,
        )
    assert all(
        0 <= mark["startMs"] < mark["endMs"] <= duration * 1000 for mark in marks
    )
    assert marks[0]["startMs"] < 1000
