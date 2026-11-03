import { RIVER_CROSSING_COST, TERRAIN_COST } from "./civ.ts";
import type { Biome } from "./climate.ts";
import type { EditResult } from "./civedit.ts";
import { MinHeap } from "./heap.ts";
import { distance, forEachNeighbor, type Mesh } from "./mesh.ts";

/**
 * 사용자가 그리고 놓는 기반 시설: 도로·철도(셀 경로), 항구, 시설물(점).
 * 도시·국경과 별개로 저장하며, 지형이 바뀌어 물에 잠긴 부분은 그리지 않는다 (데이터는 남겨 둔다).
 */
export type FacilityKind = "castle" | "fort" | "temple" | "mine" | "tower" | "ruin" | "lighthouse";

export const FACILITY_INFO: Record<FacilityKind, { ko: string; coastal?: boolean }> = {
  castle: { ko: "성" },
  fort: { ko: "요새" },
  temple: { ko: "사원" },
  mine: { ko: "광산" },
  tower: { ko: "탑" },
  ruin: { ko: "유적" },
  lighthouse: { ko: "등대", coastal: true },
};
export const FACILITY_KINDS = Object.keys(FACILITY_INFO) as FacilityKind[];

export interface PointFeature {
  cell: number;
  name?: string;
}
export interface Facility extends PointFeature {
  kind: FacilityKind;
}

export interface Infra {
  /** undefined면 도로를 자동으로 만든다. 배열이면 이 도로만 쓴다 (처음 도로를 편집할 때 자동 도로를 고정). */
  roads?: number[][];
  rails: number[][];
  ports: PointFeature[];
  facilities: Facility[];
}

export const MAX_PATHS = 400;
export const MAX_POINTS = 400;
export const MAX_FEATURE_NAME = 20;

export const emptyInfra = (): Infra => ({ rails: [], ports: [], facilities: [] });

export function cloneInfra(infra: Infra): Infra {
  return {
    roads: infra.roads?.map((p) => [...p]),
    rails: infra.rails.map((p) => [...p]),
    ports: infra.ports.map((p) => ({ ...p })),
    facilities: infra.facilities.map((f) => ({ ...f })),
  };
}

export const isEmptyInfra = (infra: Infra): boolean =>
  infra.roads === undefined && infra.rails.length === 0 && infra.ports.length === 0 && infra.facilities.length === 0;

/** 경로 계산에 필요한 지형 정보 (WorldMap의 일부) */
export interface Terrain {
  mesh: Mesh;
  elevation: Float64Array;
  biome: Biome[];
  hydro: { isLake: Uint8Array; isRiver: Uint8Array };
}

const onLand = (t: Terrain, i: number): boolean => i >= 0 && i < t.mesh.count && t.elevation[i] > 0 && !t.hydro.isLake[i];

const isCoast = (t: Terrain, i: number): boolean => {
  let coast = false;
  forEachNeighbor(t.mesh, i, (j) => { if (t.elevation[j] <= 0) coast = true; });
  return coast;
};

/**
 * 지형을 따라가는 경로(A*). 도로는 자동 도로와 같은 지형 비용을, 철도는 경사에 훨씬 민감한 비용을 쓴다
 * (철도는 급경사를 오르지 못하므로 산을 크게 돌아간다). 바다·호수는 지날 수 없다. 길이 없으면 null.
 */
export function routePath(t: Terrain, start: number, goal: number, mode: "road" | "rail"): number[] | null {
  if (!onLand(t, start) || !onLand(t, goal)) return null;
  if (start === goal) return [start];
  const { mesh, elevation, biome, hydro } = t;
  const step = (from: number, to: number): number => {
    const base = TERRAIN_COST[biome[to]];
    if (!Number.isFinite(base) || !onLand(t, to)) return Infinity;
    const d = distance(mesh, from, to);
    if (mode === "road") {
      const crossing = hydro.isRiver[to] && !hydro.isRiver[from] ? RIVER_CROSSING_COST : 0;
      return d * (base + crossing);
    }
    // 철도: 고도차 비용을 크게, 강은 다리로 건너므로 조금만
    const climb = Math.abs(elevation[to] - elevation[from]) / Math.max(1e-6, d) * 900;
    const crossing = hydro.isRiver[to] && !hydro.isRiver[from] ? 1.5 : 0;
    return d * (1 + 0.4 * (base - 1) + climb * climb + crossing);
  };
  const g = new Float64Array(mesh.count).fill(Infinity);
  const prev = new Int32Array(mesh.count).fill(-1);
  const heap = new MinHeap();
  const h = (i: number): number => distance(mesh, i, goal); // 걸음당 비용 배수는 항상 1 이상 → 허용 가능
  g[start] = 0;
  heap.push(h(start), start);
  while (heap.size > 0) {
    const [f, i] = heap.pop()!;
    if (i === goal) break;
    if (f - h(i) > g[i] + 1e-9) continue;
    forEachNeighbor(mesh, i, (j) => {
      const ng = g[i] + step(i, j);
      if (ng < g[j]) {
        g[j] = ng;
        prev[j] = i;
        heap.push(ng + h(j), j);
      }
    });
  }
  if (!Number.isFinite(g[goal])) return null;
  const path: number[] = [];
  for (let i = goal; i >= 0; i = prev[i]) path.push(i);
  return path.reverse();
}

