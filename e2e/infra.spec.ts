import { test, expect } from "@playwright/test";
import {
  clickMap, coastCells, collectErrors, crosses, dist, dragMap, enterInfraTool, expectError, expectOk, exportJson,
  isLand, landComponents, meshOf, openApp, type ExportedMap,
} from "./helpers.ts";

const at = (map: ExportedMap, cell: number) => ({ x: map.cells[cell].x, y: map.cells[cell].y });
const farFromCities = (map: ExportedMap, cell: number, d: number) =>
  map.cities.every((c) => Math.hypot(c.x - map.cells[cell].x, c.y - map.cells[cell].y) > d);

test("도로·철도를 그리고, 도로를 자동 배치로 되돌린다", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const start = await exportJson(page);
  const caps = start.cities.filter((c) => c.capital);
  expect(caps.length).toBeGreaterThanOrEqual(4);

  await enterInfraTool(page, "road");
  await dragMap(page, caps[0], caps[2]);
  await expectOk(page);
  let j = await exportJson(page);
  const road = j.infra?.roads?.at(-1);
  expect(j.infra?.roads?.length).toBe(start.roads.length + 1);
  expect([road?.[0], road?.at(-1)]).toEqual([caps[0].cell, caps[2].cell]);

  await page.check('input[name="infraTool"][value="rail"]');
  await dragMap(page, caps[1], caps[3]);
  await expectOk(page);
  j = await exportJson(page);
  expect(j.rails).toHaveLength(1);
  expect([j.rails[0][0], j.rails[0].at(-1)]).toEqual([caps[1].cell, caps[3].cell]);

  await page.click("#resetRoads");
  j = await exportJson(page);
  expect(j.infra?.roads).toBeUndefined();
  expect(j.roads).toEqual(start.roads);
  expect(j.rails).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("항구·시설물 자리 규칙, 지우기·되돌리기, 새로고침 후 유지", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const map = await exportJson(page);
  const mesh = meshOf(map);
  const coast = coastCells(map, mesh).find((i) => farFromCities(map, i, 12))!;
  const inland = map.cells.findIndex((c, i) => isLand(map, i) && c.elevation > 0.5 && farFromCities(map, i, 20));
  const castleAt = map.cells.findIndex((c, i) => isLand(map, i) && c.elevation > 0.3 && c.elevation < 0.5 && farFromCities(map, i, 40));
  const flat = map.cells.findIndex((c, i) => isLand(map, i) && c.elevation > 0.05 && c.elevation < 0.2
    && farFromCities(map, i, 40) && dist(map, i, castleAt) > 40 && dist(map, i, coast) > 40);
  expect(Math.min(coast, inland, castleAt, flat)).toBeGreaterThanOrEqual(0);

  await enterInfraTool(page, "port");
  await page.fill("#featureName", "하늬항");
  await clickMap(page, at(map, coast));
  await expectOk(page);
  await clickMap(page, at(map, inland));
  await expectError(page); // 바다에 닿지 않은 곳

  await page.check('input[name="infraTool"][value="facility"]');
  await expect(page.locator("#facilityKind")).toBeVisible();
  await page.selectOption("#facilityKind", "castle");
  await page.fill("#featureName", "검은성");
  await clickMap(page, at(map, castleAt));
  await expectOk(page);
  await page.selectOption("#facilityKind", "lighthouse");
  await clickMap(page, at(map, inland));
  await expectError(page); // 등대는 해안에만
  await page.selectOption("#facilityKind", "airport");
  await clickMap(page, at(map, inland));
  await expectError(page); // 공항은 평지에만
  await clickMap(page, at(map, flat));
  await expectOk(page);

  let j = await exportJson(page);
  expect(j.ports.map((p) => p.name)).toEqual(["하늬항"]);
  expect(j.facilities.map((f) => [f.kind, f.cell])).toEqual([["castle", castleAt], ["airport", flat]]);
  expect(j.facilities[0].name).toBe("검은성");

  await page.check('input[name="infraTool"][value="erase"]');
  await clickMap(page, at(map, castleAt));
  await expectOk(page);
  expect((await exportJson(page)).facilities.some((f) => f.kind === "castle")).toBe(false);
  await page.keyboard.press("Control+z");
  expect((await exportJson(page)).facilities.find((f) => f.kind === "castle")?.name).toBe("검은성");

  await page.reload();
  await expect(page.locator("#status")).toContainText("저장된 편집");
  j = await exportJson(page);
  expect(j.ports.map((p) => p.name)).toEqual(["하늬항"]);
  expect(j.facilities.map((f) => f.kind)).toEqual(["castle", "airport"]);
  expect(errors).toEqual([]);
});

