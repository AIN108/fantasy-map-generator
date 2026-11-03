import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { MinHeap } from "../src/heap.ts";
import { forEachNeighbor } from "../src/mesh.ts";
import { KOREAN_REAL_NAMES, NameGenerator } from "../src/names.ts";
import { createRng } from "../src/rng.ts";
import { generateWorld, toJSON } from "../src/world.ts";

const digest = (o: object): string => createHash("sha256").update(JSON.stringify(o)).digest("hex");

// 테스트 속도를 위해 셀 수를 줄인 공통 옵션
const SMALL = { cells: 3000, width: 900, height: 600 } as const;

describe("재현성", () => {
  test("같은 시드와 옵션이면 결과가 완전히 같다", () => {
    const a = toJSON(generateWorld({ ...SMALL, seed: "재현" }));
    const b = toJSON(generateWorld({ ...SMALL, seed: "재현" }));
    assert.equal(digest(a), digest(b));
  });

  test("시드가 다르면 지형이 다르다", () => {
    const a = generateWorld({ ...SMALL, seed: "a" });
    const b = generateWorld({ ...SMALL, seed: "b" });
    assert.notDeepEqual(Array.from(a.elevation.slice(0, 50)), Array.from(b.elevation.slice(0, 50)));
  });

  test("지명 스타일만 바꾸면 지형·국경·도시 위치는 그대로다", () => {
    const ko = generateWorld({ ...SMALL, seed: "스타일", nameStyle: "korean" });
    const en = generateWorld({ ...SMALL, seed: "스타일", nameStyle: "western" });
    assert.deepEqual(Array.from(ko.elevation), Array.from(en.elevation));
    assert.deepEqual(Array.from(ko.owner), Array.from(en.owner));
    assert.deepEqual(ko.cities.map((c) => c.cell), en.cities.map((c) => c.cell));
    assert.notDeepEqual(ko.states.map((s) => s.name), en.states.map((s) => s.name));
  });
});

describe("지형과 수계", () => {
  const w = generateWorld({ ...SMALL, seed: "수계" });

  test("육지 비율이 옵션과 대략 같다", () => {
    const land = w.elevation.filter((e) => e > 0).length / w.mesh.count;
    assert.ok(Math.abs(land - w.options.landRatio) < 0.03, `land=${land}`);
  });

  test("지도 가장자리는 바다다", () => {
    for (let i = 0; i < w.mesh.count; i++) if (w.mesh.isEdge[i]) assert.ok(w.elevation[i] <= 0);
  });

  test("모든 육지 셀은 메운 고도 기준으로 내리막을 따라 바다에 닿는다", () => {
    for (let i = 0; i < w.mesh.count; i++) {
      if (w.elevation[i] <= 0) continue;
      let cur = i;
      for (let steps = 0; steps < w.mesh.count && w.elevation[cur] > 0; steps++) {
        const d = w.hydro.downhill[cur];
        assert.ok(d >= 0, `셀 ${cur}에 내리막이 없음`);
        assert.ok(w.hydro.filled[d] < w.hydro.filled[cur], "내리막인데 고도가 낮아지지 않음");
        cur = d;
      }
      assert.ok(w.elevation[cur] <= 0, `셀 ${i}에서 바다에 닿지 못함`);
    }
  });

  test("강 경로는 이웃 셀로만 이어지고 하류로 갈수록 유량이 줄지 않는다", () => {
    assert.ok(w.rivers.length > 0);
    for (const r of w.rivers) {
      for (let k = 0; k + 1 < r.cells.length; k++) {
        const a = r.cells[k], b = r.cells[k + 1];
        let adjacent = false;
        forEachNeighbor(w.mesh, a, (j) => { if (j === b) adjacent = true; });
        assert.ok(adjacent, "강이 이웃이 아닌 셀로 건너뜀");
        if (w.elevation[b] > 0) assert.ok(w.hydro.flux[b] >= w.hydro.flux[a]);
      }
    }
  });
});

