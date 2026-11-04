import type { EditResult } from "./civedit.ts";
import type { Biome } from "./climate.ts";
import { forEachNeighbor, type Mesh } from "./mesh.ts";
import { cellHash } from "./rng.ts";

/**
 * 천연자원: 지형·생태에 따라 셀에 놓이는 전략·사치·기본 자원.
 * - 전략 자원: 군사·산업에 쓰이며 매장량(amount)이 있다.
 * - 사치 자원: 교역·행복에 쓰이는 귀한 물품.
 * - 기본 자원: 식량·건축 재료 같은 흔한 자원.
 * 시드와 셀 번호로 정해지는 난수를 써서, 지형 일부를 편집해도 먼 곳의 자원은 거의 그대로 남는다.
 */
export type ResourceCategory = "strategic" | "luxury" | "bonus";

export const RESOURCE_CATEGORY_KO: Record<ResourceCategory, string> = {
  strategic: "전략 자원", luxury: "사치 자원", bonus: "기본 자원",
};

export type ResourceKind =
  | "iron" | "coal" | "oil" | "horses"
  | "gold" | "silver" | "gems" | "spices" | "silk" | "pearls" | "furs"
  | "wood" | "grain" | "cattle" | "fish" | "stone";

/** 놓을 수 있는 곳: land 육지, water 바다·호수, any 둘 다 */
export type ResourceSite = "land" | "water" | "any";

export interface ResourceInfo { ko: string; category: ResourceCategory; site: ResourceSite }

export const RESOURCE_INFO: Record<ResourceKind, ResourceInfo> = {
  iron: { ko: "철광", category: "strategic", site: "land" },
  coal: { ko: "석탄", category: "strategic", site: "land" },
  oil: { ko: "석유", category: "strategic", site: "any" },
  horses: { ko: "말", category: "strategic", site: "land" },
  gold: { ko: "금", category: "luxury", site: "land" },
  silver: { ko: "은", category: "luxury", site: "land" },
  gems: { ko: "보석", category: "luxury", site: "land" },
  spices: { ko: "향신료", category: "luxury", site: "land" },
  silk: { ko: "비단", category: "luxury", site: "land" },
  pearls: { ko: "진주", category: "luxury", site: "water" },
  furs: { ko: "모피", category: "luxury", site: "land" },
  wood: { ko: "목재", category: "bonus", site: "land" },
  grain: { ko: "곡물", category: "bonus", site: "land" },
  cattle: { ko: "가축", category: "bonus", site: "land" },
  fish: { ko: "어장", category: "bonus", site: "water" },
  stone: { ko: "석재", category: "bonus", site: "land" },
};

export const RESOURCE_KINDS = Object.keys(RESOURCE_INFO) as ResourceKind[];

export const isResourceKind = (v: unknown): v is ResourceKind => typeof v === "string" && Object.hasOwn(RESOURCE_INFO, v);

export interface Resource {
  cell: number;
  kind: ResourceKind;
  /** 전략 자원의 매장량 (다른 분류는 없음) */
  amount?: number;
}

/** 전략 자원 매장량 범위 */
export const MIN_AMOUNT = 1;
export const MAX_AMOUNT = 20;

/** 자원 배치에 필요한 지형 정보 (자연 계산 결과의 일부) */
export interface ResourceTerrain {
  mesh: Mesh;
  elevation: Float64Array;
  temperature: Float64Array;
  biome: Biome[];
  hydro: { isLake: Uint8Array; isRiver: Uint8Array };
}

/** 셀 하나의 성질 (적합도 계산용) */
interface Site {
  e: number;
  t: number;
  b: Biome;
  river: boolean;
  lake: boolean;
  /** 바다 셀이 육지에 닿아 있음 (연안) */
  nearLand: boolean;
}

const hill = (s: Site): boolean => s.e >= 0.3 && s.b !== "glacier";
const land = (s: Site): boolean => s.e > 0 && !s.lake;
const shallowSea = (s: Site): boolean => s.e <= 0 && s.e > -0.25;

