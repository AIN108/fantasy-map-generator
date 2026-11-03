import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyBrush, decodeElevation, EditHistory, encodeElevation } from "../src/editor.ts";
import { findCell } from "../src/mesh.ts";
import {
  createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, parseMapJSON, toJSON, type WorldOptions,
} from "../src/world.ts";

const OPTS: WorldOptions = { ...DEFAULT_OPTIONS, seed: "편집", cells: 3000, width: 900, height: 600 };
const mesh = createMesh(OPTS);
const base = createElevation(mesh, OPTS);

/** 바다 한가운데(가장자리는 아닌) 셀을 찾는다. */
function deepOceanCell(): number {
  let best = -1;
  for (let i = 0; i < mesh.count; i++) {
    if (mesh.isEdge[i] || base[i] > -0.2) continue;
    if (best < 0 || base[i] < base[best]) best = i;
  }
  assert.ok(best >= 0, "테스트용 바다 셀이 없음");
  return best;
}

describe("브러시", () => {
  test("융기는 중심을 가장 많이, 반지름 밖은 전혀 바꾸지 않는다", () => {
    const e = Float64Array.from(base);
    const c = Math.floor(mesh.count / 2);
    const [cx, cy] = [mesh.x[c], mesh.y[c]];
    applyBrush(mesh, e, { tool: "raise", radius: 40, strength: 1 }, cx, cy);
    const center = findCell(mesh, cx, cy);
    assert.ok(e[center] > base[center]);
    for (let i = 0; i < mesh.count; i++) {
      if (Math.hypot(mesh.x[i] - cx, mesh.y[i] - cy) >= 40) assert.equal(e[i], base[i]);
      else assert.ok(e[i] >= base[i]);
    }
  });

  test("바다에 계속 융기를 칠하면 섬이 생기고, 문명 계산도 오류 없이 돈다", () => {
    const e = Float64Array.from(base);
    const c = deepOceanCell();
    for (let k = 0; k < 80; k++) applyBrush(mesh, e, { tool: "raise", radius: 35, strength: 1 }, mesh.x[c], mesh.y[c]);
    assert.ok(e[c] > 0, `고도 ${e[c]}`);
    const w = deriveWorld(OPTS, mesh, e);
    assert.ok(w.biome[c] !== "ocean");
    assert.ok(w.states.length > 0);
  });

  test("지도 가장자리 셀은 아무리 올려도 바다로 남는다", () => {
    const e = Float64Array.from(base);
    const edge = mesh.isEdge.indexOf(1);
    for (let k = 0; k < 100; k++) applyBrush(mesh, e, { tool: "raise", radius: 60, strength: 1 }, mesh.x[edge], mesh.y[edge]);
    for (let i = 0; i < mesh.count; i++) if (mesh.isEdge[i]) assert.ok(e[i] <= -0.05);
  });

  test("평탄화는 목표 높이에 가까워지고, 부드럽게는 주변과의 차이를 줄인다", () => {
    const c = Math.floor(mesh.count / 3);
    const flat = Float64Array.from(base);
    const target = 0.3;
    const gapBefore = Math.abs(flat[c] - target);
    for (let k = 0; k < 20; k++) applyBrush(mesh, flat, { tool: "flatten", radius: 50, strength: 1 }, mesh.x[c], mesh.y[c], target);
    assert.ok(Math.abs(flat[c] - target) < gapBefore * 0.1);

    const rough = Float64Array.from(base);
    for (let i = 0; i < mesh.count; i++) if (!mesh.isEdge[i]) rough[i] += i % 2 ? 0.2 : -0.2;
    const spread = (arr: Float64Array): number => {
      let s = 0, n = 0;
      for (let i = 0; i < mesh.count; i++) {
        if (Math.hypot(mesh.x[i] - mesh.x[c], mesh.y[i] - mesh.y[c]) > 30) continue;
        for (let k = mesh.neighborStart[i]; k < mesh.neighborStart[i + 1]; k++) { s += Math.abs(arr[i] - arr[mesh.neighbors[k]]); n++; }
      }
      return s / n;
    };
    const before = spread(rough);
    applyBrush(mesh, rough, { tool: "smooth", radius: 60, strength: 1 }, mesh.x[c], mesh.y[c]);
    assert.ok(spread(rough) < before * 0.8);
  });

  test("반지름·세기가 0이면 아무것도 바꾸지 않는다", () => {
    const e = Float64Array.from(base);
    assert.equal(applyBrush(mesh, e, { tool: "raise", radius: 0, strength: 1 }, 100, 100), false);
    assert.equal(applyBrush(mesh, e, { tool: "raise", radius: 30, strength: 0 }, 100, 100), false);
    assert.deepEqual(e, base);
  });
});

describe("되돌리기", () => {
  test("record → undo → redo로 스트로크 전후 상태를 오간다", () => {
    const h = new EditHistory();
    let e: Float64Array = Float64Array.from(base);
    h.record(e);
    applyBrush(mesh, e, { tool: "lower", radius: 50, strength: 1 }, 450, 300);
    const after = Float64Array.from(e);
    e = h.undo(e)!;
    assert.deepEqual(e, base);
    assert.ok(h.canRedo);
    e = h.redo(e)!;
    assert.deepEqual(e, after);
    assert.equal(h.redo(e), undefined);
  });

  test("새 스트로크를 기록하면 다시 하기 목록은 비워진다", () => {
    const h = new EditHistory();
    const e = Float64Array.from(base);
    h.record(e);
    h.undo(e);
    h.record(e);
    assert.equal(h.canRedo, false);
  });
});

describe("저장 형식", () => {
  test("16비트 인코딩은 오차 1e-4 안에서 복원되고, 길이가 다르면 거부한다", () => {
    const text = encodeElevation(base);
    const back = decodeElevation(text, base.length)!;
    assert.equal(back.length, base.length);
    for (let i = 0; i < base.length; i++) assert.ok(Math.abs(back[i] - base[i]) < 1e-4);
    assert.equal(decodeElevation(text, base.length + 1), undefined);
    assert.equal(decodeElevation("@@not-base64@@", base.length), undefined);
  });

  test("편집한 지도를 JSON으로 내보냈다가 불러오면 같은 지형이 된다", () => {
    const e = Float64Array.from(base);
    applyBrush(mesh, e, { tool: "raise", radius: 80, strength: 1 }, 300, 300);
    const json = JSON.parse(JSON.stringify(toJSON(deriveWorld(OPTS, mesh, e))));
    const parsed = parseMapJSON(json);
    assert.equal(parsed.options.seed, OPTS.seed);
    for (let i = 0; i < mesh.count; i++) assert.ok(Math.abs(parsed.elevation[i] - e[i]) < 1e-3);
  });

  test("형식이 틀린 파일은 이유와 함께 거부한다", () => {
    assert.throws(() => parseMapJSON(null), /JSON 객체/);
    assert.throws(() => parseMapJSON({ format: "other" }), /지원하지 않는 형식/);
    assert.throws(() => parseMapJSON({ format: "fantasy-map/v1", options: OPTS, cells: [] }), /셀 수/);
    const json = toJSON(deriveWorld(OPTS, mesh, base)) as { cells: { elevation: unknown }[] };
    json.cells[5].elevation = "높음";
    assert.throws(() => parseMapJSON(json), /5번 셀/);
  });
});
