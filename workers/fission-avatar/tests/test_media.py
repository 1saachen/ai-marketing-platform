import os
import subprocess
from array import array
from pathlib import Path
from random import Random
from shutil import which

import pytest

from fission_avatar.media import (
    MediaError,
    inspect_speech,
    match_driving_audio,
    prepare_character,
    validate_output,
)


def test_waveform_validates_distribution_of_matching_audio() -> None:
    rng = Random(4488)
    sound = array("h", [rng.randrange(-10_000, 10_000) for _ in range(8800)])
    shifted = array("h", [0] * 112) + sound[:-112]
    assert match_driving_audio(sound, shifted) == (28, 1000)

    unrelated = array("h", [rng.randrange(-10_000, 10_000) for _ in range(8800)])
    with pytest.raises(MediaError, match="did not match"):
        match_driving_audio(sound, unrelated)


async def test_ffmpeg_remux_and_validate_actual_containers(tmp_path: Path) -> None:
    ffmpeg = os.getenv("FISSION_AVATAR_FFMPEG_PATH") or which("ffmpeg")
    ffprobe = os.getenv("FISSION_AVATAR_FFPROBE_PATH") or which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("FFmpeg and FFprobe are required for media integration test")
    source = tmp_path / "source.mp4"
    silent = tmp_path / "silent.mp4"
    audio = tmp_path / "speech.mp3"
    output = tmp_path / "output.mp4"

    def run(*args: str) -> None:
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", *args],
            check=True,
            timeout=30,
        )

    run(
        "-f",
        "lavfi",
        "-i",
        "color=green:size=320x320:duration=3:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=311:duration=3:sample_rate=24000",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        str(source),
    )
    assert await prepare_character(source, silent, ffmpeg, ffprobe) == 3000
    run(
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.2*sin(2*PI*330*t+70*sin(2*PI*1.1*t)):s=24000:d=2",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        str(audio),
    )
    duration = await inspect_speech(audio, ffmpeg, ffprobe)
    run(
        "-i",
        str(silent),
        "-i",
        str(audio),
        "-t",
        "2",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        str(output),
    )
    result = await validate_output(output, audio, duration, 2000, ffmpeg, ffprobe)
    assert abs(result.video_duration_ms - duration) <= 100
    assert abs(result.audio_lag_ms) <= 10
    assert result.minimum_audio_correlation_permille >= 980
