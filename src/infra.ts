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
  /** 항구와 항구를 바다로 잇는 항로 (첫·마지막 셀은 항구, 사이는 바다) */
  seaRoutes: number[][];
  ports: PointFeature[];
  facilities: Facility[];
  /** 직접 놓은 다리·터널: 두 육지 셀 사이의 곧은 구간 */
  bridges: Span[];
  tunnels: Span[];
  /** 지우기로 숨긴 자동 다리·터널 표기 (그 셀이 포함된 자동 표기를 그리지 않는다) */
  hiddenMarks: number[];
}

/** 두 셀(a, b) 사이의 곧은 구간 */
export interface Span {
  a: number;
  b: number;
}

/** 직접 놓는 다리·터널의 최대 길이 (지도 좌표) */
export const MAX_SPAN_LENGTH = 250;

/** 철도 터널로 표기할 고도 (상대값). 이보다 높은 셀이 2칸 이상 이어지면 터널로 본다. */
export const TUNNEL_ELEVATION = 0.55;
/** 터널 구간의 거리당 비용 배수: 우회가 이보다 많이 길어질 때만 산을 관통한다 */
export const TUNNEL_COST = 6;

export const MAX_PATHS = 400;
export const MAX_POINTS = 400;
export const MAX_FEATURE_NAME = 20;

export const emptyInfra = (): Infra => ({
  rails: [], seaRoutes: [], ports: [], facilities: [], bridges: [], tunnels: [], hiddenMarks: [],
});

export function cloneInfra(infra: Infra): Infra {
  return {
    roads: infra.roads?.map((p) => [...p]),
    rails: infra.rails.map((p) => [...p]),
    seaRoutes: infra.seaRoutes.map((p) => [...p]),
    ports: infra.ports.map((p) => ({ ...p })),
    facilities: infra.facilities.map((f) => ({ ...f })),
    bridges: infra.bridges.map((b) => ({ ...b })),
    tunnels: infra.tunnels.map((b) => ({ ...b })),
    hiddenMarks: [...infra.hiddenMarks],
  };
}

export const isEmptyInfra = (infra: Infra): boolean =>
  infra.roads === undefined && infra.rails.length === 0 && infra.seaRoutes.length === 0
  && infra.ports.length === 0 && infra.facilities.length === 0
  && infra.bridges.length === 0 && infra.tunnels.length === 0 && infra.hiddenMarks.length === 0;

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
 * (철도는 급경사를 오르지 못해 돌아가고, 우회가 너무 길면 고산 구간을 터널로 관통한다).
 * 바다·호수는 지날 수 없다. 길이 없으면 null.
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
    // 철도: 고산 구간은 경사를 오르지 않고 터널로 관통한다 (비싸지만 평탄한 일정 비용).
    // 그 밖에서는 고도차 비용을 크게 매겨 급경사를 피하고, 강은 다리로 건너므로 조금만 더한다.
    if (elevation[to] > TUNNEL_ELEVATION || elevation[from] > TUNNEL_ELEVATION) return d * TUNNEL_COST;
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

/**
 * 두 항구를 바다로 잇는 항로(A*). 사이 셀은 모두 바다이며, 얕은 연안보다 깊은 바다를 조금 선호한다.
 * 출발·도착은 해안 육지(항구 자리) 셀이다. 길이 없으면 null.
 */
