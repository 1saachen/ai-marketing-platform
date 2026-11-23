import os
import shutil
import struct
import subprocess

import pytest

from fission_local_replace.media import MediaError, compose, inspect_source


FFMPEG = os.getenv("FISSION_LOCAL_REPLACE_FFMPEG_PATH") or shutil.which("ffmpeg")
FFPROBE = os.getenv("FISSION_LOCAL_REPLACE_FFPROBE_PATH") or shutil.which("ffprobe")
pytestmark = pytest.mark.skipif(
    not FFMPEG or not FFPROBE, reason="FFmpeg and FFprobe required"
)


def ffmpeg(*args):
    return subprocess.run(
        [FFMPEG, "-v", "error", "-nostdin", *args], check=True, capture_output=True
    ).stdout


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    directory = tmp_path_factory.mktemp("local-replace-media")
    paths = [directory / title for title in ("source.mp4", "edited.mp4", "short.mp4")]
    for file, color, duration, tone in zip(
        paths, ("red", "blue", "blue"), (5, 5, 4), (440, 880, 880)
    ):
        ffmpeg(
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s=864x486:r=30:d={duration}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={tone}:sample_rate=48000:duration={duration}",
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(file),
        )
    return paths


@pytest.mark.parametrize(
    "start,end,first_frame,last_frame",
    [(0, 1001, 0, 25), (1001, 3000, 25, 72), (3000, 5000, 72, 120), (0, 5000, 0, 120)],
)
async def test_compose_keeps_source_outside_edit_and_original_audio(
    clips, tmp_path, start, end, first_frame, last_frame
):
    source, edited, _ = clips
    result = tmp_path / "result.mp4"
    timeline = await inspect_source(source, start, end, ffprobe=FFPROBE)
    assert (timeline.start_frame, timeline.end_frame) == (first_frame, last_frame)
    await compose(source, edited, result, timeline, ffmpeg=FFMPEG, ffprobe=FFPROBE)
    pixels = ffmpeg(
        "-i", str(result), "-vf", "scale=2:2,format=rgb24", "-an", "-f", "rawvideo", "-"
    )
    assert len(pixels) == 120 * 12
    expected = [first_frame <= frame < last_frame for frame in range(120)]
    assert [pixels[i + 2] > pixels[i] for i in range(0, len(pixels), 12)] == expected
    sound = ffmpeg("-i", str(result), "-vn", "-f", "s16le", "-")
    samples = [value for (value,) in struct.iter_unpack("<h", sound)]
    # The source and edit have different injected tones. Count crossings over
    # exactly one second in the middle, independent of AAC encoder delay.
    crossings = sum(
        left < 0 <= right
        for left, right in zip(samples[48000:96000], samples[48001:96001])
    )
    assert 436 <= crossings <= 444


async def test_inspection_and_compose_reject_invalid_ranges_or_short_edit(
    clips, tmp_path
):
    source, _, short = clips
    with pytest.raises(MediaError, match="替换范围"):
        await inspect_source(source, 4800, 6000, ffprobe=FFPROBE)
    timeline = await inspect_source(source, 500, 4900, ffprobe=FFPROBE)
    with pytest.raises(MediaError, match="时间线"):
        await compose(
            source,
            short,
            tmp_path / "invalid.mp4",
            timeline,
            ffmpeg=FFMPEG,
            ffprobe=FFPROBE,
        )


async def test_portrait_without_audio_remains_silent(tmp_path):
    source, edited, output = [
        tmp_path / f"{name}.mp4" for name in ("source", "edit", "result")
    ]
    for path, rate in ((source, 60), (edited, 24)):
        ffmpeg(
            "-f",
            "lavfi",
            "-i",
            f"color=green:s=486x864:r={rate}:d=4",
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-pix_fmt",
            "yuv420p",
            str(path),
        )
    timeline = await inspect_source(source, 1000, 2000, ffprobe=FFPROBE)
    assert (timeline.ratio, timeline.frames, timeline.has_audio) == ("9:16", 96, False)
    await compose(source, edited, output, timeline, ffmpeg=FFMPEG, ffprobe=FFPROBE)
    assert output.is_file()
