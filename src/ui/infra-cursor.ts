// 시설 편집(도로·철도·항로·다리·터널·항구·시설물)의 커서 덧그리기 (main.ts에서 옮김)

import { drawBridgeSpan, drawTunnelSpan } from "../render.ts";
import { findCell, type Mesh } from "../mesh.ts";
import { hitPoint, hitSpan, MAX_SPAN_LENGTH, type Infra, type PointKind, type SpanMode, type SpanPart } from "../infra.ts";
import type { WorldMap } from "../world.ts";
import type { InfraTool } from "./tool-hints.ts";

/** 덧그릴 캔버스 (Viewport의 일부) */
export interface CursorCanvas {
  readonly octx: CanvasRenderingContext2D;
  /** 지도 좌표의 원 (선 굵기는 확대와 무관) */
  strokeCircle(x: number, y: number, r: number, dash?: number[]): void;
  /** 누르기 판정 반지름 (지도 좌표) */
  hitRadius(): number;
}

export interface InfraCursorState {
  world: WorldMap;
  mesh: Mesh;
  infra: Infra;
  tool: InfraTool;
  /** 이동 도구로 끌고 있는 항구·시설물 */
  draggingPoint: { kind: PointKind; index: number } | null;
  /** 이동 도구로 끌고 있는 다리·터널 */
  draggingSpan: { kind: "bridge" | "tunnel"; index: number; part: SpanPart } | null;
  /** 도로·철도·항로·다리·터널을 끌고 있을 때 출발 셀 (아니면 -1)과 미리보기 경로 */
  routeStart: number;
  routePreview: number[] | null;
  /** 다리·터널 용도 (고른 값) */
  spanMode(): SpanMode;
  /** 가까운 항구 셀, 없으면 -1 */
  snapToPort(x: number, y: number): number;
  /** 끌고 있는 다리·터널을 (x, y)에 놓았을 때의 새 양 끝 셀 */
  movedSpanCells(x: number, y: number): [number, number] | null;
  /** 화면에 보이는 도시 중 가장 가까운 것 (world.cities 인덱스), 없으면 -1 */
  nearestCity(x: number, y: number): number;
}

export const isLineTool = (t: InfraTool): boolean => t === "road" || t === "rail" || t === "sea";
export const isSpanTool = (t: InfraTool): boolean => t === "bridge" || t === "tunnel";

