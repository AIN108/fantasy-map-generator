import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addCity, civFromJSON, civToJSON, cloneCiv, createState, deleteCity, deleteState, ensureCivNames, isCapital,
  makeCapital, MAX_STATES, moveCity, paintTerritory, renameCity, renameState, snapshotCiv, type CivState,
} from "../src/civedit.ts";
import { applyBrush } from "../src/editor.ts";
import { forEachNeighbor } from "../src/mesh.ts";
import {
  createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, parseMapJSON, toJSON, type WorldOptions,
} from "../src/world.ts";

const OPTS: WorldOptions = { ...DEFAULT_OPTIONS, seed: "문명편집", cells: 4000, width: 1000, height: 700 };
const mesh = createMesh(OPTS);
const elevation = createElevation(mesh, OPTS);
const auto = deriveWorld(OPTS, mesh, elevation);
const isLake = auto.hydro.isLake;
const fresh = (): CivState => snapshotCiv(auto);

/** 도시가 없고 물도 아닌 육지 셀 하나 (기준 셀에서 가까운 순) */
function emptyLand(civ: CivState, near: number, minDist = 0): number {
  const taken = new Set(civ.cities.map((c) => c.cell));
  let best = -1, bestD = Infinity;
  for (let i = 0; i < mesh.count; i++) {
    if (elevation[i] <= 0 || isLake[i] || taken.has(i)) continue;
    const d = Math.hypot(mesh.x[i] - mesh.x[near], mesh.y[i] - mesh.y[near]);
    if (d >= minDist && d < bestD) { bestD = d; best = i; }
  }
  return best;
}
const oceanCell = (): number => elevation.findIndex((e, i) => e < -0.2 && !mesh.isEdge[i]);
const townIndex = (civ: CivState): number => civ.cities.findIndex((_, i) => !isCapital(civ, i));

describe("고정(snapshot)", () => {
  test("자동 배치 결과를 그대로 옮기면 같은 지도가 나온다", () => {
    const civ = fresh();
    const w = deriveWorld(OPTS, mesh, elevation, false, undefined, civ);
    assert.deepEqual(w.states.map((s) => [s.name, s.capitalCell, s.color]), auto.states.map((s) => [s.name, s.capitalCell, s.color]));
    assert.deepEqual(w.cities.map((c) => [c.cell, c.name, c.capital]), auto.cities.map((c) => [c.cell, c.name, c.capital]));
    assert.deepEqual(Array.from(w.owner), Array.from(auto.owner));
  });

  test("고정한 문명은 지형을 편집해도 도시·국경이 움직이지 않는다 (물에 잠긴 곳만 빠진다)", () => {
    const civ = fresh();
    const e = Float64Array.from(elevation);
    const c = auto.states[0].capitalCell;
    for (let k = 0; k < 40; k++) applyBrush(mesh, e, { tool: "raise", radius: 90, strength: 1 }, mesh.x[c] + 120, mesh.y[c]);
    const w = deriveWorld(OPTS, mesh, e, false, undefined, civ);
    for (const city of w.cities) assert.ok(civ.cities.some((cc) => cc.cell === city.cell));
    for (let i = 0; i < mesh.count; i++) {
      if (e[i] > 0 && !w.hydro.isLake[i]) assert.equal(w.owner[i], civ.owner[i]);
      else assert.equal(w.owner[i], -1);
    }
  });

  test("물에 잠긴 도시는 숨겨지고, 땅이 돌아오면 다시 나타난다", () => {
    const civ = fresh();
    const t = townIndex(civ);
    const cell = civ.cities[t].cell;
    const e = Float64Array.from(elevation);
    for (let k = 0; k < 60; k++) applyBrush(mesh, e, { tool: "lower", radius: 25, strength: 1 }, mesh.x[cell], mesh.y[cell]);
    assert.ok(e[cell] <= 0);
    assert.ok(!deriveWorld(OPTS, mesh, e, false, undefined, civ).cities.some((c) => c.cell === cell));
    assert.ok(deriveWorld(OPTS, mesh, elevation, false, undefined, civ).cities.some((c) => c.cell === cell));
  });
});

