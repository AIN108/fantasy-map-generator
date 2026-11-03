import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyBrush } from "../src/editor.ts";
import {
  addFacility, addPath, addPort, addSeaRoute, addSpan, cloneInfra, connected, hitSpan, MAX_SPAN_LENGTH, moveSpan,
  spanCells, spanLinks, emptyInfra, eraseAt, hitPoint, infraFromJSON, infraToJSON,
  isEmptyInfra, movePoint, pathMarks, routePath, routeSea, TUNNEL_ELEVATION, visibleInfra, type Infra,
} from "../src/infra.ts";
import { findPath } from "../src/civ.ts";
import { forEachNeighbor } from "../src/mesh.ts";
import {
  applyInfra, createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, parseMapJSON, toJSON, type WorldOptions,
} from "../src/world.ts";

const OPTS: WorldOptions = { ...DEFAULT_OPTIONS, seed: "시설", cells: 4000, width: 1000, height: 700 };
const mesh = createMesh(OPTS);
const elevation = createElevation(mesh, OPTS);
const world = deriveWorld(OPTS, mesh, elevation);
const land = (i: number): boolean => world.elevation[i] > 0 && !world.hydro.isLake[i];
const coastal = (i: number): boolean => {
  let c = false;
  forEachNeighbor(mesh, i, (j) => { if (elevation[j] <= 0) c = true; });
  return c;
};
const ocean = elevation.findIndex((e, i) => e < -0.2 && !mesh.isEdge[i]);
const coastCell = Array.from({ length: mesh.count }, (_, i) => i).find((i) => land(i) && coastal(i))!;
const inlandCell = Array.from({ length: mesh.count }, (_, i) => i).find((i) => land(i) && !coastal(i))!;
const [cityA, cityB] = [world.cities[0].cell, world.cities[1].cell];

const adjacent = (a: number, b: number): boolean => {
  let ok = false;
  forEachNeighbor(mesh, a, (j) => { if (j === b) ok = true; });
  return ok;
};

describe("경로 계산", () => {
  test("도로·철도 경로는 이웃 셀로만 이어지고 물을 지나지 않는다", () => {
    for (const mode of ["road", "rail"] as const) {
      const path = routePath(world, cityA, cityB, mode);
      assert.ok(path, `${mode} 경로 없음`);
      assert.equal(path[0], cityA);
      assert.equal(path[path.length - 1], cityB);
      for (let k = 0; k < path.length; k++) {
        assert.ok(land(path[k]));
        if (k > 0) assert.ok(adjacent(path[k - 1], path[k]));
      }
    }
  });

  test("바다에서 시작하거나 끝나는 경로는 만들지 않는다", () => {
    assert.equal(routePath(world, ocean, cityA, "road"), null);
    assert.equal(routePath(world, cityA, ocean, "rail"), null);
  });

  test("철도는 도로보다 급경사를 덜 지난다 (터널 구간 제외, 여러 도시 쌍 평균)", () => {
    const high = (c: number): boolean => elevation[c] > TUNNEL_ELEVATION;
    const maxClimb = (p: number[]): number => {
      let m = 0;
      for (let k = 1; k < p.length; k++) {
        if (high(p[k]) || high(p[k - 1])) continue; // 터널(관통) 구간은 오르막이 아니다
        m = Math.max(m, Math.abs(elevation[p[k]] - elevation[p[k - 1]]));
      }
      return m;
    };
    let road = 0, rail = 0, n = 0;
    for (let a = 0; a < world.cities.length && n < 10; a++) {
      for (let b = a + 1; b < world.cities.length && n < 10; b++) {
        const r = routePath(world, world.cities[a].cell, world.cities[b].cell, "road");
        const t = routePath(world, world.cities[a].cell, world.cities[b].cell, "rail");
        if (!r || !t || r.length < 10) continue;
        road += maxClimb(r);
        rail += maxClimb(t);
        n++;
      }
    }
    assert.ok(n >= 3, `비교할 도시 쌍 부족 (${n})`);
    assert.ok(rail <= road, `철도 최대 경사 합 ${rail.toFixed(3)} > 도로 ${road.toFixed(3)}`);
  });
});

