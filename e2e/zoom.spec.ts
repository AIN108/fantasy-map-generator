import { test, expect } from "@playwright/test";
import {
  collectErrors, enterInfraFacilityTool, exportJson, facilityCount, MAP_W, mapToScreen, openApp, pickLandCell,
} from "./helpers.ts";

test("버튼·키보드로 확대·축소하고 한계에서 버튼이 꺼진다", async ({ page }) => {
  await openApp(page);
  const level = page.locator("#zoomLevel");
  await expect(level).toHaveText("100%");
  await expect(page.locator("#zoomOut")).toBeDisabled();
  await page.click("#zoomIn");
  await expect(level).not.toHaveText("100%");
  await page.click("#zoomReset");
  await expect(level).toHaveText("100%");

  await page.locator("#map").hover();
  for (let i = 0; i < 12; i++) await page.keyboard.press("+");
  await expect(level).toHaveText("800%");
  await expect(page.locator("#zoomIn")).toBeDisabled();
  await page.keyboard.press("0");
  await expect(level).toHaveText("100%");
});

test("휠로 확대한 상태에서 누른 자리에 정확히 시설이 놓인다", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const map = await exportJson(page);
  const target = pickLandCell(map);
  const cell = map.cells[target];

  // 목표 지점 위에서 휠 확대: 커서 아래 지도점은 고정되므로 목표의 화면 위치는 그대로다
  const [tx, ty] = await mapToScreen(page, cell.x, cell.y);
  await page.mouse.move(tx, ty);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -250);
  await expect(page.locator("#zoomLevel")).not.toHaveText("100%");
  await expect(page.locator(".map-wrap")).toHaveClass(/zoomed/);

  await enterInfraFacilityTool(page);
  const box = (await page.locator("#map").boundingBox())!;
  const k = box.width / MAP_W;
  await page.mouse.click(box.x + cell.x * k, box.y + cell.y * k);
  await expect.poll(async () => facilityCount(await exportJson(page))).toBe(1);
  expect((await exportJson(page)).infra?.facilities?.at(-1)?.cell).toBe(target);
  expect(errors).toEqual([]);
});

test("편집 중 스페이스+드래그, 오른쪽 드래그는 이동만 하고 편집하지 않는다", async ({ page }) => {
  await openApp(page);
  await page.click("#zoomIn");
  await page.click("#zoomIn");
  await enterInfraFacilityTool(page);
  const [x, y] = await mapToScreen(page, 600, 400);

  const viewOf = () => page.evaluate(() => (document.getElementById("map") as HTMLCanvasElement).toDataURL().length);
  const before = await viewOf();
  // 스페이스는 커서가 지도 위에 있을 때만 이동 키로 쓰인다
  await page.mouse.move(x, y);
  await page.keyboard.down(" ");
  await expect(page.locator(".map-wrap")).toHaveClass(/pan-ready/);
  await page.mouse.down();
  await page.mouse.move(x + 150, y + 80, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up(" ");

  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x - 100, y, { steps: 5 });
  await page.mouse.up({ button: "right" });

  expect(facilityCount(await exportJson(page))).toBe(0);
  await expect(page.locator("#undo")).toBeDisabled();
  await expect.poll(viewOf).not.toBe(before);
});

test("지형 칠하기 도중 두 번째 손가락이 닿으면 편집이 취소되고 확대된다", async ({ page }) => {
  await openApp(page);
  await page.locator("#editMode").check();
  await page.click('[role="tab"][data-target="terrain"]');
  const elevBefore = (await exportJson(page)).cells.map((c) => c.elevation);
  await page.locator("#map").scrollIntoViewIfNeeded();
  const box = (await page.locator("#map").boundingBox())!;

  await page.evaluate(({ cx, cy }) => {
    const c = document.getElementById("map")!;
    const ev = (type: string, id: number, x: number, y: number) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: "touch", isPrimary: id === 1, button: 0, buttons: 1,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    }));
    ev("pointerdown", 1, cx - 40, cy);
    for (let i = 0; i < 5; i++) ev("pointermove", 1, cx - 40 + i * 3, cy);
    ev("pointerdown", 2, cx + 40, cy);
    for (let i = 1; i <= 8; i++) { ev("pointermove", 1, cx - 40 - i * 10, cy); ev("pointermove", 2, cx + 40 + i * 10, cy); }
    ev("pointerup", 2, cx + 120, cy);
    ev("pointerup", 1, cx - 120, cy);
  }, { cx: box.x + box.width / 2, cy: box.y + box.height / 2 });

  await expect(page.locator("#zoomLevel")).not.toHaveText("100%");
  await expect(page.locator("#undo")).toBeDisabled();
  expect((await exportJson(page)).cells.map((c) => c.elevation)).toEqual(elevBefore);
});
