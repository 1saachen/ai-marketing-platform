from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path


def marker_path() -> Path:
    return Path(
        os.getenv(
            "FISSION_CLONE_HEALTH_FILE",
            str(Path(tempfile.gettempdir()) / "fission-clone-analysis.health"),
        )
    )


def healthy() -> bool:
    try:
        return time.time() - marker_path().stat().st_mtime < 90
    except OSError:
        return False


if __name__ == "__main__":
    raise SystemExit(0 if healthy() else 1)
