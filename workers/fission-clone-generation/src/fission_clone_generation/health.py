import tempfile
import time
from pathlib import Path


def marker() -> Path:
    return Path(tempfile.gettempdir()) / "fission-clone-generation.health"


if __name__ == "__main__":
    try:
        fresh = time.time() - marker().stat().st_mtime < 90
    except OSError:
        fresh = False
    raise SystemExit(0 if fresh else 1)
