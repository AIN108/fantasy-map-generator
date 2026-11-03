import { BIOME_INFO } from "./climate.ts";
import { forEachNeighbor, type Mesh } from "./mesh.ts";
import type { WorldMap } from "./world.ts";

export interface Layers {
  relief: boolean;
  rivers: boolean;
  borders: boolean;
  stateTint: boolean;
  roads: boolean;
  cities: boolean;
  labels: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  relief: true, rivers: true, borders: true, stateTint: false, roads: true, cities: true, labels: true,
};

const LABEL_FONT = '"Noto Serif KR", "Noto Serif", Georgia, serif';

type Segment = [number, number, number, number];

/** 두 셀이 공유하는 보로노이 변. 꼭짓점 좌표가 일치하는 두 점을 찾는다. */
export function sharedEdge(mesh: Mesh, i: number, j: number): Segment | null {
  const a = mesh.polygons[i], b = mesh.polygons[j];
  const found: number[] = [];
  for (let p = 0; p < a.length && found.length < 4; p += 2) {
    for (let q = 0; q < b.length; q += 2) {
      if (Math.abs(a[p] - b[q]) < 1e-6 && Math.abs(a[p + 1] - b[q + 1]) < 1e-6) {
        found.push(a[p], a[p + 1]);
        break;
      }
    }
  }
  return found.length === 4 ? [found[0], found[1], found[2], found[3]] : null;
}

/** 렌더링에 반복해서 쓰는 해안선·국경 선분과 음영을 미리 계산해 둔다. */
export interface RenderCache {
  coast: Segment[];
  borders: { seg: Segment; color: string }[];
  /** 음영 포함/미포함 셀 색 (이웃과 섞어 모자이크 느낌을 줄인 값) */
  colorRelief: string[];
  colorFlat: string[];
}

export function buildRenderCache(world: WorldMap): RenderCache {
  const { mesh, elevation, owner, states } = world;
  const coast: Segment[] = [];
  const borders: { seg: Segment; color: string }[] = [];
  const shade = new Float64Array(mesh.count);
  // 북서쪽 위에서 비추는 조명
  const L = [-1, -1, 1.6];
  const ll = Math.hypot(L[0], L[1], L[2]);
  const reliefScale = Math.min(mesh.width, mesh.height) * 1.2;

  for (let i = 0; i < mesh.count; i++) {
    // 이웃 고도 차이로 기울기를 근사해 음영을 계산한다.
    let gx = 0, gy = 0;
    forEachNeighbor(mesh, i, (j) => {
      const dx = mesh.x[j] - mesh.x[i], dy = mesh.y[j] - mesh.y[i];
      const d2 = dx * dx + dy * dy || 1;
      const de = Math.max(0, elevation[j]) - Math.max(0, elevation[i]);
      gx += (de * dx) / d2;
      gy += (de * dy) / d2;
    });
    const nx = -gx * reliefScale, ny = -gy * reliefScale, nz = 1;
    const nl = Math.hypot(nx, ny, nz);
    shade[i] = (nx * L[0] + ny * L[1] + nz * L[2]) / (nl * ll);

    forEachNeighbor(mesh, i, (j) => {
      if (j < i) return; // 쌍마다 한 번만
      const landI = elevation[i] > 0, landJ = elevation[j] > 0;
      if (landI !== landJ) {
        const seg = sharedEdge(mesh, i, j);
        if (seg) coast.push(seg);
      } else if (landI && landJ && owner[i] !== owner[j] && !world.hydro.isLake[i] && !world.hydro.isLake[j]) {
        const seg = sharedEdge(mesh, i, j);
        const s = owner[i] >= 0 ? owner[i] : owner[j];
        if (seg && s >= 0) borders.push({ seg, color: states[s].color });
      }
    });
  }
  // 음영을 이웃과 평균내 셀 경계가 덜 도드라지게 한다.
  for (let pass = 0; pass < 2; pass++) {
    const next = Float64Array.from(shade);
    for (let i = 0; i < mesh.count; i++) {
      let sum = shade[i] * 2, n = 2;
      forEachNeighbor(mesh, i, (j) => { if ((elevation[j] > 0) === (elevation[i] > 0)) { sum += shade[j]; n++; } });
      next[i] = sum / n;
    }
    shade.set(next);
  }
  return { coast, borders, colorRelief: blendedColors(world, shade, true), colorFlat: blendedColors(world, shade, false) };
}

function baseRgb(world: WorldMap, shade: Float64Array, i: number, relief: boolean): [number, number, number] {
  const e = world.elevation[i];
  if (e <= 0) {
    // 얕은 바다 → 깊은 바다
    const t = Math.min(1, Math.sqrt(-e));
    return [111 + (24 - 111) * t, 166 + (70 - 166) * t, 208 + (130 - 208) * t];
  }
  const [r, g, b] = hexToRgb(BIOME_INFO[world.biome[i]].color);
  if (!relief) return [r, g, b];
  // 대비를 낮춰 산악 지대가 지나치게 어두워지지 않게 한다.
  const k = 0.8 + 0.38 * (shade[i] - 0.55);
  return [r * k, g * k, b * k];
}

