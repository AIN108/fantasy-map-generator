// 포인터 제스처 판정 (DOM 없이 시험할 수 있게 계산만 둔다).
// 좌표는 화면(CSS) 픽셀, 시간은 ms.

/** 누른 뒤 이만큼 움직이지 않고 이 시간 안에 떼면 '누르기(탭)' */
export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 350;
/** 두 번 누르기: 앞 누르기와의 간격·거리 */
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_SLOP_PX = 30;

export interface PointerSample { x: number; y: number; t: number }

/** 누른 곳(down)에서 뗀 곳(up)까지가 누르기인가 */
export function isTap(down: PointerSample, up: PointerSample): boolean {
  return up.t - down.t <= TAP_MAX_MS && Math.hypot(up.x - down.x, up.y - down.y) <= TAP_SLOP_PX;
}

/** 잇단 누르기를 세어 두 번 누르기를 알아본다. 두 번째로 알아본 뒤에는 다시 처음부터 센다 (세 번 눌러도 한 번만). */
export class TapCounter {
  private last: PointerSample | undefined;

  /** 누르기 하나를 더한다. 바로 앞 누르기와 가까우면 "double" */
  add(tap: PointerSample): "single" | "double" {
    const prev = this.last;
    if (prev && tap.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(tap.x - prev.x, tap.y - prev.y) <= DOUBLE_TAP_SLOP_PX) {
      this.last = undefined;
      return "double";
    }
    this.last = tap;
    return "single";
  }

  reset(): void { this.last = undefined; }
}

/** 두 손가락의 가운데(x, y)와 거리(d) */
export interface PinchSample { x: number; y: number; d: number; t: number }

/** 두 손가락으로 짧게 누르고 뗐는가 (가운데도 거리도 거의 그대로) */
export function isTwoFingerTap(start: PinchSample, end: PinchSample): boolean {
  return end.t - start.t <= TAP_MAX_MS
    && Math.hypot(end.x - start.x, end.y - start.y) <= TAP_SLOP_PX * 2
    && Math.abs(end.d - start.d) <= TAP_SLOP_PX * 2;
}

/** 범위 입력 값을 한 칸(step) 올리거나(dir > 0) 내린다. 범위를 넘지 않고 칸에 맞춘다. */
export function stepValue(value: number, dir: number, min: number, max: number, step: number): number {
  const next = Math.round((value + Math.sign(dir) * step - min) / step) * step + min;
  return Math.min(max, Math.max(min, next));
}

/** 휠 한 번이 키우는 쪽인가 (위로 굴리면 +1). Shift를 누르면 일부 환경은 deltaX로 보낸다. */
export const wheelDirection = (e: { deltaX: number; deltaY: number }): number => -Math.sign(e.deltaY || e.deltaX);

/** 방향키 한 번에 옮기는 양: 보이는 폭·높이의 비율 (Shift를 누르면 크게) */
export const ARROW_PAN = 0.15, ARROW_PAN_BIG = 0.5;

/** 방향키 → 보는 쪽 [x, y] 비율 (ArrowRight면 동쪽을 더 보이게 [+0.15, 0]). 방향키가 아니면 undefined */
export function arrowPan(key: string, big: boolean): [number, number] | undefined {
  const k = big ? ARROW_PAN_BIG : ARROW_PAN;
  switch (key) {
    case "ArrowLeft": return [-k, 0];
    case "ArrowRight": return [k, 0];
    case "ArrowUp": return [0, -k];
    case "ArrowDown": return [0, k];
    default: return undefined;
  }
}
