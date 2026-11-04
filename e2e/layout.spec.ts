import { test, expect, devices } from "@playwright/test";
import { collectErrors, enterInfraFacilityTool, exportJson, mapToScreen, openApp, pickLandCell } from "./helpers.ts";

// 화면 폭·배율을 테스트마다 직접 정하므로 고해상도 프로젝트에서는 돌리지 않는다 (playwright.config.ts의 testIgnore).

const rects = () => {
  const r = (id: string) => {
    const b = document.getElementById(id)!.getBoundingClientRect();
    return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) };
  };
  return { map: r("map"), overlay: r("overlay"), zoomIn: r("zoomIn"), hscroll: document.documentElement.scrollWidth > innerWidth };
};

for (const [width, below] of [[390, true], [600, true], [700, false], [1440, false]] as const) {
  test(`폭 ${width}px: 확대 버튼이 ${below ? "지도 아래" : "지도 위"}에 있다`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: below, hasTouch: below });
    const page = await ctx.newPage();
    await openApp(page);
    const r = await page.evaluate(rects);
    expect(r.overlay).toEqual(r.map);
    expect(r.hscroll).toBe(false);
    if (below) expect(r.zoomIn.t).toBeGreaterThanOrEqual(r.map.b);
    else expect(r.zoomIn.b).toBeLessThanOrEqual(r.map.b);
    await ctx.close();
  });
}

test("휴대폰: 버튼 탭으로 확대, 지도 탭으로 정확한 칸에 시설 배치", async ({ browser, browserName }) => {
  const ctx = await browser.newContext({ ...devices[browserName === "webkit" ? "iPhone 13" : "Pixel 7"] });
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  await openApp(page);
  await page.tap("#zoomIn");
  await expect(page.locator("#zoomLevel")).toHaveText("150%");
  await page.tap("#zoomReset");
  await expect(page.locator("#zoomLevel")).toHaveText("100%");

  await enterInfraFacilityTool(page);
  const map = await exportJson(page);
  const target = pickLandCell(map, 1 / 3);
  const [x, y] = await mapToScreen(page, map.cells[target].x, map.cells[target].y);
  await page.touchscreen.tap(x, y);
  await expect.poll(async () => (await exportJson(page)).infra?.facilities?.at(-1)?.cell).toBe(target);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("창 크기를 줄이면 캔버스 해상도가 따라가고 배치 좌표도 맞다", async ({ page }) => {
  await openApp(page);
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(() => page.evaluate(() => {
    const c = document.getElementById("map") as HTMLCanvasElement;
    return c.width === Math.round(c.getBoundingClientRect().width * devicePixelRatio);
  })).toBe(true);

  await enterInfraFacilityTool(page);
  const map = await exportJson(page);
  const target = pickLandCell(map, 1 / 3);
  const [x, y] = await mapToScreen(page, map.cells[target].x, map.cells[target].y);
  await page.mouse.click(x, y);
  await expect.poll(async () => (await exportJson(page)).infra?.facilities?.at(-1)?.cell).toBe(target);
});
