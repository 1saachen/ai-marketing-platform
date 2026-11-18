import json
import os
import shutil
import subprocess

import pytest

from fission_clone_generation.media import MediaError, compose, compose_timeline


@pytest.fixture
def tools():
    encoder = os.getenv("FISSION_CLONE_FFMPEG_PATH") or shutil.which("ffmpeg")
    probe = os.getenv("FISSION_CLONE_FFPROBE_PATH") or shutil.which("ffprobe")
    if not encoder or not probe:
        pytest.skip("configure local FFmpeg and FFprobe to run real media tests")
    return encoder, probe


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, timeout=45).stdout


def clip(
    ffmpeg, path, *, color, width=720, height=1280, rate="25", duration="2", audio=False
):
    inputs = ["-f", "lavfi", "-i", f"color={color}:s={width}x{height}:r={rate}"]
    if audio:
        inputs += ["-f", "lavfi", "-i", "sine=frequency=440"]
    run(
        ffmpeg,
        "-v",
        "error",
        "-y",
        *inputs,
        "-t",
        duration,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(path),
    )
    return path


async def test_real_hard_cut_exact_frames_and_silent_output(plan, tools, tmp_path):
    ffmpeg, ffprobe = tools
    left = clip(
        ffmpeg, tmp_path / "red.mp4", color="red", rate="30000/1001", audio=True
    )
    right = clip(ffmpeg, tmp_path / "green.mp4", color="green")
    output = tmp_path / "final.mp4"
    await compose(
        plan, {"shot_a": left, "shot_b": right}, output, ffmpeg=ffmpeg, ffprobe=ffprobe
    )
    data = json.loads(
        run(
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,nb_frames,avg_frame_rate",
            "-of",
            "json",
            str(output),
        )
    )
    assert data["streams"] == [
        {"codec_type": "video", "avg_frame_rate": "24/1", "nb_frames": "72"}
    ]
    frames = run(
        ffmpeg,
        "-v",
        "error",
        "-i",
        str(output),
        "-vf",
        r"select=eq(n\,35)+eq(n\,36),scale=1:1",
        "-fps_mode",
        "passthrough",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "-",
    )
    assert len(frames) == 6
    assert frames[0] > 200 and frames[1] < 25  # Last frame of the first shot is red.
    assert frames[3] < 25 and frames[4] > 90  # First frame of the second shot is green.


async def test_fractional_output_timestamps_include_one_frame_shot(tools, tmp_path):
    ffmpeg, ffprobe = tools
    timeline = {
        "fpsNumerator": 30000,
        "fpsDenominator": 1001,
        "frameCount": 91,
        "shots": [
            {"shotId": "a", "startFrame": 0, "endFrame": 30},
            {"shotId": "b", "startFrame": 30, "endFrame": 31},
            {"shotId": "c", "startFrame": 31, "endFrame": 91},
        ],
    }
    clips = {
        key: clip(
            ffmpeg,
            tmp_path / f"{key}.mp4",
            color=color,
            width=64,
            height=64,
            duration="3",
        )
        for key, color in zip("abc", ["red", "blue", "green"], strict=True)
    }
    output = tmp_path / "fractional.mp4"
    await compose_timeline(
        timeline, clips, output, width=64, height=64, ffmpeg=ffmpeg, ffprobe=ffprobe
    )
    timestamps = json.loads(
        run(
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=pts",
            "-of",
            "json",
            str(output),
        )
    )
    assert [frame["pts"] for frame in timestamps["frames"]] == [
        index * 1001 for index in range(91)
    ]


@pytest.mark.parametrize("cause", ["short", "geometry", "corrupt"])
async def test_bad_clips_stop_without_publishing(plan, tools, tmp_path, cause):
    ffmpeg, ffprobe = tools
    left = clip(ffmpeg, tmp_path / "left.mp4", color="blue")
    right = tmp_path / "bad.mp4"
    if cause == "corrupt":
        right.write_bytes(b"this is not an mp4")
    else:
        clip(
            ffmpeg,
            right,
            color="green",
            width=640 if cause == "geometry" else 720,
            duration="0.5" if cause == "short" else "2",
        )
    output = tmp_path / "result.mp4"
    with pytest.raises(MediaError):
        await compose(
            plan,
            {"shot_a": left, "shot_b": right},
            output,
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
        )
    assert not output.exists()