// 생태별 적합도 표 (규칙마다 객체를 새로 만들지 않도록 미리 둔다)
const COAL_FIT: Partial<Record<Biome, number>> = { taiga: 1, temperateForest: 1, grassland: 0.6, tundra: 0.6, wetland: 0.5 };
const OIL_FIT: Partial<Record<Biome, number>> = { desert: 1, wetland: 1, tundra: 0.7, glacier: 0.3 };
const HORSES_FIT: Partial<Record<Biome, number>> = { grassland: 1, savanna: 0.8, tundra: 0.3 };
const SILVER_FIT: Partial<Record<Biome, number>> = { tundra: 0.8, taiga: 0.6, glacier: 0.2 };
const SPICES_FIT: Partial<Record<Biome, number>> = { rainforest: 1, savanna: 0.5, wetland: 0.4 };
const SILK_FIT: Partial<Record<Biome, number>> = { temperateForest: 1, rainforest: 0.3 };
const FURS_FIT: Partial<Record<Biome, number>> = { tundra: 1, taiga: 1 };
const WOOD_FIT: Partial<Record<Biome, number>> = { taiga: 1, temperateForest: 1, rainforest: 0.8 };
const GRAIN_FIT: Partial<Record<Biome, number>> = { grassland: 0.8, savanna: 0.4, temperateForest: 0.3 };
const CATTLE_FIT: Partial<Record<Biome, number>> = { grassland: 1, savanna: 0.6, tundra: 0.2 };
const STONE_FIT: Partial<Record<Biome, number>> = { desert: 0.6, mountain: 0.5, tundra: 0.4 };
const by = (table: Partial<Record<Biome, number>>, b: Biome): number => table[b] ?? 0;

/**
 * 종류별 적합도 (0~1)와 배치 규칙. density는 적합도 1인 셀 하나가 후보가 될 확률(9,000셀 지도 기준),
 * spacing은 같은 종류끼리 떨어뜨릴 거리(지도 좌표).
 */
const RULES: Record<ResourceKind, { density: number; spacing: number; fit: (s: Site) => number }> = {
  iron: { density: 0.05, spacing: 70, fit: (s) => (land(s) && hill(s) ? (s.b === "mountain" ? 0.8 : 1) : 0) },
  coal: { density: 0.05, spacing: 70, fit: (s) => (land(s) && s.e >= 0.12 && s.e < 0.65 ? by(COAL_FIT, s.b) : 0) },
  // 육지(사막·습지·툰드라)와 육지에서 조금 떨어진 얕은 바다(해저 유전)
  oil: { density: 0.04, spacing: 80, fit: (s) => (land(s) ? by(OIL_FIT, s.b) : shallowSea(s) && !s.nearLand ? 0.25 : 0) },
  horses: {
    density: 0.035, spacing: 70,
    fit: (s) => (land(s) && s.e < 0.35 ? by(HORSES_FIT, s.b) : 0),
  },
  // 구릉·사막, 강가면 더 (사금)
  gold: {
    density: 0.025, spacing: 110,
    fit: (s) => (land(s) && (hill(s) || s.b === "desert") ? (s.river ? 1 : 0.6) : 0),
  },
  silver: {
    density: 0.025, spacing: 110,
    fit: (s) => (land(s) ? Math.max(by(SILVER_FIT, s.b), hill(s) ? 0.5 : 0) : 0),
  },
  gems: {
    density: 0.025, spacing: 110,
    fit: (s) => (land(s) ? Math.max(s.b === "rainforest" ? 1 : 0, s.b === "mountain" ? 0.6 : hill(s) && s.e > 0.45 ? 0.3 : 0) : 0),
  },
  spices: {
    density: 0.03, spacing: 100,
    fit: (s) => (land(s) ? by(SPICES_FIT, s.b) : 0),
  },
  silk: {
    density: 0.03, spacing: 100,
    fit: (s) => (land(s) && s.e < 0.5 ? by(SILK_FIT, s.b) : 0),
  },
  pearls: { density: 0.05, spacing: 100, fit: (s) => (shallowSea(s) && !s.lake && s.nearLand && s.t > 0.55 ? 1 : 0) },
  furs: {
    density: 0.03, spacing: 100,
    fit: (s) => (land(s) ? by(FURS_FIT, s.b) : 0),
  },
  wood: {
    density: 0.06, spacing: 50,
    fit: (s) => (land(s) && s.e < 0.6 ? by(WOOD_FIT, s.b) : 0),
  },
  grain: { density: 0.06, spacing: 50, fit: (s) => (land(s) && s.e < 0.3 ? Math.min(1, by(GRAIN_FIT, s.b) + (s.river ? 0.3 : 0)) : 0) },
  cattle: {
    density: 0.05, spacing: 50,
    fit: (s) => (land(s) && s.e < 0.35 ? by(CATTLE_FIT, s.b) : 0),
  },
  fish: { density: 0.06, spacing: 50, fit: (s) => (s.lake ? 0.8 : shallowSea(s) && s.nearLand ? 1 : 0) },
  stone: {
    density: 0.04, spacing: 60,
    fit: (s) => (land(s) ? Math.max(hill(s) && s.e < 0.72 ? 0.7 : 0, by(STONE_FIT, s.b)) : 0),
  },
};