describe("문명", () => {
  const w = generateWorld({ ...SMALL, seed: "문명", states: 5, citiesPerState: 4 });

  test("수도는 각자의 국가에 속하고, 국가 수만큼 있다", () => {
    const capitals = w.cities.filter((c) => c.capital);
    assert.equal(capitals.length, w.states.length);
    for (const c of capitals) assert.equal(w.owner[c.cell], c.state);
    w.states.forEach((s, id) => assert.equal(w.owner[s.capitalCell], id));
  });

  test("도시는 육지 위에 있고 호수가 아니다", () => {
    for (const c of w.cities) {
      assert.ok(w.elevation[c.cell] > 0);
      assert.equal(w.hydro.isLake[c.cell], 0);
    }
  });

  test("바다와 호수는 어느 국가에도 속하지 않는다", () => {
    for (let i = 0; i < w.mesh.count; i++) {
      if (w.elevation[i] <= 0 || w.hydro.isLake[i]) assert.equal(w.owner[i], -1);
    }
  });

  test("도로는 이웃 셀로 이어지고 바다·호수를 지나지 않는다", () => {
    for (const road of w.roads) {
      for (let k = 0; k < road.length; k++) {
        assert.ok(w.elevation[road[k]] > 0 && !w.hydro.isLake[road[k]]);
        if (k > 0) {
          let adjacent = false;
          forEachNeighbor(w.mesh, road[k - 1], (j) => { if (j === road[k]) adjacent = true; });
          assert.ok(adjacent);
        }
      }
    }
  });

  test("지도 안의 이름은 서로 겹치지 않는다", () => {
    const all = [
      ...w.states.map((s) => s.name), ...w.cities.map((c) => c.name),
      ...w.rivers.flatMap((r) => (r.name ? [r.name] : [])), ...w.peaks.map((p) => p.name),
    ];
    assert.equal(new Set(all).size, all.length);
  });
});

describe("지명", () => {
  test("한국어풍 도시 이름은 한글이고 실제 주요 지명과 겹치지 않는다", () => {
    const gen = new NameGenerator(createRng("지명"), "korean");
    for (let i = 0; i < 400; i++) {
      const name = gen.next("city", { coastal: i % 3 === 0, river: i % 5 === 0 });
      assert.match(name, /^[가-힣]{2,4}$/);
      assert.ok(!KOREAN_REAL_NAMES.has(name), name);
    }
  });

  test("한국어풍 국가·강·산 이름은 접미사가 붙는다", () => {
    const gen = new NameGenerator(createRng("접미사"), "korean");
    for (let i = 0; i < 50; i++) {
      assert.match(gen.next("state"), /국$/);
      assert.match(gen.next("river"), /(강|천)$/);
      assert.match(gen.next("mountain"), /(산|봉|령)$/);
    }
  });

  test("서구풍 이름은 대문자로 시작하는 라틴 문자다", () => {
    const gen = new NameGenerator(createRng("west"), "western");
    for (let i = 0; i < 200; i++) assert.match(gen.next("city"), /^[A-Z][a-z]{3,9}$/);
  });
});

describe("입력 검증과 유틸리티", () => {
  test("잘못된 옵션은 명확한 오류를 낸다", () => {
    assert.throws(() => generateWorld({ seed: "  " }), /시드/);
    assert.throws(() => generateWorld({ landRatio: 0.9 }), /육지 비율/);
    assert.throws(() => generateWorld({ states: 0 }), /국가 수/);
    assert.throws(() => generateWorld({ cells: 10 }), /셀 수/);
  });

  test("MinHeap은 항상 가장 작은 키를 꺼낸다", () => {
    const heap = new MinHeap();
    const rng = createRng("heap");
    const keys = Array.from({ length: 500 }, () => rng());
    keys.forEach((k, i) => heap.push(k, i));
    const out: number[] = [];
    while (heap.size > 0) out.push(heap.pop()![0]);
    assert.deepEqual(out, [...keys].sort((a, b) => a - b));
  });
});
