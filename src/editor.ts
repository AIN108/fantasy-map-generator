import { forEachNeighbor, type Mesh } from "./mesh.ts";

export type BrushTool = "raise" | "lower" | "flatten" | "smooth";

export const BRUSH_TOOLS: Record<BrushTool, { ko: string; hint: string }> = {
  raise: { ko: "융기", hint: "땅을 높입니다. 바다에 칠하면 섬이 생깁니다." },
  lower: { ko: "침강", hint: "땅을 낮춥니다. 계속 칠하면 바다가 됩니다." },
  flatten: { ko: "평탄화", hint: "처음 누른 지점의 높이에 맞춰 고릅니다." },
  smooth: { ko: "부드럽게", hint: "주변과 섞어 거친 지형을 다듬습니다." },
};

export interface Brush {
  tool: BrushTool;
  /** 반지름 (지도 픽셀) */
  radius: number;
  /** 0~1 */
  strength: number;
}

const MIN_ELEVATION = -1;
const MAX_ELEVATION = 1;
/** 가장자리 셀은 항상 바다로 둔다 (지도 밖으로 육지가 잘려 보이지 않게). */
const EDGE_CEILING = -0.05;

/** 중심에서 멀어질수록 0으로 부드럽게 줄어드는 가중치 (cosine falloff) */
const falloff = (d: number, radius: number): number => (d >= radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / radius)));

/**
 * (cx, cy)에 브러시를 한 번 찍는다. 고도 배열을 직접 바꾸고, 바뀐 셀이 있으면 true.
 * flattenTarget은 평탄화 도구에서 맞출 높이 (스트로크 시작 지점의 고도).
 */
export function applyBrush(
  mesh: Mesh, elevation: Float64Array, brush: Brush, cx: number, cy: number, flattenTarget = 0,
): boolean {
  if (!(brush.radius > 0) || !(brush.strength > 0)) return false;
  const r2 = brush.radius * brush.radius;
  const affected: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < mesh.count; i++) {
    const dx = mesh.x[i] - cx, dy = mesh.y[i] - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r2) continue;
    affected.push(i);
    weights.push(falloff(Math.sqrt(d2), brush.radius) * brush.strength);
  }
  if (affected.length === 0) return false;

  // 부드럽게는 '찍기 전' 값을 기준으로 평균내야 셀 순서에 따라 결과가 달라지지 않는다.
  const before = brush.tool === "smooth" ? Float64Array.from(elevation) : elevation;
  const step = 0.06;
  affected.forEach((i, k) => {
    const w = weights[k];
    let e = elevation[i];
    switch (brush.tool) {
      case "raise": e += step * w; break;
      case "lower": e -= step * w; break;
      case "flatten": e += (flattenTarget - e) * Math.min(1, w * 0.5); break;
      case "smooth": {
        let sum = 0, n = 0;
        forEachNeighbor(mesh, i, (j) => { sum += before[j]; n++; });
        if (n > 0) e += (sum / n - e) * Math.min(1, w * 0.6);
        break;
      }
    }
    e = Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, e));
    if (mesh.isEdge[i]) e = Math.min(e, EDGE_CEILING);
    elevation[i] = e;
  });
  return true;
}

/**
 * 편집 단위 되돌리기/다시하기. 편집 직전 상태의 스냅샷을 보관한다.
 * 스냅샷 타입은 자유롭게 정할 수 있다 (기본은 고도 배열, 화면에서는 고도+문명 묶음).
 */
export class EditHistory<T = Float64Array> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private readonly limit: number;
  private readonly copy: (t: T) => T;

  constructor(limit = 50, copy: (t: T) => T = (t) => Float64Array.from(t as Float64Array) as T) {
    this.limit = limit;
    this.copy = copy;
  }

  /** 편집을 시작하기 직전 상태를 기록한다. */
  record(state: T): void {
    this.undoStack.push(this.copy(state));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: T): T | undefined {
    const prev = this.undoStack.pop();
    if (prev) this.redoStack.push(this.copy(current));
    return prev;
  }

  redo(current: T): T | undefined {
    const next = this.redoStack.pop();
    if (next) this.undoStack.push(this.copy(current));
    return next;
  }

  /** 마지막 기록을 되돌리기 목록에 남기지 않고 꺼낸다 (시작했다가 취소한 편집용). */
  discardLast(): T | undefined {
    return this.undoStack.pop();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}

/**
 * 고도 배열을 base64 문자열로 만든다 (브라우저 저장용). 손실 없이 Float64 그대로 저장한다:
 * 양자화하면 미세한 차이로 강 경로·도시 배치가 달라져 새로고침 후 다른 지도가 될 수 있다.
 * 9,000셀 기준 약 96KB.
 */
export function encodeElevation(elevation: Float64Array): string {
  const bytes = new Uint8Array(Float64Array.from(elevation).buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** encodeElevation의 역변환. 길이가 기대값과 다르거나 값이 유한수가 아니면 undefined. */
export function decodeElevation(text: string, expectedLength: number): Float64Array | undefined {
  let bin: string;
  try {
    bin = atob(text);
  } catch {
    return undefined;
  }
  if (bin.length !== expectedLength * 8) return undefined;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const values = new Float64Array(bytes.buffer);
  if (!values.every(Number.isFinite)) return undefined;
  return values.map((v) => Math.max(-1, Math.min(1, v)));
}
