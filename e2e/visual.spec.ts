import { test, expect, type Page } from "@playwright/test";
import { openApp } from "./helpers.ts";

/*
 * 시각 회귀: 고정 시드 지도의 캔버스 픽셀(기기 해상도 그대로)을 기준 이미지와 비교한다.
 * - 지명 글자는 웹 글꼴 로딩 여부·OS 글꼴에 따라 픽셀이 달라지므로 지명 레이어를 끄고 도형만 비교한다.
 * - 화면 요소(확대 버튼 등)가 섞이지 않게 페이지 스크린샷이 아니라 캔버스 내용을 직접 읽는다.
 * 기준 이미지는 Linux Chromium(@playwright/test 고정 버전)으로 만든다. 렌더링을 의도적으로 바꿨다면
 *   npx playwright test e2e/visual.spec.ts --update-snapshots
 * 로 다시 만들고 바뀐 이미지를 함께 커밋한다.
 */

test.skip(process.platform !== "linux", "기준 이미지는 Linux(CI와 같은 환경)에서만 비교한다");

async function openForSnapshot(page: Page, hash = ""): Promise<void> {
  // 웹 글꼴을 막아 실행 환경과 관계없이 같은 조건에서 그린다 (앱은 글꼴을 최대 2.5초 기다린 뒤 진행).
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await openApp(page, hash ? `./#${hash}` : "./");
  await page.uncheck('[data-layer="labels"]');
}

/**
 * 캔버스가 더 바뀌지 않을 때(확대 뒤 선명하게 다시 그리기까지 끝난 뒤)의 PNG.
 * crop: 캔버스 기기 픽셀 기준 [x, y, w, h] 부분만 (기준 이미지 용량을 줄일 때).
 */
async function canvasPng(page: Page, crop?: [number, number, number, number]): Promise<Buffer> {
  const read = () => page.evaluate((c) => {
    const map = document.getElementById("map") as HTMLCanvasElement;
    if (!c) return map.toDataURL("image/png");
    const out = document.createElement("canvas");
    [out.width, out.height] = [c[2], c[3]];
    out.getContext("2d")!.drawImage(map, c[0], c[1], c[2], c[3], 0, 0, c[2], c[3]);
    return out.toDataURL("image/png");
  }, crop);
  let prev = await read();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(200);
    const next = await read();
    if (next === prev) return Buffer.from(next.split(",")[1], "base64");
    prev = next;
  }
  throw new Error("캔버스가 4초 동안 계속 바뀌었습니다.");
}

// 다른 CPU에서 생기는 안티에일리어싱 차이 정도만 허용한다 (해안선 굵기 1.2→2px 같은 변화는 잡힌다).
const opts = { maxDiffPixelRatio: 0.001, threshold: 0.1 };

test("기본 지도 (청운)", async ({ page }, info) => {
  await openForSnapshot(page);
  // 고해상도는 기기 픽셀이 4배라 가운데 일부만 비교한다 (선명도·좌표 배율 확인에는 충분하다).
  const crop = info.project.name === "desktop" ? undefined : [700, 450, 800, 560] as [number, number, number, number];
  expect(await canvasPng(page, crop)).toMatchSnapshot("default.png", opts);
});

test("군도 지형, 음영 끄고 국가 색", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "고해상도 기준 이미지는 기본 지도 하나만 둔다");
  await openForSnapshot(page, "seed=백야-2024&shape=archipelago&cells=12000");
  await page.uncheck('[data-layer="relief"]');
  await page.check('[data-layer="stateTint"]');
  expect(await canvasPng(page)).toMatchSnapshot("archipelago-tint.png", opts);
});

test("확대 상태 (가운데 기준 338%)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "고해상도 기준 이미지는 기본 지도 하나만 둔다");
  await openForSnapshot(page);
  for (let i = 0; i < 3; i++) await page.click("#zoomIn");
  await expect(page.locator("#zoomLevel")).toHaveText("338%");
  expect(await canvasPng(page)).toMatchSnapshot("zoomed.png", opts);
});
