import {
  applyBrush, BRUSH_TOOLS, decodeElevation, EditHistory, encodeElevation, type Brush, type BrushTool,
} from "./editor.ts";
import { findCell, type Mesh } from "./mesh.ts";
import { buildRenderCache, DEFAULT_LAYERS, describeCell, renderWorld, type Layers, type RenderCache } from "./render.ts";
import {
  createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, extractAnchors, meshKey, mergeAnchors, parseMapJSON,
  sanitizeAnchors, terrainKey, toJSON, type NameAnchors, type WorldMap, type WorldOptions,
} from "./world.ts";
import type { NameStyle } from "./names.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소가 없습니다.`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>("map");
const overlay = $<HTMLCanvasElement>("overlay");
const ctx = canvas.getContext("2d");
const octx = overlay.getContext("2d");
if (!ctx || !octx) throw new Error("Canvas 2D를 사용할 수 없습니다.");
const form = $<HTMLFormElement>("controls");
const statusEl = $("status");
const infoEl = $("cellInfo");
const legendEl = $("legend");
const editorEl = $("editor");
const mapWrap = canvas.parentElement!;

const RANGE_FIELDS = ["landRatio", "states", "citiesPerState", "temperatureShift", "cells"] as const;
type RangeField = (typeof RANGE_FIELDS)[number];
const formatters: Record<RangeField, (v: number) => string> = {
  landRatio: (v) => `${Math.round(v * 100)}%`,
  states: (v) => `${v}`,
  citiesPerState: (v) => `${v}`,
  temperatureShift: (v) => (v === 0 ? "보통" : v > 0 ? `따뜻 +${v.toFixed(2)}` : `추움 ${v.toFixed(2)}`),
  cells: (v) => v.toLocaleString("ko-KR"),
};

const STORAGE_KEY = "fmg:edits:v1";

// ── 상태 ─────────────────────────────────────────────────────────────
let options: WorldOptions = { ...DEFAULT_OPTIONS };
let mesh: Mesh | undefined;
let currentMeshKey = "";
let currentTerrainKey = "";
/** 시드로 만든 원래 지형 (편집 초기화용) */
let baseElevation: Float64Array | undefined;
/** 현재 지형 (편집이 반영된 값) */
let elevation: Float64Array | undefined;
let edited = false;
/**
 * 지명 스타일별 이름 기억. 다시 계산할 때 같은 자리의 국가·도시·강·봉우리가 이 이름을 물려받는다.
 * 지형 자체가 바뀌면(시드 변경·편집 초기화) 비운다.
 */
let nameMemory: Partial<Record<NameStyle, NameAnchors>> = {};
let world: WorldMap | undefined;
let cache: RenderCache | undefined;
let layers: Layers = { ...DEFAULT_LAYERS };
const editHistory = new EditHistory();

let editMode = false;
const brush: Brush = { tool: "raise", radius: 45, strength: 0.5 };

// ── URL 해시 ↔ 옵션 (링크로 같은 지도를 공유) ───────────────────────
function readHash(): Partial<WorldOptions> {
  const p = new URLSearchParams(location.hash.slice(1));
  const out: Partial<WorldOptions> = {};
  const seed = p.get("seed");
  if (seed) out.seed = seed.slice(0, 40);
  const style = p.get("style");
  if (style === "korean" || style === "western") out.nameStyle = style;
  const shape = p.get("shape");
  if (shape === "continent" || shape === "archipelago") out.shape = shape;
  for (const key of RANGE_FIELDS) {
    const v = Number(p.get(key));
    if (p.has(key) && Number.isFinite(v)) (out as Record<string, number>)[key] = v;
  }
  return out;
}

function writeHash(o: WorldOptions): void {
  const p = new URLSearchParams({
    seed: o.seed, style: o.nameStyle, shape: o.shape,
    landRatio: String(o.landRatio), states: String(o.states), citiesPerState: String(o.citiesPerState),
    temperatureShift: String(o.temperatureShift), cells: String(o.cells),
  });
  history.replaceState(null, "", `#${p}`);
}

