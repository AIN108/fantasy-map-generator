import { test, expect, devices } from "@playwright/test";
import { collectErrors, mapToScreen, openApp } from "./helpers.ts";

test.describe("터치", () => {
  test("지도를 누르면 셀 정보가 나오고, 두 번 누르면 그 자리가 2배로 확대된다", async ({ browser, browserName }) => {
    const ctx = await browser.newContext({ ...devices[browserName === "webkit" ? "iPhone 13" : "Pixel 7"] });
    const page = await ctx.newPage();
    const errors = collectErrors(page);
    await openApp(page);
    await expect(page.locator("#cellInfo")).toContainText("안내");
    const [x, y] = await mapToScreen(page, 600, 400);
    await page.touchscreen.tap(x, y);
    await expect(page.locator("#cellInfo")).not.toContainText("안내");
    await expect(page.locator("#cellInfo dt")).not.toHaveCount(1);
    await expect(page.locator("#zoomLevel")).toHaveText("100%");
    await page.touchscreen.tap(x, y);
    await expect(page.locator("#zoomLevel")).toHaveText("200%");
    // 확대한 자리의 셀이 손가락 아래에 남는다: 같은 자리를 다시 누르면 같은 셀 정보
    const first = await page.locator("#cellInfo").innerText();
    await page.waitForTimeout(500); // 두 번 누르기로 세지 않게
    await page.touchscreen.tap(x, y);
    await expect(page.locator("#cellInfo")).toHaveText(first);
    await expect(page.locator("#zoomLevel")).toHaveText("200%");
    expect(errors).toEqual([]);
    await ctx.close();
  });

  test("두 손가락으로 짧게 누르면 한 단계 축소된다", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "두 손가락 입력은 Chromium CDP로만 흉내 낼 수 있다");
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await openApp(page);
    await page.tap("#zoomIn");
    await page.tap("#zoomIn");
    await expect(page.locator("#zoomLevel")).toHaveText("225%");
    const box = (await page.locator("#map").boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const cdp = await ctx.newCDPSession(page);
    const two = [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: two });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator("#zoomLevel")).toHaveText("150%");
    await ctx.close();
  });
});