describe("시설 편집", () => {
  test("도로를 처음 그리면 자동 도로를 고정한 뒤 추가한다", () => {
    const infra = emptyInfra();
    const path = routePath(world, cityA, cityB, "road")!;
    assert.equal(addPath(infra, "road", path, world.roads), null);
    assert.equal(infra.roads!.length, world.roads.length + 1);
    assert.deepEqual(infra.roads![infra.roads!.length - 1], path);
    assert.match(addPath(infra, "rail", [cityA], world.roads)!, /같습니다/);
    assert.equal(addPath(infra, "rail", path, world.roads), null);
    assert.equal(infra.rails.length, 1);
  });

  test("항구는 해안에만, 등대도 해안에만, 다른 시설물은 육지 어디든 둘 수 있다", () => {
    const infra = emptyInfra();
    assert.match(addPort(world, infra, inlandCell)!, /해안/);
    assert.match(addPort(world, infra, ocean)!, /육지/);
    assert.equal(addPort(world, infra, coastCell, "  달빛 항  "), null);
    assert.equal(infra.ports[0].name, "달빛 항");
    assert.match(addFacility(world, infra, coastCell, "castle")!, /이미/);
    assert.match(addFacility(world, infra, inlandCell, "lighthouse")!, /해안/);
    assert.equal(addFacility(world, infra, inlandCell, "castle", "검은성"), null);
    assert.match(addFacility(world, infra, ocean, "mine")!, /육지/);
    assert.equal(infra.facilities.length, 1);
    assert.equal(addFacility(world, infra, coastCell + 0, "fort"), "그 자리에는 이미 시설이 있습니다.");
  });

  test("이름은 앞뒤 공백을 지우고 20자로 자른다", () => {
    const infra = emptyInfra();
    addFacility(world, infra, inlandCell, "temple", "가".repeat(30));
    assert.equal(infra.facilities[0].name!.length, 20);
    const other = Array.from({ length: mesh.count }, (_, i) => i).find((i) => land(i) && i !== inlandCell)!;
    addFacility(world, infra, other, "ruin", "   ");
    assert.equal(infra.facilities[1].name, undefined);
  });

  test("지우기는 점 시설을 먼저, 그다음 가까운 도로·철도를 지운다", () => {
    const infra = emptyInfra();
    const path = routePath(world, cityA, cityB, "rail")!;
    addPath(infra, "rail", path, world.roads);
    const mid = path[Math.floor(path.length / 2)];
    addFacility(world, infra, mid, "tower", "감시탑");
    assert.equal(eraseAt(mesh, infra, mesh.x[mid], mesh.y[mid], 10, world.roads), "탑 '감시탑'");
    assert.equal(infra.facilities.length, 0);
    assert.equal(eraseAt(mesh, infra, mesh.x[mid], mesh.y[mid], 10, world.roads), "철도");
    assert.equal(infra.rails.length, 0);
    assert.equal(eraseAt(mesh, infra, -500, -500, 10, world.roads), null);
  });

  test("자동 도로를 지우면 자동 도로를 고정하고 그중 하나만 뺀다", () => {
    const infra = emptyInfra();
    const road = world.roads[0];
    const c = road[Math.floor(road.length / 2)];
    assert.equal(eraseAt(mesh, infra, mesh.x[c], mesh.y[c], 6, world.roads), "도로");
    assert.equal(infra.roads!.length, world.roads.length - 1);
  });
});

describe("지형 변화와 표시", () => {
  test("물에 잠긴 시설은 숨기고, 경로는 물에 잠긴 곳에서 끊는다", () => {
    const infra = emptyInfra();
    const path = routePath(world, cityA, cityB, "road")!;
    addPath(infra, "road", path, []);
    addFacility(world, infra, path[Math.floor(path.length / 2)], "mine");
    const mid = path[Math.floor(path.length / 2)];
    const e = Float64Array.from(elevation);
    for (let k = 0; k < 60; k++) applyBrush(mesh, e, { tool: "lower", radius: 20, strength: 1 }, mesh.x[mid], mesh.y[mid]);
    const sunk = deriveWorld(OPTS, mesh, e);
    const v = visibleInfra(sunk, infra, sunk.roads);
    assert.equal(v.facilities.length, 0);
    assert.ok(v.roads.length >= 1);
    for (const p of v.roads) for (const c of p) assert.ok(sunk.elevation[c] > 0);
    // 데이터는 남아 있어서 땅이 돌아오면 다시 보인다
    assert.equal(infra.facilities.length, 1);
    assert.equal(visibleInfra(world, infra, world.roads).facilities.length, 1);
  });

  test("applyInfra는 고정한 도로가 있으면 자동 도로 대신 쓴다", () => {
    const infra: Infra = { ...emptyInfra(), roads: [] };
    assert.equal(applyInfra(world, infra).roads.length, 0);
    assert.equal(applyInfra(world, emptyInfra()).roads.length, world.roads.length);
  });
});

describe("저장 형식", () => {
  test("JSON 저장·불러오기 후 도로·철도·항구·시설물이 그대로다", () => {
    const infra = emptyInfra();
    addPath(infra, "road", routePath(world, cityA, cityB, "road")!, world.roads);
    addPath(infra, "rail", routePath(world, cityA, cityB, "rail")!, world.roads);
    addPort(world, infra, coastCell, "하늬항");
    addFacility(world, infra, inlandCell, "castle", "검은성");
    const json = JSON.parse(JSON.stringify(toJSON(applyInfra(world, infra), undefined, infra)));
    const parsed = parseMapJSON(json);
    assert.deepEqual(parsed.infra, cloneInfra(infra));
    assert.equal(json.ports[0].name, "하늬항");
  });

  test("손상된 시설 정보는 거부한다", () => {
    const good = infraToJSON({ ...emptyInfra(), ports: [{ cell: coastCell }] }) as Record<string, unknown>;
    assert.ok(infraFromJSON(good, mesh.count));
    assert.equal(infraFromJSON({ ...good, rails: [[1]] }, mesh.count), undefined, "1칸짜리 경로");
    assert.equal(infraFromJSON({ ...good, rails: [[1, mesh.count + 5]] }, mesh.count), undefined, "범위 밖 셀");
    assert.equal(infraFromJSON({ ...good, facilities: [{ cell: 1, kind: "spaceport" }] }, mesh.count), undefined);
    assert.equal(infraFromJSON({ ...good, ports: [{ cell: 1, name: 42 }] }, mesh.count), undefined);
    assert.equal(infraFromJSON("x", mesh.count), undefined);
    assert.throws(() => parseMapJSON({ ...(toJSON(world) as object), infra: { rails: "x" } }), /infra/);
  });

  test("빈 시설 정보 판별과 복제", () => {
    assert.ok(isEmptyInfra(emptyInfra()));
    assert.ok(!isEmptyInfra({ ...emptyInfra(), roads: [] }), "도로를 고정했으면(빈 배열이라도) 비어 있지 않다");
    const a = { ...emptyInfra(), rails: [[1, 2]] };
    const b = cloneInfra(a);
    b.rails[0].push(3);
    assert.deepEqual(a.rails[0], [1, 2]);
  });
});

