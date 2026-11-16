import { test, expect, devices } from "@playwright/test";
import { collectErrors, mapToScreen, openApp } from "./helpers.ts";
import type { Page } from "@playwright/test";

/** 화면 (x, y)에 마우스를 올렸을 때의 셀 정보 (확대·이동을 반영한 실제 셀) */
async function infoAt(page: Page, x: number, y: number): Promise<string> {
  await page.mouse.move(x + 3, y + 3);
  await page.mouse.move(x, y);
  return page.locator("#cellInfo").innerText();
}

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

test.describe("마우스", () => {
  test("편집 모드가 아닐 때 더블클릭은 그 자리 확대, Shift+더블클릭은 축소", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    const [x, y] = await mapToScreen(page, 300, 200);
    const before = await infoAt(page, x, y);
    await page.mouse.dblclick(x, y);
    await expect(page.locator("#zoomLevel")).toHaveText("200%");
    expect(await infoAt(page, x, y)).toBe(before); // 커서 아래 셀은 그대로
    await page.keyboard.down("Shift");
    await page.mouse.dblclick(x, y);
    await page.keyboard.up("Shift");
    await expect(page.locator("#zoomLevel")).toHaveText("100%");
    // 편집 중에는 확대하지 않는다
    await page.keyboard.press("e");
    await page.check('input[name="tool"][value="smooth"]');
    await page.mouse.dblclick(x, y);
    await expect(page.locator("#zoomLevel")).toHaveText("100%");
    expect(errors).toEqual([]);
  });

  test("편집 중 Shift+휠은 브러시 크기를 바꾸고 지도는 확대하지 않는다", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("e");
    const [x, y] = await mapToScreen(page, 600, 400);
    await page.mouse.move(x, y);
    await expect(page.locator("#brushSize")).toHaveValue("45");
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Shift");
    await expect(page.locator("#brushSize")).toHaveValue("55");
    await expect(page.locator("#brushSizeOut")).toHaveText("55px");
    await expect(page.locator("#zoomLevel")).toHaveText("100%");
    await page.mouse.wheel(0, -100); // Shift 없이는 그대로 확대
    await expect(page.locator("#zoomLevel")).not.toHaveText("100%");
  });
});

test.describe("키보드", () => {
  test("방향키로 확대한 지도를 옮기고, 목록에서는 방향키를 가로채지 않는다", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    const [x, y] = await mapToScreen(page, 600, 400);
    await page.locator("#map").focus();
    const at100 = await infoAt(page, x, y);
    await page.keyboard.press("ArrowRight"); // 100%에서는 옮길 곳이 없어 아무것도 하지 않는다
    expect(await infoAt(page, x, y)).toBe(at100);
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    const zoomed = await infoAt(page, x, y);
    await page.keyboard.press("ArrowRight");
    const moved = await infoAt(page, x, y);
    expect(moved).not.toBe(zoomed); // 같은 화면 자리에 다른 셀
    await page.keyboard.press("ArrowLeft");
    expect(await infoAt(page, x, y)).toBe(zoomed); // 되돌아오면 같은 셀
    await page.keyboard.press("Shift+ArrowDown");
    expect(await infoAt(page, x, y)).not.toBe(zoomed);
    // 목록(select)에 포커스가 있으면 지도는 그대로 (목록이 방향키를 쓴다)
    const fixed = await infoAt(page, x, y);
    await page.locator("#shape").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await infoAt(page, x, y)).toBe(fixed);
    expect(errors).toEqual([]);
  });

  test("편집 중 [ ]는 브러시 크기, 1~4는 지형 도구, ?는 단축키 목록", async ({ page }) => {
    await openApp(page);
    await page.locator("#map").focus();
    await page.keyboard.press("e");
    await page.keyboard.press("]");
    await page.keyboard.press("]");
    await expect(page.locator("#brushSize")).toHaveValue("55");
    await page.keyboard.press("[");
    await expect(page.locator("#brushSize")).toHaveValue("50");
    await page.keyboard.press("3");
    await expect(page.locator('input[name="tool"][value="flatten"]')).toBeChecked();
    await page.keyboard.press("1");
    await expect(page.locator('input[name="tool"][value="raise"]')).toBeChecked();
    await page.keyboard.press("?");
    await expect(page.locator("#shortcutHelp")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#shortcutHelp")).toBeHidden();
    await page.click("#shortcutHelpOpen");
    await expect(page.locator("#shortcutHelp")).toBeVisible();
    await page.click("#shortcutHelpClose");
    await expect(page.locator("#shortcutHelp")).toBeHidden();
  });
});