export function drawInfraCursor(v: CursorCanvas, s: InfraCursorState, x: number, y: number): void {
  const { world, mesh, infra, draggingPoint, draggingSpan, routeStart, routePreview, tool: infraTool } = s;
  const o = v.octx;
  if (draggingPoint) {
    const item = draggingPoint.kind === "port" ? infra.ports[draggingPoint.index] : infra.facilities[draggingPoint.index];
    if (!item) return;
    const to = findCell(mesh, x, y);
    o.setLineDash([4, 4]);
    o.strokeStyle = "rgba(0,0,0,0.6)";
    o.lineWidth = 1;
    o.beginPath();
    o.moveTo(mesh.x[item.cell], mesh.y[item.cell]);
    o.lineTo(mesh.x[to], mesh.y[to]);
    o.stroke();
    o.setLineDash([]);
    v.strokeCircle(mesh.x[to], mesh.y[to], 8);
    return;
  }
  if (isSpanTool(infraTool) && routeStart >= 0) {
    const end = findCell(mesh, x, y);
    const [ax, ay, bx, by] = [mesh.x[routeStart], mesh.y[routeStart], mesh.x[end], mesh.y[end]];
    const tooLong = Math.hypot(bx - ax, by - ay) > MAX_SPAN_LENGTH;
    o.globalAlpha = tooLong ? 0.4 : 0.9;
    if (infraTool === "bridge") drawBridgeSpan(o, ax, ay, bx, by, s.spanMode()); else drawTunnelSpan(o, ax, ay, bx, by, s.spanMode());
    o.globalAlpha = 1;
    v.strokeCircle(ax, ay, 5);
    return;
  }
  if (isLineTool(infraTool) && routeStart >= 0) {
    if (routePreview && routePreview.length >= 2) {
      o.beginPath();
      o.moveTo(mesh.x[routePreview[0]], mesh.y[routePreview[0]]);
      for (const c of routePreview) o.lineTo(mesh.x[c], mesh.y[c]);
      o.lineWidth = 4;
      o.strokeStyle = "rgba(255,255,255,0.85)";
      o.stroke();
      o.lineWidth = 2;
      o.strokeStyle = infraTool === "rail" ? "#2b2b2b" : infraTool === "sea" ? "rgba(18,38,78,0.95)" : "rgba(110,70,40,0.95)";
      o.stroke();
    }
    v.strokeCircle(mesh.x[routeStart], mesh.y[routeStart], 5);
    return;
  }
  if (infraTool === "sea") {
    const port = s.snapToPort(x, y);
    if (port >= 0) v.strokeCircle(mesh.x[port], mesh.y[port], 10);
    else v.strokeCircle(x, y, 6, [3, 3]);
    return;
  }
  if (infraTool === "toggleMode") {
    const span = hitSpan(mesh, infra, x, y, v.hitRadius());
    if (span) {
      const sp = (span.kind === "bridge" ? infra.bridges : infra.tunnels)[span.index];
      o.lineWidth = 7;
      o.strokeStyle = "rgba(255,255,255,0.55)";
      o.beginPath();
      o.moveTo(mesh.x[sp.a], mesh.y[sp.a]);
      o.lineTo(mesh.x[sp.b], mesh.y[sp.b]);
      o.stroke();
    } else v.strokeCircle(x, y, 6, [3, 3]);
    return;
  }
  if (infraTool === "move") {
    if (draggingSpan) {
      const cells = s.movedSpanCells(x, y);
      if (!cells) return;
      const [a, b] = cells;
      const tooLong = Math.hypot(mesh.x[b] - mesh.x[a], mesh.y[b] - mesh.y[a]) > MAX_SPAN_LENGTH;
      o.globalAlpha = tooLong ? 0.4 : 0.9;
      const mode = (draggingSpan.kind === "bridge" ? infra.bridges : infra.tunnels)[draggingSpan.index]?.mode ?? "road";
      if (draggingSpan.kind === "bridge") drawBridgeSpan(o, mesh.x[a], mesh.y[a], mesh.x[b], mesh.y[b], mode);
      else drawTunnelSpan(o, mesh.x[a], mesh.y[a], mesh.x[b], mesh.y[b], mode);
      o.globalAlpha = 1;
      return;
    }
    const hit = hitPoint(mesh, infra, x, y, v.hitRadius());
    const item = hit && (hit.kind === "port" ? infra.ports[hit.index] : infra.facilities[hit.index]);
    if (item) { v.strokeCircle(mesh.x[item.cell], mesh.y[item.cell], 10); return; }
    const span = hitSpan(mesh, infra, x, y, v.hitRadius());
    if (span) {
      const sp = (span.kind === "bridge" ? infra.bridges : infra.tunnels)[span.index];
      if (span.part === "body") {
        o.lineWidth = 6;
        o.strokeStyle = "rgba(255,255,255,0.5)";
        o.beginPath();
        o.moveTo(mesh.x[sp.a], mesh.y[sp.a]);
        o.lineTo(mesh.x[sp.b], mesh.y[sp.b]);
        o.stroke();
      } else {
        const c = span.part === "a" ? sp.a : sp.b;
        v.strokeCircle(mesh.x[c], mesh.y[c], 7);
      }
    }
    return;
  }
  const city = infraTool === "road" || infraTool === "rail" ? s.nearestCity(x, y) : -1;
  if (city >= 0) v.strokeCircle(mesh.x[world.cities[city].cell], mesh.y[world.cities[city].cell], 10);
  else v.strokeCircle(x, y, infraTool === "erase" ? v.hitRadius() : 6, [3, 3]);
}