/** 바다로 이어진 해안 셀 두 개 (서로 충분히 떨어진 것) */
function twoCoasts(minDist = 150): [number, number] {
  const coasts = Array.from({ length: mesh.count }, (_, i) => i).filter((i) => land(i) && coastal(i));
  for (const a of coasts) {
    for (const b of coasts) {
      if (Math.hypot(mesh.x[a] - mesh.x[b], mesh.y[a] - mesh.y[b]) < minDist) continue;
      if (routeSea(world, a, b)) return [a, b];
    }
  }
  throw new Error("바다로 이어진 해안 쌍을 찾지 못함");
}

describe("해상 항로", () => {
  const [pa, pb] = twoCoasts();

  test("항로는 두 항구 사이를 바다로만 잇는다", () => {
    const route = routeSea(world, pa, pb)!;
    assert.equal(route[0], pa);
    assert.equal(route[route.length - 1], pb);
    assert.ok(route.length >= 3);
    for (let k = 1; k < route.length - 1; k++) assert.ok(elevation[route[k]] <= 0, "중간 셀은 바다");
    for (let k = 1; k < route.length; k++) assert.ok(adjacent(route[k - 1], route[k]));
  });

  test("내륙·같은 항구·바다 셀은 항로 끝점이 될 수 없다", () => {
    assert.equal(routeSea(world, pa, inlandCell), null);
    assert.equal(routeSea(world, pa, pa), null);
    assert.equal(routeSea(world, ocean, pb), null);
    assert.match(addSeaRoute(emptyInfra(), [pa, pb])!, /바다/);
  });

  test("깊은 바다를 선호해 연안 셀을 덜 지난다", () => {
    const route = routeSea(world, pa, pb)!;
    const shallow = route.slice(1, -1).filter((c) => elevation[c] > -0.05).length;
    assert.ok(shallow <= (route.length - 2) * 0.6, `얕은 셀 ${shallow}/${route.length - 2}`);
  });

  test("항로 중간이 땅이 되면 그 항로는 숨긴다", () => {
    const infra = emptyInfra();
    const route = routeSea(world, pa, pb)!;
    addSeaRoute(infra, route);
    assert.equal(visibleInfra(world, infra, []).seaRoutes.length, 1);
    const mid = route[Math.floor(route.length / 2)];
    const e = Float64Array.from(elevation);
    for (let k = 0; k < 80; k++) applyBrush(mesh, e, { tool: "raise", radius: 25, strength: 1 }, mesh.x[mid], mesh.y[mid]);
    const raised = deriveWorld(OPTS, mesh, e);
    assert.equal(visibleInfra(raised, infra, []).seaRoutes.length, 0);
    assert.equal(infra.seaRoutes.length, 1, "데이터는 남긴다");
  });

  test("지우기로 항로를 지울 수 있다", () => {
    const infra = emptyInfra();
    const route = routeSea(world, pa, pb)!;
    addSeaRoute(infra, route);
    const mid = route[Math.floor(route.length / 2)];
    assert.equal(eraseAt(mesh, infra, mesh.x[mid], mesh.y[mid], 8, []), "항로");
    assert.equal(infra.seaRoutes.length, 0);
  });
});

