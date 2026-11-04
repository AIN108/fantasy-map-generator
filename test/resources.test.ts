import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addResource, applyResourceEdits, emptyResourceEdits, MAX_AMOUNT, placeResources, removeResource, RESOURCE_GAP,
  RESOURCE_INFO, RESOURCE_KINDS, resourceEditsFromJSON, resourceEditsToJSON, resourceSiteError, type Resource,
} from "../src/resources.ts";
import {
  applyResources, createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, generateWorld, natureOf, parseMapJSON, toJSON,
  type WorldMap, type WorldOptions,
} from "../src/world.ts";

const world = generateWorld({ ...DEFAULT_OPTIONS, seed: "청운" });
const { mesh } = world;
const isWater = (w: WorldMap, cell: number) => w.elevation[cell] <= 0 || w.hydro.isLake[cell] === 1;

describe("자원 자동 배치", () => {
  test("같은 시드면 같은 결과이고, 세 분류가 모두 나온다", () => {
    const again = generateWorld({ ...DEFAULT_OPTIONS, seed: "청운" });
    assert.deepEqual(again.resources, world.resources);
    const cats = new Set(world.resources.map((r) => RESOURCE_INFO[r.kind].category));
    assert.deepEqual([...cats].sort(), ["bonus", "luxury", "strategic"]);
    assert.ok(world.resources.length > 120 && world.resources.length < 400, `개수 ${world.resources.length}`);
  });

  test("놓인 자리가 종류별 규칙(육지/바다)에 맞고, 전략 자원만 매장량 2~8이 있다", () => {
    for (const r of world.resources) {
      assert.equal(resourceSiteError(world, r.kind, r.cell), null, `${r.kind}@${r.cell}`);
      assert.equal(mesh.isEdge[r.cell], 0);
      if (RESOURCE_INFO[r.kind].category === "strategic") assert.ok(r.amount! >= 2 && r.amount! <= 8);
      else assert.equal(r.amount, undefined);
    }
    // 어장은 연안·호수, 석유는 육지 또는 바다
    assert.ok(world.resources.some((r) => r.kind === "fish"));
    assert.ok(world.resources.filter((r) => r.kind === "fish").every((r) => isWater(world, r.cell)));
  });

  test("자원끼리 아이콘이 겹치지 않을 만큼 떨어져 있고, 한 셀에 하나만 있다", () => {
    const rs = world.resources;
    assert.equal(new Set(rs.map((r) => r.cell)).size, rs.length);
    for (let a = 0; a < rs.length; a++) {
      for (let b = a + 1; b < rs.length; b++) {
        const d = Math.hypot(mesh.x[rs[a].cell] - mesh.x[rs[b].cell], mesh.y[rs[a].cell] - mesh.y[rs[b].cell]);
        assert.ok(d >= RESOURCE_GAP, `${rs[a].kind}·${rs[b].kind} ${d.toFixed(1)}px`);
      }
    }
  });

  test("셀 수(정밀도)가 달라도 지도 전체 개수는 비슷하다", () => {
    const counts = [3000, 9000, 20000].map((cells) => generateWorld({ ...DEFAULT_OPTIONS, seed: "청운", cells }).resources.length);
    assert.ok(Math.max(...counts) / Math.min(...counts) < 1.5, counts.join(", "));
  });

  test("지형 일부를 편집해도 먼 곳의 자원은 대부분 그대로다", () => {
    const opts: WorldOptions = { ...DEFAULT_OPTIONS, seed: "청운" };
    const e = createElevation(mesh, opts);
    // 왼쪽 위 구석의 바다에 작은 섬을 만든다
    const [cx, cy] = [120, 120];
    const edited = Float64Array.from(e, (v, i) => (Math.hypot(mesh.x[i] - cx, mesh.y[i] - cy) < 30 ? 0.2 : v));
    const after = deriveWorld(opts, mesh, edited, true).resources;
    const far = (r: Resource) => Math.hypot(mesh.x[r.cell] - cx, mesh.y[r.cell] - cy) > 250;
    const key = (r: Resource) => `${r.cell}:${r.kind}`;
    const before = new Set(world.resources.filter(far).map(key));
    const kept = after.filter(far).filter((r) => before.has(key(r))).length;
    assert.ok(kept / before.size > 0.9, `${kept}/${before.size}`);
  });

  test("자연 계산을 다시 써도 자원이 같다", () => {
    const opts: WorldOptions = { ...DEFAULT_OPTIONS, seed: "청운" };
    const reused = deriveWorld(opts, mesh, world.elevation, false, undefined, undefined, undefined, natureOf(world));
    assert.deepEqual(reused.resources, world.resources);
    assert.deepEqual(placeResources(world, "청운"), world.autoResources);
  });
});

