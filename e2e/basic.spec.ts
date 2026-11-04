import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { collectErrors, exportJson, mapToScreen, openApp } from "./helpers.ts";

test("첫 화면에서 지도를 만들고, 캔버스 해상도가 화면 배율을 따른다", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const info = await page.evaluate(() => {
    const c = document.getElementById("map") as HTMLCanvasElement;
    const o = document.getElementById("overlay") as HTMLCanvasElement;
    return { css: c.getBoundingClientRect().width, w: c.width, h: c.height, ow: o.width, oh: o.height, dpr: devicePixelRatio };
  });
  expect(info.w).toBe(Math.round(info.css * info.dpr));
  expect(info.h).toBe(Math.round((info.w * 800) / 1200));
  expect([info.ow, info.oh]).toEqual([info.w, info.h]);
  await expect(page.locator("#legend span").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("JSON 내보내기를 다시 불러오면 같은 지도가 된다", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportJson")]);
  const path = await dl.path();
  const original = JSON.parse(await readFile(path, "utf8"));
  expect(original.format).toBe("fantasy-map/v1");

  await page.fill("#seed", "다른시드");
  await page.click("button.primary");
  await expect(page.locator("#status")).toContainText("셀");
  expect((await exportJson(page)).cities).not.toEqual(original.cities);

  await page.setInputFiles("#importFile", path);
  await expect(page.locator("#status")).toContainText("불러왔습니다");
  const reloaded = await exportJson(page);
  expect(reloaded.cities).toEqual(original.cities);
  expect(reloaded.cells.map((c) => c.elevation)).toEqual(original.cells.map((c: { elevation: number }) => c.elevation));
  expect(errors).toEqual([]);
});

test("지형 편집 → 되돌리기·다시 하기 → 새로고침 후 유지", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const before = (await exportJson(page)).cells.map((c) => c.elevation);

  await page.keyboard.press("e");
  await expect(page.locator("#editMode")).toBeChecked();
  await expect(page.locator("#undo")).toBeDisabled();
  await page.check('input[name="tool"][value="raise"]');
  const [sx, sy] = await mapToScreen(page, 150, 680);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * Math.PI * 4;
    await page.mouse.move(sx + Math.cos(a) * 25, sy + Math.sin(a) * 25);
  }
  await page.mouse.up();
  await expect(page.locator("#undo")).toBeEnabled();
  const edited = (await exportJson(page)).cells.map((c) => c.elevation);
  expect(edited).not.toEqual(before);

  await page.keyboard.press("Control+z");
  await expect(page.locator("#redo")).toBeEnabled();
  expect((await exportJson(page)).cells.map((c) => c.elevation)).toEqual(before);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator("#redo")).toBeDisabled();
  expect((await exportJson(page)).cells.map((c) => c.elevation)).toEqual(edited);

  await page.reload();
  await expect(page.locator("#status")).toContainText("저장된 편집");
  expect((await exportJson(page)).cells.map((c) => c.elevation)).toEqual(edited);
  expect(errors).toEqual([]);
});

test("나라 하나를 바다로 가라앉혀도 남은 지명은 그대로이고, 지명 스타일을 왕복해도 같다", async ({ page }) => {
  test.slow(); // 큰 붓으로 120번 칠하는 동안 매 프레임 지형을 다시 계산한다
  const errors = collectErrors(page);
  await openApp(page);
  const legend = async () => (await page.locator("#legend span").allTextContents()).join(" | ");
  const before = await legend();

  await page.keyboard.press("e");
  await page.check('input[name="tool"][value="lower"]');
  await page.locator("#brushSize").fill("120");
  await page.locator("#brushStrength").fill("1");
  await expect(page.locator("#brushSizeOut")).toHaveText("120px");
  // 시드 '청운' 지도 서쪽 국가 부근
  const [x, y] = await mapToScreen(page, 1200 * 0.16, 800 * 0.6);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let k = 0; k < 120; k++) await page.mouse.move(x + Math.cos(k) * 20, y + Math.sin(k) * 20);
  await page.mouse.up();
  await expect(page.locator("#undo")).toBeEnabled();
  const after = await legend();
  expect(after).not.toBe(before);
  // 가라앉지 않은 나라의 이름은 바뀌지 않는다
  const kept = after.split(" | ").filter((s) => before.includes(s.split(" · ")[0]));
  expect(kept.length).toBeGreaterThan(0);

  await page.keyboard.press("Control+z");
  await expect.poll(legend).toBe(before);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(legend).toBe(after);

  await page.selectOption("#nameStyle", "western");
  await expect.poll(legend).not.toBe(after);
  await page.selectOption("#nameStyle", "korean");
  await expect.poll(legend).toBe(after);
  expect(errors).toEqual([]);
});

test("PNG 저장은 보기 배율과 상관없이 원래 크기(1200×800)", async ({ page }) => {
  await openApp(page);
  await page.click("#zoomIn");
  await page.click("#zoomIn");
  await expect(page.locator("#zoomLevel")).not.toHaveText("100%");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportPng")]);
  const png = await readFile(await dl.path());
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 800]);
});