describe("항구·시설물 옮기기", () => {
  const [pa, pb] = twoCoasts();

  test("시설물을 옮기면 새 자리로 가고, 물·다른 시설 자리로는 못 간다", () => {
    const infra = emptyInfra();
    addFacility(world, infra, inlandCell, "castle", "성");
    addPort(world, infra, coastCell);
    const target = Array.from({ length: mesh.count }, (_, i) => i).find((i) => land(i) && i !== inlandCell && i !== coastCell)!;
    assert.equal(movePoint(world, infra, "facility", 0, target), null);
    assert.equal(infra.facilities[0].cell, target);
    assert.match(movePoint(world, infra, "facility", 0, ocean)!, /바다/);
    assert.match(movePoint(world, infra, "facility", 0, coastCell)!, /이미/);
    assert.match(movePoint(world, infra, "facility", 5, target)!, /찾을 수 없/);
  });

  test("항구·등대는 해안으로만 옮길 수 있다", () => {
    const infra = emptyInfra();
    addPort(world, infra, pa);
    addFacility(world, infra, pb, "lighthouse");
    assert.match(movePoint(world, infra, "port", 0, inlandCell)!, /해안/);
    assert.match(movePoint(world, infra, "facility", 0, inlandCell)!, /해안/);
  });

  test("항구를 옮기면 이어진 항로를 새 자리로 다시 계산한다", () => {
    const infra = emptyInfra();
    addPort(world, infra, pa);
    addPort(world, infra, pb);
    addSeaRoute(infra, routeSea(world, pa, pb)!);
    // pa 근처의 다른 해안 셀 (pb와 바다로 이어지는 곳)
    const near = Array.from({ length: mesh.count }, (_, i) => i)
      .filter((i) => land(i) && coastal(i) && i !== pa && i !== pb && routeSea(world, i, pb))
      .sort((a, b) => Math.hypot(mesh.x[a] - mesh.x[pa], mesh.y[a] - mesh.y[pa]) - Math.hypot(mesh.x[b] - mesh.x[pa], mesh.y[b] - mesh.y[pa]))[0];
    const result = { droppedRoutes: 0 };
    assert.equal(movePoint(world, infra, "port", 0, near, result), null);
    assert.equal(result.droppedRoutes, 0);
    const route = infra.seaRoutes[0];
    assert.equal(route[0], near);
    assert.equal(route[route.length - 1], pb);
  });

  test("hitPoint는 반경 안의 가장 가까운 항구·시설물을 찾는다", () => {
    const infra = emptyInfra();
    addPort(world, infra, coastCell);
    addFacility(world, infra, inlandCell, "mine");
    assert.deepEqual(hitPoint(mesh, infra, mesh.x[inlandCell], mesh.y[inlandCell], 5), { kind: "facility", index: 0 });
    assert.deepEqual(hitPoint(mesh, infra, mesh.x[coastCell], mesh.y[coastCell], 5), { kind: "port", index: 0 });
    assert.equal(hitPoint(mesh, infra, -100, -100, 5), null);
  });
});

describe("다리·터널 표기", () => {
  test("강을 짧게 건너는 지점은 다리로, 강을 따라 길게 가는 구간은 다리로 보지 않는다", () => {
    const river = Array.from({ length: mesh.count }, (_, i) => i).find((i) => world.hydro.isRiver[i] && land(i))!;
    const before = Array.from({ length: mesh.count }, (_, i) => i).find((i) => adjacent(i, river) && land(i) && !world.hydro.isRiver[i])!;
    const after = Array.from({ length: mesh.count }, (_, i) => i).find((i) => i !== before && adjacent(i, river) && land(i) && !world.hydro.isRiver[i])!;
    assert.deepEqual(pathMarks(world, [before, river, after], "road").bridges, [1]);
    // 강 셀로만 이루어진 4칸 경로(강을 따라감): 다리 없음
    const along = world.rivers.find((r) => r.cells.length >= 6)!.cells.slice(0, 5);
    assert.deepEqual(pathMarks(world, along, "road").bridges, []);
  });

  test("철도가 높은 산지를 2칸 이상 지나면 터널로 표기한다 (도로는 표기하지 않음)", () => {
    const high = Array.from({ length: mesh.count }, (_, i) => i).filter((i) => elevation[i] > TUNNEL_ELEVATION);
    const a = high.find((i) => high.some((j) => adjacent(i, j)))!;
    const b = high.find((j) => adjacent(a, j))!;
    const lowA = Array.from({ length: mesh.count }, (_, i) => i).find((i) => adjacent(i, a) && elevation[i] <= TUNNEL_ELEVATION && land(i));
    if (lowA === undefined) return; // 이 시드에서 조건에 맞는 산이 없으면 건너뜀
    const path = [lowA, a, b];
    assert.deepEqual(pathMarks(world, path, "rail").tunnels, [[1, 2]]);
    assert.deepEqual(pathMarks(world, path, "road").tunnels, []);
  });
});

describe("저장 형식 (항로)", () => {
  test("항로까지 JSON 저장·불러오기 후 그대로이고, 항로 필드가 없던 예전 형식도 읽는다", () => {
    const [pa, pb] = twoCoasts();
    const infra = emptyInfra();
    addPort(world, infra, pa);
    addPort(world, infra, pb);
    addSeaRoute(infra, routeSea(world, pa, pb)!);
    const back = infraFromJSON(JSON.parse(JSON.stringify(infraToJSON(infra))), mesh.count)!;
    assert.deepEqual(back.seaRoutes, infra.seaRoutes);
    const legacy = infraFromJSON({ rails: [], ports: [], facilities: [] }, mesh.count)!;
    assert.deepEqual(legacy.seaRoutes, []);
    assert.equal(infraFromJSON({ ...infraToJSON(infra), seaRoutes: [[1]] }, mesh.count), undefined);
  });
});

