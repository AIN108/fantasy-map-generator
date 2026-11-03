import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyBrush } from "../src/editor.ts";
import {
  addFacility, addPath, addPort, cloneInfra, emptyInfra, eraseAt, infraFromJSON, infraToJSON, isEmptyInfra,
  routePath, visibleInfra, type Infra,
} from "../src/infra.ts";
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

  test("철도는 도로보다 급경사를 덜 지난다 (여러 도시 쌍 평균)", () => {
    const maxClimb = (p: number[]): number => {
      let m = 0;
      for (let k = 1; k < p.length; k++) m = Math.max(m, Math.abs(elevation[p[k]] - elevation[p[k - 1]]));
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
