import { MinHeap } from "./heap.ts";
import type { Mesh } from "./mesh.ts";
import { forEachNeighbor } from "./mesh.ts";

export interface Hydrology {
  /** 웅덩이를 메운 고도. 모든 육지 셀이 바다까지 내리막 경로를 갖는다. */
  filled: Float64Array;
  /** 물이 흘러가는 이웃 셀 (-1: 바다·호수 바닥 등 종점) */
  downhill: Int32Array;
  /** 누적 유량 (강의 굵기) */
  flux: Float64Array;
  /** 호수 셀 */
  isLake: Uint8Array;
  /** 강이 흐르는 셀 */
  isRiver: Uint8Array;
}

const EPSILON = 1e-5;

/**
 * Priority-flood(Barnes 2014)로 웅덩이를 메우고, 내리막 방향과 유량을 계산한다.
 * rainfall: 셀별 강수량 (상대값)
 */
export function computeHydrology(
  mesh: Mesh,
  elevation: Float64Array,
  rainfall: Float64Array,
  riverThreshold: number,
  lakeDepth = 0.02,
): Hydrology {
  const n = mesh.count;
  const filled = Float64Array.from(elevation);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  const downhill = new Int32Array(n).fill(-1);

  // 바다 셀에서 시작해 육지 안쪽으로 메워 들어간다.
  for (let i = 0; i < n; i++) {
    if (elevation[i] <= 0) {
      done[i] = 1;
      heap.push(elevation[i], i);
    }
  }
  while (heap.size > 0) {
    const [, i] = heap.pop()!;
    forEachNeighbor(mesh, i, (j) => {
      if (done[j]) return;
      done[j] = 1;
      // 이웃이 더 낮으면 i보다 살짝 높게 올려 내리막 경로를 만든다 (웅덩이 메우기).
      filled[j] = Math.max(elevation[j], filled[i] + EPSILON);
      downhill[j] = i;
      heap.push(filled[j], j);
    });
  }

  const isLake = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (elevation[i] > 0 && filled[i] - elevation[i] > lakeDepth) isLake[i] = 1;
  }

  // 높은 셀부터 아래로 유량을 누적한다.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => filled[b] - filled[a]);
  const flux = new Float64Array(n);
  for (const i of order) {
    if (elevation[i] <= 0) continue;
    flux[i] += rainfall[i];
    const d = downhill[i];
    if (d >= 0) flux[d] += flux[i];
  }

  const isRiver = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (elevation[i] > 0 && !isLake[i] && flux[i] >= riverThreshold) isRiver[i] = 1;
  }
  return { filled, downhill, flux, isLake, isRiver };
}

/** 셀 i에서 하류로 따라가며 강 경로(셀 인덱스 목록)를 만든다. 바다나 호수에 닿으면 끝. */
export function traceDownstream(h: Hydrology, elevation: Float64Array, start: number): number[] {
  const path = [start];
  let i = start;
  const seen = new Set<number>([start]);
  while (true) {
    const d = h.downhill[i];
    if (d < 0 || seen.has(d)) break;
    path.push(d);
    seen.add(d);
    if (elevation[d] <= 0 || h.isLake[d]) break;
    i = d;
  }
  return path;
}

/**
 * 강을 그리기 좋은 폴리라인 목록으로 묶는다.
 * 각 강은 상류 끝(유입 강이 없는 강 셀)에서 시작해, 다른 강과 합류하거나 바다에 닿을 때까지 이어진다.
 */
export function extractRivers(mesh: Mesh, h: Hydrology, elevation: Float64Array): number[][] {
  const n = mesh.count;
  const inflow = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = h.downhill[i];
    if (h.isRiver[i] && d >= 0 && h.isRiver[d]) inflow[d] = 1;
  }
  const visited = new Uint8Array(n);
  const rivers: number[][] = [];
  // 유량이 큰 본류부터 처리해야 지류가 본류에 '합류'하는 형태가 된다.
  const sources: number[] = [];
  for (let i = 0; i < n; i++) if (h.isRiver[i] && !inflow[i]) sources.push(i);
  sources.sort((a, b) => h.flux[b] - h.flux[a]);
  for (const s of sources) {
    const path: number[] = [];
    let i = s;
    while (i >= 0) {
      path.push(i);
      if (visited[i] || elevation[i] <= 0 || h.isLake[i]) break;
      visited[i] = 1;
      i = h.downhill[i];
    }
    if (path.length >= 3) rivers.push(path);
  }
  return rivers;
}