describe("다리·터널 직접 놓기", () => {
  /** 바다·호수·강을 사이에 둔 두 육지 셀 (MAX_SPAN_LENGTH 이내) */
  function acrossWater(): [number, number] {
    const lands = Array.from({ length: mesh.count }, (_, i) => i).filter(land);
    for (const a of lands) {
      for (const b of lands) {
        const d = Math.hypot(mesh.x[a] - mesh.x[b], mesh.y[a] - mesh.y[b]);
        if (d < 30 || d > 90) continue;
        if (spanCells(mesh, a, b).some((c) => !land(c))) return [a, b];
      }
    }
    throw new Error("물 건너편 셀 쌍 없음");
  }
  /** 사이가 모두 육지이고 강도 없는 두 셀 */
  function overLand(): [number, number] {
    const lands = Array.from({ length: mesh.count }, (_, i) => i).filter((i) => land(i) && !world.hydro.isRiver[i]);
    for (const a of lands) {
      for (const b of lands) {
        const d = Math.hypot(mesh.x[a] - mesh.x[b], mesh.y[a] - mesh.y[b]);
        if (d < 40 || d > 80) continue;
        if (spanCells(mesh, a, b).every((c) => land(c) && !world.hydro.isRiver[c])) return [a, b];
      }
    }
    throw new Error("육지 위 셀 쌍 없음");
  }

  test("spanCells는 두 점 사이 직선이 지나는 셀을 순서대로 돌려준다", () => {
    const [a, b] = acrossWater();
    const cells = spanCells(mesh, a, b);
    assert.ok(cells.length >= 2);
    assert.ok(!cells.includes(a) && !cells.includes(b));
    // 순서대로 b에 가까워진다 (대체로)
    const d = (c: number): number => Math.hypot(mesh.x[c] - mesh.x[b], mesh.y[c] - mesh.y[b]);
    assert.ok(d(cells[0]) > d(cells[cells.length - 1]));
  });

  test("다리는 물을 건너야 하고, 터널은 육지 위에도 놓을 수 있다", () => {
    const infra = emptyInfra();
    const [wa, wb] = acrossWater();
    const [la, lb] = overLand();
    assert.equal(addSpan(world, infra, "bridge", wa, wb), null);
    assert.match(addSpan(world, infra, "bridge", la, lb)!, /물/);
    assert.equal(addSpan(world, infra, "tunnel", la, lb), null);
    assert.equal(addSpan(world, infra, "tunnel", wa, wb), null, "해저 터널도 된다");
    assert.equal(infra.bridges.length, 1);
    assert.equal(infra.tunnels.length, 2);
  });

  test("양 끝이 물·같은 점이거나, 너무 길거나, 이미 있으면 거부한다", () => {
    const infra = emptyInfra();
    const [wa, wb] = acrossWater();
    assert.match(addSpan(world, infra, "bridge", wa, wa)!, /같습니다/);
    assert.match(addSpan(world, infra, "bridge", wa, ocean)!, /육지/);
    const far = Array.from({ length: mesh.count }, (_, i) => i)
      .find((i) => land(i) && Math.hypot(mesh.x[i] - mesh.x[wa], mesh.y[i] - mesh.y[wa]) > MAX_SPAN_LENGTH + 20)!;
    assert.match(addSpan(world, infra, "tunnel", wa, far)!, /px까지/);
    addSpan(world, infra, "bridge", wa, wb);
    assert.match(addSpan(world, infra, "bridge", wb, wa)!, /이미/);
  });

  test("지우기는 직접 놓은 다리·터널을 지운다", () => {
    const infra = emptyInfra();
    const [wa, wb] = acrossWater();
    addSpan(world, infra, "bridge", wa, wb);
    const mx = (mesh.x[wa] + mesh.x[wb]) / 2, my = (mesh.y[wa] + mesh.y[wb]) / 2;
    assert.equal(eraseAt(mesh, infra, mx, my, 8, [], world), "도로 다리");
    assert.equal(infra.bridges.length, 0);
  });

  test("자동 다리 표기를 지우기로 누르면 그 표기만 숨긴다 (도로는 그대로)", () => {
    const road = world.roads.find((r) => pathMarks(world, r, "road").bridges.length > 0);
    if (!road) return; // 이 시드의 자동 도로에 다리가 없으면 건너뜀
    const k = pathMarks(world, road, "road").bridges[0];
    const infra = emptyInfra();
    const removed = eraseAt(mesh, infra, mesh.x[road[k]], mesh.y[road[k]], 6, world.roads, world);
    assert.equal(removed, "자동 다리 표기");
    assert.equal(infra.roads, undefined, "자동 도로는 고정하지 않는다");
    assert.equal(pathMarks(world, road, "road", new Set(infra.hiddenMarks)).bridges.includes(k), false);
  });

  test("양 끝이 물에 잠긴 다리·터널은 숨긴다", () => {
    const infra = emptyInfra();
    const [la, lb] = overLand();
    addSpan(world, infra, "tunnel", la, lb);
    const e = Float64Array.from(elevation);
    for (let k = 0; k < 80; k++) applyBrush(mesh, e, { tool: "lower", radius: 15, strength: 1 }, mesh.x[la], mesh.y[la]);
    assert.equal(visibleInfra(deriveWorld(OPTS, mesh, e), infra, []).tunnels.length, 0);
    assert.equal(visibleInfra(world, infra, []).tunnels.length, 1);
  });

  test("다리·터널·숨긴 표기도 저장·불러오기 되고, 예전 형식도 읽는다", () => {
    const infra = emptyInfra();
    const [wa, wb] = acrossWater();
    addSpan(world, infra, "bridge", wa, wb);
    infra.hiddenMarks.push(5);
    const back = infraFromJSON(JSON.parse(JSON.stringify(infraToJSON(infra))), mesh.count)!;
    assert.deepEqual(back.bridges, infra.bridges);
    assert.deepEqual(back.hiddenMarks, [5]);
    const legacy = infraFromJSON({ rails: [], seaRoutes: [], ports: [], facilities: [] }, mesh.count)!;
    assert.deepEqual([legacy.bridges, legacy.tunnels, legacy.hiddenMarks], [[], [], []]);
    assert.equal(infraFromJSON({ ...infraToJSON(infra), bridges: [{ a: 1, b: 1 }] }, mesh.count), undefined);
    assert.equal(infraFromJSON({ ...infraToJSON(infra), hiddenMarks: [-1] }, mesh.count), undefined);
  });
});

