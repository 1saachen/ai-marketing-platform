import json
import os
import shutil
import subprocess

import pytest

from fission_clone_generation.media import (
    MediaError,
    compose,
    compose_source_edit,
    compose_timeline,
    extract_shot_reference,
    normalize_original,
)
from fission_clone_generation.plan import SOURCE_EDIT_MODE
from fission_clone_generation.review import Reviewer


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


async def test_review_comparison_preserves_frame_order_and_single_frame_evidence(tools, tmp_path):
    ffmpeg, ffprobe = tools
    clips = {
        key: clip(ffmpeg, tmp_path / f"{key}.mp4", color=color, width=64, height=64)
        for key, color in zip("abc", ["red", "green", "blue"], strict=True)
    }
    final = tmp_path / "chronological.mp4"
    await compose_timeline(
        {
            "fpsNumerator": 24, "fpsDenominator": 1, "frameCount": 72,
            "shots": [
                {"shotId": key, "startFrame": index * 24, "endFrame": (index + 1) * 24}
                for index, key in enumerate("abc")
            ],
        },
        clips, final, width=64, height=64, ffmpeg=ffmpeg, ffprobe=ffprobe,
    )
    reviewer = Reviewer("https://provider.invalid", "offline", ffmpeg)
    try:
        for frames, colors in [([23, 24, 48], [(255, 0, 0), (0, 128, 0), (0, 0, 255)]),
                               ([71], [(0, 0, 255)])]:
            image = tmp_path / f"comparison-{len(frames)}.jpg"
            image.write_bytes(await reviewer._comparison_jpeg(final, frames))
            metadata = json.loads(run(
                ffprobe, "-v", "error", "-show_entries", "stream=width,height",
                "-of", "json", str(image),
            ))
            assert metadata["streams"] == [{"width": 320 * len(frames), "height": 320}]
            pixels = run(
                ffmpeg, "-v", "error", "-i", str(image), "-vf", f"scale={len(frames)}:1:flags=neighbor",
                "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
            )
            assert len(pixels) == len(colors) * 3
            assert all(abs(actual - expected) < 12
                       for actual, expected in zip(pixels, sum((list(c) for c in colors), []), strict=True))
    finally:
        await reviewer.close()


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


