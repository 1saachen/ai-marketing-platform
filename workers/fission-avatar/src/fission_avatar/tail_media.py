from __future__ import annotations

import asyncio
import hashlib
import wave
from array import array
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path
from sys import byteorder
from typing import TypedDict

from .media import _MP3, MAX_AUDIO_BYTES, MediaError, _run
from .provider import Timing

SAMPLE_RATE = 24_000
_SAMPLES_PER_MS = SAMPLE_RATE // 1000
_MIN_SECONDS, _MAX_SECONDS = 61, 90
_MIN_SEGMENTS, _MAX_SEGMENTS = 5, 12
_MAX_SEGMENT_SECONDS = 15
_PAUSE_MARGIN = SAMPLE_RATE // 100
_CANDIDATE_SPACING = SAMPLE_RATE // 10


class TailSegment(TypedDict):
    sourceStartSample: int
    sourceEndSample: int
    leadingSilenceSamples: int
    durationSeconds: int


class TailPlan(TypedDict):
    masterSha256: str
    sourceSamples: int
    segments: list[TailSegment]


@dataclass(frozen=True)
class TailSpeech:
    plan: TailPlan
    _pcm: bytes
    _timings: list[Timing]

    async def write_segment(
        self, ordinal: int, wav: Path, mp3: Path, ffmpeg: str
    ) -> list[Timing]:
        if not 1 <= ordinal <= len(self.plan["segments"]):
            raise MediaError("invalid tail-chain segment ordinal")
        segment = self.plan["segments"][ordinal - 1]
        start, end = segment["sourceStartSample"], segment["sourceEndSample"]
        leading = segment["leadingSilenceSamples"]
        duration = segment["durationSeconds"] * SAMPLE_RATE
        trailing = duration - (end - start) - leading
        data = (
            b"\0" * (leading * 2)
            + self._pcm[start * 2 : end * 2]
            + b"\0" * (trailing * 2)
        )
        with wav.open("xb") as target, wave.open(target, "wb") as sound:
            sound.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            sound.writeframes(data)
        await _run(
            ffmpeg,
            "-v",
            "error",
            "-nostdin",
            "-xerror",
            "-n",
            "-protocol_whitelist",
            "file,pipe",
            "-f",
            "wav",
            "-i",
            str(wav),
            "-map",
            "0:a:0",
            "-map_metadata",
            "-1",
            "-threads",
            "1",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "64k",
            "-write_xing",
            "1",
            "-f",
            "mp3",
            str(mp3),
        )
        return _shifted_words(self._timings, segment)


def _shifted_words(timings: list[Timing], segment: TailSegment) -> list[Timing]:
    start, end = segment["sourceStartSample"], segment["sourceEndSample"]
    leading = segment["leadingSilenceSamples"]
    words = []
    for word in timings:
        start_sample = word["startMs"] * _SAMPLES_PER_MS
        if not start <= start_sample < end:
            continue
        end_sample = min(end, word["endMs"] * _SAMPLES_PER_MS)
        words.append(
            Timing(
                text=word["text"],
                startMs=round((start_sample - start + leading) / _SAMPLES_PER_MS),
                endMs=round((end_sample - start + leading) / _SAMPLES_PER_MS),
                confidencePermille=word["confidencePermille"],
            )
        )
    if not 1 <= len(words) <= 240 or any(
        word["startMs"] >= word["endMs"] for word in words
    ):
        raise MediaError("tail-chain segment requires valid timed speech")
    return words


def _timed_gaps(timings: list[Timing], source_samples: int) -> list[tuple[int, int]]:
    if not timings:
        raise MediaError("tail-chain speech has no timings")
    gaps = []
    latest_start, latest_end = -1, 0
    for word in timings:
        start = word["startMs"] * _SAMPLES_PER_MS
        end = word["endMs"] * _SAMPLES_PER_MS
        if (
            start < latest_start
            or not 0 <= start < min(end, source_samples)
            or end > source_samples + _SAMPLES_PER_MS
        ):
            raise MediaError("tail-chain timings fall outside decoded speech")
        if latest_end and start - latest_end >= 2 * _PAUSE_MARGIN:
            gaps.append((latest_end + _PAUSE_MARGIN, start - _PAUSE_MARGIN))
        latest_start, latest_end = start, max(latest_end, end)
    return gaps


def _pause_energy(samples: array[int], cut: int) -> int:
    return sum(
        value * value for value in samples[cut - _PAUSE_MARGIN : cut + _PAUSE_MARGIN]
    )