test("항로는 바다로만 잇고, 항구를 옮기면 항로가 따라간다", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const map = await exportJson(page);
  const mesh = meshOf(map);
  const coasts = coastCells(map, mesh).filter((i) => farFromCities(map, i, 12));
  const west = coasts.filter((i) => map.cells[i].x < 450).sort((a, b) => map.cells[a].x - map.cells[b].x)[0];
  const east = coasts.filter((i) => map.cells[i].x > 950).sort((a, b) => map.cells[b].x - map.cells[a].x)[0];
  expect(west).toBeDefined();
  expect(east).toBeDefined();

  await enterInfraTool(page, "port");
  await clickMap(page, at(map, west));
  await clickMap(page, at(map, east));
  await expectOk(page);
  expect((await exportJson(page)).ports.map((p) => p.cell)).toEqual([west, east]);

  await page.check('input[name="infraTool"][value="sea"]');
  await dragMap(page, at(map, west), at(map, east));
  await expectOk(page);
  let j = await exportJson(page);
  expect(j.seaRoutes).toHaveLength(1);
  const route = j.seaRoutes[0];
  expect([route[0], route.at(-1)]).toEqual([west, east]);
  expect(route.slice(1, -1).every((c) => j.cells[c].elevation <= 0)).toBe(true);

  await dragMap(page, { x: 600, y: 400 }, at(map, east));
  await expectError(page); // 항구가 아닌 곳에서 시작

  // 동쪽 항구를 30px 이상 떨어진 가까운 다른 해안으로 옮긴다
  const moveTo = coasts.filter((i) => map.cells[i].x > 900 && dist(map, i, east) > 30)
    .sort((a, b) => dist(map, a, east) - dist(map, b, east))[0];
  await page.check('input[name="infraTool"][value="move"]');
  await dragMap(page, at(map, east), at(map, moveTo));
  await expectOk(page);
  j = await exportJson(page);
  expect(j.ports[1].cell).toBe(moveTo);
  expect(j.seaRoutes[0]?.at(-1)).toBe(moveTo);

  const inland = map.cells.findIndex((c, i) => isLand(map, i) && c.elevation > 0.4);
  await dragMap(page, at(map, moveTo), at(map, inland));
  await expectError(page);
  expect((await exportJson(page)).ports[1].cell).toBe(moveTo);

  await page.keyboard.press("Control+z");
  j = await exportJson(page);
  expect(j.ports[1].cell).toBe(east);
  expect(j.seaRoutes[0]?.at(-1)).toBe(east);
  expect(errors).toEqual([]);
});