async def test_source_edit_preserves_original_spans_and_absolute_edit_offsets(
    source_edit_plan, tools, tmp_path
):
    ffmpeg, ffprobe = tools
    plan = source_edit_plan
    original = clip(
        ffmpeg, tmp_path / "raw-original.mp4", color="red", width=540, height=960,
        rate="30", duration="4", audio=True,
    )
    normalized = tmp_path / "original.mp4"
    await normalize_original(
        plan, original, normalized, ffmpeg=ffmpeg, ffprobe=ffprobe
    )
    edited = tmp_path / "full-edit.mp4"
    run(
        ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
        "color=yellow:s=720x1280:r=24:d=4.05", "-threads", "1",
        "-vf", "drawbox=color=blue:t=fill:enable='gte(t,2)'",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(edited),
    )
    final = tmp_path / "result.mp4"
    await compose_source_edit(
        plan, normalized, edited, final, ffmpeg=ffmpeg, ffprobe=ffprobe
    )
    data = json.loads(run(
        ffprobe, "-v", "error", "-show_entries",
        "stream=codec_type,nb_frames,avg_frame_rate,width,height", "-of", "json", str(final),
    ))
    assert data["streams"] == [{
        "codec_type": "video", "nb_frames": "96", "avg_frame_rate": "24/1",
        "width": 720, "height": 1280,
    }]
    frames = run(
        ffmpeg, "-v", "error", "-i", str(final), "-vf",
        r"select=eq(n\,47)+eq(n\,48)+eq(n\,95),scale=1:1", "-fps_mode",
        "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    )
    # The unchanged shot stays original red. The edit starts at source frame
    # 48 (blue), not at local frame zero of the provider's full video (yellow).
    assert len(frames) == 9
    assert all(
        abs(actual - expected) < 12
        for actual, expected in zip(frames, [255, 0, 0, 0, 0, 255, 0, 0, 255], strict=True)
    )


async def test_shot_reference_cut_pads_only_its_last_frame_and_keeps_final_cut(
    shot_reference_plan, tools, tmp_path,
):
    ffmpeg, ffprobe = tools
    plan = shot_reference_plan
    raw = tmp_path / "raw.mp4"
    run(
        ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=270x480:r=30:d=4",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-threads", "1",
        "-vf", "drawbox=color=yellow:t=fill:enable='between(t,0.75,1.499)',"
        "drawbox=color=blue:t=fill:enable='gte(t,1.5)'",
        "-c:v", "mpeg4", "-pix_fmt", "yuv420p", str(raw),
    )
    original = tmp_path / "original.mp4"
    await normalize_original(plan, raw, original, ffmpeg=ffmpeg, ffprobe=ffprobe)
    clips = {}
    for index, shot in enumerate(plan["shots"]):
        reference = tmp_path / f"reference-{index}.mp4"
        await extract_shot_reference(
            plan, index, original, reference, ffmpeg=ffmpeg, ffprobe=ffprobe
        )
        streams = json.loads(run(
            ffprobe, "-v", "error", "-show_entries",
            "stream=codec_type,codec_name,nb_frames,avg_frame_rate,width,height",
            "-of", "json", str(reference),
        ))["streams"]
        assert streams == [{
            "codec_type": "video", "codec_name": "h264",
            "nb_frames": str(shot["referenceFrames"]), "avg_frame_rate": "24/1",
            "width": 720, "height": 1280,
        }]
        clips[shot["shotId"]] = reference

    final = tmp_path / "final.mp4"
    await compose(plan, clips, final, ffmpeg=ffmpeg, ffprobe=ffprobe)

    def colors(path, frames):
        select = "+".join(rf"eq(n\,{index})" for index in frames)
        return run(
            ffmpeg, "-v", "error", "-i", str(path), "-vf", f"select={select},scale=1:1",
            "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
        )

    red, yellow, blue = [255, 0, 0], [255, 255, 0], [0, 0, 255]
    for actual, expected in (
        (colors(clips["shot_a"], [0, 35, 36, 47]), red + yellow * 3),
        (colors(clips["shot_b"], [0, 59]), blue * 2),
        (colors(final, [0, 35, 36, 95]), red + yellow + blue * 2),
    ):
        assert all(
            abs(current - target) < 12
            for current, target in zip(actual, expected, strict=True)
        )


@pytest.mark.parametrize("source_frames", [96, 95])
async def test_legacy_container_duration_only_extends_one_original_frame(
    shot_reference_plan, tools, tmp_path, source_frames,
):
    ffmpeg, ffprobe = tools
    plan = shot_reference_plan
    timeline = plan["timeline"]
    timeline.update(durationMs=4042, frameCount=97)
    for key in ("stages", "shots"):
        timeline[key][-1].update(endMs=4042, endFrame=97)
    plan["shots"][1]["referenceFrames"] = 61

    # Encode the frame index in eight black or white vertical strips so decoding
    # can reveal an extra, missing or reordered frame anywhere in the timeline.
    raw = tmp_path / "legacy.mp4"
    run(
        ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
        f"nullsrc=s=72x128:r=24,trim=end_frame={source_frames},"
        "geq=lum='16+219*gt(bitand(N,pow(2,floor(8*X/W))),0)':cb=128:cr=128",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4.042",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(raw),
    )
    source = json.loads(run(
        ffprobe, "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=duration,nb_read_frames:format=duration",
        "-of", "json", str(raw),
    ))
    assert round(float(source["format"]["duration"]) * 1000) == 4042
    assert source["streams"] == [{
        "duration": f"{source_frames / 24:.6f}", "nb_read_frames": str(source_frames),
    }]

    original = tmp_path / "normalized.mp4"
    if source_frames == 95:
        with pytest.raises(MediaError, match="成片未完整覆盖锁定帧时间线"):
            await normalize_original(plan, raw, original, ffmpeg=ffmpeg, ffprobe=ffprobe)
        assert not original.exists()
        return

    def frame_numbers(path):
        pixels = run(
            ffmpeg, "-v", "error", "-i", str(path), "-vf", "scale=8:1:flags=neighbor",
            "-fps_mode", "passthrough", "-pix_fmt", "gray", "-f", "rawvideo", "-",
        )
        assert len(pixels) % 8 == 0
        return [
            sum(1 << bit for bit, value in enumerate(pixels[offset:offset + 8]) if value > 128)
            for offset in range(0, len(pixels), 8)
        ]

    await normalize_original(plan, raw, original, ffmpeg=ffmpeg, ffprobe=ffprobe)
    expected = list(range(96)) + [95]
    assert frame_numbers(original) == expected
    references = {}
    for index, shot in enumerate(plan["shots"]):
        reference = tmp_path / f"legacy-reference-{index}.mp4"
        await extract_shot_reference(
            plan, index, original, reference, ffmpeg=ffmpeg, ffprobe=ffprobe,
        )
        references[shot["shotId"]] = reference
    assert frame_numbers(references["shot_a"]) == expected[:36] + [35] * 12
    assert frame_numbers(references["shot_b"]) == expected[36:]

    output = tmp_path / "composed.mp4"
    await compose(plan, references, output, ffmpeg=ffmpeg, ffprobe=ffprobe)
    assert frame_numbers(output) == expected

    generated = clip(
        ffmpeg, tmp_path / "short-generated.mp4", color="black", rate="24", duration="2.5",
    )
    with pytest.raises(MediaError, match="生成镜头短于锁定区间"):
        await compose(
            plan, {**references, "shot_b": generated}, tmp_path / "short-output.mp4",
            ffmpeg=ffmpeg, ffprobe=ffprobe,
        )

    plan["mode"] = SOURCE_EDIT_MODE
    plan["sourceVideo"]["renderSeconds"] = 5
    for shot in plan["shots"]:
        del shot["referenceFrames"]
    with pytest.raises(MediaError, match="成片未完整覆盖锁定帧时间线"):
        await normalize_original(
            plan, raw, tmp_path / "source-edit.mp4", ffmpeg=ffmpeg, ffprobe=ffprobe,
        )
