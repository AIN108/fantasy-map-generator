import { BIOME_INFO } from "./climate.ts";
import { FACILITY_INFO, pathMarks, type FacilityKind, type SpanMode } from "./infra.ts";
import { forEachNeighbor, type Mesh } from "./mesh.ts";
import type { WorldMap } from "./world.ts";

export interface Layers {
  relief: boolean;
  rivers: boolean;
  borders: boolean;
  stateTint: boolean;
  roads: boolean;
  rails: boolean;
  seaRoutes: boolean;
  facilities: boolean;
  cities: boolean;
  labels: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  relief: true, rivers: true, borders: true, stateTint: false, roads: true, rails: true, seaRoutes: true, facilities: true,
  cities: true, labels: true,
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
  /** 글자 테두리·여백의 배율 (확대해도 화면에서 같은 굵기로 보이게) */
  private readonly scale: number;

  constructor(ctx: CanvasRenderingContext2D, width: number, height: number, scale = 1) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.scale = scale;
  }

  reserve(box: Box): void {
    this.boxes.push(box);
  }

  /** 후보 위치 중 겹치지 않는 첫 자리에 그린다. 모두 겹치면 그리지 않는다. */
  place(text: string, font: string, candidates: [number, number, CanvasTextAlign][], color: string, halo = "rgba(255,255,255,0.85)"): boolean {
    const ctx = this.ctx;
    ctx.font = font;
    // 글꼴 크기는 화면 픽셀 기준. 겹침 판정은 지도 단위로 환산해서 한다.
    const m = ctx.measureText(text);
    const k = this.scale;
    const w = m.width * k, h = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || 12) * k;
    for (const [x, y, align] of candidates) {
      const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
      const box = { x: left - 2 * k, y: y - h - k, w: w + 4 * k, h: h + 4 * k };
      if (box.x < 0 || box.y < 0 || box.x + box.w > this.width || box.y + box.h > this.height) continue;
      if (this.boxes.some((b) => overlaps(b, box))) continue;
      this.boxes.push(box);
      // 확대 변환을 상쇄한 좌표계에서 원래 크기 글꼴로 그린다
      // (작은 글꼴을 늘려 그리면 글자가 흐릿해진다).
      const t = ctx.getTransform();
      ctx.save();
      ctx.setTransform(t.a * k, t.b * k, t.c * k, t.d * k, t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f);
      ctx.textAlign = align;
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = halo;
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = color;
      ctx.fillText(text, 0, 0);
      ctx.restore();
      return true;
    }
    return false;
  }
}

/** 지도에 그리는 부분: 전체, 지명을 뺀 바탕, 지명만 */
export type RenderPart = "all" | "base" | "labels";

/**
 * 지도를 지도 좌표로 그린다 (확대·이동은 호출하는 쪽이 ctx 변환으로 건다).
 * zoom: 현재 확대 배율. 지명 글자는 이 값으로 나눠 그려서 화면에서 늘 같은 크기로 보이고,
 * 확대할수록 글자끼리 덜 겹쳐 더 많은 지명이 드러난다. 지형·선·아이콘은 지도와 함께 커진다.
 * part: "base"는 지명 없이 바탕만(확대·이동 중 늘려 쓸 사본용), "labels"는 그 위에 지명만 덧그린다.
 * textScale: 지명과 도시·시설 표시를 키우는 배율. 지도를 작게 줄여 보여 주는 좁은 화면에서
 * 글자·아이콘이 읽을 수 없을 만큼 작아지지 않게 1보다 크게 준다. 키운 만큼 겹치는 지명은 덜 그려진다.
 * 글자는 확대와 관계없이 이 배율을 유지하고, 표시(아이콘)는 확대할수록 원래 크기로 돌아간다.
 */
export function renderWorld(
  ctx: CanvasRenderingContext2D, world: WorldMap, cache: RenderCache, layers: Layers, zoom = 1, part: RenderPart = "all",
  textScale = 1,
): void {
  const t = Number.isFinite(textScale) && textScale > 0 ? textScale : 1;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  // 도시·시설 표시는 지도와 함께 커지므로, 키운 배율은 확대할수록 줄여 원래 크기로 돌아가게 한다.
  const m = Math.max(1, t / z);
  if (part !== "labels") drawBase(ctx, world, cache, layers, m);
  if (part !== "base" && layers.labels) drawLabels(ctx, world, layers, t / z, m);
}

