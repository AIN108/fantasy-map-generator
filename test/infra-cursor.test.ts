import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyInfra, MAX_SPAN_LENGTH, type Infra } from "../src/infra.ts";
import { findCell } from "../src/mesh.ts";
import { drawInfraCursor, type CursorCanvas, type InfraCursorState } from "../src/ui/infra-cursor.ts";
import { createMesh, DEFAULT_OPTIONS, type WorldMap } from "../src/world.ts";

const mesh = createMesh({ ...DEFAULT_OPTIONS, seed: "커서", cells: 2000, width: 1000, height: 700 });
const world = { cities: [{ cell: 42 }] } as unknown as WorldMap;

/** 덧그리기 호출을 기록하는 가짜 캔버스 */
function fakeCanvas(): CursorCanvas & { calls: string[]; sets: [string, unknown][]; circles: unknown[][] } {
  const calls: string[] = [], sets: [string, unknown][] = [], circles: unknown[][] = [];
  const octx = new Proxy({}, {
    get: (_t, k) => (..._a: unknown[]) => { calls.push(String(k)); },
    set: (_t, k, v) => { sets.push([String(k), v]); return true; },
  }) as CanvasRenderingContext2D;
  return { octx, calls, sets, circles, strokeCircle: (...a: unknown[]) => { circles.push(a); }, hitRadius: () => 12 };
}

function state(over: Partial<InfraCursorState> = {}, infra: Infra = emptyInfra()): InfraCursorState {
  return {
    world, mesh, infra, tool: "road", draggingPoint: null, draggingSpan: null, routeStart: -1, routePreview: null,
    spanMode: () => "road", snapToPort: () => -1, movedSpanCells: () => null, nearestCity: () => -1, ...over,
  };
}

test("항로: 가까운 항구가 있으면 그 항구를, 없으면 점선 원을 그린다", () => {
  const a = fakeCanvas();
  drawInfraCursor(a, state({ tool: "sea" }), 100, 200);
  assert.deepEqual(a.circles, [[100, 200, 6, [3, 3]]]);
  const b = fakeCanvas();
  drawInfraCursor(b, state({ tool: "sea", snapToPort: () => 10 }), 100, 200);
  assert.deepEqual(b.circles, [[mesh.x[10], mesh.y[10], 10]]);
});

test("도로·철도를 끄는 중이면 미리보기 경로를 두 번(테두리·본선) 긋고 출발점에 원을 그린다", () => {
  for (const [tool, color] of [["road", "rgba(110,70,40,0.95)"], ["rail", "#2b2b2b"]] as const) {
    const c = fakeCanvas();
    drawInfraCursor(c, state({ tool, routeStart: 3, routePreview: [3, 4, 5] }), 0, 0);
    assert.equal(c.calls.filter((k) => k === "lineTo").length, 3);
    assert.equal(c.calls.filter((k) => k === "stroke").length, 2);
    assert.deepEqual(c.sets.filter(([k]) => k === "strokeStyle").map(([, v]) => v), ["rgba(255,255,255,0.85)", color]);
    assert.deepEqual(c.circles, [[mesh.x[3], mesh.y[3], 5]]);
  }
});

test("도로 도구는 가까운 도시를 강조하고, 지우개는 누르기 반지름의 점선 원을 그린다", () => {
  const a = fakeCanvas();
  drawInfraCursor(a, state({ tool: "road", nearestCity: () => 0 }), 50, 60);
  assert.deepEqual(a.circles, [[mesh.x[42], mesh.y[42], 10]]);
  const b = fakeCanvas();
  drawInfraCursor(b, state({ tool: "erase", nearestCity: () => 0 }), 50, 60);
  assert.deepEqual(b.circles, [[50, 60, 12, [3, 3]]]);
});

test("항구를 끄는 중이면 원래 자리에서 점선을 긋고 놓일 셀에 원을 그린다", () => {
  const infra = emptyInfra();
  infra.ports.push({ cell: 7 } as Infra["ports"][number]);
  const c = fakeCanvas();
  drawInfraCursor(c, state({ tool: "move", draggingPoint: { kind: "port", index: 0 } }, infra), 300, 300);
  const to = findCell(mesh, 300, 300);
  assert.ok(c.calls.includes("setLineDash"));
  assert.deepEqual(c.circles, [[mesh.x[to], mesh.y[to], 8]]);
});

test("다리를 끄는 중이면 너무 길 때 흐리게 그린다", () => {
  const start = findCell(mesh, 10, 10);
  const near = fakeCanvas();
  drawInfraCursor(near, state({ tool: "bridge", routeStart: start }), mesh.x[start] + 5, mesh.y[start]);
  assert.deepEqual(near.sets.find(([k]) => k === "globalAlpha"), ["globalAlpha", 0.9]);
  const far = fakeCanvas();
  drawInfraCursor(far, state({ tool: "bridge", routeStart: start }), mesh.x[start] + MAX_SPAN_LENGTH + 100, mesh.y[start] + 100);
  assert.deepEqual(far.sets.find(([k]) => k === "globalAlpha"), ["globalAlpha", 0.4]);
  assert.deepEqual(far.circles, [[mesh.x[start], mesh.y[start], 5]]);
});