describe("다리·터널을 길로 쓰기", () => {
  // 군도 지도: 섬이 여럿이라 다리 없이는 이어지지 않는 육지 쌍이 있다
  const AO: WorldOptions = { ...DEFAULT_OPTIONS, seed: "다리섬", cells: 4000, width: 1000, height: 700, shape: "archipelago" };
  const am = createMesh(AO);
  const aw = deriveWorld(AO, am, createElevation(am, AO));
  const aLand = (i: number): boolean => aw.elevation[i] > 0 && !aw.hydro.isLake[i];
  // 육지 연결 요소 번호
  const comp = new Int32Array(am.count).fill(-1);
  let n = 0;
  for (let s = 0; s < am.count; s++) {
    if (!aLand(s) || comp[s] >= 0) continue;
    const q = [s];
    comp[s] = n;
    while (q.length) {
      const i = q.pop()!;
      forEachNeighbor(am, i, (j) => { if (aLand(j) && comp[j] < 0) { comp[j] = n; q.push(j); } });
    }
    n++;
  }
  /** 서로 다른 섬에 있고 MAX_SPAN_LENGTH 이내인 두 육지 셀 */
  function islandPair(): [number, number] {
    for (let a = 0; a < am.count; a++) {
      if (!aLand(a)) continue;
      for (let b = 0; b < am.count; b++) {
        if (!aLand(b) || comp[a] === comp[b]) continue;
        const d = Math.hypot(am.x[a] - am.x[b], am.y[a] - am.y[b]);
        if (d > 40 && d < 120) return [a, b];
      }
    }
    throw new Error("섬 쌍 없음");
  }
  const [ia, ib] = islandPair();
  // 각 섬 안에서 다리 끝에서 조금 떨어진 육지 (경로의 출발·도착)
  const farIn = (c: number): number => Array.from({ length: am.count }, (_, i) => i)
    .filter((i) => comp[i] === comp[c] && i !== c)
    .sort((x, y) => Math.hypot(am.x[y] - am.x[c], am.y[y] - am.y[c]) - Math.hypot(am.x[x] - am.x[c], am.y[x] - am.y[c]))[0];
  const startCell = farIn(ia), goalCell = farIn(ib);

  test("다리가 없으면 다른 섬으로 가는 도로·철도는 만들 수 없다", () => {
    assert.equal(routePath(aw, startCell, goalCell, "road"), null);
    assert.equal(routePath(aw, startCell, goalCell, "rail"), null);
  });

  test("도로용 다리는 도로만, 철도용 다리는 철도만 건넌다", () => {
    const roadOnly = emptyInfra();
    assert.equal(addSpan(aw, roadOnly, "bridge", ia, ib, "road"), null);
    assert.ok(routePath(aw, startCell, goalCell, "road", spanLinks(aw, roadOnly, "road")));
    assert.equal(routePath(aw, startCell, goalCell, "rail", spanLinks(aw, roadOnly, "rail")), null, "철도는 도로용 다리를 못 건넌다");
    const railOnly = emptyInfra();
    assert.equal(addSpan(aw, railOnly, "bridge", ia, ib, "rail"), null);
    assert.ok(routePath(aw, startCell, goalCell, "rail", spanLinks(aw, railOnly, "rail")));
    assert.equal(routePath(aw, startCell, goalCell, "road", spanLinks(aw, railOnly, "road")), null, "도로는 철도용 다리를 못 건넌다");
  });

  test("같은 자리에 도로용·철도용 다리를 하나씩 둘 수 있고, 같은 용도는 중복 거부", () => {
    const infra = emptyInfra();
    assert.equal(addSpan(aw, infra, "bridge", ia, ib, "road"), null);
    assert.equal(addSpan(aw, infra, "bridge", ia, ib, "rail"), null);
    assert.match(addSpan(aw, infra, "bridge", ib, ia, "rail")!, /이미/);
  });

  test("다리를 놓으면 도로·철도가 그 다리를 건너 이어진다", () => {
    const infra = emptyInfra();
    assert.equal(addSpan(aw, infra, "bridge", ia, ib, "road"), null);
    assert.equal(addSpan(aw, infra, "bridge", ia, ib, "rail"), null);
    for (const mode of ["road", "rail"] as const) {
      const links = spanLinks(aw, infra, mode);
      const path = routePath(aw, startCell, goalCell, mode, links);
      assert.ok(path, `${mode}: 다리를 건너는 경로가 없음`);
      const k = path.findIndex((c, i) => i > 0 && ((path[i - 1] === ia && c === ib) || (path[i - 1] === ib && c === ia)));
      assert.ok(k > 0, `${mode}: 경로가 다리를 지나지 않음`);
      for (let i = 1; i < path.length; i++) assert.ok(connected(am, links, path[i - 1], path[i]));
    }
  });

  test("터널도 길로 쓴다", () => {
    const infra = emptyInfra();
    assert.equal(addSpan(aw, infra, "tunnel", ia, ib), null);
    assert.ok(routePath(aw, startCell, goalCell, "road", spanLinks(aw, infra, "road")));
  });

  test("자동 도로 경로 계산(findPath)도 다리를 건넌다", () => {
    const infra = emptyInfra();
    addSpan(aw, infra, "bridge", ia, ib);
    const roadCells = new Uint8Array(am.count);
    assert.equal(findPath(am, aw.biome, aw.hydro, startCell, goalCell, roadCells), null);
    const path = findPath(am, aw.biome, aw.hydro, startCell, goalCell, roadCells, spanLinks(aw, infra, "road"));
    assert.ok(path && path.includes(ia) && path.includes(ib));
  });

  test("다리를 지우면 그 위를 지나던 도로는 끊긴 곳에서 나뉘어 그려진다", () => {
    const infra = emptyInfra();
    addSpan(aw, infra, "bridge", ia, ib);
    const path = routePath(aw, startCell, goalCell, "road", spanLinks(aw, infra, "road"))!;
    addPath(infra, "road", path, []);
    assert.equal(visibleInfra(aw, infra, []).roads.length, 1);
    infra.bridges = [];
    const pieces = visibleInfra(aw, infra, []).roads;
    assert.equal(pieces.length, 2);
    for (const p of pieces) for (let i = 1; i < p.length; i++) assert.ok(connected(am, new Map(), p[i - 1], p[i]));
  });

  test("이동: 끝점을 잡으면 그 끝만, 몸통을 잡으면 통째로", () => {
    const infra = emptyInfra();
    addSpan(aw, infra, "bridge", ia, ib);
    assert.deepEqual(hitSpan(am, infra, am.x[ia], am.y[ia], 10), { kind: "bridge", index: 0, part: "a" });
    assert.deepEqual(hitSpan(am, infra, am.x[ib], am.y[ib], 10), { kind: "bridge", index: 0, part: "b" });
    const mx = (am.x[ia] + am.x[ib]) / 2, my = (am.y[ia] + am.y[ib]) / 2;
    assert.equal(hitSpan(am, infra, mx, my, 10)?.part, "body");
    assert.equal(hitSpan(am, infra, -100, -100, 10), null);
  });

  test("옮길 때도 놓을 때와 같은 조건을 검사한다", () => {
    const infra = emptyInfra();
    addSpan(aw, infra, "bridge", ia, ib);
    // b 끝을 a와 같은 섬 안쪽 육지로 → 물을 건너지 않으면 거부 (같은 섬 안, 사이가 모두 육지인 셀)
    const sameIsland = Array.from({ length: am.count }, (_, i) => i).find((i) => comp[i] === comp[ia] && i !== ia
      && Math.hypot(am.x[i] - am.x[ia], am.y[i] - am.y[ia]) > 15 && Math.hypot(am.x[i] - am.x[ia], am.y[i] - am.y[ia]) < 40
      && spanCells(am, ia, i).every((c) => aLand(c) && !aw.hydro.isRiver[c]) && !aw.hydro.isRiver[i]);
    if (sameIsland !== undefined) assert.match(moveSpan(aw, infra, "bridge", 0, ia, sameIsland)!, /물/);
    const ocean2 = aw.elevation.findIndex((e, i) => e < -0.2 && !am.isEdge[i]);
    assert.match(moveSpan(aw, infra, "bridge", 0, ia, ocean2)!, /육지/);
    assert.equal(moveSpan(aw, infra, "bridge", 0, ib, ia), null, "방향만 뒤집기");
    assert.deepEqual(infra.bridges[0], { a: ib, b: ia, mode: "road" });
    assert.match(moveSpan(aw, infra, "tunnel", 0, ia, ib)!, /찾을 수 없/);
  });
});

