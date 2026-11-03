import { Delaunay } from "d3-delaunay";
import type { Rng } from "./rng.ts";

/** 지도를 이루는 불규칙 다각형 셀들. 모든 단계가 이 셀 그래프 위에서 계산된다. */
export interface Mesh {
  width: number;
  height: number;
  count: number;
  /** 셀 중심 좌표 */
  x: Float64Array;
  y: Float64Array;
  /** 셀 i의 이웃은 neighbors[neighborStart[i] .. neighborStart[i+1]) */
  neighborStart: Int32Array;
  neighbors: Int32Array;
  /** 지도 가장자리에 닿는 셀 (항상 바다로 둔다) */
  isEdge: Uint8Array;
  /** 셀 다각형 꼭짓점 [x0, y0, x1, y1, ...] */
  polygons: Float64Array[];
}

/**
 * Bridson의 Poisson disk 샘플링: 점 사이 거리가 최소 radius 이상이면서 고르게 퍼진 점 집합.
 * 무작위 점보다 셀 크기가 균일해서 지형과 경로 계산이 안정적이다.
 */
export function poissonDisk(rng: Rng, width: number, height: number, radius: number, tries = 30): number[] {
  const cell = radius / Math.SQRT2;
  const gw = Math.ceil(width / cell), gh = Math.ceil(height / cell);
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts: number[] = [];
  const active: number[] = [];

  const add = (x: number, y: number): void => {
    const idx = pts.length / 2;
    pts.push(x, y);
    active.push(idx);
    grid[Math.floor(y / cell) * gw + Math.floor(x / cell)] = idx;
  };
  const fits = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2); yy++) {
      for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
        const j = grid[yy * gw + xx];
        if (j < 0) continue;
        const dx = pts[2 * j] - x, dy = pts[2 * j + 1] - y;
        if (dx * dx + dy * dy < radius * radius) return false;
      }
    }
    return true;
  };

  add(rng() * width, rng() * height);
  while (active.length > 0) {
    const ai = Math.floor(rng() * active.length);
    const i = active[ai];
    const px = pts[2 * i], py = pts[2 * i + 1];
    let placed = false;
    for (let t = 0; t < tries; t++) {
      const ang = rng() * Math.PI * 2;
      const r = radius * (1 + rng());
      const nx = px + Math.cos(ang) * r, ny = py + Math.sin(ang) * r;
      if (fits(nx, ny)) {
        add(nx, ny);
        placed = true;
        break;
      }
    }
    if (!placed) {
      active[ai] = active[active.length - 1];
      active.pop();
    }
  }
  return pts;
}

/** 목표 셀 수에 맞춰 반지름을 정하고 보로노이 메시를 만든다. */
export function buildMesh(rng: Rng, width: number, height: number, targetCells: number): Mesh {
  if (!(targetCells >= 100)) throw new RangeError(`셀 수는 100 이상이어야 합니다: ${targetCells}`);
  // Poisson disk의 점 밀도는 대략 면적 / (0.7 * r^2 * 2.6) 근처이므로 경험적 계수로 반지름을 고른다.
  const radius = Math.sqrt((width * height) / (targetCells * 1.6));
  const pts = poissonDisk(rng, width, height, radius);
  const count = pts.length / 2;

  const delaunay = new Delaunay(Float64Array.from(pts));
  const voronoi = delaunay.voronoi([0, 0, width, height]);

  const x = new Float64Array(count), y = new Float64Array(count);
  const neighborStart = new Int32Array(count + 1);
  const neighborList: number[] = [];
  const isEdge = new Uint8Array(count);
  const polygons: Float64Array[] = new Array(count);
  const margin = radius * 1.5;

  for (let i = 0; i < count; i++) {
    x[i] = pts[2 * i];
    y[i] = pts[2 * i + 1];
    neighborStart[i] = neighborList.length;
    for (const j of delaunay.neighbors(i)) neighborList.push(j);
    const poly = voronoi.cellPolygon(i);
    const flat = new Float64Array(poly ? (poly.length - 1) * 2 : 0);
    if (poly) {
      for (let k = 0; k < poly.length - 1; k++) {
        flat[2 * k] = poly[k][0];
        flat[2 * k + 1] = poly[k][1];
      }
    }
    polygons[i] = flat;
    if (x[i] < margin || y[i] < margin || x[i] > width - margin || y[i] > height - margin) isEdge[i] = 1;
  }
  neighborStart[count] = neighborList.length;

  return {
    width, height, count, x, y,
    neighborStart,
    neighbors: Int32Array.from(neighborList),
    isEdge,
    polygons,
  };
}

/** 셀 i의 이웃 인덱스를 순회한다. */
export function forEachNeighbor(mesh: Mesh, i: number, fn: (j: number) => void): void {
  for (let k = mesh.neighborStart[i]; k < mesh.neighborStart[i + 1]; k++) fn(mesh.neighbors[k]);
}

export function distance(mesh: Mesh, i: number, j: number): number {
  return Math.hypot(mesh.x[i] - mesh.x[j], mesh.y[i] - mesh.y[j]);
}

/** 좌표에서 가장 가까운 셀 (마우스 오버용). 단순 탐색이지만 1만 셀 기준 충분히 빠르다. */
export function findCell(mesh: Mesh, px: number, py: number): number {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < mesh.count; i++) {
    const d = (mesh.x[i] - px) ** 2 + (mesh.y[i] - py) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
