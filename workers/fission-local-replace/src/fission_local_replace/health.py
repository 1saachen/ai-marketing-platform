from pathlib import Path
import tempfile
import time


def marker() -> Path:
    return Path(tempfile.gettempdir()) / "fission-local-replace.health"


if __name__ == "__main__":
    try:
        fresh = time.time() - marker().stat().st_mtime < 90
    except OSError:
        fresh = False
    raise SystemExit(0 if fresh else 1)