const cleanName = (name: string | undefined): string | undefined => {
  const n = name?.replace(/\s+/g, " ").trim();
  return n ? n.slice(0, MAX_FEATURE_NAME) : undefined;
};

/** 도로·철도 경로를 추가한다. 자동 도로 상태에서 도로를 추가하면 autoRoads를 먼저 고정한다. */
export function addPath(infra: Infra, kind: "road" | "rail", path: number[], autoRoads: number[][]): EditResult {
  if (path.length < 2) return "출발점과 도착점이 같습니다. 끌어서 두 지점을 이어 주세요.";
  if (kind === "road") {
    infra.roads ??= autoRoads.map((p) => [...p]);
    if (infra.roads.length >= MAX_PATHS) return `도로는 ${MAX_PATHS}개까지 그릴 수 있습니다.`;
    infra.roads.push(path);
  } else {
    if (infra.rails.length >= MAX_PATHS) return `철도는 ${MAX_PATHS}개까지 그릴 수 있습니다.`;
    infra.rails.push(path);
  }
  return null;
}

const occupied = (infra: Infra, cell: number): boolean =>
  infra.ports.some((p) => p.cell === cell) || infra.facilities.some((f) => f.cell === cell);

export function addPort(t: Terrain, infra: Infra, cell: number, name?: string): EditResult {
  if (!onLand(t, cell)) return "항구는 육지(해안)에 둡니다.";
  if (!isCoast(t, cell)) return "항구는 바다에 닿은 해안에만 둘 수 있습니다.";
  if (occupied(infra, cell)) return "그 자리에는 이미 시설이 있습니다.";
  if (infra.ports.length >= MAX_POINTS) return `항구는 ${MAX_POINTS}개까지 둘 수 있습니다.`;
  infra.ports.push({ cell, name: cleanName(name) });
  return null;
}

export function addFacility(t: Terrain, infra: Infra, cell: number, kind: FacilityKind, name?: string): EditResult {
  if (!FACILITY_INFO[kind]) return "알 수 없는 시설 종류입니다.";
  if (!onLand(t, cell)) return "시설물은 육지에 둡니다.";
  if (FACILITY_INFO[kind].coastal && !isCoast(t, cell)) return `${FACILITY_INFO[kind].ko}는 해안에만 둘 수 있습니다.`;
  if (occupied(infra, cell)) return "그 자리에는 이미 시설이 있습니다.";
  if (infra.facilities.length >= MAX_POINTS) return `시설물은 ${MAX_POINTS}개까지 둘 수 있습니다.`;
  infra.facilities.push({ cell, kind, name: cleanName(name) });
  return null;
}

/** 점에서 선분까지 거리의 제곱 */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}

/**
 * (x, y)에서 radius 안의 가장 가까운 시설을 지운다. 점(항구·시설물)이 선(도로·철도)보다 우선.
 * 자동 도로를 지우면 그 전에 autoRoads를 고정한다. 지운 것의 설명을, 없으면 null을 돌려준다.
 */
