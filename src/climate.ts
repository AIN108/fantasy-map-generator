import type { Mesh } from "./mesh.ts";
import { forEachNeighbor } from "./mesh.ts";
import { createNoise2D, fbm, type Rng } from "./rng.ts";

export const BIOMES = [
  "ocean", "lake", "beach", "glacier", "tundra", "taiga", "grassland",
  "temperateForest", "rainforest", "savanna", "desert", "wetland", "mountain",
] as const;
export type Biome = (typeof BIOMES)[number];

export const BIOME_INFO: Record<Biome, { ko: string; color: string }> = {
  ocean: { ko: "바다", color: "#3b6ea5" },
  lake: { ko: "호수", color: "#5b8fc7" },
  beach: { ko: "해안", color: "#e8d9a8" },
  glacier: { ko: "빙하", color: "#f2f5f7" },
  tundra: { ko: "툰드라", color: "#b9bfa8" },
  taiga: { ko: "침엽수림", color: "#5f7f5a" },
  grassland: { ko: "초원", color: "#a9c46c" },
  temperateForest: { ko: "온대림", color: "#6e9a4c" },
  rainforest: { ko: "열대우림", color: "#3f7f3a" },
  savanna: { ko: "사바나", color: "#cdbf6b" },
  desert: { ko: "사막", color: "#e3c98a" },
  wetland: { ko: "습지", color: "#7f9e7a" },
  mountain: { ko: "고산", color: "#9a8f84" },
};

/** 셀별 바다까지의 거리 (그래프 홉 수). 바다는 0. */
export function distanceToOcean(mesh: Mesh, elevation: Float64Array): Int32Array {
  const dist = new Int32Array(mesh.count).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < mesh.count; i++) if (elevation[i] <= 0) { dist[i] = 0; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    forEachNeighbor(mesh, i, (j) => {
      if (dist[j] < 0) { dist[j] = dist[i] + 1; queue.push(j); }
    });
  }
  return dist;
}

/** 0(북쪽 끝, 한대) ~ 1(남쪽 끝, 열대) 사이의 위도 온도에 고도 감률을 적용 */
export function computeTemperature(mesh: Mesh, elevation: Float64Array, rng: Rng, latitudeShift: number): Float64Array {
  const noise = createNoise2D(rng);
  const t = new Float64Array(mesh.count);
  const s = Math.min(mesh.width, mesh.height);
  for (let i = 0; i < mesh.count; i++) {
    const lat = mesh.y[i] / mesh.height;
    let v = 0.22 + 0.72 * lat + latitudeShift + 0.08 * fbm(noise, mesh.x[i] / s * 3, mesh.y[i] / s * 3, 3);
    if (elevation[i] > 0) v -= 0.45 * elevation[i];
    t[i] = Math.min(1, Math.max(0, v));
  }
  return t;
}

/**
 * 습도: 바다에서 멀수록 건조, 서쪽에서 부는 바람이 산을 넘으면 비그늘로 더 건조해진다.
 * 강·호수 주변 보정은 수계 계산 뒤 addWaterMoisture로 더한다.
 */
export function computeMoisture(mesh: Mesh, elevation: Float64Array, rng: Rng): Float64Array {
  const noise = createNoise2D(rng);
  const oceanDist = distanceToOcean(mesh, elevation);
  const m = new Float64Array(mesh.count);
  const s = Math.min(mesh.width, mesh.height);

  // 서→동 방향으로 셀을 훑으며, 바람을 거슬러 오는 쪽(서쪽 이웃)의 최대 고도를 누적해 비그늘을 근사한다.
  const order = Array.from({ length: mesh.count }, (_, i) => i).sort((a, b) => mesh.x[a] - mesh.x[b]);
  const upwindPeak = new Float64Array(mesh.count);
  for (const i of order) {
    let peak = 0;
    forEachNeighbor(mesh, i, (j) => {
      if (mesh.x[j] < mesh.x[i]) peak = Math.max(peak, upwindPeak[j] * 0.97, elevation[j]);
    });
    upwindPeak[i] = elevation[i] > 0 ? peak : 0;
  }

  for (let i = 0; i < mesh.count; i++) {
    if (elevation[i] <= 0) { m[i] = 1; continue; }
    const coast = Math.exp(-oceanDist[i] / 9);
    const shadow = Math.max(0, upwindPeak[i] - elevation[i]) * 1.1;
    const n = 0.5 + 0.5 * fbm(noise, mesh.x[i] / s * 2.5, mesh.y[i] / s * 2.5, 4);
    m[i] = Math.min(1, Math.max(0, 0.15 + 0.5 * coast + 0.45 * n - shadow));
  }
  return m;
}

/** 강·호수 주변 습도를 올린다 (홉 거리에 따라 감쇠). */
export function addWaterMoisture(mesh: Mesh, moisture: Float64Array, water: Uint8Array, hops = 3): void {
  const dist = new Int32Array(mesh.count).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < mesh.count; i++) if (water[i]) { dist[i] = 0; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    if (dist[i] >= hops) continue;
    forEachNeighbor(mesh, i, (j) => {
      if (dist[j] < 0) { dist[j] = dist[i] + 1; queue.push(j); }
    });
  }
  for (let i = 0; i < mesh.count; i++) {
    if (dist[i] >= 0) moisture[i] = Math.min(1, moisture[i] + 0.25 * (1 - dist[i] / (hops + 1)));
  }
}

/** 휘태커 다이어그램을 단순화한 온도×습도 생태 분류 */
export function classifyBiome(elevation: number, temperature: number, moisture: number, isLake: boolean, coastal: boolean): Biome {
  if (elevation <= 0) return "ocean";
  if (isLake) return "lake";
  if (temperature < 0.12) return "glacier";
  if (elevation > 0.72) return "mountain";
  if (coastal && elevation < 0.04 && moisture < 0.85) return "beach";
  if (temperature < 0.28) return "tundra";
  if (moisture > 0.85 && elevation < 0.12) return "wetland";
  if (temperature < 0.45) return moisture > 0.35 ? "taiga" : "tundra";
  if (temperature > 0.68) {
    if (moisture < 0.22) return "desert";
    if (moisture < 0.5) return "savanna";
    return moisture > 0.68 ? "rainforest" : "temperateForest";
  }
  if (moisture < 0.2) return "desert";
  if (moisture < 0.45) return "grassland";
  return "temperateForest";
}

/** 생태별 거주 적합도 (도시 배치·국가 확장 비용에 사용) */
export const BIOME_HABITABILITY: Record<Biome, number> = {
  ocean: 0, lake: 0, beach: 0.6, glacier: 0, tundra: 0.15, taiga: 0.4, grassland: 1,
  temperateForest: 0.85, rainforest: 0.45, savanna: 0.6, desert: 0.12, wetland: 0.3, mountain: 0.08,
};