// ── 폼 ↔ 옵션 ────────────────────────────────────────────────────────
function fillForm(o: WorldOptions): void {
  $<HTMLInputElement>("seed").value = o.seed;
  $<HTMLSelectElement>("nameStyle").value = o.nameStyle;
  $<HTMLSelectElement>("shape").value = o.shape;
  for (const key of RANGE_FIELDS) {
    $<HTMLInputElement>(key).value = String(o[key]);
    $(`${key}Out`).textContent = formatters[key](o[key]);
  }
}

function readForm(): WorldOptions {
  const num = (id: RangeField): number => Number($<HTMLInputElement>(id).value);
  return {
    ...DEFAULT_OPTIONS,
    seed: $<HTMLInputElement>("seed").value.trim(),
    nameStyle: $<HTMLSelectElement>("nameStyle").value === "western" ? "western" : "korean",
    shape: $<HTMLSelectElement>("shape").value === "archipelago" ? "archipelago" : "continent",
    landRatio: num("landRatio"),
    states: num("states"),
    citiesPerState: num("citiesPerState"),
    temperatureShift: num("temperatureShift"),
    cells: num("cells"),
  };
}

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

// ── 그리기 ───────────────────────────────────────────────────────────
function draw(): void {
  if (world && cache) renderWorld(ctx!, world, cache, layers);
}

function renderLegend(w: WorldMap): void {
  legendEl.replaceChildren(
    ...w.states.map((s) => {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = s.color;
      const capital = w.cities.find((c) => c.cell === s.capitalCell);
      item.append(swatch, `${s.name} · 수도 ${capital?.name ?? "-"}`);
      return item;
    }),
  );
}

function updateEditButtons(): void {
  $<HTMLButtonElement>("undo").disabled = !editHistory.canUndo;
  $<HTMLButtonElement>("redo").disabled = !editHistory.canRedo;
  $<HTMLButtonElement>("resetEdits").disabled = !edited;
}

/**
 * 현재 메시·고도로 기후부터 문명까지 다시 계산해 그린다.
 * natureOnly: 브러시로 칠하는 중에는 지형·강·생태만 빠르게 갱신한다.
 */
