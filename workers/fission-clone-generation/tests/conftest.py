import json
from pathlib import Path

import pytest


@pytest.fixture
def plan():
    path = (
        Path(__file__).resolve().parents[3]
        / "packages/contracts/fixtures/fission-clone-generation-plan.json"
    )
    return json.loads(path.read_text("utf-8"))
