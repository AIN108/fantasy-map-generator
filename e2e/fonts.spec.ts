import { test, expect } from "@playwright/test";
import { collectErrors, openApp } from "./helpers.ts";

test("한글 글꼴 파일이 첫 그리기 뒤에 도착해도 지도를 다시 그려, 마지막 그림의 지명은 모두 제 글꼴이다", async ({ page }) => {
  const errors = collectErrors(page);
  // 지도 캔버스에 한글 지명을 그릴 때마다, 그 글꼴의 글자 파일이 준비돼 있었는지를 프레임 번호와 함께 남긴다.
  await page.addInitScript(() => {
    const w = window as unknown as { __frame: number; __labels: { f: number; ready: boolean }[] };
    w.__frame = 0;
    w.__labels = [];
    const tick = (): void => { w.__frame++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth?: number) {
      if (/[가-힣]/.test(text) && /Noto/.test(this.font) && this.canvas.id === "map") w.__labels.push({ f: w.__frame, ready: document.fonts.check(this.font, text) });
      return maxWidth === undefined ? orig.call(this, text, x, y) : orig.call(this, text, x, y, maxWidth);
    };
  });
  await openApp(page);
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.waitForTimeout(500); // 마지막 글꼴 도착 뒤 다음 프레임의 다시 그리기까지
  const r = await page.evaluate(() => {
    const labels = (window as unknown as { __labels: { f: number; ready: boolean }[] }).__labels;
    const last = Math.max(...labels.map((l) => l.f));
    const inLast = labels.filter((l) => l.f === last);
    return { total: inLast.length, notReady: inLast.filter((l) => !l.ready).length };
  });
  expect(r.total).toBeGreaterThan(10);
  expect(r.notReady, `마지막 그림에서 글꼴이 준비 안 된 지명 ${r.notReady}/${r.total}개`).toBe(0);
  expect(errors).toEqual([]);
});