function derive(natureOnly = false): void {
  if (!mesh || !elevation) return;
  try {
    const t0 = performance.now();
    const prior = nameMemory[options.nameStyle];
    world = deriveWorld(options, mesh, elevation, natureOnly, prior);
    if (!natureOnly) nameMemory[options.nameStyle] = mergeAnchors(extractAnchors(world), prior);
    cache = buildRenderCache(world);
    if (canvas.width !== options.width || canvas.height !== options.height) {
      canvas.width = overlay.width = options.width;
      canvas.height = overlay.height = options.height;
    }
    draw();
    if (natureOnly) return;
    renderLegend(world);
    writeHash(options);
    const editNote = edited ? " · 지형 편집됨" : "";
    setStatus(`셀 ${world.mesh.count.toLocaleString("ko-KR")}개 · 국가 ${world.states.length} · 도시 ${world.cities.length} · ${Math.round(performance.now() - t0)}ms${editNote}`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * 폼 옵션으로 지도를 만든다. 지형을 결정하는 옵션(시드·크기·셀 수·육지 비율·지형)이 그대로면
 * 편집한 지형을 유지하고 기후·문명만 다시 계산한다.
 */
function generate(
  next: WorldOptions, opts: { restoreFrom?: Float64Array; names?: Partial<Record<NameStyle, NameAnchors>> } = {},
): void {
  try {
    const nextTerrainKey = terrainKey(next);
    if (edited && nextTerrainKey !== currentTerrainKey && !opts.restoreFrom) {
      const ok = confirm("시드·육지 비율·지형·정밀도를 바꾸면 편집한 지형이 사라집니다. 계속할까요?\n(필요하면 먼저 'JSON 저장'으로 보관하세요.)");
      if (!ok) {
        fillForm(options);
        return;
      }
    }
    options = next;
    if (meshKey(next) !== currentMeshKey || !mesh) {
      mesh = createMesh(next);
      currentMeshKey = meshKey(next);
    }
    if (nextTerrainKey !== currentTerrainKey || !baseElevation || opts.restoreFrom) {
      baseElevation = createElevation(mesh, next);
      elevation = opts.restoreFrom ? Float64Array.from(opts.restoreFrom) : Float64Array.from(baseElevation);
      edited = !!opts.restoreFrom && differs(elevation, baseElevation);
      currentTerrainKey = nextTerrainKey;
      editHistory.clear();
      // 새 지형이면 이전 이름 기억은 의미가 없다. 저장본·파일에서 되살리는 경우에만 이름을 넘겨받는다.
      nameMemory = opts.names ?? {};
    }
    derive();
    saveEdits();
    updateEditButtons();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

const differs = (a: Float64Array, b: Float64Array): boolean => a.some((v, i) => Math.abs(v - b[i]) > 1e-3);

// ── 편집 내용 브라우저 저장 (이 브라우저에만 남는 편의 기능) ─────────
function saveEdits(): void {
  try {
    if (edited && elevation) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        terrainKey: currentTerrainKey, data: encodeElevation(elevation), names: nameMemory,
      }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 조용히 건너뛴다.
  }
}

function loadSavedEdits(o: WorldOptions): { elevation: Float64Array; names: Partial<Record<NameStyle, NameAnchors>> } | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as { terrainKey?: unknown; data?: unknown; names?: Record<string, unknown> };
    if (saved.terrainKey !== terrainKey(o) || typeof saved.data !== "string") return undefined;
    const elevation = decodeElevation(saved.data, createMesh(o).count);
    if (!elevation) return undefined;
    const names: Partial<Record<NameStyle, NameAnchors>> = {};
    for (const style of ["korean", "western"] as const) {
      const a = sanitizeAnchors(saved.names?.[style]);
      if (a && a.nameStyle === style) names[style] = a;
    }
    return { elevation, names };
  } catch {
    return undefined;
  }
}

// ── 편집 모드 ───────────────────────────────────────────────────────
function setEditMode(on: boolean): void {
  editMode = on;
  $<HTMLInputElement>("editMode").checked = on;
  editorEl.classList.toggle("active", on);
  mapWrap.classList.toggle("editing", on);
  if (!on) octx!.clearRect(0, 0, overlay.width, overlay.height);
}

function setTool(tool: BrushTool): void {
  brush.tool = tool;
  $("toolHint").textContent = BRUSH_TOOLS[tool].hint;
  const radio = form.ownerDocument.querySelector<HTMLInputElement>(`input[name="tool"][value="${tool}"]`);
  if (radio) radio.checked = true;
}

function toMapCoords(e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [((e.clientX - rect.left) / rect.width) * canvas.width, ((e.clientY - rect.top) / rect.height) * canvas.height];
}

function drawBrushCursor(x: number, y: number): void {
  octx!.clearRect(0, 0, overlay.width, overlay.height);
  if (!editMode) return;
  octx!.lineWidth = 2;
  octx!.strokeStyle = "rgba(0,0,0,0.55)";
  octx!.beginPath();
  octx!.arc(x, y, brush.radius, 0, Math.PI * 2);
  octx!.stroke();
  octx!.lineWidth = 1;
  octx!.strokeStyle = "rgba(255,255,255,0.9)";
  octx!.stroke();
}

let painting = false;
let lastPoint: [number, number] | undefined;
let flattenTarget = 0;
let previewQueued = false;

function queuePreview(): void {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    derive(true);
  });
}