/** 서로 다른 자원끼리 떨어뜨릴 거리 (아이콘이 겹치지 않게, 지도 좌표) */
export const RESOURCE_GAP = 14;

/** 겹칠 때 남길 순서: 전략 > 사치 > 기본 */
const CATEGORY_RANK: Record<ResourceCategory, number> = { strategic: 2, luxury: 1, bonus: 0 };

/** 반경 안의 점을 빠르게 찾기 위한 격자 */
class PointGrid {
  private readonly size: number;
  private readonly buckets = new Map<string, number[]>();
  private readonly mesh: Mesh;
  constructor(mesh: Mesh, size: number) { this.mesh = mesh; this.size = size; }
  private key(x: number, y: number): string { return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`; }
  add(cell: number): void {
    const k = this.key(this.mesh.x[cell], this.mesh.y[cell]);
    const b = this.buckets.get(k);
    if (b) b.push(cell); else this.buckets.set(k, [cell]);
  }
  /** cell 주변 r 안의 다른 점에 대해 visit (true를 돌려주면 멈춘다) */
  some(cell: number, r: number, visit: (other: number) => boolean): boolean {
    const { mesh, size } = this;
    const x = mesh.x[cell], y = mesh.y[cell];
    const gx = Math.floor(x / size), gy = Math.floor(y / size), span = Math.ceil(r / size);
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        for (const o of this.buckets.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (o !== cell && (mesh.x[o] - x) ** 2 + (mesh.y[o] - y) ** 2 < r * r && visit(o)) return true;
        }
      }
    }
    return false;
  }
}

function siteOf(t: ResourceTerrain, i: number): Site {
  let nearLand = false;
  if (t.elevation[i] <= 0) forEachNeighbor(t.mesh, i, (j) => { if (t.elevation[j] > 0) nearLand = true; });
  return {
    e: t.elevation[i], t: t.temperature[i], b: t.biome[i], river: t.hydro.isRiver[i] === 1, lake: t.hydro.isLake[i] === 1, nearLand,
  };
}

/**
 * 시드와 지형으로 자원을 자동 배치한다. 같은 입력이면 항상 같은 결과.
 * 1) 종류마다 적합도 × 밀도 확률로 후보 셀을 고른다 (셀 번호 난수: 다른 셀의 변화와 무관).
 * 2) 같은 종류끼리 spacing 안에서는 우선순위가 가장 높은 후보만 남긴다.
 * 3) 다른 종류끼리 RESOURCE_GAP 안에서 겹치면 전략 > 사치 > 기본, 같으면 우선순위 순으로 남긴다.
 * 결정이 모두 주변 셀만 보고 이뤄지므로, 지형 일부를 편집해도 먼 곳의 자원은 바뀌지 않는다
 * (단, 기후·강처럼 멀리까지 영향을 주는 변화는 예외).
 */
export function placeResources(t: ResourceTerrain, seed: string): Resource[] {
  const { mesh } = t;
  const scale = 9000 / Math.max(1, mesh.count); // 셀이 작을수록 셀당 확률을 낮춰 지도 전체 개수를 비슷하게
  const sites: Site[] = Array.from({ length: mesh.count }, (_, i) => siteOf(t, i));
  const kept: { cell: number; kind: ResourceKind; priority: number }[] = [];
  for (const kind of RESOURCE_KINDS) {
    const rule = RULES[kind];
    const pick = cellHash(seed, `resource:${kind}`);
    const rank = cellHash(seed, `resource-rank:${kind}`);
    const candidates: number[] = [];
    const grid = new PointGrid(mesh, rule.spacing);
    for (let i = 0; i < mesh.count; i++) {
      if (mesh.isEdge[i]) continue;
      const fit = rule.fit(sites[i]);
      if (fit > 0 && pick(i) < fit * rule.density * scale) { candidates.push(i); grid.add(i); }
    }
    for (const c of candidates) {
      const p = rank(c);
      const beaten = grid.some(c, rule.spacing, (o) => rank(o) > p);
      if (!beaten) kept.push({ cell: c, kind, priority: CATEGORY_RANK[RESOURCE_INFO[kind].category] + p });
    }
  }
  const all = new PointGrid(mesh, RESOURCE_GAP);
  const byCell = new Map<number, (typeof kept)[number][]>();
  for (const k of kept) {
    all.add(k.cell);
    const list = byCell.get(k.cell);
    if (list) list.push(k); else byCell.set(k.cell, [k]);
  }
  const amountOf = cellHash(seed, "resource-amount");
  const out: Resource[] = [];
  for (const k of kept) {
    // 같은 셀에 여러 종류가 뽑혔으면 우선순위가 높은 것만, 가까운 다른 셀과 겹쳐도 높은 쪽만 남긴다.
    if ((byCell.get(k.cell) ?? []).some((o) => o.priority > k.priority)) continue;
    if (all.some(k.cell, RESOURCE_GAP, (o) => (byCell.get(o) ?? []).some((x) => x.priority > k.priority))) continue;
    const r: Resource = { cell: k.cell, kind: k.kind };
    if (RESOURCE_INFO[k.kind].category === "strategic") r.amount = 2 + Math.floor(amountOf(k.cell) * 7); // 2~8
    out.push(r);
  }
  return out.sort((a, b) => a.cell - b.cell);
}

// ── 직접 편집 ────────────────────────────────────────────────────────

/**
 * 자동 배치 위에 얹는 편집: 직접 놓은 자원과 지운 자동 자원의 셀.
 * 지형을 바꿔 자동 배치가 달라져도 편집은 그대로 남는다.
 */
export interface ResourceEdits {
  added: Resource[];
  /** 숨긴 자동 자원의 셀 */
  removed: number[];
}

export const MAX_RESOURCE_EDITS = 2000;

export const emptyResourceEdits = (): ResourceEdits => ({ added: [], removed: [] });
export const cloneResourceEdits = (r: ResourceEdits): ResourceEdits => ({ added: r.added.map((x) => ({ ...x })), removed: [...r.removed] });
export const isEmptyResourceEdits = (r: ResourceEdits): boolean => r.added.length === 0 && r.removed.length === 0;

/** 보조사 '은/는': 받침이 있으면 '은'. 한글로 끝나지 않으면 '은(는)'. */
function eun(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (!(code >= 0 && code <= 11171)) return "은(는)";
  return code % 28 === 0 ? "는" : "은";
}

/** 그 셀에 그 종류를 놓을 수 없으면 이유, 놓을 수 있으면 null */
export function resourceSiteError(t: Pick<ResourceTerrain, "mesh" | "elevation" | "hydro">, kind: ResourceKind, cell: number): EditResult {
  if (!(cell >= 0 && cell < t.mesh.count)) return "지도 밖입니다.";
  const water = t.elevation[cell] <= 0 || t.hydro.isLake[cell] === 1;
  const { site, ko } = RESOURCE_INFO[kind];
  if (site === "land" && water) return `${ko}${eun(ko)} 육지에만 둘 수 있습니다.`;
  if (site === "water" && !water) return `${ko}${eun(ko)} 바다·호수에만 둘 수 있습니다.`;
  return null;
}

/** 자동 배치에 편집을 반영한 최종 자원 목록. 지형과 맞지 않게 된 직접 놓은 자원은 숨긴다(데이터는 남긴다). */
export function applyResourceEdits(
  auto: readonly Resource[], edits: ResourceEdits, t: Pick<ResourceTerrain, "mesh" | "elevation" | "hydro">,
): Resource[] {
  if (isEmptyResourceEdits(edits)) return auto.map((r) => ({ ...r }));
  const hidden = new Set(edits.removed);
  const added = edits.added.filter((r) => resourceSiteError(t, r.kind, r.cell) === null);
  const addedCells = new Set(added.map((r) => r.cell));
  return [
    ...auto.filter((r) => !hidden.has(r.cell) && !addedCells.has(r.cell)).map((r) => ({ ...r })),
    ...added.map((r) => ({ ...r })),
  ].sort((a, b) => a.cell - b.cell);
}

/** 자원을 놓는다 (그 셀에 자원이 있으면 바꾼다). 전략 자원은 매장량을 받는다. */
export function addResource(
  t: Pick<ResourceTerrain, "mesh" | "elevation" | "hydro">, edits: ResourceEdits, auto: readonly Resource[],
  cell: number, kind: ResourceKind, amount?: number,
): EditResult {
  const error = resourceSiteError(t, kind, cell);
  if (error) return error;
  if (edits.added.length >= MAX_RESOURCE_EDITS) return `자원은 ${MAX_RESOURCE_EDITS}개까지 직접 놓을 수 있습니다.`;
  const r: Resource = { cell, kind };
  if (RESOURCE_INFO[kind].category === "strategic") {
    const a = Math.round(amount ?? 4);
    if (!(a >= MIN_AMOUNT && a <= MAX_AMOUNT)) return `매장량은 ${MIN_AMOUNT}~${MAX_AMOUNT}이어야 합니다.`;
    r.amount = a;
  }
  edits.added = edits.added.filter((x) => x.cell !== cell);
  edits.added.push(r);
  // 자동 자원이 있던 자리면 그것은 숨긴다 (나중에 직접 놓은 것을 지워도 자동 자원이 되살아나지 않게).
  if (auto.some((x) => x.cell === cell) && !edits.removed.includes(cell)) edits.removed.push(cell);
  return null;
}

/** 그 셀의 자원을 지운다. 지운 자원의 이름, 없으면 null. */
export function removeResource(edits: ResourceEdits, shown: readonly Resource[], auto: readonly Resource[], cell: number): string | null {
  const target = shown.find((r) => r.cell === cell);
  if (!target) return null;
  edits.added = edits.added.filter((x) => x.cell !== cell);
  if (auto.some((x) => x.cell === cell) && !edits.removed.includes(cell)) edits.removed.push(cell);
  return RESOURCE_INFO[target.kind].ko;
}

/** 지도 좌표 (x, y)에서 r 안의 가장 가까운 자원의 셀, 없으면 -1 */
export function hitResource(mesh: Mesh, shown: readonly Resource[], x: number, y: number, r: number): number {
  let best = -1, bestD = r * r;
  for (const res of shown) {
    const d = (mesh.x[res.cell] - x) ** 2 + (mesh.y[res.cell] - y) ** 2;
    if (d <= bestD) { bestD = d; best = res.cell; }
  }
  return best;
}

export function resourceEditsToJSON(r: ResourceEdits): { added: Resource[]; removed: number[] } {
  return { added: r.added.map((x) => ({ ...x })), removed: [...r.removed] };
}

/** 저장본·파일의 자원 편집을 읽는다. 형식이 틀리면 undefined. */
export function resourceEditsFromJSON(data: unknown, cellCount: number): ResourceEdits | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const o = data as Record<string, unknown>;
  const cell = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < cellCount;
  const addedRaw = o.added ?? [], removedRaw = o.removed ?? [];
  if (!Array.isArray(addedRaw) || !Array.isArray(removedRaw)) return undefined;
  if (addedRaw.length > MAX_RESOURCE_EDITS || removedRaw.length > cellCount) return undefined;
  const added: Resource[] = [];
  const seen = new Set<number>();
  for (const raw of addedRaw) {
    const r = raw as Record<string, unknown> | null;
    if (!r || !cell(r.cell) || !isResourceKind(r.kind) || seen.has(r.cell)) return undefined;
    seen.add(r.cell);
    const item: Resource = { cell: r.cell, kind: r.kind };
    if (RESOURCE_INFO[r.kind].category === "strategic") {
      const a = r.amount === undefined ? 4 : r.amount;
      if (!(Number.isInteger(a) && (a as number) >= MIN_AMOUNT && (a as number) <= MAX_AMOUNT)) return undefined;
      item.amount = a as number;
    }
    added.push(item);
  }
  if (!removedRaw.every(cell)) return undefined;
  return { added, removed: [...new Set(removedRaw as number[])] };
}
