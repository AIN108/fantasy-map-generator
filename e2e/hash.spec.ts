import { test, expect } from "@playwright/test";
import { collectErrors, exportJson, mapToScreen, openApp } from "./helpers.ts";

test("열린 탭에 다른 옵션의 링크를 붙여 넣으면 그 옵션으로 다시 만든다", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await page.evaluate(() => { location.hash = "#seed=해시시험&states=4"; });
  await expect(page.locator("#seed")).toHaveValue("해시시험");
  await expect(page.locator("#states")).toHaveValue("4");
  const j = await exportJson(page);
  expect(j.options.seed).toBe("해시시험");
  expect(j.states.length).toBeLessThanOrEqual(4);
  // 범위를 벗어난 링크는 만들지 않고 주소를 되돌린다
  await page.evaluate(() => { location.hash = "#seed=해시시험&states=999"; });
  await expect(page.locator("#status")).toContainText("국가 수");
  await expect(page.locator("#states")).toHaveValue("4");
  expect(decodeURIComponent(page.url())).toContain("states=4");
  expect(errors).toEqual([]);
});

test("편집한 지도를 링크로 복사해 새 브라우저에서 열면 같은 지형·도시가 된다", async ({ page, browser }) => {
  const errors = collectErrors(page);
  // 클립보드 대신 복사한 글을 받아 둔다
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { (window as unknown as { copied: string }).copied = t; } } });
  });
  await openApp(page);
  await page.keyboard.press("e");
  await page.check('input[name="tool"][value="raise"]');
  const [sx, sy] = await mapToScreen(page, 150, 680);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 0; k < 30; k++) await page.mouse.move(sx + Math.cos(k / 5) * 25, sy + Math.sin(k / 5) * 25);
  await page.mouse.up();
  await expect(page.locator("#undo")).toBeEnabled();
  const original = await exportJson(page);

  await page.click("#copyLink");
  await expect(page.locator("#status")).toContainText("편집한 지형");
  const link = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  expect(link).toMatch(/&e=[A-Za-z0-9_-]+$/);

  const other = await browser.newContext();
  const page2 = await other.newPage();
  const errors2 = collectErrors(page2);
  await page2.goto(link); // 새 브라우저라 저장된 편집이 없어 묻지 않는다
  await expect(page2.locator("#status")).toContainText("링크에 담긴 편집 지도를 열었습니다");
  const opened = await exportJson(page2);
  expect(opened.cells.map((c) => c.elevation)).toEqual(original.cells.map((c) => c.elevation));
  expect(opened.cities).toEqual(original.cities);
  expect(page2.url()).not.toContain("&e=");
  await other.close();
  expect(errors).toEqual([]);
  expect(errors2).toEqual([]);
});