export function routeSea(t: Terrain, start: number, goal: number): number[] | null {
  if (start === goal || !onLand(t, start) || !onLand(t, goal)) return null;
  const { mesh, elevation } = t;
  const isSea = (i: number): boolean => elevation[i] <= 0;
  const step = (from: number, to: number): number => {
    if (to !== goal && !isSea(to)) return Infinity;
    // 수심 0.15(상대값)보다 얕으면 최대 2.5배까지 비싸게: 해안선을 바짝 붙어 가지 않게
    const shallow = isSea(to) ? Math.max(0, 1 - -elevation[to] / 0.15) : 0;
    return distance(mesh, from, to) * (1 + 1.5 * shallow);
  };
  const g = new Float64Array(mesh.count).fill(Infinity);
  const prev = new Int32Array(mesh.count).fill(-1);
  const heap = new MinHeap();
  const h = (i: number): number => distance(mesh, i, goal);
  g[start] = 0;
  heap.push(h(start), start);
  while (heap.size > 0) {
    const [f, i] = heap.pop()!;
    if (i === goal) break;
    if (f - h(i) > g[i] + 1e-9) continue;
    if (i !== start && !isSea(i)) continue;
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
  path.reverse();
  return path.length >= 3 ? path : null; // 항구 → 바다 → 항구 (바다를 한 칸도 안 지나면 항로가 아님)
}

export function addSeaRoute(infra: Infra, path: number[]): EditResult {
  if (path.length < 3) return "항로는 바다를 지나 두 항구를 이어야 합니다.";
  if (infra.seaRoutes.length >= MAX_PATHS) return `항로는 ${MAX_PATHS}개까지 그릴 수 있습니다.`;
  infra.seaRoutes.push(path);
  return null;
}

/**
 * 다리·터널을 직접 놓는다. 양 끝은 육지(호수 제외)여야 하고 길이는 MAX_SPAN_LENGTH 이하.
 * 다리는 그 사이에 물(바다·호수·강)이 하나 이상 있어야 하고, 터널은 사이가 어떤 지형이든 된다 (해저 터널 포함).
 */
export function addSpan(t: Terrain, infra: Infra, kind: "bridge" | "tunnel", a: number, b: number): EditResult {
  const label = kind === "bridge" ? "다리" : "터널";
  if (a === b) return `${label}의 양 끝이 같습니다. 끌어서 두 지점을 이어 주세요.`;
  if (!onLand(t, a) || !onLand(t, b)) return `${label}의 양 끝은 육지여야 합니다.`;
  const len = distance(t.mesh, a, b);
  if (len > MAX_SPAN_LENGTH) return `${label}는 ${MAX_SPAN_LENGTH}px까지 놓을 수 있습니다 (지금 ${Math.round(len)}px).`;
  const list = kind === "bridge" ? infra.bridges : infra.tunnels;
  if (list.length >= MAX_PATHS) return `${label}는 ${MAX_PATHS}개까지 놓을 수 있습니다.`;
  if (list.some((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a))) return `같은 자리에 이미 ${label}가 있습니다.`;
  if (kind === "bridge" && !spanCells(t.mesh, a, b).some((c) => !onLand(t, c) || t.hydro.isRiver[c])) {
    return "다리는 물(바다·호수·강)을 건너야 합니다. 물 건너편까지 끌어 주세요.";
  }
  list.push({ a, b });
  return null;
}

/** a에서 b까지 곧은 선이 지나는 셀들 (양 끝 제외, 대략 셀 간격 절반마다 표본) */
export function spanCells(mesh: Mesh, a: number, b: number): number[] {
  const len = distance(mesh, a, b);
  const steps = Math.max(1, Math.ceil(len / 4));
  const out: number[] = [];
  let last = a;
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const px = mesh.x[a] + (mesh.x[b] - mesh.x[a]) * t, py = mesh.y[a] + (mesh.y[b] - mesh.y[a]) * t;
    // 가까운 이웃부터 따라가며 가장 가까운 셀을 찾는다 (전체 탐색보다 훨씬 빠름)
    let cur = last, improved = true;
    while (improved) {
      improved = false;
      let bestD = (mesh.x[cur] - px) ** 2 + (mesh.y[cur] - py) ** 2;
      forEachNeighbor(mesh, cur, (j) => {
        const d = (mesh.x[j] - px) ** 2 + (mesh.y[j] - py) ** 2;
        if (d < bestD) { bestD = d; cur = j; improved = true; }
      });
    }
    if (cur !== last && cur !== a && cur !== b) out.push(cur);
    last = cur;
  }
  return out;
}

export type PointKind = "port" | "facility";

/** (x, y)에서 radius 안의 가장 가까운 항구·시설물. 없으면 null. */
export function hitPoint(mesh: Mesh, infra: Infra, x: number, y: number, radius: number): { kind: PointKind; index: number } | null {
  const r2 = radius * radius;
  let best: { kind: PointKind; index: number; d: number } | null = null;
  const check = (kind: PointKind, cell: number, index: number): void => {
    const d = (mesh.x[cell] - x) ** 2 + (mesh.y[cell] - y) ** 2;
    if (d <= r2 && (!best || d < best.d)) best = { kind, index, d };
  };
  infra.ports.forEach((p, i) => check("port", p.cell, i));
  infra.facilities.forEach((f, i) => check("facility", f.cell, i));
  if (!best) return null;
  const { kind, index } = best;
  return { kind, index };
}

/**
 * 항구·시설물을 다른 셀로 옮긴다 (놓을 때와 같은 조건 검사).
 * 항구를 옮기면 그 항구에서 시작·끝나는 항로를 새 자리로 다시 계산하고, 길이 없으면 그 항로는 지운다.
 * 성공하면 null, 실패하면 이유. 항로를 지웠다면 droppedRoutes에 개수를 담는다.
 */
