import { renderWorld, type Layers, type RenderCache } from "../render.ts";
import { anchoredView, clampView, identityView, MAX_SCALE, MIN_SCALE, sameView, toMap, zoomAt, type View } from "../view.ts";
import type { WorldMap } from "../world.ts";
import { isTypingTarget } from "./dom.ts";

/**
 * 지도 캔버스 그리기와 확대·이동 입력 (휠·버튼·키보드·끌기·두 손가락).
 * 편집(칠하기·끌기)은 하지 않고, 편집에 해당하는 포인터 입력은 hooks로 넘긴다.
 *
 * 좌표계 세 가지: 지도 좌표(메시), 보기 좌표(지도 크기 width×height 기준의 화면 위치, View가 다루는 값),
 * 기기 픽셀(캔버스 실제 해상도 = 화면 표시 크기 × devicePixelRatio). pixelRatio()가 보기 좌표 → 기기 픽셀 배율이다.
 */

export interface Scene { world: WorldMap; cache: RenderCache; layers: Layers }

export interface ViewportHooks {
  /** 지금 그릴 지도. 아직 없으면 undefined */
  scene(): Scene | undefined;
  editMode(): boolean;
  /** 편집 입력. 확대·이동으로 쓰지 않은 포인터만 넘어온다. */
  editDown(e: PointerEvent): void;
  editMove(e: PointerEvent): void;
  editEnd(e: PointerEvent): void;
  /** 하던 편집을 없던 일로 한다 (편집 중 두 번째 손가락이 닿았을 때). */
  editCancel(): void;
  /** 보기가 바뀐 뒤 커서를 다시 그린다. 마우스가 지도 위에 없으면 x, y는 undefined. */
  viewChanged(x?: number, y?: number): void;
  /** 포인터가 지도를 벗어났다. */
  pointerLeave(): void;
}

/** 확대·축소 버튼 한 번의 배율 */
const ZOOM_STEP = 1.5;
/** 움직임이 멈춘 뒤 선명하게 다시 그릴 때까지 기다리는 시간 */
const SHARP_DELAY_MS = 140;
/**
 * 좁은 화면에서 지명·도시·시설 표시를 키우는 배율. 지도를 표시 크기로 줄였을 때 글자가
 * 원래 크기의 MIN_TEXT_RATIO보다 작아지지 않게 한다 (넓은 화면에서는 1, 휴대폰에서는 약 3).
 */
const MIN_TEXT_RATIO = 0.85;

export interface ZoomControls {
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  zoomReset: HTMLButtonElement;
  level: HTMLElement;
}

export class Viewport {
  readonly canvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly octx: CanvasRenderingContext2D;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly wrap: HTMLElement;
  private readonly controls: ZoomControls;
  private readonly hooks: ViewportHooks;

  private width = 1200;
  private height = 800;
  private mapSize = "";
  private currentView: View = identityView();

  /** 지명을 뺀 전체 지도 사본 (확대·이동 중 늘려 쓰는 바탕, 기기 픽셀 해상도) */
  private readonly baseCanvas = document.createElement("canvas");
  private baseFresh = false;
  /** 칠하는 동안 바탕을 그릴 낮은 해상도 캔버스 (화면 표시 크기 = DPR 1) */
  private readonly lowCanvas = document.createElement("canvas");
  private sharpTimer = 0;
  private fastQueued = false;
  /** 마지막으로 마우스가 있던 보기 좌표 (휠로 확대한 뒤 커서를 다시 그리기 위해) */
  private hoverPx: [number, number] | undefined;

