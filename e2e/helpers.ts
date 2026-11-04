import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

/** 지도 좌표계 크기 (옵션 기본값). 화면 좌표 변환에 쓴다. */
export const MAP_W = 1200;
export const MAP_H = 800;

export interface ExportedCell { x: number; y: number; elevation: number; biome: string; state: number }
export interface ExportedCity { name: string; x: number; y: number; capital: boolean; state: number }
export interface ExportedMap {
  format: string;
  cells: ExportedCell[];
  cities: ExportedCity[];
  states: { name: string; cellCount: number }[];
  infra?: { facilities?: { cell: number }[] };
}

/** 페이지에서 난 오류를 모은다. 테스트 끝에 비어 있는지 확인한다. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text());
  });
  return errors;
}

/** 첫 지도가 생성될 때까지 연다. 확인 창은 모두 수락한다. */
export async function openApp(page: Page): Promise<void> {
  page.on("dialog", (d) => void d.accept());
  await page.goto("./");
  await expect(page.locator("#status")).toContainText("셀");
}

export async function exportJson(page: Page): Promise<ExportedMap> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportJson")]);
  return JSON.parse(await readFile(await dl.path(), "utf8")) as ExportedMap;
}

/** 지도 좌표 (mx, my)의 화면 좌표. 보기가 전체(100%)일 때만 맞다. */
export async function mapToScreen(page: Page, mx: number, my: number): Promise<[number, number]> {
  await page.locator("#map").scrollIntoViewIfNeeded();
  const box = await page.locator("#map").boundingBox();
  if (!box) throw new Error("지도 캔버스가 보이지 않습니다.");
  return [box.x + (mx / MAP_W) * box.width, box.y + (my / MAP_H) * box.height];
}

/** 시설을 놓기 좋은 평지 셀 (호수 제외). 결정적이도록 인덱스 순서에서 고른다. */
export function pickLandCell(map: ExportedMap, fraction = 0.5): number {
  const land = map.cells
    .map((_, i) => i)
    .filter((i) => map.cells[i].elevation > 0.05 && map.cells[i].elevation < 0.3 && map.cells[i].biome !== "lake");
  if (land.length === 0) throw new Error("평지 셀이 없습니다.");
  return land[Math.floor(land.length * fraction)];
}

export async function enterInfraFacilityTool(page: Page): Promise<void> {
  await page.locator("#editMode").check();
  await page.click('[role="tab"][data-target="infra"]');
  await page.check('input[name="infraTool"][value="facility"]');
}

export const facilityCount = (map: ExportedMap): number => map.infra?.facilities?.length ?? 0;