export function eraseAt(mesh: Mesh, infra: Infra, x: number, y: number, radius: number, autoRoads: number[][]): string | null {
  const r2 = radius * radius;
  const pointD = (cell: number): number => (mesh.x[cell] - x) ** 2 + (mesh.y[cell] - y) ** 2;

  let best: { kind: "port" | "facility"; index: number; d: number } | undefined;
  infra.ports.forEach((p, index) => {
    const d = pointD(p.cell);
    if (d <= r2 && (!best || d < best.d)) best = { kind: "port", index, d };
  });
  infra.facilities.forEach((f, index) => {
    const d = pointD(f.cell);
    if (d <= r2 && (!best || d < best.d)) best = { kind: "facility", index, d };
  });
  if (best) {
    if (best.kind === "port") {
      const [p] = infra.ports.splice(best.index, 1);
      return p.name ? `항구 '${p.name}'` : "항구";
    }
    const [f] = infra.facilities.splice(best.index, 1);
    return f.name ? `${FACILITY_INFO[f.kind].ko} '${f.name}'` : FACILITY_INFO[f.kind].ko;
  }

  const pathD = (path: number[]): number => {
    let d = Infinity;
    for (let k = 0; k + 1 < path.length; k++) {
      const a = path[k], b = path[k + 1];
      d = Math.min(d, segDist2(x, y, mesh.x[a], mesh.y[a], mesh.x[b], mesh.y[b]));
    }
    return d;
  };
  let line: { kind: "road" | "rail"; index: number; d: number } | undefined;
  (infra.roads ?? autoRoads).forEach((p, index) => {
    const d = pathD(p);
    if (d <= r2 && (!line || d < line.d)) line = { kind: "road", index, d };
  });
  infra.rails.forEach((p, index) => {
    const d = pathD(p);
    if (d <= r2 && (!line || d < line.d)) line = { kind: "rail", index, d };
  });
  if (!line) return null;
  if (line.kind === "rail") {
    infra.rails.splice(line.index, 1);
    return "철도";
  }
  infra.roads ??= autoRoads.map((p) => [...p]);
  infra.roads.splice(line.index, 1);
  return "도로";
}

/**
 * 화면에 그릴 기반 시설. 물에 잠긴 점 시설은 빼고, 경로는 물에 잠긴 지점에서 끊어 여러 조각으로 나눈다.
 * roads가 undefined면 autoRoads를 그대로 쓴다.
 */
export function visibleInfra(t: Terrain, infra: Infra, autoRoads: number[][]): {
  roads: number[][]; rails: number[][]; ports: PointFeature[]; facilities: Facility[];
} {
  const split = (paths: number[][]): number[][] => paths.flatMap((p) => {
    const out: number[][] = [];
    let cur: number[] = [];
    for (const c of p) {
      if (onLand(t, c)) cur.push(c);
      else { if (cur.length >= 2) out.push(cur); cur = []; }
    }
    if (cur.length >= 2) out.push(cur);
    return out;
  });
  return {
    roads: infra.roads ? split(infra.roads) : autoRoads,
    rails: split(infra.rails),
    ports: infra.ports.filter((p) => onLand(t, p.cell)),
    facilities: infra.facilities.filter((f) => onLand(t, f.cell)),
  };
}

// ── 저장 형식 ─────────────────────────────────────────────────────────

export function infraToJSON(infra: Infra): object {
  return cloneInfra(infra);
}

/** 외부 입력을 검증해 Infra로 만든다. 형식이 하나라도 틀리면 undefined. */
export function infraFromJSON(data: unknown, cellCount: number): Infra | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const o = data as Record<string, unknown>;
  const cell = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < cellCount;
  const paths = (v: unknown): number[][] | undefined => {
    if (!Array.isArray(v) || v.length > MAX_PATHS) return undefined;
    const out: number[][] = [];
    for (const p of v) {
      if (!Array.isArray(p) || p.length < 2 || p.length > cellCount || !p.every(cell)) return undefined;
      out.push([...p]);
    }
    return out;
  };
  const name = (v: unknown): string | undefined | false =>
    v === undefined ? undefined : typeof v === "string" && v.length <= MAX_FEATURE_NAME * 3 ? cleanName(v) : false;

  const roads = o.roads === undefined ? undefined : paths(o.roads);
  if (o.roads !== undefined && !roads) return undefined;
  const rails = paths(o.rails ?? []);
  if (!rails || !Array.isArray(o.ports ?? []) || !Array.isArray(o.facilities ?? [])) return undefined;
  const portsRaw = (o.ports ?? []) as unknown[];
  const facRaw = (o.facilities ?? []) as unknown[];
  if (portsRaw.length > MAX_POINTS || facRaw.length > MAX_POINTS) return undefined;

  const ports: PointFeature[] = [];
  for (const raw of portsRaw) {
    const p = raw as Record<string, unknown> | null;
    const n = name(p?.name);
    if (!p || !cell(p.cell) || n === false) return undefined;
    ports.push({ cell: p.cell, name: n });
  }
  const facilities: Facility[] = [];
  for (const raw of facRaw) {
    const f = raw as Record<string, unknown> | null;
    const n = name(f?.name);
    if (!f || !cell(f.cell) || n === false || typeof f.kind !== "string" || !(f.kind in FACILITY_INFO)) return undefined;
    facilities.push({ cell: f.cell, kind: f.kind as FacilityKind, name: n });
  }
  return { roads, rails, ports, facilities };
}