function drawBase(ctx: CanvasRenderingContext2D, world: WorldMap, cache: RenderCache, layers: Layers, m: number): void {
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

  const hidden = new Set(world.hiddenMarks);

  // 5-1) 해상 항로: 남색 긴 점선
  if (layers.seaRoutes && world.seaRoutes.length > 0) {
    ctx.strokeStyle = "rgba(18,38,78,0.8)";
    ctx.lineWidth = 1.4;
    ctx.setLineDash([7, 5]);
    ctx.lineCap = "round";
    for (const route of world.seaRoutes) {
      smoothPath(ctx, mesh, route);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // 5-2) 직접 놓은 다리·터널: 도로·철도보다 먼저 그려 그 위로 길이 지나가게 한다
  // (도로·철도 레이어 중 하나라도 켜져 있으면 그린다)
  if (layers.roads || layers.rails) {
    for (const s of world.tunnels) {
      if (s.mode === "rail" ? layers.rails : layers.roads) drawTunnelSpan(ctx, mesh.x[s.a], mesh.y[s.a], mesh.x[s.b], mesh.y[s.b], s.mode);
    }
    for (const s of world.bridges) {
      if (s.mode === "rail" ? layers.rails : layers.roads) drawBridgeSpan(ctx, mesh.x[s.a], mesh.y[s.a], mesh.x[s.b], mesh.y[s.b], s.mode);
    }
  }
  // 터널 연결 구간은 길 선을 그리지 않는다 (땅속이므로 터널 표기만 보이게). 용도별로 따로 본다.
  const tunnelPairsOf = (mode: SpanMode): Set<string> =>
    new Set(world.tunnels.filter((t) => t.mode === mode).flatMap((t) => [`${t.a}>${t.b}`, `${t.b}>${t.a}`]));
  const roadTunnels = tunnelPairsOf("road"), railTunnels = tunnelPairsOf("rail");
  const outsideTunnels = (path: number[], tunnelPairs: Set<string>): number[][] => {
    const pieces: number[][] = [];
    let cur: number[] = [path[0]];
    for (let k = 1; k < path.length; k++) {
      if (tunnelPairs.has(`${path[k - 1]}>${path[k]}`)) {
        if (cur.length >= 2) pieces.push(cur);
        cur = [path[k]];
      } else cur.push(path[k]);
    }
    if (cur.length >= 2) pieces.push(cur);
    return pieces;
  };

  // 6) 도로
  if (layers.roads) {
    ctx.strokeStyle = "rgba(110,70,40,0.8)";
    ctx.lineWidth = 1.1;
    ctx.setLineDash([3, 2]);
    for (const road of world.roads) {
      for (const piece of outsideTunnels(road, roadTunnels)) {
        smoothPath(ctx, mesh, piece);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    for (const road of world.roads) {
      for (const k of pathMarks(world, road, "road", hidden).bridges) drawBridge(ctx, mesh, road, k, "rgba(110,70,40,0.95)");
    }
  }

  // 6-1) 철도: 검은 선 위에 흰 점선 (지도에서 흔히 쓰는 철도 표기). 고산 구간은 터널(회색 점선 + 입구)
  if (layers.rails && world.rails.length > 0) {
    ctx.lineCap = "butt";
    for (const rail of world.rails) {
      const marks = pathMarks(world, rail, "rail", hidden);
      // 터널 구간을 뺀 나머지를 철도 표기로 그린다 (조각 경계는 한 셀씩 겹쳐 끊김 없이)
      let from = 0;
      const pieces: number[][] = [];
      for (const [a, b] of marks.tunnels) {
        if (a > from) pieces.push(rail.slice(from, a + 1));
        from = b;
      }
      if (from < rail.length - 1) pieces.push(rail.slice(from));
      for (const piece of pieces.flatMap((pc) => outsideTunnels(pc, railTunnels))) {
        if (piece.length < 2) continue;
        smoothPath(ctx, mesh, piece);
        ctx.strokeStyle = "#2b2b2b";
        ctx.lineWidth = 2.6;
        ctx.stroke();
        ctx.strokeStyle = "#f4f1ea";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const [a, b] of marks.tunnels) drawTunnel(ctx, mesh, rail, a, b);
      for (const k of marks.bridges) drawBridge(ctx, mesh, rail, k, "#2b2b2b");
    }
  }

  // 6-3) 항구·시설물 아이콘
  if (layers.facilities) {
    for (const port of world.ports) {
      drawScaledIcon(ctx, "port", mesh.x[port.cell], mesh.y[port.cell], m);
    }
    for (const f of world.facilities) {
      drawScaledIcon(ctx, f.kind, mesh.x[f.cell], mesh.y[f.cell], m);
    }
  }

  // 7) 도시 표시
  if (layers.cities) {
    for (const c of world.cities) {
      const x = mesh.x[c.cell], y = mesh.y[c.cell];
      ctx.beginPath();
      if (c.capital) {
        ctx.rect(x - 4 * m, y - 4 * m, 8 * m, 8 * m);
      } else {
        ctx.arc(x, y, 2.6 * m, 0, Math.PI * 2);
      }
      ctx.fillStyle = c.capital ? "#b3261e" : "#fff";
      ctx.strokeStyle = "#222";
      ctx.lineWidth = 1.2 * m;
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.restore();
}

/** 지명을 덧그린다. k = 1 / 확대 배율 (글자 크기·간격을 화면 기준으로 고정). */
/** 시설 아이콘을 m배로 그린다. */
function drawScaledIcon(ctx: CanvasRenderingContext2D, kind: FacilityKind | "port", x: number, y: number, m: number): void {
  if (m === 1) { drawFacilityIcon(ctx, kind, x, y); return; }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(m, m);
  drawFacilityIcon(ctx, kind, 0, 0);
  ctx.restore();
}

/** 지명을 덧그린다. k = 글자 배율 / 확대 배율 (글자 크기·간격을 화면 기준으로 고정), m = 도시·시설 표시 배율. */
function drawLabels(ctx: CanvasRenderingContext2D, world: WorldMap, layers: Layers, k: number, m: number): void {
  const { mesh } = world;
  ctx.save();
  const placer = new LabelPlacer(ctx, mesh.width, mesh.height, k);
  // 아이콘·도시 표시 자리는 글자가 덮지 않게 비워 둔다 (아이콘은 지도와 함께 커진다).
  if (layers.facilities) {
    for (const f of [...world.ports, ...world.facilities]) {
      placer.reserve({ x: mesh.x[f.cell] - 7 * m, y: mesh.y[f.cell] - 7 * m, w: 14 * m, h: 14 * m });
    }
  }
  if (layers.cities) {
    for (const c of world.cities) {
      const r = (c.capital ? 5 : 3) * m;
      placer.reserve({ x: mesh.x[c.cell] - r, y: mesh.y[c.cell] - r, w: 2 * r, h: 2 * r });
    }
  }
  {
    // 국가 이름 (가장 크게, 먼저 배치)
    for (const s of world.states) {
      if (s.cellCount < 30) continue;
      const x = mesh.x[s.labelCell], y = mesh.y[s.labelCell];
      const size = Math.round(Math.min(30, 14 + Math.sqrt(s.cellCount) * 0.45));
      const sz = size * k;
      placer.place(s.name, `600 ${size}px ${LABEL_FONT}`, [[x, y, "center"], [x, y - sz, "center"], [x, y + sz, "center"]], "rgba(40,30,25,0.75)", "rgba(255,255,255,0.55)");
    }
    // 수도 → 도시 순서로
    if (layers.cities) {
      const ordered = [...world.cities].sort((a, b) => Number(b.capital) - Number(a.capital));
      for (const c of ordered) {
        const x = mesh.x[c.cell], y = mesh.y[c.cell];
        const font = c.capital ? `700 14px ${LABEL_FONT}` : `500 11.5px ${LABEL_FONT}`;
        // 도시 표시(지도와 함께 커짐) 바깥에 글자 간격(화면 크기 고정)만큼 띄운다
        const r = (c.capital ? 4 : 2.6) * m;
        const gap = r + (c.capital ? 3 : 4.4) * k;
        placer.place(c.name, font, [
          [x + gap, y + 4 * k, "left"], [x - gap, y + 4 * k, "right"], [x, y - r - (c.capital ? 4 : 5.4) * k, "center"], [x, y + r + (c.capital ? 12 : 13.4) * k, "center"],
        ], "#1e1e1e");
      }
    }
    // 이름 붙인 항구·시설물
    if (layers.facilities) {
      for (const f of [...world.ports, ...world.facilities]) {
        if (!f.name) continue;
        const x = mesh.x[f.cell], y = mesh.y[f.cell];
        // 아이콘 반경 7(지도 단위) + 글자 간격
        const gx = 7 * m + 2 * k;
        placer.place(f.name, `500 11px ${LABEL_FONT}`, [
          [x + gx, y + 4 * k, "left"], [x - gx, y + 4 * k, "right"], [x, y - 7 * m - 3 * k, "center"], [x, y + 7 * m + 12 * k, "center"],
          [x + gx, y - 6 * k, "left"], [x - gx, y - 6 * k, "right"], [x + gx, y + 15 * k, "left"], [x - gx, y + 15 * k, "right"],
        ], "#3a2f25");
      }
    }
    // 강 이름: 강의 중간 지점
    if (layers.rivers) {
      for (const r of world.rivers) {
        if (!r.name) continue;
        const mid = r.cells[Math.floor(r.cells.length / 2)];
        placer.place(r.name, `italic 500 11px ${LABEL_FONT}`, [[mesh.x[mid], mesh.y[mid] - 5 * k, "center"], [mesh.x[mid], mesh.y[mid] + 13 * k, "center"]], "#24527f");
      }
    }
    // 산봉우리
    for (const p of world.peaks) {
      const x = mesh.x[p.cell], y = mesh.y[p.cell];
      if (placer.place(`▲ ${p.name}`, `500 11px ${LABEL_FONT}`, [[x, y, "center"], [x, y + 14 * k, "center"]], "#4a3b2c")) continue;
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
  const port = world.ports.find((p) => p.cell === i);
  if (port) info["항구"] = port.name ?? "이름 없음";
  const fac = world.facilities.find((f) => f.cell === i);
  if (fac) info["시설"] = fac.name ? `${FACILITY_INFO[fac.kind].ko} · ${fac.name}` : FACILITY_INFO[fac.kind].ko;
  return info;
}

/** 경로의 k번째 셀에서의 진행 방향 (라디안) */
function pathAngle(mesh: Mesh, path: number[], k: number): number {
  const a = path[Math.max(0, k - 1)], b = path[Math.min(path.length - 1, k + 1)];
  return Math.atan2(mesh.y[b] - mesh.y[a], mesh.x[b] - mesh.x[a]);
}

/** 다리: 진행 방향을 따라 놓인 짧은 상판 (양옆 난간 선과 끝이 벌어진 날개) */
function drawBridge(ctx: CanvasRenderingContext2D, mesh: Mesh, path: number[], k: number, color: string): void {
  const c = path[k];
  ctx.save();
  ctx.translate(mesh.x[c], mesh.y[c]);
  ctx.rotate(pathAngle(mesh, path, k));
  ctx.fillStyle = "rgba(244,241,234,0.95)";
  ctx.fillRect(-5, -2.2, 10, 4.4);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-7, -4); ctx.lineTo(-5, -2.2); ctx.lineTo(5, -2.2); ctx.lineTo(7, -4);
  ctx.moveTo(-7, 4); ctx.lineTo(-5, 2.2); ctx.lineTo(5, 2.2); ctx.lineTo(7, 4);
  ctx.stroke();
  ctx.restore();
}

/**
 * 직접 놓은 다리: 두 점 사이 상판과 난간, 양 끝 날개.
 * 도로용은 밝은 상판, 철도용은 어두운 상판에 침목 무늬로 구분한다.
 */
export function drawBridgeSpan(
  ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, mode: SpanMode = "road",
): void {
  const len = Math.hypot(bx - ax, by - ay);
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(Math.atan2(by - ay, bx - ax));
  ctx.fillStyle = mode === "rail" ? "#4a4a4a" : "rgba(244,241,234,0.95)";
  ctx.fillRect(-2, -2.6, len + 4, 5.2);
  if (mode === "rail") {
    // 침목: 상판을 가로지르는 짧은 밝은 선
    ctx.strokeStyle = "rgba(244,241,234,0.85)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let px = 1; px < len; px += 4) { ctx.moveTo(px, -1.8); ctx.lineTo(px, 1.8); }
    ctx.stroke();
  }
  ctx.strokeStyle = mode === "rail" ? "#1e1e1e" : "#3a2f25";
  ctx.lineWidth = 1.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-4.5, -5); ctx.lineTo(-2, -2.6); ctx.lineTo(len + 2, -2.6); ctx.lineTo(len + 4.5, -5);
  ctx.moveTo(-4.5, 5); ctx.lineTo(-2, 2.6); ctx.lineTo(len + 2, 2.6); ctx.lineTo(len + 4.5, 5);
  ctx.stroke();
  // 교각: 긴 다리일수록 여러 개
  const piers = Math.max(0, Math.floor(len / 28));
  ctx.lineWidth = 1;
  for (let k = 1; k <= piers; k++) {
    const px = (len * k) / (piers + 1);
    ctx.beginPath();
    ctx.moveTo(px, -2.6); ctx.lineTo(px, 2.6);
    ctx.stroke();
  }
  ctx.restore();
}

/** 직접 놓은 터널: 두 점 사이 점선과 양 끝 입구. 도로용은 갈색, 철도용은 짙은 회색 점선. */
export function drawTunnelSpan(
  ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, mode: SpanMode = "road",
): void {
  const angle = Math.atan2(by - ay, bx - ax);
  ctx.save();
  ctx.strokeStyle = mode === "rail" ? "rgba(40,40,40,0.85)" : "rgba(110,70,40,0.85)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [x, y, rot] of [[ax, ay, angle], [bx, by, angle + Math.PI]] as const) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.arc(0, 0, 4.5, -Math.PI / 2, Math.PI / 2);
    ctx.strokeStyle = "#2b2b2b";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/** 터널: 구간은 회색 점선, 양 끝에는 산을 향해 열린 반원 입구 */
function drawTunnel(ctx: CanvasRenderingContext2D, mesh: Mesh, path: number[], a: number, b: number): void {
  const piece = path.slice(a, b + 1);
  smoothPath(ctx, mesh, piece);
  ctx.strokeStyle = "rgba(60,60,60,0.75)";
  ctx.lineWidth = 1.3;
  ctx.setLineDash([2, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [k, inward] of [[a, 0], [b, Math.PI]] as const) {
    const c = path[k];
    ctx.save();
    ctx.translate(mesh.x[c], mesh.y[c]);
    ctx.rotate(pathAngle(mesh, path, k) + inward);
    ctx.beginPath();
    ctx.arc(0, 0, 4, -Math.PI / 2, Math.PI / 2);
    ctx.strokeStyle = "#2b2b2b";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 시설 아이콘 (지름 약 12px). 글꼴마다 모양이 다른 이모지 대신 직접 그린다.
 * 흰 바탕 원 위에 어두운 기호를 올려 어떤 지형 색 위에서도 보이게 한다.
 */
export function drawFacilityIcon(ctx: CanvasRenderingContext2D, kind: FacilityKind | "port", x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#2b2b2b";
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  switch (kind) {
    case "port": // 닻
      ctx.moveTo(0, -4); ctx.lineTo(0, 4);
      ctx.moveTo(-2.5, -2); ctx.lineTo(2.5, -2);
      ctx.moveTo(-3.5, 1.5); ctx.quadraticCurveTo(0, 6, 3.5, 1.5);
      ctx.stroke();
      break;
    case "castle": // 성벽 (총안)
      ctx.moveTo(-4, 4); ctx.lineTo(-4, -3); ctx.lineTo(-2.5, -3); ctx.lineTo(-2.5, -1.5); ctx.lineTo(-0.8, -1.5);
      ctx.lineTo(-0.8, -3); ctx.lineTo(0.8, -3); ctx.lineTo(0.8, -1.5); ctx.lineTo(2.5, -1.5); ctx.lineTo(2.5, -3);
      ctx.lineTo(4, -3); ctx.lineTo(4, 4); ctx.closePath();
      ctx.fill();
      break;
    case "fort": // 별 모양 성채
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? 2 : 4.6;
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
        if (k === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      break;
    case "temple": // 지붕과 기둥
      ctx.moveTo(-4.5, -1); ctx.lineTo(0, -4.5); ctx.lineTo(4.5, -1); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-3, 0); ctx.lineTo(-3, 3.5); ctx.moveTo(0, 0); ctx.lineTo(0, 3.5); ctx.moveTo(3, 0); ctx.lineTo(3, 3.5);
      ctx.moveTo(-4.5, 4); ctx.lineTo(4.5, 4);
      ctx.stroke();
      break;
    case "mine": // 엇갈린 곡괭이
      ctx.moveTo(-3.5, 3.5); ctx.lineTo(3.5, -3.5); ctx.moveTo(3.5, 3.5); ctx.lineTo(-3.5, -3.5);
      ctx.moveTo(1, -4.5); ctx.lineTo(4.5, -1); ctx.moveTo(-1, -4.5); ctx.lineTo(-4.5, -1);
      ctx.stroke();
      break;
    case "tower": // 가는 탑
      ctx.moveTo(-1.8, 4); ctx.lineTo(-1.2, -2.5); ctx.lineTo(0, -4.8); ctx.lineTo(1.2, -2.5); ctx.lineTo(1.8, 4); ctx.closePath();
      ctx.fill();
      break;
    case "ruin": // 부러진 기둥
      ctx.moveTo(-3, 4); ctx.lineTo(-3, -3); ctx.moveTo(0, 4); ctx.lineTo(0, 0.5); ctx.moveTo(3, 4); ctx.lineTo(3, -1.5);
      ctx.moveTo(-4.5, 4); ctx.lineTo(4.5, 4);
      ctx.stroke();
      break;
    case "airport": // 비행기 (위에서 본 모습)
      ctx.moveTo(0, -5); ctx.lineTo(0.9, -1.5); ctx.lineTo(5, 0.5); ctx.lineTo(5, 1.6); ctx.lineTo(0.9, 0.6);
      ctx.lineTo(0.7, 3.2); ctx.lineTo(2.2, 4.3); ctx.lineTo(2.2, 5); ctx.lineTo(0, 4.3); ctx.lineTo(-2.2, 5);
      ctx.lineTo(-2.2, 4.3); ctx.lineTo(-0.7, 3.2); ctx.lineTo(-0.9, 0.6); ctx.lineTo(-5, 1.6); ctx.lineTo(-5, 0.5);
      ctx.lineTo(-0.9, -1.5); ctx.closePath();
      ctx.fill();
      break;
    case "base": // 깃대와 깃발
      ctx.moveTo(-2.5, 5); ctx.lineTo(-2.5, -5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-2.2, -5); ctx.lineTo(4.5, -3); ctx.lineTo(-2.2, -1); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-4.5, 5); ctx.lineTo(0.5, 5);
      ctx.stroke();
      break;
    case "lighthouse": // 등대와 빛
      ctx.moveTo(-1.6, 4); ctx.lineTo(-1, -2); ctx.lineTo(1, -2); ctx.lineTo(1.6, 4); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-1.5, -3.2); ctx.lineTo(1.5, -3.2);
      ctx.moveTo(-2.5, -4.5); ctx.lineTo(-4.3, -5.3); ctx.moveTo(2.5, -4.5); ctx.lineTo(4.3, -5.3);
      ctx.stroke();
      break;
  }
  ctx.restore();
}
