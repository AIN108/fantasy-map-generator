import { test, expect } from "@playwright/test";
import { collectErrors, exportJson, openApp } from "./helpers.ts";

test("도시 검색으로 확대하고 이름을 고치면 검색 결과가 갱신된다", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const before = await exportJson(page);
  const city = before.cities[0];
  await page.selectOption("#placeCategory", "city");
  await page.fill("#placeQuery", city.name);
  await page.locator("#placeResults button").first().click();
  await expect(page.locator("#zoomLevel")).toHaveText("300%");
  await expect(page.locator("#map")).toBeFocused();
  await expect(page.locator("#status")).toContainText(city.name);
  expect((await exportJson(page)).cities).toEqual(before.cities);
  await expect(page.locator("#undo")).toBeDisabled();

  await page.check("#editMode");
  await page.getByRole("tab", { name: "도시", exact: true }).click();
  await page.check('input[name="cityTool"][value="rename"]');
  // 이름 바꾸기는 지도 클릭으로 실행한다. 확대를 풀어 좌표를 맞춘다.
  await page.click("#zoomReset");
  const box = (await page.locator("#map").boundingBox())!;
  page.removeAllListeners("dialog");
  page.once("dialog", (d) => void d.accept("검색 시험 도시"));
  await page.mouse.click(box.x + city.x / before.options.width * box.width, box.y + city.y / before.options.height * box.height);
  await page.fill("#placeQuery", "검색 시험 도시");
  await expect(page.locator("#placeResults button")).toHaveCount(1);
  await expect(page.locator("#placeResults button")).toContainText("검색 시험 도시");
  expect(errors).toEqual([]);
});

test("검색 단축키·결과 이동·빈 결과·초기화가 편집 단축키와 충돌하지 않는다", async ({ page }) => {
  await openApp(page);
  await page.locator("#map").focus();
  await page.keyboard.press("/");
  await expect(page.locator("#placeQuery")).toBeFocused();
  await page.selectOption("#placeCategory", "state");
  await page.locator("#placeQuery").press("ArrowDown");
  await expect(page.locator("#placeResults button").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#placeResults button").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#placeQuery")).toBeFocused();
  await page.fill("#placeQuery", "없는 장소 e+0");
  await expect(page.locator("#placeCount")).toContainText("검색 결과가 없습니다");
  await expect(page.locator("#editMode")).not.toBeChecked();
  await page.locator("#placeQuery").press("Escape");
  await expect(page.locator("#placeCategory")).toHaveValue("all");
  await expect(page.locator("#placeResults")).toBeHidden();
});

test("좁은 화면에서도 검색 칸·결과·초기화가 화면 안에 들어간다", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openApp(page);
  await page.selectOption("#placeCategory", "city");
  for (const selector of ["#placeQuery", "#placeCategory", "#placeClear", "#placeResults"]) {
    const box = (await page.locator(selector).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }
  await page.locator("#placeResults button").first().click();
  await expect(page.locator("#zoomLevel")).toHaveText("300%");
});
