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


@pytest.fixture
def source_edit_plan(plan):
    plan["mode"] = "SEEDANCE_2_0_SOURCE_EDIT"
    plan["renderInstructionVersion"] = 2
    plan["sourceVideo"] = {
        "fileObjectId": "77777777-7777-4777-8777-777777777777",
        "sha256": "c" * 64,
        "sizeBytes": 8192,
        "renderSeconds": 4,
        "mimeType": "video/mp4",
    }
    timeline = plan["timeline"]
    timeline.update(durationMs=4000, frameCount=96)
    for key in ("stages", "shots"):
        timeline[key][0].update(endMs=2000, endFrame=48)
        timeline[key][1].update(startMs=2000, startFrame=48, endMs=4000, endFrame=96)
    plan["shots"][0]["targets"] = []
    plan["shots"][1]["targets"][0]["sourceDescription"] = "手里握着的白盖粉色小瓶"
    return plan


@pytest.fixture
def shot_reference_plan(source_edit_plan):
    plan = source_edit_plan
    plan["mode"] = "SEEDANCE_2_0_SHOT_REFERENCE"
    del plan["sourceVideo"]["renderSeconds"]
    for key in ("stages", "shots"):
        plan["timeline"][key][0].update(endMs=1500, endFrame=36)
        plan["timeline"][key][1].update(startMs=1500, startFrame=36)
    plan["shots"][0]["referenceFrames"] = 48
    plan["shots"][1]["referenceFrames"] = 60
    return plan


@pytest.fixture
def shot_motion():
    return {
        "status": "OBSERVED",
        "openingState": "商品直立在柜台，手在右侧",
        "closingState": "商品放稳，正面转向左侧，手松开",
        "reason": "",
        "events": [
            {
                "startMs": 200,
                "endMs": 840,
                "subjectAction": "手握住并拿起商品",
                "cameraAction": "固定机位观察",
                "contact": "拇指和食指握住商品两侧",
                "productPose": "商品离开台面，正面朝前",
                "evidenceFramesMs": [230, 820],
            },
            {
                "startMs": 840,
                "endMs": 1450,
                "subjectAction": "向左转动商品，放回台面后松手",
                "cameraAction": "保持构图",
                "contact": "底部接触台面后手指离开",
                "productPose": "放稳且正面转向左侧",
                "evidenceFramesMs": [1000, 1360],
            },
        ],
    }