describe("자원 편집", () => {
  const landCell = world.resources.find((r) => r.kind === "wood")!.cell; // 자동 목재가 있는 육지
  const emptyLand = mesh.x.findIndex((_, i) => !isWater(world, i) && !mesh.isEdge[i] && !world.resources.some((r) => r.cell === i));
  const sea = mesh.x.findIndex((_, i) => world.elevation[i] < -0.3 && !mesh.isEdge[i]);

  test("놓기: 자리 규칙 검사, 전략 자원 매장량 검사, 같은 칸이면 바꾼다", () => {
    const edits = emptyResourceEdits();
    assert.match(addResource(world, edits, world.autoResources, sea, "coal") ?? "", /육지에만/);
    assert.match(addResource(world, edits, world.autoResources, emptyLand, "fish") ?? "", /바다·호수에만/);
    assert.match(addResource(world, edits, world.autoResources, emptyLand, "iron", MAX_AMOUNT + 1) ?? "", /매장량/);
    assert.equal(addResource(world, edits, world.autoResources, sea, "oil", 12), null);
    assert.equal(addResource(world, edits, world.autoResources, landCell, "gold"), null);
    const shown = applyResources(world, edits).resources;
    assert.deepEqual(shown.find((r) => r.cell === sea), { cell: sea, kind: "oil", amount: 12 });
    assert.deepEqual(shown.filter((r) => r.cell === landCell), [{ cell: landCell, kind: "gold" }]);
    assert.equal(shown.length, world.resources.length + 1);
  });

  test("지우기: 자동 자원은 숨기고, 직접 놓은 자원은 없앤다. 지형과 안 맞게 된 자원은 보이지 않는다", () => {
    const edits = emptyResourceEdits();
    assert.equal(removeResource(edits, world.resources, world.autoResources, landCell), "목재");
    assert.equal(removeResource(edits, world.resources, world.autoResources, emptyLand), null);
    assert.ok(!applyResources(world, edits).resources.some((r) => r.cell === landCell));

    addResource(world, edits, world.autoResources, emptyLand, "silk");
    // 그 칸이 바다가 되면 비단은 보이지 않지만 편집 기록에는 남는다
    const drowned = { ...world, elevation: Float64Array.from(world.elevation, (v, i) => (i === emptyLand ? -0.1 : v)) };
    assert.ok(!applyResourceEdits(world.autoResources, edits, drowned).some((r) => r.cell === emptyLand));
    assert.ok(edits.added.some((r) => r.cell === emptyLand));
  });

  test("편집 JSON 왕복과 잘못된 값 거부", () => {
    const edits = emptyResourceEdits();
    addResource(world, edits, world.autoResources, sea, "oil", 7);
    removeResource(edits, world.resources, world.autoResources, landCell);
    const back = resourceEditsFromJSON(JSON.parse(JSON.stringify(resourceEditsToJSON(edits))), mesh.count);
    assert.deepEqual(back, edits);
    const n = mesh.count;
    assert.equal(resourceEditsFromJSON({ added: [{ cell: 1, kind: "constructor" }] }, n), undefined); // 프로토타입 키
    assert.equal(resourceEditsFromJSON({ added: [{ cell: 1, kind: "wood" }, { cell: 1, kind: "gold" }] }, n), undefined);
    assert.equal(resourceEditsFromJSON({ added: [{ cell: 1, kind: "iron", amount: 99 }] }, n), undefined);
    assert.equal(resourceEditsFromJSON({ removed: [n] }, n), undefined);
    assert.equal(resourceEditsFromJSON("x", n), undefined);
    assert.deepEqual(resourceEditsFromJSON({ added: [{ cell: 1, kind: "coal" }] }, n)?.added, [{ cell: 1, kind: "coal", amount: 4 }]);
  });

  test("지도 JSON에 최종 자원 목록과 편집이 들어가고, 다시 불러오면 편집이 살아난다", () => {
    const edits = emptyResourceEdits();
    addResource(world, edits, world.autoResources, sea, "oil", 9);
    const shown = applyResources(world, edits);
    const json = JSON.parse(JSON.stringify(toJSON(shown, undefined, undefined, edits))) as {
      resources: { cell: number; kind: string; name: string; category: string; amount?: number; x: number; y: number }[];
    };
    assert.equal(json.resources.length, shown.resources.length);
    const { x, y, ...oil } = json.resources.find((r) => r.cell === sea)!;
    assert.deepEqual(oil, { cell: sea, kind: "oil", name: "석유", category: "strategic", amount: 9 });
    assert.ok(Math.abs(x - mesh.x[sea]) < 0.01 && Math.abs(y - mesh.y[sea]) < 0.01);
    assert.deepEqual(parseMapJSON(json).resources, edits);
    // 편집이 없으면 resourceEdits 칸을 넣지 않는다
    assert.equal("resourceEdits" in (toJSON(world) as object), false);
  });

  test("모든 종류에 이름·분류가 있다", () => {
    for (const k of RESOURCE_KINDS) assert.ok(RESOURCE_INFO[k].ko.length > 0);
    assert.equal(RESOURCE_KINDS.length, 16);
  });
});

// 메시를 다시 만들어도 같은 셀 수인지 (편집 테스트의 셀 번호가 유효한지) 확인
test("테스트용 메시는 기본 옵션과 같다", () => {
  assert.equal(createMesh({ ...DEFAULT_OPTIONS, seed: "청운" }).count, mesh.count);
});
