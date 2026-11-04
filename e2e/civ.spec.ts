import { test, expect, type Page } from "@playwright/test";
import { collectErrors, exportJson, mapToScreen, openApp } from "./helpers.ts";

async function clickMap(page: Page, mx: number, my: number): Promise<void> {
  const [x, y] = await mapToScreen(page, mx, my);
  await page.mouse.click(x, y);
}

test("도시 이동·이름 바꾸기·추가, 수도는 지울 수 없음", async ({ page }) => {
  const errors = collectErrors(page);
  let nextName = "";
  page.on("dialog", (d) => void (d.type() === "prompt" ? d.accept(nextName) : d.accept()));
  await page.goto("./");
  await expect(page.locator("#status")).toContainText("셀");
  const start = await exportJson(page);
  const town = start.cities.find((c) => !c.capital);
  if (!town) throw new Error("일반 도시가 없습니다.");

  await page.keyboard.press("e");
  await page.click('[role="tab"][data-target="city"]');

  // 이동: 끌어서 놓는다
  const [sx, sy] = await mapToScreen(page, town.x, town.y);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(sx + k * 3, sy + k * 3);
  await page.mouse.up();
  let j = await exportJson(page);
  const moved = j.cities.find((c) => c.name === town.name);
  expect(moved).toBeDefined();
  expect(Math.hypot(moved!.x - town.x, moved!.y - town.y)).toBeGreaterThan(5);

  // 이름 바꾸기
  await page.check('input[name="cityTool"][value="rename"]');
  nextName = "테스트성";
  await clickMap(page, moved!.x, moved!.y);
  await expect.poll(async () => (await exportJson(page)).cities.some((c) => c.name === "테스트성")).toBe(true);

  // 추가: 다른 도시와 떨어진 육지
  j = await exportJson(page);
  await page.check('input[name="cityTool"][value="add"]');
  const spot = j.cells.find((c) => c.elevation > 0.05 && c.biome !== "lake"
    && j.cities.every((city) => Math.hypot(city.x - c.x, city.y - c.y) > 60));
  if (!spot) throw new Error("빈 육지가 없습니다.");
  await clickMap(page, spot.x, spot.y);
  await expect.poll(async () => (await exportJson(page)).cities.length).toBe(j.cities.length + 1);

  // 수도 삭제는 거부
  const capital = start.cities.find((c) => c.capital)!;
  await page.check('input[name="cityTool"][value="delete"]');
  await clickMap(page, capital.x, capital.y);
  await expect(page.locator("#status")).toHaveClass(/error/);
  expect((await exportJson(page)).cities.some((c) => c.name === capital.name)).toBe(true);
  expect(errors).toEqual([]);
});

test("국경 칠하기와 되돌리기", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  let j = await exportJson(page);
  const owned = (m: typeof j) => m.cells.filter((c) => c.state === 0).length;
  const before = owned(j);
  const target = j.cells.find((c) => c.state === 1 && c.elevation > 0.05);
  if (!target) throw new Error("두 번째 국가의 육지가 없습니다.");

  await page.keyboard.press("e");
  await page.click('[role="tab"][data-target="border"]');
  await page.selectOption("#paintState", "0");
  const [sx, sy] = await mapToScreen(page, target.x, target.y);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 0; k < 8; k++) await page.mouse.move(sx + k * 4, sy);
  await page.mouse.up();
  j = await exportJson(page);
  expect(owned(j)).toBeGreaterThan(before);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => owned(await exportJson(page))).toBe(before);
  expect(errors).toEqual([]);
});