describe("도시 편집", () => {
  test("도시를 옮기면 그 자리로 가고, 바다·다른 도시 자리로는 못 옮긴다", () => {
    const civ = fresh();
    const t = townIndex(civ);
    const target = emptyLand(civ, civ.cities[t].cell, 40);
    assert.equal(moveCity(civ, t, target, elevation, isLake), null);
    assert.equal(civ.cities[t].cell, target);
    assert.match(moveCity(civ, t, oceanCell(), elevation, isLake)!, /바다/);
    const other = civ.cities.findIndex((_, i) => i !== t);
    assert.match(moveCity(civ, t, civ.cities[other].cell, elevation, isLake)!, /이미/);
  });

  test("수도를 옮기면 새 자리가 그 나라 땅이 된다", () => {
    const civ = fresh();
    const capIdx = civ.states[0].capitalCity;
    const target = emptyLand(civ, civ.cities[civ.states[1].capitalCity].cell, 30);
    assert.equal(moveCity(civ, capIdx, target, elevation, isLake), null);
    assert.equal(civ.owner[target], 0);
    const w = deriveWorld(OPTS, mesh, elevation, false, undefined, civ);
    assert.equal(w.states[0].capitalCell, target);
    assert.equal(w.owner[target], 0);
  });

  test("도시 추가는 새 이름을 붙이고, 이름은 지도 안에서 겹치지 않는다", () => {
    const civ = fresh();
    const before = civ.cities.length;
    const cell = emptyLand(civ, civ.cities[0].cell, 60);
    assert.equal(addCity(civ, cell, elevation, isLake, "korean", OPTS.seed), null);
    assert.equal(civ.cities.length, before + 1);
    const names = [...civ.cities.map((c) => c.names.korean), ...civ.states.map((s) => s.names.korean)];
    assert.ok(names.every(Boolean));
    assert.equal(new Set(names).size, names.length);
    assert.match(addCity(civ, oceanCell(), elevation, isLake, "korean", OPTS.seed)!, /바다/);
    assert.match(addCity(civ, cell, elevation, isLake, "korean", OPTS.seed)!, /이미/);
  });

  test("일반 도시는 지울 수 있고, 수도는 지울 수 없으며 수도 인덱스가 맞게 유지된다", () => {
    const civ = fresh();
    const capitalsBefore = civ.states.map((s) => civ.cities[s.capitalCity].cell);
    assert.match(deleteCity(civ, civ.states[0].capitalCity)!, /수도/);
    const t = townIndex(civ);
    const removed = civ.cities[t].cell;
    assert.equal(deleteCity(civ, t), null);
    assert.ok(!civ.cities.some((c) => c.cell === removed));
    assert.deepEqual(civ.states.map((s) => civ.cities[s.capitalCity].cell), capitalsBefore);
  });

  test("이름 바꾸기는 빈 이름·너무 긴 이름·중복 이름을 거부한다", () => {
    const civ = fresh();
    assert.equal(renameCity(civ, 1, "  새 마을  ", "korean"), null);
    assert.equal(civ.cities[1].names.korean, "새 마을");
    assert.match(renameCity(civ, 1, "   ", "korean")!, /비어/);
    assert.match(renameCity(civ, 1, "가".repeat(21), "korean")!, /20자/);
    assert.match(renameCity(civ, 2, "새 마을", "korean")!, /이미/);
    assert.match(renameCity(civ, 2, civ.states[0].names.korean!, "korean")!, /이미/);
    assert.equal(renameState(civ, 0, "새 왕국", "korean"), null);
    assert.equal(deriveWorld(OPTS, mesh, elevation, false, undefined, civ).states[0].name, "새 왕국");
  });

  test("수도 지정은 그 도시가 속한 나라의 수도를 바꾼다", () => {
    const civ = fresh();
    const t = civ.cities.findIndex((c, i) => !isCapital(civ, i) && civ.owner[c.cell] >= 0);
    const state = civ.owner[civ.cities[t].cell];
    assert.equal(makeCapital(civ, t), null);
    assert.equal(civ.states[state].capitalCity, t);
    assert.match(makeCapital(civ, t)!, /이미/);
  });
});