export function movePoint(
  t: Terrain, infra: Infra, kind: PointKind, index: number, cell: number, result: { droppedRoutes: number } = { droppedRoutes: 0 },
): EditResult {
  const item = kind === "port" ? infra.ports[index] : infra.facilities[index];
  if (!item) return "시설을 찾을 수 없습니다.";
  if (item.cell === cell) return null;
  if (!onLand(t, cell)) return "바다나 호수로는 옮길 수 없습니다.";
  const coastalOnly = kind === "port" || FACILITY_INFO[(item as Facility).kind]?.coastal;
  if (coastalOnly && !isCoast(t, cell)) return `${kind === "port" ? "항구" : "등대"}는 해안으로만 옮길 수 있습니다.`;
  const taken = infra.ports.some((p, i) => p.cell === cell && !(kind === "port" && i === index))
    || infra.facilities.some((f, i) => f.cell === cell && !(kind === "facility" && i === index));
  if (taken) return "그 자리에는 이미 시설이 있습니다.";

  const old = item.cell;
  item.cell = cell;
  if (kind === "port") {
    const kept: number[][] = [];
    for (const route of infra.seaRoutes) {
      const first = route[0], last = route[route.length - 1];
      if (first !== old && last !== old) { kept.push(route); continue; }
      const next = routeSea(t, first === old ? cell : first, last === old ? cell : last);
      if (next) kept.push(next); else result.droppedRoutes++;
    }
    infra.seaRoutes = kept;
  }
  return null;
}

/** 다리·터널 표기 위치 */
export interface PathMarks {
  /** 강을 건너는 지점: 경로 안 셀 인덱스 (그 셀 위에 다리를 그린다) */
  bridges: number[];
  /** 철도가 높은 산지를 지나는 구간: [시작, 끝] 경로 인덱스 (양 끝 포함) */
  tunnels: [number, number][];
}


/**
 * 경로에서 다리(강 건너기)와 터널(철도의 고산 구간)을 찾는다.
 * 강을 따라 길게 나란히 가는 구간(강 셀이 3칸 이상 연속)은 다리로 보지 않는다.
 */
