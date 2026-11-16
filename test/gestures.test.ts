import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ARROW_PAN, ARROW_PAN_BIG, arrowPan, DOUBLE_TAP_MS, isTap, isTwoFingerTap, stepValue, TAP_MAX_MS, TAP_SLOP_PX, TapCounter, wheelDirection } from "../src/ui/gestures.ts";

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

describe("Shift+휠 브러시 크기", () => {
  test("한 칸씩 바꾸고 범위·칸에 맞춘다", () => {
    assert.equal(stepValue(45, 1, 10, 160, 5), 50);
    assert.equal(stepValue(45, -1, 10, 160, 5), 40);
    assert.equal(stepValue(158, 1, 10, 160, 5), 160);
    assert.equal(stepValue(10, -1, 10, 160, 5), 10);
    assert.equal(stepValue(47, 1, 10, 160, 5), 50, "칸에 맞춘다");
    assert.equal(stepValue(45, 3, 10, 160, 5), 50, "세기와 상관없이 한 칸");
  });
  test("휠 방향: 위로 굴리면 키운다, Shift로 deltaX만 와도 같다", () => {
    assert.equal(wheelDirection({ deltaX: 0, deltaY: -100 }), 1);
    assert.equal(wheelDirection({ deltaX: 0, deltaY: 40 }), -1);
    assert.equal(wheelDirection({ deltaX: -100, deltaY: 0 }), 1);
  });
});

describe("방향키 이동", () => {
  test("방향키는 그쪽을 더 보이게, Shift는 크게, 다른 키는 아님", () => {
    assert.deepEqual(arrowPan("ArrowRight", false), [ARROW_PAN, 0]);
    assert.deepEqual(arrowPan("ArrowLeft", false), [-ARROW_PAN, 0]);
    assert.deepEqual(arrowPan("ArrowUp", true), [0, -ARROW_PAN_BIG]);
    assert.deepEqual(arrowPan("ArrowDown", true), [0, ARROW_PAN_BIG]);
    assert.equal(arrowPan("a", false), undefined);
  });
});