describe("국경 편집", () => {
  test("국경 칠하기는 육지만 바꾸고 다른 나라 수도 자리는 지킨다", () => {
    const civ = fresh();
    const cap1 = civ.cities[civ.states[1].capitalCity].cell;
    const changed = paintTerritory(mesh, civ, elevation, isLake, mesh.x[cap1], mesh.y[cap1], 80, 0);
    assert.ok(changed > 0);
    assert.equal(civ.owner[cap1], 1, "다른 나라 수도 셀은 그대로");
    for (let i = 0; i < mesh.count; i++) {
      const inside = Math.hypot(mesh.x[i] - mesh.x[cap1], mesh.y[i] - mesh.y[cap1]) < 80;
      if (inside && elevation[i] > 0 && !isLake[i] && i !== cap1) assert.equal(civ.owner[i], 0);
      if (elevation[i] <= 0) assert.equal(civ.owner[i], auto.owner[i]);
    }
  });

  test("무소속(-1)으로 칠할 수 있고, 없는 나라 번호는 무시한다", () => {
    const civ = fresh();
    const c = auto.cities[auto.cities.length - 1].cell;
    assert.ok(paintTerritory(mesh, civ, elevation, isLake, mesh.x[c], mesh.y[c], 40, -1) > 0);
    assert.equal(paintTerritory(mesh, civ, elevation, isLake, mesh.x[c], mesh.y[c], 40, 99), 0);
  });

  test("칠한 국경이 지도에 반영되고 국경선이 생긴다", () => {
    const civ = fresh();
    const cap0 = civ.cities[civ.states[0].capitalCity].cell;
    paintTerritory(mesh, civ, elevation, isLake, mesh.x[cap0] + 60, mesh.y[cap0], 50, 1);
    const w = deriveWorld(OPTS, mesh, elevation, false, undefined, civ);
    let borderPairs = 0;
    for (let i = 0; i < mesh.count; i++) {
      forEachNeighbor(mesh, i, (j) => { if (w.owner[i] === 1 && w.owner[j] === 0) borderPairs++; });
    }
    assert.ok(borderPairs > 0);
  });
});

describe("저장 형식", () => {
  test("JSON으로 저장·불러오기 하면 편집한 문명(두 지명 스타일 이름 포함)이 그대로다", () => {
    const civ = fresh();
    renameCity(civ, 3, "내마을", "korean");
    ensureCivNames(civ, "western", OPTS.seed);
    const parsed = parseMapJSON(JSON.parse(JSON.stringify(toJSON(deriveWorld(OPTS, mesh, elevation, false, undefined, civ), civ))));
    assert.ok(parsed.civ);
    assert.deepEqual(parsed.civ.cities, civ.cities);
    assert.deepEqual(parsed.civ.states, civ.states);
    assert.deepEqual(Array.from(parsed.civ.owner), Array.from(civ.owner));
  });

  test("지명 스타일을 바꾸면 이름을 새로 붙이고, 원래 스타일 이름은 남는다", () => {
    const civ = fresh();
    const korean = civ.cities.map((c) => c.names.korean);
    ensureCivNames(civ, "western", OPTS.seed);
    assert.ok(civ.cities.every((c) => /^[A-Z][a-z]+$/.test(c.names.western!)));
    assert.deepEqual(civ.cities.map((c) => c.names.korean), korean);
  });

  test("손상된 문명 정보는 거부한다", () => {
    const good = civToJSON(fresh());
    assert.ok(civFromJSON(good, mesh.count));
    assert.equal(civFromJSON(good, mesh.count + 1), undefined, "셀 수 불일치");
    assert.equal(civFromJSON({ ...good, owner: "@@@" }, mesh.count), undefined);
    assert.equal(civFromJSON({ ...good, cities: [{ cell: -5, names: { korean: "x" } }] }, mesh.count), undefined);
    const dupCapital = { ...good, states: good.states.map((s) => ({ ...s, capitalCity: 0 })) };
    assert.equal(civFromJSON(dupCapital, mesh.count), undefined, "두 나라가 같은 수도");
    assert.equal(civFromJSON({ ...good, states: [{ ...good.states[0], color: "red;background:url(x)" }] }, mesh.count), undefined);
    assert.throws(() => parseMapJSON({ ...(toJSON(auto) as object), civ: { cities: "x" } }), /civ/);
  });

  test("cloneCiv는 원본과 독립적이다", () => {
    const civ = fresh();
    const copy = cloneCiv(civ);
    copy.cities[0].names.korean = "바뀜";
    copy.owner[0] = 5;
    assert.notEqual(civ.cities[0].names.korean, "바뀜");
    assert.notEqual(civ.owner[0], 5);
  });
});

