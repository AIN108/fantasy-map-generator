import { test, expect } from "@playwright/test";
import { clickMap, collectErrors, expectError, expectOk, exportJson, isLand, mapToScreen, openApp } from "./helpers.ts";

const water = (map: Awaited<ReturnType<typeof exportJson>>, cell: number) => !isLand(map, cell);

test("자원이 지형 규칙대로 자동 배치되고, 범례 개수가 맞고, 레이어로 끌 수 있다", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const map = await exportJson(page);
  expect(map.resources.length).toBeGreaterThan(100);
  expect(new Set(map.resources.map((r) => r.category))).toEqual(new Set(["strategic", "luxury", "bonus"]));
  for (const r of map.resources) {
    if (r.kind === "fish" || r.kind === "pearls") expect(water(map, r.cell), `${r.name}@${r.cell}`).toBe(true);
    else if (r.kind !== "oil") expect(water(map, r.cell), `${r.name}@${r.cell}`).toBe(false);
    expect(r.amount !== undefined).toBe(r.category === "strategic");
  }

  const legend = page.locator("#resourceLegend");
  await expect(legend).toBeVisible();
  const counts = await legend.locator("span[data-kind]").allTextContents();
  const total = counts.reduce((sum, t) => sum + Number(t.match(/(\d+)$/)?.[1] ?? 0), 0);
  expect(total).toBe(map.resources.length);

  // 자원이 있는 칸 위에 마우스를 올리면 셀 정보에 나온다
  const target = map.resources.find((r) => r.category === "strategic")!;
  const [x, y] = await mapToScreen(page, target.x, target.y);
  await page.mouse.move(x, y);
  await expect(page.locator("#cellInfo")).toContainText(`${target.name} (전략 자원 · 매장량 ${target.amount})`);

  await page.uncheck('[data-layer="resources"]');
  await expect(legend).toBeHidden();
  await page.check('[data-layer="resources"]');
  await expect(legend).toBeVisible();
  expect(errors).toEqual([]);
});

test("자원 탭: 놓기·바꾸기·지우기·되돌리기, 새로고침과 JSON 왕복에서 유지", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const map = await exportJson(page);
  const taken = new Set(map.resources.map((r) => r.cell));
  const far = (i: number) => map.resources.every((r) => Math.hypot(r.x - map.cells[i].x, r.y - map.cells[i].y) > 20)
    && map.cities.every((c) => Math.hypot(c.x - map.cells[i].x, c.y - map.cells[i].y) > 20);
  const land = map.cells.findIndex((c, i) => isLand(map, i) && c.elevation < 0.4 && far(i));
  const auto = map.resources.find((r) => r.kind === "wood" && map.cities.every((c) => Math.hypot(c.x - r.x, c.y - r.y) > 20))!;
  expect(land).toBeGreaterThanOrEqual(0);
  expect(taken.has(land)).toBe(false);

  await page.locator("#editMode").check();
  await page.click('[role="tab"][data-target="resource"]');
  await expect(page.locator("#resourceKind")).toBeVisible();
  await page.selectOption("#resourceKind", "coal");
  await expect(page.locator("#resourceAmountField")).toBeVisible();
  // 숫자를 입력하는 동안에는 단축키(0: 맞춤, e: 편집 모드)가 동작하지 않는다
  await page.click("#zoomIn");
  await page.locator("#resourceAmount").fill("");
  await page.locator("#resourceAmount").pressSequentially("10");
  await expect(page.locator("#zoomLevel")).toHaveText("150%");
  await expect(page.locator("#editMode")).toBeChecked();
  await page.click("#zoomReset");

  await clickMap(page, map.cells[land]);
  await expectOk(page);
  await page.selectOption("#resourceKind", "fish");
  await expect(page.locator("#resourceAmountField")).toBeHidden();
  await clickMap(page, map.cells[land]);
  await expectError(page); // 어장은 육지에 둘 수 없다
  await page.selectOption("#resourceKind", "gold");
  await clickMap(page, auto);
  await expectOk(page);
  await expect(page.locator("#status")).toContainText("목재를 금(으)로 바꿨습니다");

  let j = await exportJson(page);
  expect(j.resources.find((r) => r.cell === land)).toMatchObject({ kind: "coal", amount: 10 });
  expect(j.resources.find((r) => r.cell === auto.cell)?.kind).toBe("gold");
  expect(j.resourceEdits?.added).toHaveLength(2);

  await page.check('input[name="resourceTool"][value="erase"]');
  await expect(page.locator("#resourceKindField")).toBeHidden();
  await clickMap(page, map.cells[land]);
  await expect(page.locator("#status")).toContainText("석탄을 지웠습니다");
  expect((await exportJson(page)).resources.some((r) => r.cell === land)).toBe(false);
  await page.keyboard.press("Control+z");
  expect((await exportJson(page)).resources.find((r) => r.cell === land)?.kind).toBe("coal");

  await page.reload();
  await expect(page.locator("#status")).toContainText("저장된 편집");
  j = await exportJson(page);
  expect(j.resources.find((r) => r.cell === land)).toMatchObject({ kind: "coal", amount: 10 });

  // JSON으로 저장했다가 다른 지도를 만든 뒤 불러오면 편집이 돌아온다
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportJson")]);
  const path = await dl.path();
  await page.click('[role="tab"][data-target="resource"]'); // 새로고침하면 지형 탭으로 돌아간다
  await page.click("#resetResources");
  expect((await exportJson(page)).resources.find((r) => r.cell === auto.cell)?.kind).toBe("wood");
  await page.setInputFiles("#importFile", path);
  await expect(page.locator("#status")).toContainText("직접 편집한 자원");
  j = await exportJson(page);
  expect(j.resources.find((r) => r.cell === auto.cell)?.kind).toBe("gold");
  expect(errors).toEqual([]);
});