export function pathMarks(t: Terrain, path: number[], mode: "road" | "rail", hidden?: ReadonlySet<number>): PathMarks {
  const bridges: number[] = [];
  const tunnels: [number, number][] = [];
  let k = 0;
  while (k < path.length) {
    if (t.hydro.isRiver[path[k]]) {
      let end = k;
      while (end + 1 < path.length && t.hydro.isRiver[path[end + 1]]) end++;
      const mid = Math.floor((k + end) / 2);
      const isHidden = hidden && path.slice(k, end + 1).some((c) => hidden.has(c));
      if (end - k + 1 <= 2 && k > 0 && end < path.length - 1 && !isHidden) bridges.push(mid);
      k = end + 1;
    } else k++;
  }
  if (mode === "rail") {
    k = 0;
    while (k < path.length) {
      if (t.elevation[path[k]] > TUNNEL_ELEVATION) {
        let end = k;
        while (end + 1 < path.length && t.elevation[path[end + 1]] > TUNNEL_ELEVATION) end++;
        if (end > k && !(hidden && path.slice(k, end + 1).some((c) => hidden.has(c)))) tunnels.push([k, end]);
        k = end + 1;
      } else k++;
    }
  }
  return { bridges, tunnels };
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
 * (x, y)에서 radius 안의 가장 가까운 시설을 지운다. 우선순위는
 * 점(항구·시설물) → 직접 놓은 다리·터널 → 자동 다리·터널 표기(숨김) → 선(도로·철도·항로).
 * 자동 도로를 지우면 그 전에 autoRoads를 고정한다. t를 주면 자동 표기도 숨길 수 있다.
 * 지운 것의 설명을, 없으면 null을 돌려준다.
 */
export function eraseAt(
  mesh: Mesh, infra: Infra, x: number, y: number, radius: number, autoRoads: number[][], t?: Terrain,
): string | null {
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

  // 직접 놓은 다리·터널
  let span: { kind: "bridge" | "tunnel"; index: number; d: number } | undefined;
  const spanD = (s: Span): number => segDist2(x, y, mesh.x[s.a], mesh.y[s.a], mesh.x[s.b], mesh.y[s.b]);
  infra.bridges.forEach((s, index) => {
    const d = spanD(s);
    if (d <= r2 && (!span || d < span.d)) span = { kind: "bridge", index, d };
  });
  infra.tunnels.forEach((s, index) => {
    const d = spanD(s);
    if (d <= r2 && (!span || d < span.d)) span = { kind: "tunnel", index, d };
  });
  if (span) {
    (span.kind === "bridge" ? infra.bridges : infra.tunnels).splice(span.index, 1);
    return span.kind === "bridge" ? "다리" : "터널";
  }

  // 자동 다리·터널 표기: 지우지 않고 그 셀을 숨김 목록에 넣는다
  if (t) {
    const hidden = new Set(infra.hiddenMarks);
    let mark: { cell: number; kind: string; d: number } | undefined;
    const consider = (paths: number[][], mode: "road" | "rail"): void => {
      for (const path of paths) {
        const marks = pathMarks(t, path, mode, hidden);
        for (const k of marks.bridges) {
          const d = pointD(path[k]);
          if (d <= r2 && (!mark || d < mark.d)) mark = { cell: path[k], kind: "다리 표기", d };
        }
        for (const [from, to] of marks.tunnels) {
          for (let k = from; k < to; k++) {
            const a = path[k], b = path[k + 1];
            const d = segDist2(x, y, mesh.x[a], mesh.y[a], mesh.x[b], mesh.y[b]);
            if (d <= r2 && (!mark || d < mark.d)) mark = { cell: path[k], kind: "터널 표기", d };
          }
        }
      }
    };
    consider(visibleInfra(t, infra, autoRoads).roads, "road");
    consider(visibleInfra(t, infra, autoRoads).rails, "rail");
    if (mark) {
      infra.hiddenMarks.push(mark.cell);
      return `자동 ${mark.kind}`;
    }
  }

  const pathD = (path: number[]): number => {
    let d = Infinity;
    for (let k = 0; k + 1 < path.length; k++) {
      const a = path[k], b = path[k + 1];
      d = Math.min(d, segDist2(x, y, mesh.x[a], mesh.y[a], mesh.x[b], mesh.y[b]));
    }
    return d;
  };
  let line: { kind: "road" | "rail" | "sea"; index: number; d: number } | undefined;
  (infra.roads ?? autoRoads).forEach((p, index) => {
    const d = pathD(p);
    if (d <= r2 && (!line || d < line.d)) line = { kind: "road", index, d };
  });
  infra.rails.forEach((p, index) => {
    const d = pathD(p);
    if (d <= r2 && (!line || d < line.d)) line = { kind: "rail", index, d };
  });
  infra.seaRoutes.forEach((p, index) => {
    const d = pathD(p);
    if (d <= r2 && (!line || d < line.d)) line = { kind: "sea", index, d };
  });
  if (!line) return null;
  if (line.kind === "rail") {
    infra.rails.splice(line.index, 1);
    return "철도";
  }
  if (line.kind === "sea") {
    infra.seaRoutes.splice(line.index, 1);
    return "항로";
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
  roads: number[][]; rails: number[][]; seaRoutes: number[][]; ports: PointFeature[]; facilities: Facility[];
  bridges: Span[]; tunnels: Span[]; hiddenMarks: number[];
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
    // 항로는 지형 편집으로 중간 바다가 땅이 되면 통째로 숨긴다 (끊긴 항로는 의미가 없다)
    seaRoutes: infra.seaRoutes.filter((r) => r.slice(1, -1).every((c) => t.elevation[c] <= 0)),
    ports: infra.ports.filter((p) => onLand(t, p.cell)),
    facilities: infra.facilities.filter((f) => onLand(t, f.cell)),
    // 다리·터널은 양 끝이 물에 잠기면 숨긴다
    bridges: infra.bridges.filter((s) => onLand(t, s.a) && onLand(t, s.b)),
    tunnels: infra.tunnels.filter((s) => onLand(t, s.a) && onLand(t, s.b)),
    hiddenMarks: infra.hiddenMarks,
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
  const seaRoutes = paths(o.seaRoutes ?? []);
  if (!rails || !seaRoutes || !Array.isArray(o.ports ?? []) || !Array.isArray(o.facilities ?? [])) return undefined;
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
  const spans = (v: unknown): Span[] | undefined => {
    if (!Array.isArray(v) || v.length > MAX_PATHS) return undefined;
    const out: Span[] = [];
    for (const raw of v) {
      const sp = raw as Record<string, unknown> | null;
      if (!sp || !cell(sp.a) || !cell(sp.b) || sp.a === sp.b) return undefined;
      out.push({ a: sp.a, b: sp.b });
    }
    return out;
  };
  const bridges = spans(o.bridges ?? []);
  const tunnels = spans(o.tunnels ?? []);
  const hiddenRaw = o.hiddenMarks ?? [];
  if (!bridges || !tunnels || !Array.isArray(hiddenRaw) || hiddenRaw.length > MAX_POINTS * 4 || !hiddenRaw.every(cell)) {
    return undefined;
  }
  return { roads, rails, seaRoutes, ports, facilities, bridges, tunnels, hiddenMarks: [...hiddenRaw] };
}
