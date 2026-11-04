import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { forEachNeighbor, type Mesh } from "../src/mesh.ts";
import { createMesh, type WorldOptions } from "../src/world.ts";

/** 지도 좌표계 크기 (옵션 기본값). 화면 좌표 변환에 쓴다. */
export const MAP_W = 1200;
export const MAP_H = 800;

export interface ExportedCell { x: number; y: number; elevation: number; biome: string; state: number }
export interface ExportedCity { name: string; cell: number; x: number; y: number; capital: boolean; coastal?: boolean; state: number }
export interface Span { a: number; b: number; mode: "road" | "rail" }
export interface ExportedMap {
  format: string;
  options: WorldOptions;
  cells: ExportedCell[];
  cities: ExportedCity[];
  states: { name: string; cellCount: number }[];
  roads: number[][];
  rails: number[][];
  seaRoutes: number[][];
  ports: { cell: number; name?: string }[];
  facilities: { cell: number; kind: string; name?: string }[];
  bridges: Span[];
  tunnels: Span[];
  resources: { cell: number; kind: string; name: string; category: string; amount?: number; x: number; y: number }[];
  resourceEdits?: { added: { cell: number; kind: string; amount?: number }[]; removed: number[] };
  infra?: {
    roads?: number[][]; rails?: number[][]; facilities?: { cell: number }[]; hiddenMarks?: unknown[];
  };
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
export async function openApp(page: Page, path = "./"): Promise<void> {
  page.on("dialog", (d) => void d.accept());
  await page.goto(path);
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

export const enterInfraFacilityTool = (page: Page): Promise<void> => enterInfraTool(page, "facility");

export const facilityCount = (map: ExportedMap): number => map.infra?.facilities?.length ?? 0;

/** 지도 좌표 (mx, my)를 누른다 (보기 100% 기준). */
export async function clickMap(page: Page, p: { x: number; y: number }): Promise<void> {
  const [x, y] = await mapToScreen(page, p.x, p.y);
  await page.mouse.click(x, y);
}

/** 지도 좌표 a에서 b까지 끌어 놓는다. */
export async function dragMap(page: Page, a: { x: number; y: number }, b: { x: number; y: number }, steps = 12): Promise<void> {
  const [ax, ay] = await mapToScreen(page, a.x, a.y);
  const [bx, by] = await mapToScreen(page, b.x, b.y);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  for (let k = 1; k <= steps; k++) await page.mouse.move(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
  await page.mouse.up();
}

/**
 * 내보낸 지도의 셀 이웃 정보. JSON에는 이웃이 없으므로 같은 옵션으로 메시를 다시 만든다
 * (메시는 시드·크기·셀 수로만 정해진다).
 */
export function meshOf(map: ExportedMap): Mesh {
  const mesh = createMesh(map.options);
  if (mesh.count !== map.cells.length) throw new Error(`메시 셀 수 ${mesh.count} ≠ JSON 셀 수 ${map.cells.length}`);
  return mesh;
}

export const isLand = (map: ExportedMap, i: number): boolean => map.cells[i].elevation > 0 && map.cells[i].biome !== "lake";

/** 바다에 닿은 육지 셀 (항구·등대를 둘 수 있는 곳) */
export function coastCells(map: ExportedMap, mesh: Mesh): number[] {
  return map.cells.map((_, i) => i).filter((i) => {
    if (!isLand(map, i)) return false;
    let coast = false;
    forEachNeighbor(mesh, i, (j) => { if (map.cells[j].elevation <= 0) coast = true; });
    return coast;
  });
}

/** 육지 연결 요소 번호 (바다·호수는 -1) */
export function landComponents(map: ExportedMap, mesh: Mesh): Int32Array {
  const comp = new Int32Array(mesh.count).fill(-1);
  let n = 0;
  for (let s = 0; s < mesh.count; s++) {
    if (comp[s] >= 0 || !isLand(map, s)) continue;
    const stack = [s];
    comp[s] = n;
    while (stack.length) {
      const i = stack.pop()!;
      forEachNeighbor(mesh, i, (j) => {
        if (comp[j] < 0 && isLand(map, j)) { comp[j] = n; stack.push(j); }
      });
    }
    n++;
  }
  return comp;
}

export const dist = (map: ExportedMap, a: number, b: number): number =>
  Math.hypot(map.cells[a].x - map.cells[b].x, map.cells[a].y - map.cells[b].y);

/** 경로가 다리·터널 span을 (어느 방향으로든) 지나는지 */
export const crosses = (path: number[] | undefined, s: Span | undefined): boolean =>
  !!path && !!s && path.some((c, k) => k > 0 && ((path[k - 1] === s.a && c === s.b) || (path[k - 1] === s.b && c === s.a)));

export async function enterInfraTool(page: Page, tool: string): Promise<void> {
  if (!(await page.locator("#editMode").isChecked())) await page.locator("#editMode").check();
  await page.click('[role="tab"][data-target="infra"]');
  await page.check(`input[name="infraTool"][value="${tool}"]`);
}

export const expectError = (page: Page) => expect(page.locator("#status")).toHaveClass(/error/);
export const expectOk = (page: Page) => expect(page.locator("#status")).not.toHaveClass(/error/);
