import { Delaunay } from "d3-delaunay";
import { BIOME_HABITABILITY, type Biome } from "./climate.ts";
import { MinHeap } from "./heap.ts";
import type { Hydrology } from "./hydrology.ts";
import { distance, forEachNeighbor, type Mesh } from "./mesh.ts";
import type { Rng } from "./rng.ts";

export interface City {
  cell: number;
  name: string;
  capital: boolean;
  state: number; // -1: 무소속
  coastal: boolean;
  riverside: boolean;
}

export interface State {
  id: number;
  name: string;
  capitalCell: number;
  color: string;
  /** 국가 이름 라벨을 둘 셀 (국경에서 가장 먼 셀) */
  labelCell: number;
  cellCount: number;
}

/** 지형별 이동 비용 배수 (국가 확장·도로 경로 공용) */
const TERRAIN_COST: Record<Biome, number> = {
  ocean: Infinity, lake: Infinity, beach: 1.2, glacier: 12, tundra: 3, taiga: 2.2, grassland: 1,
  temperateForest: 1.8, rainforest: 3.5, savanna: 1.3, desert: 3, wetland: 3.5, mountain: 8,
};
const RIVER_CROSSING_COST = 4;

export function isCoastal(mesh: Mesh, elevation: Float64Array, i: number): boolean {
  let coastal = false;
  forEachNeighbor(mesh, i, (j) => { if (elevation[j] <= 0) coastal = true; });
  return coastal;
}

/**
 * 셀별 정착 적합도 점수. jitter는 셀 번호로 정해지는 난수여야 한다:
 * 순서대로 소비하는 RNG를 쓰면 한 셀의 육지/바다가 바뀔 때 뒤쪽 셀 값이 전부 밀려 먼 도시까지 움직인다.
 */
export function settlementScore(
  mesh: Mesh, elevation: Float64Array, biome: Biome[], hydro: Hydrology, jitter: (cell: number) => number,
): Float64Array {
  const score = new Float64Array(mesh.count);
  let maxFlux = 1e-9;
  for (let i = 0; i < mesh.count; i++) if (hydro.isRiver[i]) maxFlux = Math.max(maxFlux, hydro.flux[i]);
  for (let i = 0; i < mesh.count; i++) {
    if (elevation[i] <= 0 || hydro.isLake[i]) continue;
    const hab = BIOME_HABITABILITY[biome[i]];
    if (hab <= 0) continue;
    let s = hab;
    if (isCoastal(mesh, elevation, i)) s *= 1.5;
    if (hydro.isRiver[i]) s *= 1.4 + 0.8 * Math.sqrt(hydro.flux[i] / maxFlux);
    let nearLake = false;
    forEachNeighbor(mesh, i, (j) => { if (hydro.isLake[j]) nearLake = true; });
    if (nearLake) s *= 1.3;
    s *= 1 - 0.6 * elevation[i];
    score[i] = s * (0.85 + 0.3 * jitter(i));
  }
  return score;
}

/** 점수 높은 셀부터, 이미 고른 셀과 minDist 이상 떨어진 셀을 count개 고른다. */
export function pickSpaced(mesh: Mesh, score: Float64Array, count: number, minDist: number, exclude: number[] = []): number[] {
  const order = Array.from({ length: mesh.count }, (_, i) => i)
    .filter((i) => score[i] > 0)
    .sort((a, b) => score[b] - score[a]);
  const chosen: number[] = [];
  const all = [...exclude];
  const min2 = minDist * minDist;
  for (const i of order) {
    if (chosen.length >= count) break;
    let ok = true;
    for (const j of all) {
      const dx = mesh.x[i] - mesh.x[j], dy = mesh.y[i] - mesh.y[j];
      if (dx * dx + dy * dy < min2) { ok = false; break; }
    }
    if (ok) { chosen.push(i); all.push(i); }
  }
  return chosen;
}

function stepCost(mesh: Mesh, biome: Biome[], hydro: Hydrology, from: number, to: number): number {
  const base = TERRAIN_COST[biome[to]];
  if (!Number.isFinite(base)) return Infinity;
  const crossing = hydro.isRiver[to] && !hydro.isRiver[from] ? RIVER_CROSSING_COST : 0;
  return distance(mesh, from, to) * (base + crossing);
}

/**
 * 수도에서 동시에 Dijkstra로 퍼져 나가며 셀을 차지한다. 산·강·바다가 비싸므로
 * 국경이 자연스럽게 산맥과 강을 따라 생긴다. maxCost를 넘는 오지는 무소속(-1)으로 남는다.
 */
export function expandStates(
  mesh: Mesh, biome: Biome[], hydro: Hydrology, capitals: number[], maxCost: number,
): Int32Array {
  const owner = new Int32Array(mesh.count).fill(-1);
  const cost = new Float64Array(mesh.count).fill(Infinity);
  const heap = new MinHeap();
  capitals.forEach((c, s) => { cost[c] = 0; owner[c] = s; heap.push(0, c); });
  while (heap.size > 0) {
    const [c, i] = heap.pop()!;
    if (c > cost[i]) continue;
    forEachNeighbor(mesh, i, (j) => {
      const nc = c + stepCost(mesh, biome, hydro, i, j);
      if (nc < cost[j] && nc <= maxCost) {
        cost[j] = nc;
        owner[j] = owner[i];
        heap.push(nc, j);
      }
    });
  }
  return owner;
}

