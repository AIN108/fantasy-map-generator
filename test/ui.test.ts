import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { snapshotCiv } from "../src/civedit.ts";
import { emptyInfra } from "../src/infra.ts";
import { formatHash, parseHash } from "../src/ui/options.ts";
import { loadSavedEdits, saveEdits, STORAGE_KEY, type KeyValueStore } from "../src/ui/storage.ts";
import { eul } from "../src/ui/text.ts";
import { createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, terrainKey, type WorldOptions } from "../src/world.ts";

describe("목적격 조사", () => {
  test("받침 있으면 '을', 없으면 '를'", () => {
    assert.equal(eul("성"), "을");
    assert.equal(eul("다리"), "를");
    assert.equal(eul("항구 '하늬항'"), "을"); // 따옴표 앞 글자로 판단
    assert.equal(eul("터널)"), "을");
  });
  test("한글로 끝나지 않으면 '을(를)'", () => {
    assert.equal(eul("Westmarch"), "을(를)");
    assert.equal(eul("map.json"), "을(를)");
    assert.equal(eul(""), "을(를)");
  });
});

describe("URL 해시", () => {
  test("옵션 → 해시 → 옵션 왕복", () => {
    const o: WorldOptions = { ...DEFAULT_OPTIONS, seed: "청운-1234", nameStyle: "western", shape: "archipelago", cells: 12000, temperatureShift: -0.1 };
    const back = { ...DEFAULT_OPTIONS, ...parseHash(formatHash(o)) };
    assert.deepEqual(back, o);
  });
  test("알 수 없는 값은 버리고, 시드는 40자로 자른다", () => {
    const p = parseHash(`#seed=${"가".repeat(50)}&style=klingon&shape=moon&cells=abc&states=5`);
    assert.equal(p.seed?.length, 40);
    assert.equal(p.nameStyle, undefined);
    assert.equal(p.shape, undefined);
    assert.equal(p.cells, undefined);
    assert.equal(p.states, 5);
    assert.deepEqual(parseHash(""), {});
  });
});

describe("편집 내용 저장", () => {
  const OPTS: WorldOptions = { ...DEFAULT_OPTIONS, seed: "저장", cells: 3000, width: 900, height: 600 };
  const mesh = createMesh(OPTS);
  const elevation = createElevation(mesh, OPTS);
  const key = terrainKey(OPTS);
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => { data.set(k, v); },
      removeItem: (k) => { data.delete(k); },
    };
  };

  test("저장한 지형·문명·시설을 그대로 읽는다", () => {
    const store = memory();
    const edited = Float64Array.from(elevation, (v, i) => (i % 7 === 0 ? v + 0.01 : v));
    const civ = snapshotCiv(deriveWorld(OPTS, mesh, edited));
    const infra = emptyInfra();
    infra.ports.push({ cell: 10, name: "하늬항" });
    saveEdits(store, key, true, { elevation: edited, names: {}, civ, infra });
    const back = loadSavedEdits(store, key, () => mesh.count);
    assert.ok(back);
    assert.deepEqual([...back.elevation], [...edited]);
    assert.deepEqual(back.civ?.cities.map((c) => c.cell), civ.cities.map((c) => c.cell));
    assert.deepEqual(back.infra?.ports, [{ cell: 10, name: "하늬항" }]);
  });

  test("편집이 없으면 지우고, 지형 키·셀 수가 다르거나 손상되면 읽지 않는다", () => {
    const store = memory();
    saveEdits(store, key, true, { elevation, names: {} });
    let asked = 0;
    assert.equal(loadSavedEdits(store, "다른 지형", () => ++asked), undefined);
    assert.equal(asked, 0, "지형이 다르면 셀 수(메시)를 구하지 않는다");
    assert.equal(loadSavedEdits(store, key, () => mesh.count + 1), undefined);
    store.setItem(STORAGE_KEY, "{망가진 JSON");
    assert.equal(loadSavedEdits(store, key, () => mesh.count), undefined);
    saveEdits(store, key, false, { elevation, names: {} });
    assert.equal(store.data.has(STORAGE_KEY), false);
  });

  test("저장소가 예외를 던져도 조용히 넘어간다", () => {
    const broken: KeyValueStore = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("denied"); },
    };
    assert.doesNotThrow(() => saveEdits(broken, key, true, { elevation, names: {} }));
    assert.equal(loadSavedEdits(broken, key, () => mesh.count), undefined);
  });
});