describe("국가 만들기·없애기", () => {
  test("나라 안의 도시로 새 나라를 만들면 영토를 두 수도 중 가까운 쪽으로 나눈다", () => {
    const civ = fresh();
    const t = civ.cities.findIndex((c, i) => !isCapital(civ, i) && civ.owner[c.cell] >= 0);
    const cell = civ.cities[t].cell;
    const parent = civ.owner[cell];
    const parentCap = civ.cities[civ.states[parent].capitalCity].cell;
    const parentCellsBefore = civ.owner.filter((o) => o === parent).length;
    assert.equal(createState(mesh, civ, t, elevation, isLake, "korean", OPTS.seed, 100), null);
    const id = civ.states.length - 1;
    assert.equal(civ.states[id].capitalCity, t);
    assert.equal(civ.owner[cell], id);
    const d2 = (i: number, c: number): number => (mesh.x[i] - mesh.x[c]) ** 2 + (mesh.y[i] - mesh.y[c]) ** 2;
    let newCells = 0;
    for (let i = 0; i < mesh.count; i++) {
      if (civ.owner[i] === id) { newCells++; assert.ok(i === cell || d2(i, cell) < d2(i, parentCap)); }
      if (civ.owner[i] === parent) assert.ok(d2(i, parentCap) <= d2(i, cell));
    }
    assert.ok(newCells > 1);
    assert.equal(civ.owner.filter((o) => o === parent).length + newCells, parentCellsBefore);
    // 다른 나라 영토는 그대로
    for (let i = 0; i < mesh.count; i++) {
      if (auto.owner[i] !== parent) assert.equal(civ.owner[i], auto.owner[i]);
    }
    // 이름·색이 기존 나라와 겹치지 않는다
    const names = civ.states.map((s) => s.names.korean);
    assert.equal(new Set(names).size, names.length);
    assert.ok(!civ.states.slice(0, -1).some((s) => s.color === civ.states[id].color));
    const w = deriveWorld(OPTS, mesh, elevation, false, undefined, civ);
    assert.equal(w.states.length, auto.states.length + 1);
    assert.ok(w.cities.find((c) => c.cell === cell)!.capital);
  });

  test("무소속 땅의 도시로 만들면 주변 무소속 땅만 가져간다", () => {
    const civ = fresh();
    const t = townIndex(civ);
    const cell = civ.cities[t].cell;
    // 도시 주변을 무소속으로 만든 뒤 나라를 세운다
    paintTerritory(mesh, civ, elevation, isLake, mesh.x[cell], mesh.y[cell], 60, -1);
    const ownedBefore = Int32Array.from(civ.owner);
    assert.equal(createState(mesh, civ, t, elevation, isLake, "korean", OPTS.seed, 40), null);
    const id = civ.states.length - 1;
    for (let i = 0; i < mesh.count; i++) {
      if (ownedBefore[i] >= 0) assert.equal(civ.owner[i], ownedBefore[i], "원래 있던 나라 땅은 건드리지 않는다");
      if (civ.owner[i] === id) assert.ok(Math.hypot(mesh.x[i] - mesh.x[cell], mesh.y[i] - mesh.y[cell]) < 40);
    }
    assert.ok(civ.owner.filter((o) => o === id).length > 1);
  });

  test("수도로는 새 나라를 만들 수 없고, 나라 수에는 상한이 있다", () => {
    const civ = fresh();
    assert.match(createState(mesh, civ, civ.states[0].capitalCity, elevation, isLake, "korean", OPTS.seed, 50)!, /이미/);
    let made = 0;
    for (let i = 0; i < civ.cities.length && civ.states.length < MAX_STATES; i++) {
      if (!isCapital(civ, i) && createState(mesh, civ, i, elevation, isLake, "korean", OPTS.seed, 30) === null) made++;
    }
    assert.ok(made > 0);
    if (civ.states.length === MAX_STATES) {
      const free = civ.cities.findIndex((_, i) => !isCapital(civ, i));
      if (free >= 0) assert.match(createState(mesh, civ, free, elevation, isLake, "korean", OPTS.seed, 30)!, /까지/);
    }
  });

  test("나라를 없애면 영토가 무소속이 되고, 뒤쪽 나라 번호가 당겨진다", () => {
    const civ = fresh();
    const removed = 1;
    const capCity = civ.states[removed].capitalCity;
    const lastName = civ.states[civ.states.length - 1].names.korean;
    const lastCells = civ.owner.filter((o) => o === civ.states.length - 1).length;
    assert.equal(deleteState(civ, removed, -1), null);
    assert.equal(civ.states.length, auto.states.length - 1);
    for (let i = 0; i < mesh.count; i++) {
      if (auto.owner[i] === removed) assert.equal(civ.owner[i], -1);
      else if (auto.owner[i] > removed) assert.equal(civ.owner[i], auto.owner[i] - 1);
    }
    assert.equal(civ.states[civ.states.length - 1].names.korean, lastName);
    assert.equal(civ.owner.filter((o) => o === civ.states.length - 1).length, lastCells);
    assert.ok(!isCapital(civ, capCity), "수도였던 도시는 일반 도시로 남는다");
    assert.ok(civ.cities[capCity]);
    const w = deriveWorld(OPTS, mesh, elevation, false, undefined, civ);
    assert.equal(w.states.length, auto.states.length - 1);
  });

  test("나라를 없애면서 영토를 다른 나라에 합칠 수 있다", () => {
    const civ = fresh();
    const removedCells = civ.owner.filter((o) => o === 0).length;
    const targetCells = civ.owner.filter((o) => o === 2).length;
    assert.equal(deleteState(civ, 0, 2), null);
    // 0번이 빠지면서 2번은 1번이 된다
    assert.equal(civ.owner.filter((o) => o === 1).length, removedCells + targetCells);
    assert.match(deleteState(civ, 0, 0)!, /없앨 나라/);
    assert.match(deleteState(civ, 0, 99)!, /찾을 수 없/);
    assert.match(deleteState(civ, 99, -1)!, /찾을 수 없/);
  });

  test("만들고 없앤 결과도 저장·불러오기 후 그대로다", () => {
    const civ = fresh();
    createState(mesh, civ, townIndex(civ), elevation, isLake, "korean", OPTS.seed, 50);
    deleteState(civ, 0, -1);
    const back = civFromJSON(JSON.parse(JSON.stringify(civToJSON(civ))), mesh.count)!;
    assert.deepEqual(back.states, civ.states);
    assert.deepEqual(Array.from(back.owner), Array.from(civ.owner));
  });
});
