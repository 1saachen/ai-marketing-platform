from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any, cast

from ai_runtime.seedance import SeedanceTransport
from continuity_probe import Ledger, PilotError, make_scene, seedance_payload


class FakeArk:
    def __init__(self) -> None:
        self.creates: list[dict[str, Any]] = []

    @staticmethod
    def tail(ordinal: int) -> str:
        return f"https://test.invalid/seedance/native-tail-{ordinal}.jpg"

    async def render_request(
        self, payload: dict[str, Any], name: str, checkpoint: Any, task: str | None
    ) -> Any:
        if task is None:
            self.creates.append(payload)
            task = f"fixture-{len(self.creates)}"
        await checkpoint(10, task)
        return SimpleNamespace(content=f"original provider video {task}".encode())

    async def _request(self, method: str, path: str) -> dict[str, Any]:
        ordinal = int(path.rsplit("-", 1)[-1])
        return {
            "status": "succeeded",
            "content": {"last_frame_url": self.tail(ordinal)},
            "usage": {"completion_tokens": 40_000},
        }


class ContinuityProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_links_native_tail_and_resumes_completed_scene_without_recreating(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            state = Ledger(root, "same-input", 800)
            mock = FakeArk()
            ark = cast(SeedanceTransport, mock)
            first, tail = await make_scene(ark, state, root, 1, None)
            self.assertEqual(tail, mock.tail(1))
            second, next_tail = await make_scene(ark, state, root, 2, tail)
            self.assertEqual(next_tail, mock.tail(2))
            self.assertEqual(mock.creates[1]["content"][1]["role"], "first_frame")
            self.assertEqual(
                mock.creates[1]["content"][1]["image_url"]["url"], mock.tail(1)
            )
            self.assertEqual(first.read_bytes(), b"original provider video fixture-1")
            self.assertEqual(second.read_bytes(), b"original provider video fixture-2")
            self.assertEqual(
                await make_scene(ark, Ledger(root, "same-input", 800), root, 2, tail),
                (second, next_tail),
            )
            self.assertEqual(len(mock.creates), 2)
            self.assertEqual(state.entries["seedance-1"]["costCents"], 148)

    async def test_unknown_create_and_changed_checkpoint_never_submit_again(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            state = Ledger(root, "same-input", 800)
            state.reserve("seedance", "seedance-1")
            mock = FakeArk()
            with self.assertRaisesRegex(PilotError, "受理状态未知"):
                await make_scene(cast(SeedanceTransport, mock), state, root, 1, None)
            with self.assertRaisesRegex(PilotError, "不一致"):
                Ledger(root, "changed-input", 800)
            self.assertFalse(mock.creates)

    def test_fixed_cost_envelope_and_strict_input(self) -> None:
        with TemporaryDirectory() as directory:
            state = Ledger(Path(directory), "same-input", 210)
            state.reserve("seedance", "seedance-1")
            with self.assertRaisesRegex(PilotError, "预算"):
                state.reserve("seedance", "seedance-2")
        self.assertFalse(seedance_payload(1, None)["generate_audio"])
        self.assertFalse(seedance_payload(3, FakeArk.tail(2))["return_last_frame"])
        with self.assertRaises(PilotError):
            seedance_payload(2, "http://test.invalid/tail.jpg")


if __name__ == "__main__":
    unittest.main()
