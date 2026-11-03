/**
 * 지도 보기(확대·이동) 상태와 좌표 변환.
 * 캔버스 픽셀 좌표 (px, py)와 지도 좌표 (x, y)의 관계: x = view.x + px / view.scale.
 * view.x·view.y는 캔버스 왼쪽 위 모서리에 보이는 지도 좌표다.
 */
export interface View { scale: number; x: number; y: number }

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

export const identityView = (): View => ({ scale: 1, x: 0, y: 0 });

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 배율을 허용 범위로 자르고, 지도 밖이 보이지 않도록 위치를 맞춘다. */
export function clampView(v: View, width: number, height: number): View {
  const scale = Number.isFinite(v.scale) ? clamp(v.scale, MIN_SCALE, MAX_SCALE) : MIN_SCALE;
  const maxX = width - width / scale;
  const maxY = height - height / scale;
  return {
    scale,
    x: Number.isFinite(v.x) ? clamp(v.x, 0, maxX) : 0,
    y: Number.isFinite(v.y) ? clamp(v.y, 0, maxY) : 0,
  };
}

export function toMap(v: View, px: number, py: number): [number, number] {
  return [v.x + px / v.scale, v.y + py / v.scale];
}

export function toCanvas(v: View, x: number, y: number): [number, number] {
  return [(x - v.x) * v.scale, (y - v.y) * v.scale];
}

/** 지도 점 (mx, my)가 캔버스 픽셀 (px, py)에 오도록 하는 보기 (배율 scale). */
export function anchoredView(
  mx: number, my: number, px: number, py: number, scale: number, width: number, height: number,
): View {
  const s = clamp(scale, MIN_SCALE, MAX_SCALE);
  return clampView({ scale: s, x: mx - px / s, y: my - py / s }, width, height);
}

/** 캔버스 픽셀 (px, py) 아래의 지도 점을 고정한 채 factor배 확대·축소한다. */
export function zoomAt(v: View, factor: number, px: number, py: number, width: number, height: number): View {
  const [mx, my] = toMap(v, px, py);
  return anchoredView(mx, my, px, py, v.scale * factor, width, height);
}

/** 캔버스 픽셀 단위로 끈 만큼 지도를 옮긴다 (끄는 방향으로 지도가 따라온다). */
export function panBy(v: View, dpx: number, dpy: number, width: number, height: number): View {
  return clampView({ scale: v.scale, x: v.x - dpx / v.scale, y: v.y - dpy / v.scale }, width, height);
}

export const sameView = (a: View, b: View): boolean =>
  Math.abs(a.scale - b.scale) < 1e-9 && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
