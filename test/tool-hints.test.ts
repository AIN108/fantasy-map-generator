import assert from "node:assert/strict";
import { test } from "node:test";
import { BRUSH_TOOLS } from "../src/editor.ts";
import {
  BORDER_HINT, CITY_TOOL_HINTS, INFRA_TOOL_HINTS, RESOURCE_TOOL_HINTS, toolHintText, type ToolHintState,
} from "../src/ui/tool-hints.ts";

const base: ToolHintState = {
  target: "terrain", brushTool: "raise", cityTool: "move", infraTool: "road", resourceTool: "add", civEdited: false, roadsFixed: false,
};
const CIV_NOTE = " (처음 편집하면 자동 배치를 멈추고 지금 상태를 고정합니다)";
const ROAD_NOTE = " (도로를 처음 편집하면 자동 도로를 지금 상태로 고정합니다)";

test("지형은 고른 붓의 안내를 덧붙임 없이 쓴다", () => {
  for (const brushTool of ["raise", "lower", "flatten", "smooth"] as const) {
    assert.equal(toolHintText({ ...base, brushTool }), BRUSH_TOOLS[brushTool].hint);
  }
});

test("도시·국경은 자동 배치 중일 때만 고정 안내를 붙인다", () => {
  assert.equal(toolHintText({ ...base, target: "city", cityTool: "add" }), CITY_TOOL_HINTS.add + CIV_NOTE);
  assert.equal(toolHintText({ ...base, target: "city", cityTool: "add", civEdited: true }), CITY_TOOL_HINTS.add);
  assert.equal(toolHintText({ ...base, target: "border" }), BORDER_HINT + CIV_NOTE);
  assert.equal(toolHintText({ ...base, target: "border", civEdited: true }), BORDER_HINT);
});

test("시설은 도로·지우개 도구에서 도로가 자동일 때만 고정 안내를 붙인다", () => {
  assert.equal(toolHintText({ ...base, target: "infra", infraTool: "road" }), INFRA_TOOL_HINTS.road + ROAD_NOTE);
  assert.equal(toolHintText({ ...base, target: "infra", infraTool: "erase" }), INFRA_TOOL_HINTS.erase + ROAD_NOTE);
  assert.equal(toolHintText({ ...base, target: "infra", infraTool: "road", roadsFixed: true }), INFRA_TOOL_HINTS.road);
  assert.equal(toolHintText({ ...base, target: "infra", infraTool: "rail" }), INFRA_TOOL_HINTS.rail);
  assert.equal(toolHintText({ ...base, target: "infra", infraTool: "port", civEdited: true }), INFRA_TOOL_HINTS.port);
});

test("자원은 고른 도구의 안내를 쓴다", () => {
  assert.equal(toolHintText({ ...base, target: "resource", resourceTool: "erase" }), RESOURCE_TOOL_HINTS.erase);
});
