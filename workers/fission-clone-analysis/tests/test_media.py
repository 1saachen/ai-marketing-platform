import json
import os
import shutil
import sys
from pathlib import Path

import pytest
from fission_clone_analysis.media import (
    MediaError,
    MediaLimits,
    frame_times,
    run_process,
    sample_video,
)


def test_frame_sampling_is_bounded_and_never_seeks_past_eof():
    times = frame_times(120_000, MediaLimits())
    assert times[0] == 0 and times[-1] < 120_000
    assert len(times) == 24 and times == sorted(set(times))
    with pytest.raises(MediaError):
        frame_times(120_001, MediaLimits())


async def test_process_timeout_and_excess_output_are_bounded():
    with pytest.raises(MediaError, match="超时"):
        await run_process([sys.executable, "-c", "import time; time.sleep(10)"], 0.2)
    with pytest.raises(MediaError, match="超出限制"):
        await run_process(
            [sys.executable, "-c", "import sys; sys.stdout.write('x' * 1500000)"], 5
        )


def local_tools():
    repo = Path(__file__).resolve().parents[3]
    directory = repo / ".tmp/tools/ffmpeg/runtime/ffmpeg-9.0.2-essentials_build/bin"
    ffmpeg = os.getenv("FISSION_CLONE_FFMPEG_PATH") or shutil.which("ffmpeg")
    ffprobe = os.getenv("FISSION_CLONE_FFPROBE_PATH") or shutil.which("ffprobe")
    if not ffmpeg and (directory / "ffmpeg.exe").is_file():
        ffmpeg = str(directory / "ffmpeg.exe")
    if not ffprobe and (directory / "ffprobe.exe").is_file():
        ffprobe = str(directory / "ffprobe.exe")
    if not ffmpeg or not ffprobe:
        pytest.skip(
            "local FFmpeg/FFprobe not available; media integration not executed"
        )
    return ffmpeg, ffprobe


async def test_real_local_media_probe_and_sampling(tmp_path):
    ffmpeg, ffprobe = local_tools()
    source = tmp_path / "reference.mp4"
    await run_process(
        [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=96x128:rate=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-t",
            "1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-y",
            str(source),
        ],
        30,
    )
    value = await sample_video(
        source, tmp_path, MediaLimits(ffmpeg=ffmpeg, ffprobe=ffprobe, max_frames=4)
    )
    assert (value.duration_ms, value.width, value.height, value.has_audio) == (
        1000,
        96,
        128,
        True,
    )
    assert len(value.frames) == 2
    assert all(frame.jpeg.startswith(b"\xff\xd8") for frame in value.frames)
    assert not list(tmp_path.glob("frame-*.jpg"))
    assert value.metadata()["audioSemantics"] == "UNASSESSED"
    assert value.cut_candidates == ()


@pytest.mark.parametrize("video_duration", [None, "N/A", "nan", "inf", "0", "-1"])
async def test_probe_falls_back_to_container_for_unusable_video_duration(
    tmp_path, monkeypatch, video_duration
):
    async def tool(args, timeout):
        if args[0] == "ffprobe":
            return json.dumps(
                {
                    "streams": [
                        {
                            "codec_type": "video",
                            "duration": video_duration,
                            "width": 96,
                            "height": 128,
                        }
                    ],
                    "format": {"duration": "4.042000"},
                }
            ).encode()
        Path(args[-1]).write_bytes(b"jpeg")
        return b""

    monkeypatch.setattr("fission_clone_analysis.media.run_process", tool)
    result = await sample_video(
        tmp_path / "source", tmp_path, MediaLimits(max_frames=2)
    )
    assert result.duration_ms == 4042
    assert [frame.time_ms for frame in result.frames] == [0, 3842]


async def test_real_legacy_container_duration_keeps_report_and_video_evidence_separate(
    tmp_path,
):
    ffmpeg, ffprobe = local_tools()
    source = tmp_path / "different-av-durations.mp4"
    await run_process(
        [
            ffmpeg, "-nostdin", "-v", "error",
            "-f", "lavfi", "-i", "testsrc2=size=96x128:rate=24:d=4",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=4.042",
            "-c:v", "libx264", "-c:a", "aac", "-y", str(source),
        ],
        30,
    )
    output = await run_process(
        [
            ffprobe, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "format=duration:stream=duration,nb_frames",
            "-of", "json", str(source),
        ],
        30,
    )
    probe = json.loads(output)
    assert float(probe["streams"][0]["duration"]) == 4
    assert int(probe["streams"][0]["nb_frames"]) == 96
    assert float(probe["format"]["duration"]) == 4.042

    limits = MediaLimits(ffmpeg=ffmpeg, ffprobe=ffprobe, max_frames=2)
    current = await sample_video(source, tmp_path, limits)
    assert current.duration_ms == 4000

    frozen = {"durationMs": 4042, "width": 96, "height": 128}
    legacy = await sample_video(source, tmp_path, limits, frozen_media=frozen)
    assert legacy.metadata()["durationMs"] == 4042
    assert legacy.frames == current.frames
    assert [frame.time_ms for frame in legacy.frames] == [0, 3800]

    shorter = await sample_video(
        source, tmp_path, limits, frozen_media={**frozen, "durationMs": 3958}
    )
    assert shorter.metadata()["durationMs"] == 3958
    assert [frame.time_ms for frame in shorter.frames] == [0, 3758]


async def test_real_hard_cut_supplies_both_sides_within_frame_budget(tmp_path):
    ffmpeg, ffprobe = local_tools()
    source = tmp_path / "hard-cut.mp4"
    await run_process(
        [
            ffmpeg, "-nostdin", "-v", "error",
            "-f", "lavfi", "-i", "color=black:s=96x128:r=24:d=3",
            "-f", "lavfi", "-i", "color=white:s=96x128:r=24:d=3",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
            "-c:v", "libx264", "-y", str(source),
        ],
        30,
    )
    limits = MediaLimits(ffmpeg=ffmpeg, ffprobe=ffprobe, max_frames=4)
    value = await sample_video(source, tmp_path, limits)
    times = {frame.time_ms: frame.jpeg for frame in value.frames}
    assert value.metadata()["cutCandidates"] == [
        {"timeMs": 3000, "beforeMs": 2850, "afterMs": 3050}
    ]
    assert set(times) == {0, 2850, 3050, 5800}
    assert times[0] == times[2850] != times[3050] == times[5800]
    assert not list(tmp_path.glob("frame-*.jpg"))