test("다리·터널: 도로는 도로용, 철도는 철도용만 건너고 용도를 바꿀 수 있다", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const map = await exportJson(page);
  const mesh = meshOf(map);
  const comp = landComponents(map, mesh);
  const size = new Map<number, number>();
  for (const c of comp) if (c >= 0) size.set(c, (size.get(c) ?? 0) + 1);
  const mainland = [...size].sort((a, b) => b[1] - a[1])[0][0];
  const land = map.cells.map((_, i) => i).filter((i) => comp[i] >= 0);
  const mainCells = land.filter((i) => comp[i] === mainland);

  // 본토와 가장 가까운 섬(5셀 이상)으로 가는 다리 자리
  let best: { main: number; island: number; d: number } | undefined;
  for (const i of land) {
    if (comp[i] === mainland || size.get(comp[i])! < 5) continue;
    for (const k of mainCells) {
      const d = dist(map, i, k);
      if (d > 25 && (!best || d < best.d)) best = { main: k, island: i, d };
    }
  }
  expect(best, "본토 근처 섬이 있어야 한다").toBeDefined();
  const { main, island } = best!;
  const islandId = comp[island];
  // 같은 섬으로 가는 두 번째 다리 자리: 본토 쪽 끝을 25~60px 옆으로
  let alt: { main: number; island: number; d: number } | undefined;
  for (const i of land) {
    if (comp[i] !== islandId || i === island) continue;
    for (const k of mainCells) {
      const d = dist(map, i, k), off = dist(map, k, main);
      if (d > 25 && d < 160 && off > 25 && off < 60 && (!alt || d < alt.d)) alt = { main: k, island: i, d };
    }
  }
  expect(alt).toBeDefined();
  const islandFar = land.filter((i) => comp[i] === islandId).sort((a, b) => dist(map, b, main) - dist(map, a, main))[0];
  const city = map.cities.reduce((a, c) => (Math.hypot(c.x - map.cells[main].x, c.y - map.cells[main].y)
    < Math.hypot(a.x - map.cells[main].x, a.y - map.cells[main].y) ? c : a));

  await enterInfraTool(page, "bridge");
  await expect(page.locator("#spanMode")).toBeVisible();
  await page.selectOption("#spanMode", "road");
  await dragMap(page, at(map, main), at(map, island));
  await expectOk(page);

  await page.check('input[name="infraTool"][value="road"]');
  await dragMap(page, city, at(map, islandFar));
  await expectOk(page);
  let j = await exportJson(page);
  const roadBridge = j.bridges.find((b) => b.mode === "road");
  expect(crosses(j.infra?.roads?.at(-1), roadBridge)).toBe(true);

  await page.check('input[name="infraTool"][value="rail"]');
  await dragMap(page, city, at(map, islandFar));
  await expectError(page); // 철도는 도로용 다리를 건너지 못한다

  await page.check('input[name="infraTool"][value="bridge"]');
  await page.selectOption("#spanMode", "rail");
  await dragMap(page, at(map, alt!.main), at(map, alt!.island));
  await expectOk(page);
  await page.check('input[name="infraTool"][value="rail"]');
  await dragMap(page, city, at(map, islandFar));
  await expectOk(page);
  j = await exportJson(page);
  const railBridge = j.bridges.find((b) => b.mode === "rail");
  expect(crosses(j.rails[0], railBridge)).toBe(true);
  expect(crosses(j.rails[0], roadBridge)).toBe(false);

  // 용도 전환: 도로용 다리를 철도용으로
  await page.check('input[name="infraTool"][value="toggleMode"]');
  await clickMap(page, { x: (map.cells[main].x + map.cells[island].x) / 2, y: (map.cells[main].y + map.cells[island].y) / 2 });
  await expectOk(page);
  expect((await exportJson(page)).bridges.map((b) => b.mode)).toEqual(["rail", "rail"]);
  await page.keyboard.press("Control+z");
  expect((await exportJson(page)).bridges.map((b) => b.mode)).toEqual(["road", "rail"]);

  // 육지끼리 다리는 거부, 산을 관통하는 터널은 허용
  const flatA = land.find((i) => map.cells[i].elevation > 0.1 && map.cells[i].elevation < 0.2)!;
  const flatB = land.find((i) => i !== flatA && map.cells[i].elevation > 0 && dist(map, i, flatA) > 25 && dist(map, i, flatA) < 40)!;
  await page.check('input[name="infraTool"][value="bridge"]');
  await dragMap(page, at(map, flatA), at(map, flatB));
  await expectError(page);

  const peak = land.reduce((a, b) => (map.cells[b].elevation > map.cells[a].elevation ? b : a));
  const side = (dir: 1 | -1) => land.filter((i) => map.cells[i].elevation < 0.35
    && Math.abs(map.cells[i].y - map.cells[peak].y) < 25 && dir * (map.cells[i].x - map.cells[peak].x) > 30)
    .sort((a, b) => dir * (map.cells[a].x - map.cells[b].x))[0];
  await page.check('input[name="infraTool"][value="tunnel"]');
  await dragMap(page, at(map, side(-1)), at(map, side(1)));
  await expectOk(page);

  await page.reload();
  await expect(page.locator("#status")).toContainText("저장된 편집");
  j = await exportJson(page);
  expect(j.bridges.map((b) => b.mode)).toEqual(["road", "rail"]);
  expect(j.tunnels).toHaveLength(1);
  expect(errors).toEqual([]);
});
