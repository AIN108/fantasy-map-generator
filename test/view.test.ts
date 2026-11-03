import assert from "node:assert/strict";
import { test } from "node:test";
import { EditHistory } from "../src/editor.ts";
import { anchoredView, clampView, identityView, MAX_SCALE, panBy, toCanvas, toMap, zoomAt } from "../src/view.ts";

const W = 1200, H = 800;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("전체 보기에서는 캔버스 좌표가 곧 지도 좌표", () => {
  assert.deepEqual(toMap(identityView(), 300, 200), [300, 200]);
});

test("toMap과 toCanvas는 서로 역변환", () => {
  const v = { scale: 3, x: 200, y: 150 };
  const [x, y] = toMap(v, 450, 120);
  const [px, py] = toCanvas(v, x, y);
  close(px, 450);
  close(py, 120);
});

test("커서 아래 지도 점을 고정한 채 확대한다", () => {
  const v0 = identityView();
  const v1 = zoomAt(v0, 2, 900, 600, W, H);
  assert.equal(v1.scale, 2);
  const [mx, my] = toMap(v1, 900, 600);
  close(mx, 900);
  close(my, 600);
  // 다시 커서 아래 점 고정으로 축소하면 처음으로 돌아온다
  assert.deepEqual(zoomAt(v1, 0.5, 900, 600, W, H), v0);
});

test("배율은 1~MAX_SCALE, 위치는 지도 밖이 보이지 않게 자른다", () => {
  assert.deepEqual(clampView({ scale: 0.3, x: 50, y: -20 }, W, H), identityView());
  const v = clampView({ scale: 100, x: 5000, y: -5 }, W, H);
  assert.equal(v.scale, MAX_SCALE);
  close(v.x, W - W / MAX_SCALE);
  assert.equal(v.y, 0);
  assert.deepEqual(clampView({ scale: NaN, x: NaN, y: 3 }, W, H), identityView());
});

test("끄는 방향으로 지도가 따라오고 가장자리에서 멈춘다", () => {
  const v = { scale: 2, x: 300, y: 200 };
  const moved = panBy(v, 100, -40, W, H);
  close(moved.x, 250);
  close(moved.y, 220);
  const edge = panBy(v, 10_000, 10_000, W, H);
  assert.equal(edge.x, 0);
  assert.equal(edge.y, 0);
});

test("두 손가락: 잡은 지도 점이 손가락 가운데를 따라간다", () => {
  const v = anchoredView(600, 400, 300, 300, 4, W, H);
  const [mx, my] = toMap(v, 300, 300);
  close(mx, 600);
  close(my, 400);
});

test("discardLast는 기록을 꺼내되 다시 실행 목록에 남기지 않는다", () => {
  const h = new EditHistory<number[]>(10, (t) => [...t]);
  h.record([1]);
  assert.deepEqual(h.discardLast(), [1]);
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
});