/** 빠르게 끌어도 끊기지 않게, 이전 점과 현재 점 사이를 반지름의 1/3 간격으로 메워 찍는다. */
function paintTo(x: number, y: number): void {
  if (!mesh || !elevation) return;
  const [px, py] = lastPoint ?? [x, y];
  const dist = Math.hypot(x - px, y - py);
  const steps = Math.max(1, Math.ceil(dist / (brush.radius / 3)));
  let changed = false;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    changed = applyBrush(mesh, elevation, brush, px + (x - px) * t, py + (y - py) * t, flattenTarget) || changed;
  }
  lastPoint = [x, y];
  if (changed) {
    edited = true;
    queuePreview();
  }
}

canvas.addEventListener("pointerdown", (e) => {
  if (!editMode || e.button !== 0 || !mesh || !elevation) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = toMapCoords(e);
  editHistory.record(elevation);
  flattenTarget = elevation[findCell(mesh, x, y)];
  painting = true;
  lastPoint = undefined;
  paintTo(x, y);
});

canvas.addEventListener("pointermove", (e) => {
  const [x, y] = toMapCoords(e);
  if (editMode) drawBrushCursor(x, y);
  if (painting) {
    paintTo(x, y);
    return;
  }
  if (!world) return;
  const info = describeCell(world, findCell(world.mesh, x, y));
  infoEl.replaceChildren(
    ...Object.entries(info).flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
});

function endStroke(): void {
  if (!painting) return;
  painting = false;
  lastPoint = undefined;
  if (baseElevation && elevation) edited = differs(elevation, baseElevation);
  derive(); // 손을 떼면 도시·국가·도로까지 다시 배치
  saveEdits();
  updateEditButtons();
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);
canvas.addEventListener("pointerleave", () => {
  if (!painting) octx!.clearRect(0, 0, overlay.width, overlay.height);
});

function undo(): void {
  if (!elevation) return;
  const prev = editHistory.undo(elevation);
  if (!prev) return;
  elevation = prev;
  edited = !!baseElevation && differs(elevation, baseElevation);
  derive();
  saveEdits();
  updateEditButtons();
}

function redo(): void {
  if (!elevation) return;
  const next = editHistory.redo(elevation);
  if (!next) return;
  elevation = next;
  edited = !!baseElevation && differs(elevation, baseElevation);
  derive();
  saveEdits();
  updateEditButtons();
}

// ── 내보내기·불러오기 ───────────────────────────────────────────────
function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeFileName = (s: string): string => s.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "map";
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

async function importFile(file: File): Promise<void> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("파일이 너무 큽니다 (20MB 이하만 불러올 수 있습니다).");
  const parsed = parseMapJSON(JSON.parse(await file.text()));
  fillForm(parsed.options);
  mesh = parsed.mesh;
  currentMeshKey = meshKey(parsed.options);
  currentTerrainKey = ""; // 강제로 새 지형으로 취급
  edited = false;
  generate(parsed.options, {
    restoreFrom: parsed.elevation,
    names: parsed.anchors ? { [parsed.anchors.nameStyle]: parsed.anchors } : {},
  });
  setStatus(`${file.name}을(를) 불러왔습니다.${edited ? " (편집된 지형 포함)" : ""}`);
}

// ── 이벤트 연결 ─────────────────────────────────────────────────────
form.addEventListener("submit", (e) => {
  e.preventDefault();
  generate(readForm());
});
for (const key of RANGE_FIELDS) {
  $<HTMLInputElement>(key).addEventListener("input", (e) => {
    $(`${key}Out`).textContent = formatters[key](Number((e.target as HTMLInputElement).value));
  });
}
// 지명 스타일은 지형과 독립된 난수열을 쓰므로 바꾸면 이름만 바뀐다 (편집한 지형도 유지).
$<HTMLSelectElement>("nameStyle").addEventListener("change", () => generate(readForm()));
$("random").addEventListener("click", () => {
  const words = ["청운", "백야", "적설", "은하", "흑림", "금파", "월영", "해무", "남풍", "북극", "옥천", "현무"];
  $<HTMLInputElement>("seed").value = `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 9000 + 1000)}`;
  generate(readForm());
});

