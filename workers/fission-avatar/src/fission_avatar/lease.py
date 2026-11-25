from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import UUID

from ai_runtime.http import InternalApiError

UNAVAILABLE = {404, 409}


class LeasePort(Protocol):
    token: str

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]: ...


class LeaseInactive(RuntimeError):
    """The API cancelled or superseded the task attempt."""


@dataclass
class Heartbeat:
    api: LeasePort
    phase: str
    progress: int = 5
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def update(
        self, phase: str | None = None, progress: int | None = None
    ) -> None:
        async with self.lock:
            if phase is not None:
                self.phase = phase
            if progress is not None:
                self.progress = progress
            response = await self.api.call(
                "POST", "heartbeat", {"phase": self.phase, "progress": self.progress}
            )
            if response.get("active") is False:
                raise LeaseInactive
            if response.get("active") is not True:
                raise InternalApiError("invalid heartbeat response", retryable=False)

    async def tick(self) -> None:
        while True:
            await asyncio.sleep(10)
            await self.update()


async def claim_task(api: LeasePort) -> dict[str, Any] | None:
    while True:
        try:
            claim = await api.call("POST", "claim")
        except InternalApiError as error:
            if error.status_code in UNAVAILABLE:
                return None
            raise
        status = claim.get("status")
        if status == "CLAIMED":
            break
        if status == "INACTIVE":
            return None
        if status != "BUSY":
            raise InternalApiError("invalid claim status", retryable=False)
        await asyncio.sleep(15)

    raw_token = claim.get("attemptToken")
    try:
        api.token = str(UUID(raw_token)) if isinstance(raw_token, str) else ""
    except ValueError:
        api.token = ""
    if not api.token:
        raise InternalApiError("invalid claim token", retryable=False)
    return claim


async def with_heartbeat(
    beat: Heartbeat, execute: Callable[[], Awaitable[None]], timeout: int
) -> None:
    async def attempt() -> None:
        async with asyncio.timeout(timeout):
            await execute()

    work = asyncio.create_task(attempt())
    ticker = asyncio.create_task(beat.tick())
    try:
        done, pending = await asyncio.wait(
            {work, ticker}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if work in done:
            await work
        else:
            await ticker
    finally:
        work.cancel()
        ticker.cancel()
        await asyncio.gather(work, ticker, return_exceptions=True)


async def fail_task(api: LeasePort, code: str, *, retryable: bool) -> None:
    try:
        await api.call("POST", "fail", {"code": code, "retryable": retryable})
    except InternalApiError as error:
        if error.status_code not in UNAVAILABLE:
            raise
