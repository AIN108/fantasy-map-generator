import { FACILITY_INFO } from "./infra.ts";
import { RESOURCE_CATEGORY_KO, RESOURCE_INFO } from "./resources.ts";
import type { SearchPlace } from "./search.ts";
import type { WorldMap } from "./world.ts";

export const PLACE_CATEGORIES = [
  { value: "state", label: "국가" }, { value: "city", label: "도시" },
  { value: "river", label: "강" }, { value: "peak", label: "봉우리" },
  { value: "port", label: "항구" }, { value: "facility", label: "시설물" },
  { value: "resource", label: "천연자원" },
] as const;

export interface WorldPlace extends SearchPlace { cell: number; x: number; y: number }

/** 화면에 유효한 장소만 모은다. 잠긴 도시·시설은 WorldMap에서 이미 빠져 있다. */
export function worldPlaces(world: WorldMap): WorldPlace[] {
  const out: WorldPlace[] = [];
  const stateNames = new Map(world.states.map((s) => [s.id, s.name]));
  const owner = (cell: number): string => stateNames.get(world.owner[cell]) ?? "무소속";
  function add(category: string, id: number, cell: number, name: string, detail: string): void {
    if (!Number.isInteger(cell) || cell < 0 || cell >= world.mesh.count) return;
    out.push({ key: `${category}:${id}`, category, cell, name, detail, x: world.mesh.x[cell], y: world.mesh.y[cell] });
  }
  for (const s of world.states) {
    const capital = world.cities.find((c) => c.cell === s.capitalCell);
    add("state", s.id, capital?.cell ?? s.labelCell, s.name, `국가 · 수도 ${capital?.name ?? "없음"}`);
  }
  for (const c of world.cities) add("city", c.cell, c.cell, c.name, `${c.capital ? "수도" : "도시"} · ${stateNames.get(c.state) ?? "무소속"}`);
  world.rivers.forEach((r, i) => {
    if (r.name && r.cells.length) add("river", i, r.cells[Math.floor(r.cells.length / 2)], r.name, "강");
  });
  for (const p of world.peaks) add("peak", p.cell, p.cell, p.name, `봉우리 · ${owner(p.cell)}`);
  for (const p of world.ports) add("port", p.cell, p.cell, p.name || "이름 없는 항구", `항구 · ${owner(p.cell)}`);
  world.facilities.forEach((f, i) => add("facility", i, f.cell, f.name || FACILITY_INFO[f.kind].ko, `시설물 · ${FACILITY_INFO[f.kind].ko} · ${owner(f.cell)}`));
  // 천연자원: 이름(철광·석유…)과 분류(전략·사치·기본)로 찾는다. 전략 자원은 매장량을 함께 보여 준다.
  world.resources.forEach((r, i) => {
    const info = RESOURCE_INFO[r.kind];
    add("resource", i, r.cell, info.ko,
      `${RESOURCE_CATEGORY_KO[info.category]}${r.amount !== undefined ? ` · 매장량 ${r.amount}` : ""} · ${owner(r.cell)}`);
  });
  return out;
}