def _pause_candidates(
    samples: array[int], gaps: list[tuple[int, int]], quiet_limit: float
) -> dict[int, int]:
    windows: dict[int, tuple[int, int]] = {}
    whole_seconds: dict[int, int] = {}
    for low, high in gaps:
        middle = (low + high) // 2
        positions = set(range(low, high + 1, _CANDIDATE_SPACING))
        positions.update(
            range(-(-low // SAMPLE_RATE) * SAMPLE_RATE, high + 1, SAMPLE_RATE)
        )
        positions.add(middle)
        for cut in sorted(positions):
            energy = _pause_energy(samples, cut)
            if energy > quiet_limit:
                continue
            cost = round(100 * energy / quiet_limit)
            if cut % SAMPLE_RATE == 0:
                whole_seconds[cut] = cost
            window = cut // _CANDIDATE_SPACING
            previous = windows.get(window)
            if previous is None or cost < previous[0]:
                windows[window] = cost, cut
    return {**{cut: cost for cost, cut in windows.values()}, **whole_seconds}


def _plan_sections(
    source_samples: int, speech_starts: list[int], pauses: dict[int, int]
) -> list[TailSegment]:
    positions = [0, *sorted(pauses), source_samples]
    # For each boundary, retain the best way to reach each segment count and integer duration.
    State = tuple[int, int]
    Step = tuple[int, int, State]
    paths: list[dict[State, Step]] = [{(0, 0): (0, 0, (0, 0))}]
    next_speech = [bisect_left(speech_starts, position) for position in positions]
    for index, end in enumerate(positions[1:], 1):
        states: dict[State, Step] = {}
        remaining = source_samples - end
        first = bisect_left(
            positions, end - _MAX_SEGMENT_SECONDS * SAMPLE_RATE, 0, index
        )
        last = bisect_left(positions, end - 3 * SAMPLE_RATE, first, index)
        for previous in range(first, last):
            duration = -(-(end - positions[previous]) // SAMPLE_RATE)
            if next_speech[previous] == next_speech[index]:
                continue
            cost = pauses.get(end, 0) + (duration - 10) ** 2
            for (count, total), (score, _, _) in paths[previous].items():
                if (
                    count >= _MAX_SEGMENTS
                    or remaining
                    > (_MAX_SEGMENTS - count - 1) * _MAX_SEGMENT_SECONDS * SAMPLE_RATE
                    or total + duration - (-remaining // SAMPLE_RATE) > _MAX_SECONDS
                ):
                    continue
                key = count + 1, total + duration
                if key not in states or score + cost < states[key][0]:
                    states[key] = score + cost, previous, (count, total)
        paths.append(states)
    candidates = [
        (total, count, step[0])
        for (count, total), step in paths[-1].items()
        if _MIN_SEGMENTS <= count <= _MAX_SEGMENTS
        and _MIN_SECONDS <= total <= _MAX_SECONDS
    ]
    if not candidates:
        raise MediaError("speech pauses cannot fit the supported tail-chain durations")
    total, count, _ = min(candidates)
    key = count, total
    index = len(positions) - 1
    segments = []
    while index:
        _, previous, previous_key = paths[index][key]
        start, end = positions[previous], positions[index]
        duration = key[1] - previous_key[1]
        leading_silence = (duration * SAMPLE_RATE - (end - start)) // 2
        segments.append(
            TailSegment(
                sourceStartSample=start,
                sourceEndSample=end,
                leadingSilenceSamples=leading_silence,
                durationSeconds=duration,
            )
        )
        index, key = previous, previous_key
    return list(reversed(segments))


def _validate_sections(
    segments: list[TailSegment],
    samples: array[int],
    timings: list[Timing],
    gaps: list[tuple[int, int]],
    quiet_limit: float,
) -> None:
    if not _MIN_SEGMENTS <= len(segments) <= _MAX_SEGMENTS:
        raise MediaError("unsupported tail-chain segment count")
    previous, total = 0, 0
    for segment in segments:
        start, end = segment["sourceStartSample"], segment["sourceEndSample"]
        duration, leading = segment["durationSeconds"], segment["leadingSilenceSamples"]
        padding = duration * SAMPLE_RATE - (end - start)
        if (
            start != previous
            or not start < end <= len(samples)
            or not 4 <= duration <= _MAX_SEGMENT_SECONDS
            or not 0 <= leading <= padding < SAMPLE_RATE
            or start > 0
            and (
                not any(low <= start <= high for low, high in gaps)
                or _pause_energy(samples, start) > quiet_limit
            )
        ):
            raise MediaError(
                "frozen tail-chain slice does not match the original speech"
            )
        _shifted_words(timings, segment)
        previous, total = end, total + duration
    if previous != len(samples) or not _MIN_SECONDS <= total <= _MAX_SECONDS:
        raise MediaError("frozen tail-chain slices do not cover the original speech")


def _prepare(
    pcm: bytes, digest: str, timings: list[Timing], plan: TailPlan | None
) -> TailSpeech:
    if not 0 < len(pcm) <= _MAX_SECONDS * SAMPLE_RATE * 2 or len(pcm) % 2:
        raise MediaError("decoded master speech is outside the supported duration")
    samples: array[int] = array("h")
    samples.frombytes(pcm)
    if byteorder != "little":
        samples.byteswap()
    if plan is not None and (
        plan["masterSha256"] != digest or plan["sourceSamples"] != len(samples)
    ):
        raise MediaError("frozen tail-chain master speech changed")
    gaps = _timed_gaps(timings, len(samples))
    average_energy = sum(value * value for value in samples) / len(samples)
    if average_energy <= 100:
        raise MediaError("tail-chain master contains insufficient speech energy")
    quiet_limit = max(16**2, average_energy * 0.15**2) * (2 * _PAUSE_MARGIN)
    if plan is None:
        speech_starts = [word["startMs"] * _SAMPLES_PER_MS for word in timings]
        plan = TailPlan(
            masterSha256=digest,
            sourceSamples=len(samples),
            segments=_plan_sections(
                len(samples),
                speech_starts,
                _pause_candidates(samples, gaps, quiet_limit),
            ),
        )
    _validate_sections(plan["segments"], samples, timings, gaps, quiet_limit)
    return TailSpeech(plan, pcm, timings)


async def prepare_tail_speech(
    source: Path, timings: list[Timing], ffmpeg: str, plan: TailPlan | None = None
) -> TailSpeech:
    with source.open("rb") as file:
        if not 0 < source.stat().st_size <= MAX_AUDIO_BYTES:
            raise MediaError("invalid master speech file size")
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    pcm = await _run(
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        *_MP3,
        "-threads",
        "1",
        "-i",
        str(source),
        "-map",
        "0:a:0",
        "-vn",
        "-t",
        str(_MAX_SECONDS + 1),
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
        capture=True,
    )
    return await asyncio.to_thread(_prepare, pcm, digest, timings, plan)
