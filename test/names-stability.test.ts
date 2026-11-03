import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyBrush } from "../src/editor.ts";
import {
  createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, extractAnchors, mergeAnchors, parseMapJSON,
  sanitizeAnchors, toJSON, type WorldMap, type WorldOptions,
} from "../src/world.ts";

const OPTS: WorldOptions = { ...DEFAULT_OPTIONS, seed: "이름유지", cells: 4000, width: 1000, height: 700 };
const mesh = createMesh(OPTS);
const base = createElevation(mesh, OPTS);
const original = deriveWorld(OPTS, mesh, base);

/** 두 번째 국가 수도 주변을 바다로 가라앉혀 도시 일부가 사라지게 한다. */
function sunk(): Float64Array {
  const e = Float64Array.from(base);
  const c = original.states[Math.min(1, original.states.length - 1)].capitalCell;
  for (let k = 0; k < 80; k++) applyBrush(mesh, e, { tool: "lower", radius: 70, strength: 1 }, mesh.x[c], mesh.y[c]);
  return e;
}

const cityNames = (w: WorldMap): Map<number, string> => new Map(w.cities.map((c) => [c.cell, c.name]));
const allNames = (w: WorldMap): string[] => [
  ...w.states.map((s) => s.name), ...w.cities.map((c) => c.name),
  ...w.rivers.flatMap((r) => (r.name ? [r.name] : [])), ...w.peaks.map((p) => p.name),
];

describe("편집 후 이름 유지", () => {
  test("지형이 그대로면 이전 이름을 넘겨도 결과가 같다", () => {
    const again = deriveWorld(OPTS, mesh, base, false, extractAnchors(original));
    assert.deepEqual(allNames(again), allNames(original));
    assert.deepEqual(again.states.map((s) => s.color), original.states.map((s) => s.color));
  });

  test("수도 주변을 가라앉혀도, 자리가 그대로인 도시와 국가는 이름·색을 지킨다", () => {
    const after = deriveWorld(OPTS, mesh, sunk(), false, extractAnchors(original));
    const before = cityNames(original);
    const stayed = after.cities.filter((c) => before.has(c.cell));
    assert.ok(stayed.length >= original.cities.length * 0.6, `자리를 지킨 도시 ${stayed.length}`);
    for (const c of stayed) assert.equal(c.name, before.get(c.cell));
    // 수도가 그대로인 국가는 이름과 색이 같아야 한다
    for (const s of after.states) {
      const old = original.states.find((o) => o.capitalCell === s.capitalCell);
      if (old) {
        assert.equal(s.name, old.name);
        assert.equal(s.color, old.color);
      }
    }
  });

  test("이름은 지도 안에서 중복되지 않는다 (물려받은 이름 + 새 이름)", () => {
    const after = deriveWorld(OPTS, mesh, sunk(), false, extractAnchors(original));
    const names = allNames(after);
    assert.equal(new Set(names).size, names.length);
  });

  test("편집 후 되돌리면(이름 기억 사용) 원래 이름이 모두 돌아온다", () => {
    let memory = extractAnchors(original);
    const edited = deriveWorld(OPTS, mesh, sunk(), false, memory);
    memory = mergeAnchors(extractAnchors(edited), memory);
    const restored = deriveWorld(OPTS, mesh, base, false, memory);
    assert.deepEqual([...cityNames(restored)], [...cityNames(original)]);
    assert.deepEqual(restored.states.map((s) => s.name), original.states.map((s) => s.name));
  });

  test("지명 스타일이 다른 이름 정보는 쓰지 않는다", () => {
    const western = deriveWorld({ ...OPTS, nameStyle: "western" }, mesh, base, false, extractAnchors(original));
    for (const c of western.cities) assert.match(c.name, /^[A-Z][a-z]+$/);
  });

  test("이름 기억은 같은 이름을 한 번만 남긴다", () => {
    const a = extractAnchors(original);
    const merged = mergeAnchors(a, a);
    assert.equal(merged.cities.length, a.cities.length);
    assert.equal(new Set(merged.cities.map((c) => c.name)).size, merged.cities.length);
  });
});

describe("이름 정보 저장·불러오기", () => {
  test("JSON으로 저장했다가 불러오면 편집한 지형의 이름이 그대로 살아난다", () => {
    const after = deriveWorld(OPTS, mesh, sunk(), false, extractAnchors(original));
    const parsed = parseMapJSON(JSON.parse(JSON.stringify(toJSON(after))));
    const reloaded = deriveWorld(parsed.options, parsed.mesh, parsed.elevation, false, parsed.anchors);
    assert.deepEqual(reloaded.cities.map((c) => c.name), after.cities.map((c) => c.name));
    assert.deepEqual(reloaded.states.map((s) => s.name), after.states.map((s) => s.name));
  });

  test("형식이 틀린 이름 정보는 걸러낸다", () => {
    assert.equal(sanitizeAnchors(null), undefined);
    assert.equal(sanitizeAnchors({ nameStyle: "klingon" }), undefined);
    const a = sanitizeAnchors({
      nameStyle: "korean",
      states: [{ capitalCell: 3, name: "가국", color: "hsl(10 55% 50%)" }, { capitalCell: -1, name: "x", color: "red" }],
      cities: [{ cell: 1, name: "가람" }, { cell: "2", name: "나" }, { cell: 5, name: "" }],
      rivers: [{ cells: [1, 2, 3], name: "가강" }, { cells: [1, "a"], name: "나강" }],
      peaks: "아무거나",
    })!;
    assert.equal(a.states.length, 1);
    assert.equal(a.cities.length, 1);
    assert.equal(a.rivers.length, 1);
    assert.equal(a.peaks.length, 0);
  });

  test("범위를 벗어난 셀 번호가 있어도 계산이 깨지지 않는다", () => {
    const bogus = sanitizeAnchors({
      nameStyle: "korean",
      states: [{ capitalCell: 999999, name: "유령국", color: "hsl(10 55% 50%)" }],
      cities: [{ cell: 999999, name: "유령" }],
      rivers: [], peaks: [{ cell: 999999, name: "유령산" }],
    })!;
    const w = deriveWorld(OPTS, mesh, base, false, bogus);
    assert.ok(!allNames(w).includes("유령"));
  });
});
