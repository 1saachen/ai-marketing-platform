import hashlib
import json

import pytest
from fission_clone_analysis.contracts import contracts_directory


@pytest.fixture
def report():
    return json.loads(
        (contracts_directory() / "fixtures/fission-clone-analysis.json").read_text(
            "utf-8"
        )
    )


@pytest.fixture
def mapping():
    return json.loads(
        (contracts_directory() / "fixtures/fission-clone-mapping.json").read_text(
            "utf-8"
        )
    )


@pytest.fixture
def snapshot(report, mapping):
    return {
        "schemaVersion": 1,
        "operation": "ANALYZE",
        "purpose": None,
        "input": {
            "ref": mapping["sourceInput"],
            "input": {
                "schemaVersion": 1,
                "referenceUploadId": "44444444-4444-4444-8444-444444444444",
                "productUploadIds": [],
                "productName": "隔离测试商品",
                "productFacts": "本地合成的绿色方块包装，400×400图片。",
                "sourceRightsConfirmed": True,
            },
            "files": [
                {
                    "fileObjectId": "55555555-5555-4555-8555-555555555555",
                    "role": "REFERENCE",
                    "originalFileName": "qa-reference.mp4",
                    "mimeType": "video/mp4",
                    "sizeBytes": 9,
                    "sha256": hashlib.sha256(b"synthetic").hexdigest(),
                    "media": {
                        "durationMs": 3000,
                        "width": 360,
                        "height": 640,
                        "frameRate": 24,
                    },
                }
            ],
        },
        "analysis": {"ref": mapping["sourceAnalysis"], "report": report},
        "mapping": mapping,
        "candidates": [],
        "expectedDraftRevision": 1,
        "expectedArtifactRevision": 0,
        "model": "unit-test-model",
    }


@pytest.fixture
def claim(snapshot):
    return {
        "claimed": True,
        "taskId": "66666666-6666-4666-8666-666666666666",
        "projectId": "77777777-7777-4777-8777-777777777777",
        "workflowRunId": "88888888-8888-4888-8888-888888888888",
        "attemptToken": "99999999-9999-4999-8999-999999999999",
        "leaseExpiresAt": "2026-11-11T00:01:00Z",
        "inputHash": "f" * 64,
        "snapshot": snapshot,
        "checkpoints": [],
    }
