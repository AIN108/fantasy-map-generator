import { test, expect } from "@playwright/test";
import { collectErrors, exportJson, openApp } from "./helpers.ts";

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