/** 지형 비용 A*. 기존 도로 셀은 싸게 쳐서 도로가 합쳐지게 한다. 경로가 없으면 null. */
export function findPath(
  mesh: Mesh, biome: Biome[], hydro: Hydrology, start: number, goal: number, roadCells: Uint8Array,
): number[] | null {
  const g = new Float64Array(mesh.count).fill(Infinity);
  const prev = new Int32Array(mesh.count).fill(-1);
  const heap = new MinHeap();
  const h = (i: number): number => distance(mesh, i, goal) * 0.35; // 도로 할인(0.35) 이하라 허용 가능 휴리스틱
  g[start] = 0;
  heap.push(h(start), start);
  while (heap.size > 0) {
    const [f, i] = heap.pop()!;
    if (i === goal) break;
    if (f - h(i) > g[i] + 1e-9) continue;
    forEachNeighbor(mesh, i, (j) => {
      let c = stepCost(mesh, biome, hydro, i, j);
      if (!Number.isFinite(c)) return;
      if (roadCells[j]) c *= 0.35;
      const ng = g[i] + c;
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
 * 도시 간 들로네 삼각분할 간선 중 최소 신장 트리 + 짧은 여분 간선을 도로 후보로 쓰고,
 * 후보마다 A*로 실제 경로를 만든다. 바다로 막힌 간선은 버린다.
 */
export function buildRoads(
  mesh: Mesh, biome: Biome[], hydro: Hydrology, cities: City[], pairJitter: (cellA: number, cellB: number) => number,
  maxEdgeLength: number,
): number[][] {
  if (cities.length < 2) return [];
  const pts = cities.flatMap((c) => [mesh.x[c.cell], mesh.y[c.cell]]);
  const edges: [number, number, number][] = [];
  if (cities.length === 2) {
    edges.push([0, 1, distance(mesh, cities[0].cell, cities[1].cell)]);
  } else {
    const del = new Delaunay(Float64Array.from(pts));
    const { triangles, halfedges } = del;
    for (let e = 0; e < triangles.length; e++) {
      if (e < halfedges[e] || halfedges[e] === -1) {
        const a = triangles[e], b = triangles[e % 3 === 2 ? e - 2 : e + 1];
        const len = distance(mesh, cities[a].cell, cities[b].cell);
        if (len <= maxEdgeLength) edges.push([a, b, len]);
      }
    }
  }
  edges.sort((p, q) => p[2] - q[2]);

  // Kruskal MST + 무작위로 일부 짧은 간선을 더해 순환로를 만든다.
  const parent = cities.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const chosen: [number, number][] = [];
  for (const [a, b, len] of edges) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) { parent[ra] = rb; chosen.push([a, b]); }
    else if (len < maxEdgeLength * 0.5 && pairJitter(cities[a].cell, cities[b].cell) < 0.25) chosen.push([a, b]);
  }

  const roadCells = new Uint8Array(mesh.count);
  const roads: number[][] = [];
  // 수도가 낀 간선부터 깔아야 주요 간선도로가 먼저 생기고 지선이 거기에 붙는다.
  chosen.sort((p, q) => Number(cities[q[0]].capital || cities[q[1]].capital) - Number(cities[p[0]].capital || cities[p[1]].capital));
  for (const [a, b] of chosen) {
    const path = findPath(mesh, biome, hydro, cities[a].cell, cities[b].cell, roadCells);
    if (!path || path.length < 2) continue;
    for (const c of path) roadCells[c] = 1;
    roads.push(path);
  }
  return roads;
}

/** 국경에서 가장 먼 셀 (국가 이름 라벨 위치). 다중 출발 BFS. */
export function stateLabelCells(mesh: Mesh, owner: Int32Array, stateCount: number): Int32Array {
  const dist = new Int32Array(mesh.count).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < mesh.count; i++) {
    if (owner[i] < 0) continue;
    let border = mesh.isEdge[i] === 1;
    forEachNeighbor(mesh, i, (j) => { if (owner[j] !== owner[i]) border = true; });
    if (border) { dist[i] = 0; queue.push(i); }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    forEachNeighbor(mesh, i, (j) => {
      if (owner[j] === owner[i] && dist[j] < 0) { dist[j] = dist[i] + 1; queue.push(j); }
    });
  }
  const best = new Int32Array(stateCount).fill(-1);
  const bestD = new Int32Array(stateCount).fill(-1);
  for (let i = 0; i < mesh.count; i++) {
    const s = owner[i];
    if (s >= 0 && dist[i] > bestD[s]) { bestD[s] = dist[i]; best[s] = i; }
  }
  return best;
}

/** 주변보다 높은 고산 셀 중 서로 떨어진 봉우리들 */
export function findPeaks(mesh: Mesh, elevation: Float64Array, count: number, minDist: number): number[] {
  const score = new Float64Array(mesh.count);
  for (let i = 0; i < mesh.count; i++) {
    if (elevation[i] < 0.55) continue;
    let isMax = true;
    forEachNeighbor(mesh, i, (j) => { if (elevation[j] > elevation[i]) isMax = false; });
    if (isMax) score[i] = elevation[i];
  }
  return pickSpaced(mesh, score, count, minDist);
}

/** 국가 색: 황금각 간격 색상환으로 인접 국가끼리 색이 비슷하지 않게 */
export function stateColor(index: number, rng: Rng): string {
  const hue = (index * 137.508 + rng() * 20) % 360;
  return `hsl(${hue.toFixed(1)} 55% 50%)`;
}