/** 같은 종류(육지/바다) 이웃과 색을 한 번 섞는다. */
function blendedColors(world: WorldMap, shade: Float64Array, relief: boolean): string[] {
  const { mesh, elevation } = world;
  const rgb = Array.from({ length: mesh.count }, (_, i) => baseRgb(world, shade, i, relief));
  const out: string[] = new Array(mesh.count);
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  for (let i = 0; i < mesh.count; i++) {
    let [r, g, b] = rgb[i].map((v) => v * 2);
    let n = 2;
    forEachNeighbor(mesh, i, (j) => {
      if ((elevation[j] > 0) !== (elevation[i] > 0)) return;
      r += rgb[j][0]; g += rgb[j][1]; b += rgb[j][2]; n++;
    });
    out[i] = `rgb(${c(r / n)},${c(g / n)},${c(b / n)})`;
  }
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function cellPath(ctx: CanvasRenderingContext2D, poly: Float64Array): void {
  ctx.beginPath();
  ctx.moveTo(poly[0], poly[1]);
  for (let k = 2; k < poly.length; k += 2) ctx.lineTo(poly[k], poly[k + 1]);
  ctx.closePath();
}

/** 셀 중심을 잇는 경로를 중점 기준 2차 곡선으로 부드럽게 그린다. */
function smoothPath(ctx: CanvasRenderingContext2D, mesh: Mesh, cells: number[]): void {
  ctx.beginPath();
  ctx.moveTo(mesh.x[cells[0]], mesh.y[cells[0]]);
  for (let k = 1; k < cells.length - 1; k++) {
    const a = cells[k], b = cells[k + 1];
    ctx.quadraticCurveTo(mesh.x[a], mesh.y[a], (mesh.x[a] + mesh.x[b]) / 2, (mesh.y[a] + mesh.y[b]) / 2);
  }
  const last = cells[cells.length - 1];
  ctx.lineTo(mesh.x[last], mesh.y[last]);
}

interface Box { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

class LabelPlacer {
  private boxes: Box[] = [];
  private readonly ctx: CanvasRenderingContext2D;
  private readonly width: number;
  private readonly height: number;

  constructor(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
  }

  reserve(box: Box): void {
    this.boxes.push(box);
  }

  /** 후보 위치 중 겹치지 않는 첫 자리에 그린다. 모두 겹치면 그리지 않는다. */
  place(text: string, font: string, candidates: [number, number, CanvasTextAlign][], color: string, halo = "rgba(255,255,255,0.85)"): boolean {
    const ctx = this.ctx;
    ctx.font = font;
    const m = ctx.measureText(text);
    const w = m.width, h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || 12;
    for (const [x, y, align] of candidates) {
      const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
      const box = { x: left - 2, y: y - h - 1, w: w + 4, h: h + 4 };
      if (box.x < 0 || box.y < 0 || box.x + box.w > this.width || box.y + box.h > this.height) continue;
      if (this.boxes.some((b) => overlaps(b, box))) continue;
      this.boxes.push(box);
      ctx.textAlign = align;
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = halo;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      return true;
    }
    return false;
  }
}

export function renderWorld(ctx: CanvasRenderingContext2D, world: WorldMap, cache: RenderCache, layers: Layers): void {
  const { mesh, elevation, hydro } = world;
  ctx.save();
  ctx.clearRect(0, 0, mesh.width, mesh.height);

  // 1) 셀 채우기 (같은 색으로 테두리를 그려 셀 사이 실금을 없앤다)
  ctx.lineWidth = 0.8;
  for (let i = 0; i < mesh.count; i++) {
    const poly = mesh.polygons[i];
    if (poly.length < 6) continue;
    const col = layers.relief ? cache.colorRelief[i] : cache.colorFlat[i];
    cellPath(ctx, poly);
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.fill();
    ctx.stroke();
  }

  // 2) 국가 색 덧칠
  if (layers.stateTint) {
    ctx.globalAlpha = 0.22;
    for (let i = 0; i < mesh.count; i++) {
      const s = world.owner[i];
      if (s < 0 || elevation[i] <= 0) continue;
      cellPath(ctx, mesh.polygons[i]);
      ctx.fillStyle = world.states[s].color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 3) 호수와 해안선
  ctx.fillStyle = BIOME_INFO.lake.color;
  for (let i = 0; i < mesh.count; i++) {
    if (!hydro.isLake[i]) continue;
    cellPath(ctx, mesh.polygons[i]);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(30,45,60,0.75)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of cache.coast) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
  ctx.stroke();

  // 4) 강: 하류로 갈수록 굵게
  if (layers.rivers) {
    let maxFlux = 1e-9;
    for (const r of world.rivers) maxFlux = Math.max(maxFlux, r.flux);
    ctx.strokeStyle = "#4a7fb8";
    ctx.lineCap = "round";
    for (const r of world.rivers) {
      for (let k = 0; k + 1 < r.cells.length; k++) {
        const a = r.cells[k], b = r.cells[k + 1];
        ctx.lineWidth = 0.6 + 3 * Math.sqrt(hydro.flux[a] / maxFlux);
        const ax = k === 0 ? mesh.x[a] : (mesh.x[r.cells[k - 1]] + mesh.x[a]) / 2;
        const ay = k === 0 ? mesh.y[a] : (mesh.y[r.cells[k - 1]] + mesh.y[a]) / 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(mesh.x[a], mesh.y[a], (mesh.x[a] + mesh.x[b]) / 2, (mesh.y[a] + mesh.y[b]) / 2);
        if (k + 2 === r.cells.length) ctx.lineTo(mesh.x[b], mesh.y[b]);
        ctx.stroke();
      }
    }
  }

  // 5) 국경
  if (layers.borders) {
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    for (const { seg, color } of cache.borders) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(seg[0], seg[1]);
      ctx.lineTo(seg[2], seg[3]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 6) 도로
  if (layers.roads) {
    ctx.strokeStyle = "rgba(110,70,40,0.8)";
    ctx.lineWidth = 1.1;
    ctx.setLineDash([3, 2]);
    for (const road of world.roads) {
      smoothPath(ctx, mesh, road);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  const placer = new LabelPlacer(ctx, mesh.width, mesh.height);

  // 7) 도시 표시
  if (layers.cities) {
    for (const c of world.cities) {
      const x = mesh.x[c.cell], y = mesh.y[c.cell];
      ctx.beginPath();
      if (c.capital) {
        ctx.rect(x - 4, y - 4, 8, 8);
        placer.reserve({ x: x - 5, y: y - 5, w: 10, h: 10 });
      } else {
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        placer.reserve({ x: x - 3, y: y - 3, w: 6, h: 6 });
      }
      ctx.fillStyle = c.capital ? "#b3261e" : "#fff";
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();
    }
  }

  if (layers.labels) {
    // 국가 이름 (가장 크게, 먼저 배치)
    for (const s of world.states) {
      if (s.cellCount < 30) continue;
      const x = mesh.x[s.labelCell], y = mesh.y[s.labelCell];
      const size = Math.round(Math.min(30, 14 + Math.sqrt(s.cellCount) * 0.45));
      placer.place(s.name, `600 ${size}px ${LABEL_FONT}`, [[x, y, "center"], [x, y - size, "center"], [x, y + size, "center"]], "rgba(40,30,25,0.75)", "rgba(255,255,255,0.55)");
    }
    // 수도 → 도시 순서로
    if (layers.cities) {
      const ordered = [...world.cities].sort((a, b) => Number(b.capital) - Number(a.capital));
      for (const c of ordered) {
        const x = mesh.x[c.cell], y = mesh.y[c.cell];
        const font = c.capital ? `700 14px ${LABEL_FONT}` : `500 11.5px ${LABEL_FONT}`;
        placer.place(c.name, font, [[x + 7, y + 4, "left"], [x - 7, y + 4, "right"], [x, y - 8, "center"], [x, y + 16, "center"]], "#1e1e1e");
      }
    }
    // 강 이름: 강의 중간 지점
    if (layers.rivers) {
      for (const r of world.rivers) {
        if (!r.name) continue;
        const mid = r.cells[Math.floor(r.cells.length / 2)];
        placer.place(r.name, `italic 500 11px ${LABEL_FONT}`, [[mesh.x[mid], mesh.y[mid] - 5, "center"], [mesh.x[mid], mesh.y[mid] + 13, "center"]], "#24527f");
      }
    }
    // 산봉우리
    for (const p of world.peaks) {
      const x = mesh.x[p.cell], y = mesh.y[p.cell];
      if (placer.place(`▲ ${p.name}`, `500 11px ${LABEL_FONT}`, [[x, y, "center"], [x, y + 14, "center"]], "#4a3b2c")) continue;
    }
  }
  ctx.restore();
}

/** 마우스 위치 셀의 정보 (패널 표시용). 고도·기온은 상대값을 그럴듯한 단위로 환산한 것. */
export function describeCell(world: WorldMap, i: number): Record<string, string> {
  const e = world.elevation[i];
  const s = world.owner[i];
  const info: Record<string, string> = {
    생태: BIOME_INFO[world.biome[i]].ko,
    고도: e > 0 ? `${Math.round(e * 4200)} m` : `수심 ${Math.round(-e * 5000)} m`,
  };
  if (e > 0) {
    info["기온"] = `${(world.temperature[i] * 42 - 12).toFixed(1)} °C (연평균)`;
    info["습도"] = `${Math.round(world.moisture[i] * 100)} %`;
    info["소속"] = s >= 0 ? world.states[s].name : "무소속";
    if (world.hydro.isRiver[i]) info["강"] = "흐름 있음";
  }
  const city = world.cities.find((c) => c.cell === i);
  if (city) info["도시"] = city.capital ? `${city.name} (수도)` : city.name;
  return info;
}
