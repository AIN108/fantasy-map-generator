import type { Mesh } from "./mesh.ts";
import { forEachNeighbor } from "./mesh.ts";
import { createNoise2D, fbm, type Rng } from "./rng.ts";

export interface TerrainOptions {
  /** 육지 비율 (0.15 ~ 0.7) */
  landRatio: number;
  /** 큰 대륙 하나(continent) 또는 여러 섬(archipelago) */
  shape: "continent" | "archipelago";
}

/**
 * 셀 고도를 만든다. 결과는 해수면 기준으로 정규화되어
 * 육지는 (0, 1], 바다는 [-1, 0] 범위다.
 */
export function generateElevation(mesh: Mesh, rng: Rng, opts: TerrainOptions): Float64Array {
  if (!(opts.landRatio > 0.05 && opts.landRatio < 0.95)) {
    throw new RangeError(`landRatio는 0.05~0.95 사이여야 합니다: ${opts.landRatio}`);
  }
  const base = createNoise2D(rng);
  const ridge = createNoise2D(rng);
  const warp = createNoise2D(rng);
  const { width, height, count } = mesh;
  const scale = Math.min(width, height);
  const raw = new Float64Array(count);

  // 대륙 중심을 약간 흔들어 매번 같은 원형 대륙이 나오지 않게 한다.
  const cx = width * (0.4 + rng() * 0.2), cy = height * (0.4 + rng() * 0.2);
  const freq = opts.shape === "archipelago" ? 4.5 : 2.2;

  for (let i = 0; i < count; i++) {
    const nx = mesh.x[i] / scale, ny = mesh.y[i] / scale;
    // 도메인 워핑으로 해안선을 덜 둥글게
    const wx = nx + 0.25 * warp(nx * 1.5, ny * 1.5);
    const wy = ny + 0.25 * warp(nx * 1.5 + 31.7, ny * 1.5 - 12.3);
    let e = 0.5 + 0.5 * fbm(base, wx * freq, wy * freq, 6);

    // 능선 노이즈(1-|n|)를 높은 곳에만 더해 산맥을 만든다.
    const r = 1 - Math.abs(fbm(ridge, wx * 3, wy * 3, 4));
    e += 0.35 * r * r * Math.max(0, e - 0.45);

    if (opts.shape === "continent") {
      const dx = (mesh.x[i] - cx) / (width * 0.5), dy = (mesh.y[i] - cy) / (height * 0.5);
      const d = Math.sqrt(dx * dx + dy * dy);
      e -= 0.55 * Math.pow(d, 2.2);
    } else {
      // 군도: 가장자리만 약하게 낮춘다.
      const ex = Math.min(mesh.x[i], width - mesh.x[i]) / (width * 0.5);
      const ey = Math.min(mesh.y[i], height - mesh.y[i]) / (height * 0.5);
      e -= 0.35 * Math.pow(1 - Math.min(ex, ey), 3);
    }
    raw[i] = mesh.isEdge[i] ? -1 : e;
  }

  smooth(mesh, raw, 1);
  for (let i = 0; i < count; i++) if (mesh.isEdge[i]) raw[i] = -1;

  // 원하는 육지 비율이 되도록 해수면을 분위수로 정한다.
  const sorted = Float64Array.from(raw).sort();
  const seaLevel = sorted[Math.min(count - 1, Math.floor(count * (1 - opts.landRatio)))];
  let maxH = 1e-9, minH = -1e-9;
  for (let i = 0; i < count; i++) {
    const h = raw[i] - seaLevel;
    if (h > maxH) maxH = h;
    if (h < minH) minH = h;
  }
  const elevation = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const h = raw[i] - seaLevel;
    // 육지는 제곱근 대신 1.3승으로 눌러 저지대를 넓히고 고산은 드물게
    elevation[i] = h > 0 ? Math.pow(h / maxH, 1.3) : -Math.pow(h / minH, 0.8);
    if (mesh.isEdge[i]) elevation[i] = Math.min(elevation[i], -0.05);
  }
  return elevation;
}

/** 이웃 평균과 섞는 라플라시안 평활화 */
export function smooth(mesh: Mesh, values: Float64Array, passes: number, weight = 0.5): void {
  const tmp = new Float64Array(values.length);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < mesh.count; i++) {
      let sum = 0, n = 0;
      forEachNeighbor(mesh, i, (j) => { sum += values[j]; n++; });
      tmp[i] = n > 0 ? values[i] * (1 - weight) + (sum / n) * weight : values[i];
    }
    values.set(tmp);
  }
}

export const isLand = (elevation: Float64Array, i: number): boolean => elevation[i] > 0;