describe("다리를 옮기면 길이 따라간다", () => {
  const AO: WorldOptions = { ...DEFAULT_OPTIONS, seed: "다리섬", cells: 4000, width: 1000, height: 700, shape: "archipelago" };
  const am = createMesh(AO);
  const aw = deriveWorld(AO, am, createElevation(am, AO));
  const aLand = (i: number): boolean => aw.elevation[i] > 0 && !aw.hydro.isLake[i];
  const comp = new Int32Array(am.count).fill(-1);
  let n = 0;
  for (let s = 0; s < am.count; s++) {
    if (!aLand(s) || comp[s] >= 0) continue;
    const q = [s];
    comp[s] = n;
    while (q.length) {
      const i = q.pop()!;
      forEachNeighbor(am, i, (j) => { if (aLand(j) && comp[j] < 0) { comp[j] = n; q.push(j); } });
    }
    n++;
  }
  // 서로 다른 섬의 다리 끝 쌍과, 같은 두 섬을 잇는 두 번째(옮길 자리) 쌍
  const pairs: [number, number][] = [];
  for (let a = 0; a < am.count && pairs.length < 400; a++) {
    if (!aLand(a)) continue;
    for (let b = 0; b < am.count; b++) {
      if (!aLand(b) || comp[a] === comp[b]) continue;
      const d = Math.hypot(am.x[a] - am.x[b], am.y[a] - am.y[b]);
      if (d > 40 && d < 120) pairs.push([a, b]);
    }
  }
  const [ia, ib] = pairs[0];
  const alt = pairs.find(([a, b]) => comp[a] === comp[ia] && comp[b] === comp[ib] && a !== ia && b !== ib
    && Math.hypot(am.x[a] - am.x[ia], am.y[a] - am.y[ia]) > 15)!;
  const inIsland = (c: number): number => Array.from({ length: am.count }, (_, i) => i)
    .filter((i) => comp[i] === comp[c] && i !== c)
    .sort((x, y) => Math.hypot(am.x[y] - am.x[c], am.y[y] - am.y[c]) - Math.hypot(am.x[x] - am.x[c], am.y[x] - am.y[c]))[0];
  const start = inIsland(ia), goal = inIsland(ib);
  const usesSpan = (p: number[], a: number, b: number): boolean =>
    p.some((c, k) => k > 0 && ((p[k - 1] === a && c === b) || (p[k - 1] === b && c === a)));

  for (const mode of ["road", "rail"] as const) {
    test(`${mode === "road" ? "도로" : "철도"}: 다리를 옮기면 지나던 경로가 새 다리로 다시 이어진다`, () => {
      const infra: Infra = { ...emptyInfra(), roads: [] };
      addSpan(aw, infra, "bridge", ia, ib, mode);
      const path = routePath(aw, start, goal, mode, spanLinks(aw, infra, mode))!;
      addPath(infra, mode, path, []);
      const list = mode === "road" ? infra.roads! : infra.rails;
      const result = { rerouted: 0, broken: 0 };
      assert.equal(moveSpan(aw, infra, "bridge", 0, alt[0], alt[1], result), null);
      assert.deepEqual(result, { rerouted: 1, broken: 0 });
      const moved = list[list.length - 1];
      assert.equal(moved[0], start, "출발점은 그대로");
      assert.equal(moved[moved.length - 1], goal, "도착점은 그대로");
      assert.ok(usesSpan(moved, alt[0], alt[1]), "새 다리를 건넌다");
      assert.ok(!usesSpan(moved, ia, ib), "옛 다리 자리는 지나지 않는다");
      // 다른 용도의 경로는 건드리지 않는다
      const other = mode === "road" ? infra.rails : infra.roads!;
      assert.equal(other.length, 0);
    });
  }

  test("다른 용도의 경로는 옮겨도 따라가지 않는다 (도로용 다리를 옮겨도 철도는 그대로)", () => {
    const infra: Infra = { ...emptyInfra(), roads: [] };
    addSpan(aw, infra, "bridge", ia, ib, "road");
    addSpan(aw, infra, "bridge", ia, ib, "rail");
    const rail = routePath(aw, start, goal, "rail", spanLinks(aw, infra, "rail"))!;
    addPath(infra, "rail", rail, []);
    const result = { rerouted: 0, broken: 0 };
    assert.equal(moveSpan(aw, infra, "bridge", 0, alt[0], alt[1], result), null);
    assert.deepEqual(result, { rerouted: 0, broken: 0 });
    assert.deepEqual(infra.rails[0], rail);
  });

  test("새 자리로 이어질 수 없으면 경로를 그대로 두고 개수를 센다", () => {
    const infra: Infra = { ...emptyInfra(), roads: [] };
    addSpan(aw, infra, "bridge", ia, ib, "road");
    const path = routePath(aw, start, goal, "road", spanLinks(aw, infra, "road"))!;
    addPath(infra, "road", path, []);
    // 같은 섬 안의 두 해안 셀로 옮기면 두 섬을 잇는 길이 없어진다
    const sameIsland = pairs.find(([a, b]) => comp[a] === comp[ia] && comp[b] !== comp[ib]);
    if (!sameIsland) return;
    const result = { rerouted: 0, broken: 0 };
    assert.equal(moveSpan(aw, infra, "bridge", 0, sameIsland[0], sameIsland[1], result), null);
    assert.equal(result.broken, 1);
    assert.deepEqual(infra.roads![0], path, "경로 데이터는 그대로 (화면에서는 끊겨 그려짐)");
  });

  test("용도가 없던 예전 다리·터널은 도로용으로 읽는다", () => {
    const back = infraFromJSON({ bridges: [{ a: ia, b: ib }], tunnels: [{ a: ia, b: ib, mode: "rail" }] }, am.count)!;
    assert.equal(back.bridges[0].mode, "road");
    assert.equal(back.tunnels[0].mode, "rail");
    assert.equal(infraFromJSON({ bridges: [{ a: ia, b: ib, mode: "boat" }] }, am.count), undefined);
  });

  test("지우기 메시지에 용도가 나온다", () => {
    const infra = emptyInfra();
    addSpan(aw, infra, "bridge", ia, ib, "rail");
    const mx = (am.x[ia] + am.x[ib]) / 2, my = (am.y[ia] + am.y[ib]) / 2;
    assert.equal(eraseAt(am, infra, mx, my, 8, [], aw), "철도 다리");
  });
});