document.querySelectorAll<HTMLInputElement>("[data-layer]").forEach((box) => {
  const key = box.dataset.layer as keyof Layers;
  box.checked = layers[key];
  box.addEventListener("change", () => {
    layers = { ...layers, [key]: box.checked };
    draw();
  });
});

$<HTMLInputElement>("editMode").addEventListener("change", (e) => setEditMode((e.target as HTMLInputElement).checked));
document.querySelectorAll<HTMLInputElement>('input[name="tool"]').forEach((radio) => {
  radio.addEventListener("change", () => setTool(radio.value as BrushTool));
});
const brushSize = $<HTMLInputElement>("brushSize");
const brushStrength = $<HTMLInputElement>("brushStrength");
const syncBrush = (): void => {
  brush.radius = Number(brushSize.value);
  brush.strength = Number(brushStrength.value);
  $("brushSizeOut").textContent = `${brush.radius}px`;
  $("brushStrengthOut").textContent = `${Math.round(brush.strength * 100)}%`;
};
brushSize.addEventListener("input", syncBrush);
brushStrength.addEventListener("input", syncBrush);
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("resetEdits").addEventListener("click", () => {
  if (!baseElevation || !elevation || !edited) return;
  if (!confirm("편집한 지형을 모두 지우고 시드 지형으로 되돌릴까요? (되돌리기로 복구할 수 있습니다)")) return;
  editHistory.record(elevation);
  elevation = Float64Array.from(baseElevation);
  edited = false;
  derive();
  saveEdits();
  updateEditButtons();
});

document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" && (target as HTMLInputElement).type === "text") return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  } else if (!mod && e.key.toLowerCase() === "e") {
    setEditMode(!editMode);
  }
});

$("exportPng").addEventListener("click", () => {
  if (!world) return;
  canvas.toBlob((blob) => blob && download(`${safeFileName(options.seed)}.png`, blob), "image/png");
});
$("exportJson").addEventListener("click", () => {
  if (!world) return;
  download(`${safeFileName(options.seed)}${edited ? "_편집" : ""}.json`, new Blob([JSON.stringify(toJSON(world))], { type: "application/json" }));
});
$("importJson").addEventListener("click", () => $<HTMLInputElement>("importFile").click());
$<HTMLInputElement>("importFile").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) importFile(file).catch((err) => setStatus(err instanceof Error ? err.message : String(err), true));
});
$("copyLink").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus(edited
      ? "링크를 복사했습니다. 편집한 지형은 링크에 담기지 않으니 함께 보내려면 'JSON 저장'을 쓰세요."
      : "현재 지도 링크를 복사했습니다.");
  } catch {
    setStatus("클립보드에 접근할 수 없습니다. 주소창의 링크를 직접 복사하세요.", true);
  }
});

// ── 시작 ─────────────────────────────────────────────────────────────
const initial: WorldOptions = { ...DEFAULT_OPTIONS, ...readHash() };
fillForm(initial);
setTool(brush.tool);
syncBrush();
setEditMode(false);
// 지도 라벨이 대체 글꼴로 그려지지 않도록 웹 글꼴을 먼저 기다린다 (실패해도 진행).
Promise.race([
  document.fonts.load('600 16px "Noto Serif KR"'),
  new Promise((r) => setTimeout(r, 2500)),
]).catch(() => undefined).finally(() => {
  const saved = loadSavedEdits(initial);
  generate(initial, saved ? { restoreFrom: saved.elevation, names: saved.names } : {});
  if (saved && edited) setStatus("이 브라우저에 저장된 편집 지형을 불러왔습니다. 시드 지형으로 돌아가려면 '편집 초기화'를 누르세요.");
});
