import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DOUBLE_TAP_MS, isTap, isTwoFingerTap, TAP_MAX_MS, TAP_SLOP_PX, TapCounter } from "../src/ui/gestures.ts";

describe("누르기 판정", () => {
  const down = { x: 100, y: 100, t: 1000 };
  test("짧고 거의 움직이지 않으면 누르기, 끌거나 오래 누르면 아니다", () => {
    assert.equal(isTap(down, { x: 104, y: 97, t: 1100 }), true);
    assert.equal(isTap(down, { x: 100 + TAP_SLOP_PX + 1, y: 100, t: 1100 }), false, "끌기");
    assert.equal(isTap(down, { x: 100, y: 100, t: 1000 + TAP_MAX_MS + 1 }), false, "길게 누르기");
  });

  test("두 번 누르기: 가까운 자리에서 잇달아 누를 때만, 세 번째는 다시 한 번으로 센다", () => {
    const c = new TapCounter();
    assert.equal(c.add({ x: 10, y: 10, t: 0 }), "single");
    assert.equal(c.add({ x: 20, y: 18, t: 200 }), "double");
    assert.equal(c.add({ x: 20, y: 18, t: 300 }), "single", "두 번으로 알아본 뒤에는 새로 센다");
    assert.equal(c.add({ x: 200, y: 18, t: 400 }), "single", "먼 자리");
    assert.equal(c.add({ x: 200, y: 18, t: 400 + DOUBLE_TAP_MS + 1 }), "single", "늦게 누름");
    c.reset();
    assert.equal(c.add({ x: 200, y: 18, t: 500 }), "single");
  });

  test("두 손가락 누르기: 가운데·거리가 거의 그대로이고 짧을 때만", () => {
    const s = { x: 300, y: 200, d: 120, t: 0 };
    assert.equal(isTwoFingerTap(s, { x: 305, y: 196, d: 125, t: 200 }), true);
    assert.equal(isTwoFingerTap(s, { x: 300, y: 200, d: 200, t: 200 }), false, "벌려서 확대");
    assert.equal(isTwoFingerTap(s, { x: 360, y: 200, d: 120, t: 200 }), false, "두 손가락으로 끌기");
    assert.equal(isTwoFingerTap(s, { x: 300, y: 200, d: 120, t: TAP_MAX_MS + 1 }), false, "오래 누름");
  });
});
