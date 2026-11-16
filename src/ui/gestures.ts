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