  // 누르고 있는 포인터 (보기 좌표). 두 개가 되면 두 손가락 확대·이동.
  private readonly pointers = new Map<number, [number, number]>();
  private pan: { id: number; last: [number, number] } | null = null;
  private pinch: { mx: number; my: number; dist: number; scale: number } | null = null;
  /** 두 손가락 제스처 뒤 남은 손가락으로는 편집하지 않는다 (모두 뗄 때까지). */
  private gestureLock = false;
  private spaceHeld = false;
  private hovering = false;
  private resizeQueued = false;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement, controls: ZoomControls, hooks: ViewportHooks) {
    const ctx = canvas.getContext("2d");
    const octx = overlay.getContext("2d");
    if (!ctx || !octx) throw new Error("Canvas 2D를 사용할 수 없습니다.");
    if (!canvas.parentElement) throw new Error("지도 캔버스를 감싸는 요소가 없습니다.");
    this.canvas = canvas;
    this.overlay = overlay;
    this.ctx = ctx;
    this.octx = octx;
    this.wrap = canvas.parentElement;
    this.controls = controls;
    this.hooks = hooks;
    this.listen();
    this.syncZoomUi();
  }

  get view(): View { return this.currentView; }

  // ── 크기·해상도 ─────────────────────────────────────────────────────
  /** 지도 크기가 바뀌면 화면 비율을 맞추고 보기를 처음으로 되돌린다. */
  setMapSize(width: number, height: number): void {
    if (this.mapSize === `${width}x${height}`) return;
    this.mapSize = `${width}x${height}`;
    this.width = width;
    this.height = height;
    this.canvas.style.aspectRatio = this.overlay.style.aspectRatio = `${width} / ${height}`;
    this.currentView = identityView();
    this.syncZoomUi();
  }

  private pixelRatio(): number { return this.canvas.width / this.width; }

  private textScale(): number {
    const cssWidth = this.canvas.getBoundingClientRect().width;
    if (!(cssWidth > 0)) return 1;
    return Math.min(3, Math.max(1, MIN_TEXT_RATIO / (cssWidth / this.width)));
  }

  /** 기기 픽셀 해상도를 화면 표시 크기에 맞춘다. 바뀌었으면 true. */
  syncBacking(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    // 화면에 아직 그려지지 않았으면(폭 0) 지도 크기를 그대로 쓴다. 너무 큰 캔버스는 막는다.
    const cssWidth = rect.width > 0 ? rect.width : this.width;
    const w = Math.max(1, Math.min(4096, Math.round(cssWidth * dpr)));
    const h = Math.max(1, Math.round((w * this.height) / this.width));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = this.overlay.width = w;
    this.canvas.height = this.overlay.height = h;
    this.baseFresh = false;
    return true;
  }

  // ── 그리기 ───────────────────────────────────────────────────────────
  /**
   * 현재 보기(확대·이동)로 지도를 다시 그린다.
   * fast: 칠하는 동안에는 바탕을 화면 표시 해상도(DPR 1)로 그려 늘려 쓰고 지명만 기기 해상도로 얹는다.
   * 고해상도 화면에서 픽셀 수가 4~9배라 칠하기가 느려지는 것을 막는다. 손을 떼면 선명하게 다시 그린다.
   */
  draw(fast = false): void {
    const scene = this.hooks.scene();
    if (!scene) return;
    const { world, cache, layers } = scene;
    const { canvas, ctx } = this;
    clearTimeout(this.sharpTimer);
    const view = this.currentView;
    const s = view.scale, r = this.pixelRatio();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const cssWidth = Math.round(canvas.getBoundingClientRect().width);
    if (fast && cssWidth > 0 && cssWidth < canvas.width) {
      this.baseFresh = false;
      const lr = cssWidth / this.width;
      this.lowCanvas.width = cssWidth;
      this.lowCanvas.height = Math.max(1, Math.round((cssWidth * this.height) / this.width));
      const l = this.lowCanvas.getContext("2d")!;
      l.setTransform(s * lr, 0, 0, s * lr, -view.x * s * lr, -view.y * s * lr);
      renderWorld(l, world, cache, layers, s, "base", this.textScale());
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(this.lowCanvas, 0, 0, canvas.width, canvas.height);
      ctx.setTransform(s * r, 0, 0, s * r, -view.x * s * r, -view.y * s * r);
      renderWorld(ctx, world, cache, layers, s, "labels", this.textScale());
    } else if (s === 1) {
      // 전체 보기: 바탕을 사본에 그려 옮기고 지명만 덧그린다 (사본을 따로 만드는 비용이 들지 않는다).
      this.renderBase(scene);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(this.baseCanvas, 0, 0);
      ctx.setTransform(r, 0, 0, r, 0, 0);
      renderWorld(ctx, world, cache, layers, 1, "labels", this.textScale());
    } else {
      this.baseFresh = false;
      ctx.setTransform(s * r, 0, 0, s * r, -view.x * s * r, -view.y * s * r);
      renderWorld(ctx, world, cache, layers, s, "all", this.textScale());
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private renderBase({ world, cache, layers }: Scene): void {
    const r = this.pixelRatio();
    this.baseCanvas.width = this.canvas.width;
    this.baseCanvas.height = this.canvas.height;
    const b = this.baseCanvas.getContext("2d")!;
    b.setTransform(r, 0, 0, r, 0, 0);
    renderWorld(b, world, cache, layers, 1, "base", this.textScale());
    this.baseFresh = true;
  }

  /** 움직이는 동안: 바탕 사본을 늘리고 지명만 현재 배율에 맞춰 새로 얹는다. */
  private drawFast(): void {
    const scene = this.hooks.scene();
    if (!scene) return;
    if (!this.baseFresh) this.renderBase(scene);
    const { canvas, ctx } = this;
    const view = this.currentView;
    const s = view.scale, r = this.pixelRatio();
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.baseCanvas, view.x * r, view.y * r, w / s, h / s, 0, 0, w, h);
    // 지명은 늘리지 않고 현재 배율에 맞춰 새로 배치한다 (움직이는 동안에도 글자 크기가 그대로).
    ctx.setTransform(s * r, 0, 0, s * r, -view.x * s * r, -view.y * s * r);
    renderWorld(ctx, scene.world, scene.cache, scene.layers, s, "labels", this.textScale());
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** PNG 저장용: 보고 있는 화면과 관계없이 지도 전체를 원래 크기(width×height)로 그린다. */
  exportCanvas(): HTMLCanvasElement {
    const out = document.createElement("canvas");
    out.width = this.width;
    out.height = this.height;
    const scene = this.hooks.scene();
    if (scene) renderWorld(out.getContext("2d")!, scene.world, scene.cache, scene.layers);
    return out;
  }

  // ── 보기 ─────────────────────────────────────────────────────────────
  /**
   * 보기를 바꾼다. 움직이는 동안에는 바탕 사본을 늘리고 지명만 새로 얹어 빠르게 보여 주고,
   * 잠시 멈추면 그 배율로 선명하게 다시 그린다.
   */
  setView(next: View): void {
    const clamped = clampView(next, this.width, this.height);
    if (sameView(clamped, this.currentView)) return;
    this.currentView = clamped;
    this.syncZoomUi();
    if (!this.fastQueued) {
      this.fastQueued = true;
      requestAnimationFrame(() => {
        this.fastQueued = false;
        this.drawFast();
        const hover = this.hoverPx && toMap(this.currentView, ...this.hoverPx);
        this.hooks.viewChanged(hover?.[0], hover?.[1]);
      });
    }
    clearTimeout(this.sharpTimer);
    this.sharpTimer = window.setTimeout(() => this.draw(), SHARP_DELAY_MS);
  }

  zoomBy(factor: number): void {
    this.setView(zoomAt(this.currentView, factor, this.width / 2, this.height / 2, this.width, this.height));
  }

  resetView(): void { this.setView(identityView()); }

  private syncZoomUi(): void {
    const s = this.currentView.scale;
    this.wrap.classList.toggle("zoomed", s > MIN_SCALE + 1e-6);
    this.controls.level.textContent = `${Math.round(s * 100)}%`;
    this.controls.zoomIn.disabled = s >= MAX_SCALE - 1e-6;
    this.controls.zoomOut.disabled = s <= MIN_SCALE + 1e-6;
    this.controls.zoomReset.disabled = s <= MIN_SCALE + 1e-6;
  }

  // ── 좌표·덧그림 ──────────────────────────────────────────────────────
  /** 화면(client) 좌표 → 보기 좌표 (지도 크기 기준, 확대 전) */
  private canvasPx(e: { clientX: number; clientY: number }): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / Math.max(1, rect.width)) * this.width,
      ((e.clientY - rect.top) / Math.max(1, rect.height)) * this.height,
    ];
  }

  /** 화면 좌표 → 지도 좌표 (확대·이동 반영) */
  toMapCoords(e: { clientX: number; clientY: number }): [number, number] {
    return toMap(this.currentView, ...this.canvasPx(e));
  }

  /** 화면 크기·확대 배율과 관계없이 손가락·마우스로 누르기 쉬운 선택 반경 (지도 좌표) */
  hitRadius(): number {
    return (14 * (this.width / Math.max(1, this.canvas.getBoundingClientRect().width))) / this.currentView.scale;
  }

  /** 덧그림 캔버스를 비우고, 이후 그리기가 지도 좌표를 쓰도록 보기 변환을 건다. */
  clearOverlay(): CanvasRenderingContext2D {
    const o = this.octx, v = this.currentView;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const k = v.scale * this.pixelRatio();
    o.setTransform(k, 0, 0, k, -v.x * k, -v.y * k);
    return o;
  }

  /** 커서 원. 확대해도 화면에서 같은 굵기로 보이게 한다. */
  strokeCircle(x: number, y: number, r: number, dash: number[] = []): void {
    const o = this.octx, s = this.currentView.scale;
    o.setLineDash(dash.map((d) => d / s));
    o.lineWidth = 2 / s;
    o.strokeStyle = "rgba(0,0,0,0.55)";
    o.beginPath();
    o.arc(x, y, r, 0, Math.PI * 2);
    o.stroke();
    o.lineWidth = 1 / s;
    o.strokeStyle = "rgba(255,255,255,0.95)";
    o.stroke();
    o.setLineDash([]);
  }

  // ── 입력 ─────────────────────────────────────────────────────────────
  /** 포인터를 캔버스에 붙잡는다. 이미 떼어진 포인터면 조용히 넘어간다. */
  capturePointer(id: number): void {
    try { this.canvas.setPointerCapture(id); } catch { /* 붙잡지 못해도 캔버스 안에서는 그대로 동작한다 */ }
  }

  private pinchPoints(): { mid: [number, number]; dist: number } {
    const [a, b] = [...this.pointers.values()];
    return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])) };
  }

  private onPointerDown(e: PointerEvent): void {
    this.pointers.set(e.pointerId, this.canvasPx(e));
    if (this.pointers.size === 2) {
      e.preventDefault();
      this.hooks.editCancel();
      this.pan = null;
      this.wrap.classList.remove("panning");
      const { mid, dist } = this.pinchPoints();
      const [mx, my] = toMap(this.currentView, ...mid);
      this.pinch = { mx, my, dist, scale: this.currentView.scale };
      this.gestureLock = true;
      this.capturePointer(e.pointerId);
      return;
    }
    if (this.pointers.size > 2 || this.gestureLock) return;
    // 이동: 가운데·오른쪽 버튼, 편집 모드가 아닐 때의 왼쪽 버튼, 편집 중 스페이스바 + 왼쪽 버튼
    const wantsPan = e.button === 1 || e.button === 2 || (e.button === 0 && (!this.hooks.editMode() || this.spaceHeld));
    if (wantsPan) {
      e.preventDefault();
      this.pan = { id: e.pointerId, last: this.canvasPx(e) };
      this.wrap.classList.add("panning");
      this.capturePointer(e.pointerId);
      return;
    }
    this.hooks.editDown(e);
  }

  private onPointerMove(e: PointerEvent): void {
    const px = this.canvasPx(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, px);
    if (this.pinch) {
      if (this.pointers.size >= 2) {
        const { mid, dist } = this.pinchPoints();
        const { pinch } = this;
        this.setView(anchoredView(pinch.mx, pinch.my, mid[0], mid[1], pinch.scale * (dist / pinch.dist), this.width, this.height));
      }
      return;
    }
    if (this.pan) {
      if (e.pointerId === this.pan.id) {
        const v = this.currentView, s = v.scale;
        this.setView({ scale: s, x: v.x - (px[0] - this.pan.last[0]) / s, y: v.y - (px[1] - this.pan.last[1]) / s });
        this.pan.last = px;
      }
      return;
    }
    if (this.gestureLock) return;
    if (e.pointerType === "mouse") this.hoverPx = px;
    this.hooks.editMove(e);
  }

  private onPointerEnd(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch || this.gestureLock) {
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) this.gestureLock = false;
      return;
    }
    if (this.pan) {
      if (e.pointerId === this.pan.id) {
        this.pan = null;
        this.wrap.classList.remove("panning");
      }
      return;
    }
    this.hooks.editEnd(e);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.hooks.scene()) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(-e.deltaY * unit * 0.0015);
    const s = this.currentView.scale;
    // 더 줄이거나 키울 수 없으면 페이지 스크롤을 막지 않는다.
    if ((factor < 1 && s <= MIN_SCALE + 1e-6) || (factor > 1 && s >= MAX_SCALE - 1e-6)) return;
    e.preventDefault();
    this.hoverPx = this.canvasPx(e);
    this.setView(zoomAt(this.currentView, factor, this.hoverPx[0], this.hoverPx[1], this.width, this.height));
  }

  /** 확대·이동 키 (스페이스: 끌어서 이동, + - 0: 확대·축소·맞춤). 처리했으면 true. */
  private onKeyDown(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement;
    if (isTypingTarget(target)) return false;
    if (e.key === " " && this.hooks.editMode() && this.hovering) {
      e.preventDefault(); // 페이지 스크롤·포커스된 버튼 누름을 막는다
      this.spaceHeld = true;
      this.wrap.classList.add("pan-ready");
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || target.tagName === "SELECT") return false;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); this.zoomBy(ZOOM_STEP); return true; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); this.zoomBy(1 / ZOOM_STEP); return true; }
    if (e.key === "0") { e.preventDefault(); this.resetView(); return true; }
    return false;
  }

  private releaseSpace(): void {
    this.spaceHeld = false;
    this.wrap.classList.remove("pan-ready");
  }

  /** 창 크기·화면 배율(브라우저 확대, 다른 모니터로 이동)이 바뀌면 해상도를 다시 맞춘다. */
  private onResize(): void {
    if (this.resizeQueued) return;
    this.resizeQueued = true;
    requestAnimationFrame(() => {
      this.resizeQueued = false;
      if (this.hooks.scene() && this.syncBacking()) { this.draw(); this.clearOverlay(); }
    });
  }

  private listen(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    c.addEventListener("pointermove", (e) => this.onPointerMove(e));
    c.addEventListener("pointerup", (e) => this.onPointerEnd(e));
    c.addEventListener("pointercancel", (e) => this.onPointerEnd(e));
    c.addEventListener("pointerenter", () => { this.hovering = true; });
    c.addEventListener("pointerleave", () => {
      this.hovering = false;
      this.hoverPx = undefined;
      this.hooks.pointerLeave();
    });
    c.addEventListener("contextmenu", (e) => e.preventDefault()); // 오른쪽 버튼 끌기로 이동
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.controls.zoomIn.addEventListener("click", () => this.zoomBy(ZOOM_STEP));
    this.controls.zoomOut.addEventListener("click", () => this.zoomBy(1 / ZOOM_STEP));
    this.controls.zoomReset.addEventListener("click", () => this.resetView());
    // 캡처 단계에서 받아, 확대·이동 키를 처리했으면 다른 단축키 처리기로 넘기지 않는다.
    document.addEventListener("keydown", (e) => { if (this.onKeyDown(e)) e.stopImmediatePropagation(); }, { capture: true });
    document.addEventListener("keyup", (e) => {
      if (e.key !== " " || !this.spaceHeld) return;
      e.preventDefault();
      this.releaseSpace();
    });
    window.addEventListener("blur", () => this.releaseSpace());
    new ResizeObserver(() => this.onResize()).observe(c);
    window.addEventListener("resize", () => this.onResize());
  }
}
