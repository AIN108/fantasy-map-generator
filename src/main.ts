import {
  addCity, civFromJSON, civToJSON, cloneCiv, deleteCity, ensureCivNames, makeCapital, moveCity,
  paintTerritory, renameCity, renameState, snapshotCiv, type CivState, type EditResult,
} from "./civedit.ts";
import {
  applyBrush, BRUSH_TOOLS, decodeElevation, EditHistory, encodeElevation, type Brush, type BrushTool,
} from "./editor.ts";
import { findCell, type Mesh } from "./mesh.ts";
import type { NameStyle } from "./names.ts";
import { buildRenderCache, DEFAULT_LAYERS, describeCell, renderWorld, type Layers, type RenderCache } from "./render.ts";
import {
  createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, extractAnchors, meshKey, mergeAnchors, parseMapJSON,
  sanitizeAnchors, terrainKey, toJSON, type NameAnchors, type WorldMap, type WorldOptions,
} from "./world.ts";

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
const paintStateEl = $<HTMLSelectElement>("paintState");

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
/** 시드로 만든 원래 지형 (지형 초기화용) */
let baseElevation: Float64Array | undefined;
/** 현재 지형 (편집이 반영된 값) */
let elevation: Float64Array | undefined;
let edited = false;
/**
 * 직접 편집한 문명. undefined면 도시·국가·국경을 자동 배치하고,
 * 값이 있으면 자동 배치를 멈추고 이 값을 그대로 쓴다 (도시·국경 도구를 처음 쓸 때 만들어진다).
 */
let civ: CivState | undefined;
/**
 * 지명 스타일별 이름 기억. 다시 계산할 때 같은 자리의 국가·도시·강·봉우리가 이 이름을 물려받는다.
 * 지형 자체가 바뀌면(시드 변경) 비운다.
 */
let nameMemory: Partial<Record<NameStyle, NameAnchors>> = {};
let world: WorldMap | undefined;
let cache: RenderCache | undefined;
let layers: Layers = { ...DEFAULT_LAYERS };

/** 되돌리기 단위: 지형과 문명을 함께 보관한다. */
interface Snapshot { elevation: Float64Array; civ?: CivState }
const editHistory = new EditHistory<Snapshot>(50, (s) => ({
  elevation: Float64Array.from(s.elevation), civ: s.civ && cloneCiv(s.civ),
}));

type EditTarget = "terrain" | "city" | "border";
type CityTool = "move" | "add" | "delete" | "rename" | "capital";
const CITY_TOOL_HINTS: Record<CityTool, string> = {
  move: "도시를 끌어 옮깁니다. 수도를 옮기면 그 자리가 수도의 나라 땅이 됩니다.",
  add: "빈 땅을 누르면 도시가 생깁니다. 이름은 자동으로 붙고, 나중에 바꿀 수 있습니다.",
  delete: "도시를 누르면 지웁니다. 수도는 지울 수 없습니다.",
  rename: "도시를 누르고 새 이름을 입력합니다.",
  capital: "도시를 누르면 그 도시가 속한 나라의 수도가 됩니다.",
};
let editMode = false;
let editTarget: EditTarget = "terrain";
let cityTool: CityTool = "move";
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

/** 국경 칠하기에서 고를 국가 목록 (선택은 유지) */
function renderPaintStates(w: WorldMap): void {
  const selected = paintStateEl.value;
  const opts = w.states.map((s) => {
    const o = document.createElement("option");
    o.value = String(s.id);
    o.textContent = s.name;
    return o;
  });
  const none = document.createElement("option");
  none.value = "-1";
  none.textContent = "무소속 (지우기)";
  paintStateEl.replaceChildren(...opts, none);
  if ([...paintStateEl.options].some((o) => o.value === selected)) paintStateEl.value = selected;
}

function updateEditButtons(): void {
  $<HTMLButtonElement>("undo").disabled = !editHistory.canUndo;
  $<HTMLButtonElement>("redo").disabled = !editHistory.canRedo;
  $<HTMLButtonElement>("resetEdits").disabled = !edited;
  $<HTMLButtonElement>("resetCiv").disabled = !civ;
}

/**
 * 현재 메시·고도(·편집한 문명)로 기후부터 문명까지 다시 계산해 그린다.
 * natureOnly: 지형 브러시로 칠하는 중에는 지형·강·생태만 빠르게 갱신한다.
 */
function derive(natureOnly = false): void {
  if (!mesh || !elevation) return;
  try {
    const t0 = performance.now();
    const prior = nameMemory[options.nameStyle];
    if (civ) ensureCivNames(civ, options.nameStyle, options.seed);
    world = deriveWorld(options, mesh, elevation, natureOnly, prior, civ);
    if (!natureOnly) nameMemory[options.nameStyle] = mergeAnchors(extractAnchors(world), prior);
    cache = buildRenderCache(world);
    if (canvas.width !== options.width || canvas.height !== options.height) {
      canvas.width = overlay.width = options.width;
      canvas.height = overlay.height = options.height;
    }
    draw();
    if (natureOnly) return;
    renderLegend(world);
    renderPaintStates(world);
    writeHash(options);
    const notes = [edited ? "지형 편집됨" : "", civ ? "도시·국경 직접 편집됨" : ""].filter(Boolean);
    const hidden = civ ? civ.cities.length - world.cities.length : 0;
    if (hidden > 0) notes.push(`물에 잠긴 도시 ${hidden}곳 숨김`);
    setStatus(`셀 ${world.mesh.count.toLocaleString("ko-KR")}개 · 국가 ${world.states.length} · 도시 ${world.cities.length} · ${Math.round(performance.now() - t0)}ms${notes.map((n) => ` · ${n}`).join("")}`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

/** 편집 후 공통 마무리: 다시 그리고, 저장하고, 버튼 상태를 맞춘다. */
function commit(): void {
  if (baseElevation && elevation) edited = differs(elevation, baseElevation);
  derive();
  saveEdits();
  updateEditButtons();
}

/**
 * 폼 옵션으로 지도를 만든다. 지형을 결정하는 옵션(시드·크기·셀 수·육지 비율·지형)이 그대로면
 * 편집한 지형을 유지하고 기후·문명만 다시 계산한다.
 */
function generate(
  next: WorldOptions,
  opts: { restoreFrom?: Float64Array; names?: Partial<Record<NameStyle, NameAnchors>>; civ?: CivState } = {},
): void {
  try {
    const nextTerrainKey = terrainKey(next);
    const restoring = !!opts.restoreFrom;
    if ((edited || civ) && nextTerrainKey !== currentTerrainKey && !restoring) {
      const ok = confirm("시드·육지 비율·지형·정밀도를 바꾸면 편집한 지형과 도시·국경이 사라집니다. 계속할까요?\n(필요하면 먼저 'JSON 저장'으로 보관하세요.)");
      if (!ok) {
        fillForm(options);
        return;
      }
    } else if (civ && !restoring && (next.states !== options.states || next.citiesPerState !== options.citiesPerState)) {
      // 직접 편집한 문명에는 국가 수·도시 수 옵션이 적용되지 않는다.
      const ok = confirm("국가 수·도시 수를 바꾸려면 직접 편집한 도시·국경을 버리고 자동 배치로 돌아가야 합니다. 계속할까요?");
      if (!ok) {
        fillForm(options);
        return;
      }
      editHistory.record(snap());
      civ = undefined;
    }
    options = next;
    if (meshKey(next) !== currentMeshKey || !mesh) {
      mesh = createMesh(next);
      currentMeshKey = meshKey(next);
    }
    if (nextTerrainKey !== currentTerrainKey || !baseElevation || restoring) {
      baseElevation = createElevation(mesh, next);
      elevation = opts.restoreFrom ? Float64Array.from(opts.restoreFrom) : Float64Array.from(baseElevation);
      edited = restoring && differs(elevation, baseElevation);
      currentTerrainKey = nextTerrainKey;
      editHistory.clear();
      // 새 지형이면 이전 이름 기억·편집 문명은 의미가 없다. 저장본·파일에서 되살리는 경우에만 넘겨받는다.
      nameMemory = opts.names ?? {};
      civ = opts.civ;
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
    if ((edited || civ) && elevation) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        terrainKey: currentTerrainKey,
        data: encodeElevation(elevation),
        names: nameMemory,
        civ: civ ? civToJSON(civ) : undefined,
      }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 조용히 건너뛴다.
  }
}

interface SavedEdits {
  elevation: Float64Array;
  names: Partial<Record<NameStyle, NameAnchors>>;
  civ?: CivState;
}

function loadSavedEdits(o: WorldOptions): SavedEdits | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as { terrainKey?: unknown; data?: unknown; names?: Record<string, unknown>; civ?: unknown };
    if (saved.terrainKey !== terrainKey(o) || typeof saved.data !== "string") return undefined;
    const count = createMesh(o).count;
    const elevation = decodeElevation(saved.data, count);
    if (!elevation) return undefined;
    const names: Partial<Record<NameStyle, NameAnchors>> = {};
    for (const style of ["korean", "western"] as const) {
      const a = sanitizeAnchors(saved.names?.[style]);
      if (a && a.nameStyle === style) names[style] = a;
    }
    return { elevation, names, civ: saved.civ === undefined ? undefined : civFromJSON(saved.civ, count) };
  } catch {
    return undefined;
  }
}

// ── 편집 모드·도구 ──────────────────────────────────────────────────
function setEditMode(on: boolean): void {
  editMode = on;
  $<HTMLInputElement>("editMode").checked = on;
  editorEl.classList.toggle("active", on);
  mapWrap.classList.toggle("editing", on);
  if (!on) octx!.clearRect(0, 0, overlay.width, overlay.height);
}

function updateHint(): void {
  const hint = editTarget === "terrain"
    ? BRUSH_TOOLS[brush.tool].hint
    : editTarget === "city"
      ? CITY_TOOL_HINTS[cityTool]
      : "고른 국가의 영토로 칠합니다. 다른 나라의 수도 자리는 칠해지지 않습니다.";
  const civNote = editTarget !== "terrain" && !civ ? " (처음 편집하면 자동 배치를 멈추고 지금 상태를 고정합니다)" : "";
  $("toolHint").textContent = hint + civNote;
}

function setEditTarget(target: EditTarget): void {
  editTarget = target;
  editorEl.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.target === target));
  });
  editorEl.querySelectorAll<HTMLElement>(".tab-panel").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== target;
  });
  // 도시 도구는 브러시를 쓰지 않고, 국경은 세기가 필요 없다.
  $("brushFields").hidden = target === "city";
  $("strengthField").hidden = target !== "terrain";
  mapWrap.classList.toggle("city-tool", target === "city");
  updateHint();
}

function setTool(tool: BrushTool): void {
  brush.tool = tool;
  const radio = document.querySelector<HTMLInputElement>(`input[name="tool"][value="${tool}"]`);
  if (radio) radio.checked = true;
  updateHint();
}

function toMapCoords(e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [((e.clientX - rect.left) / rect.width) * canvas.width, ((e.clientY - rect.top) / rect.height) * canvas.height];
}

/** 화면 크기와 관계없이 손가락·마우스로 누르기 쉬운 도시 선택 반경 (지도 좌표) */
const hitRadius = (): number => 14 * (canvas.width / Math.max(1, canvas.getBoundingClientRect().width));

function clearOverlay(): void {
  octx!.clearRect(0, 0, overlay.width, overlay.height);
}

function strokeCircle(x: number, y: number, r: number, dash: number[] = []): void {
  const o = octx!;
  o.setLineDash(dash);
  o.lineWidth = 2;
  o.strokeStyle = "rgba(0,0,0,0.55)";
  o.beginPath();
  o.arc(x, y, r, 0, Math.PI * 2);
  o.stroke();
  o.lineWidth = 1;
  o.strokeStyle = "rgba(255,255,255,0.95)";
  o.stroke();
  o.setLineDash([]);
}

/** 편집 대상에 맞는 커서를 덧그린다 (브러시 원, 도시 강조, 끌고 있는 도시의 새 위치). */
function drawCursor(x: number, y: number): void {
  clearOverlay();
  if (!editMode || !world) return;
  if (editTarget !== "city") {
    strokeCircle(x, y, brush.radius);
    return;
  }
  if (draggingCity >= 0 && civ && mesh) {
    const from = civ.cities[draggingCity].cell;
    const to = findCell(mesh, x, y);
    const o = octx!;
    o.setLineDash([4, 4]);
    o.strokeStyle = "rgba(0,0,0,0.6)";
    o.beginPath();
    o.moveTo(mesh.x[from], mesh.y[from]);
    o.lineTo(mesh.x[to], mesh.y[to]);
    o.stroke();
    o.setLineDash([]);
    const ok = elevation![to] > 0 && !world.hydro.isLake[to];
    o.fillStyle = ok ? "rgba(255,255,255,0.9)" : "rgba(200,40,40,0.9)";
    o.beginPath();
    o.arc(mesh.x[to], mesh.y[to], 5, 0, Math.PI * 2);
    o.fill();
    o.stroke();
    return;
  }
  const city = nearestWorldCity(x, y);
  if (city >= 0) {
    const c = world.cities[city];
    strokeCircle(world.mesh.x[c.cell], world.mesh.y[c.cell], 10);
  } else if (cityTool === "add") {
    strokeCircle(x, y, 5, [3, 3]);
  }
}

/** 화면에 보이는 도시 중 커서와 가장 가까운 것 (world.cities 인덱스) */
function nearestWorldCity(x: number, y: number): number {
  if (!world) return -1;
  const r2 = hitRadius() ** 2;
  let best = -1, bestD = r2;
  world.cities.forEach((c, i) => {
    const d = (world!.mesh.x[c.cell] - x) ** 2 + (world!.mesh.y[c.cell] - y) ** 2;
    if (d <= bestD) { bestD = d; best = i; }
  });
  return best;
}

/** 자동 배치 상태면 지금 결과를 고정해 편집 가능한 문명으로 만든다. */
function ensureCiv(): CivState | undefined {
  if (civ) return civ;
  if (!world || world.states.length === 0 && world.cities.length === 0) {
    setStatus("편집할 문명이 없습니다. 지도를 먼저 생성하세요.", true);
    return undefined;
  }
  civ = snapshotCiv(world);
  return civ;
}

function snap(): Snapshot {
  return { elevation: elevation!, civ };
}

/** 편집 연산을 되돌리기 기록과 함께 실행한다. 실패하면 기록을 남기지 않는다. */
function applyCivEdit(edit: (c: CivState) => EditResult, success?: string): void {
  if (!elevation) return;
  const before: Snapshot = { elevation: Float64Array.from(elevation), civ: civ && cloneCiv(civ) };
  const target = ensureCiv();
  if (!target) return;
  const error = edit(target);
  if (error) {
    // 실패한 편집이 자동 배치→직접 편집 전환만 일으키지 않도록 원래 상태로 돌린다.
    civ = before.civ;
    setStatus(error, true);
    return;
  }
  editHistory.record(before);
  commit();
  if (success) setStatus(success);
}

// ── 포인터 입력 ──────────────────────────────────────────────────────
let painting = false;
let lastPoint: [number, number] | undefined;
let flattenTarget = 0;
let previewQueued = false;
let draggingCity = -1;
let borderBefore: Snapshot | undefined;

function queuePreview(natureOnly: boolean): void {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    derive(natureOnly);
  });
}

/** 빠르게 끌어도 끊기지 않게, 이전 점과 현재 점 사이를 반지름의 1/3 간격으로 메워 찍는다. */
function strokeTo(x: number, y: number, dab: (px: number, py: number) => boolean): boolean {
  const [px, py] = lastPoint ?? [x, y];
  const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / (brush.radius / 3)));
  let changed = false;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    changed = dab(px + (x - px) * t, py + (y - py) * t) || changed;
  }
  lastPoint = [x, y];
  return changed;
}

function paintTerrainTo(x: number, y: number): void {
  if (!mesh || !elevation) return;
  const changed = strokeTo(x, y, (px, py) => applyBrush(mesh!, elevation!, brush, px, py, flattenTarget));
  if (changed) {
    edited = true;
    queuePreview(true);
  }
}

function paintBorderTo(x: number, y: number): void {
  if (!mesh || !elevation || !civ || !world) return;
  const stateId = Number(paintStateEl.value);
  const changed = strokeTo(x, y, (px, py) =>
    paintTerritory(mesh!, civ!, elevation!, world!.hydro.isLake, px, py, brush.radius, stateId) > 0);
  // 국경은 문명까지 보여야 하므로 전체를 다시 계산한다 (프레임당 한 번).
  if (changed) queuePreview(false);
}

function handleCityClick(x: number, y: number): void {
  if (!world || !mesh || !elevation) return;
  const style = options.nameStyle;
  const visible = nearestWorldCity(x, y);
  // 화면의 도시(world.cities)를 편집 문명(civ.cities)의 인덱스로 바꾼다.
  const civIndex = (c: CivState): number =>
    visible < 0 ? -1 : c.cities.findIndex((cc) => cc.cell === world!.cities[visible].cell);

  if (cityTool === "add") {
    if (visible >= 0) { setStatus("이미 도시가 있는 자리입니다.", true); return; }
    const cell = findCell(mesh, x, y);
    applyCivEdit((c) => addCity(c, cell, elevation!, world!.hydro.isLake, style, options.seed), "도시를 추가했습니다.");
    return;
  }
  if (visible < 0) { setStatus("도시를 눌러 주세요.", true); return; }
  const name = world.cities[visible].name;
  if (cityTool === "delete") {
    if (!confirm(`'${name}'을(를) 지울까요?`)) return;
    applyCivEdit((c) => deleteCity(c, civIndex(c)), `'${name}'을(를) 지웠습니다.`);
  } else if (cityTool === "rename") {
    const next = prompt("새 도시 이름", name);
    if (next === null || next.trim() === name) return;
    applyCivEdit((c) => renameCity(c, civIndex(c), next, style), "이름을 바꿨습니다.");
  } else if (cityTool === "capital") {
    applyCivEdit((c) => makeCapital(c, civIndex(c)), `'${name}'을(를) 수도로 정했습니다.`);
  }
}

canvas.addEventListener("pointerdown", (e) => {
  if (!editMode || e.button !== 0 || !mesh || !elevation || !world) return;
  e.preventDefault();
  const [x, y] = toMapCoords(e);
  if (editTarget === "terrain") {
    canvas.setPointerCapture(e.pointerId);
    editHistory.record(snap());
    flattenTarget = elevation[findCell(mesh, x, y)];
    painting = true;
    lastPoint = undefined;
    paintTerrainTo(x, y);
  } else if (editTarget === "border") {
    borderBefore = { elevation: Float64Array.from(elevation), civ: civ && cloneCiv(civ) };
    if (!ensureCiv()) return;
    canvas.setPointerCapture(e.pointerId);
    painting = true;
    lastPoint = undefined;
    paintBorderTo(x, y);
  } else if (cityTool === "move") {
    const visible = nearestWorldCity(x, y);
    if (visible < 0) return;
    const before: Snapshot = { elevation: Float64Array.from(elevation), civ: civ && cloneCiv(civ) };
    const c = ensureCiv();
    if (!c) return;
    draggingCity = c.cities.findIndex((cc) => cc.cell === world!.cities[visible].cell);
    borderBefore = before;
    canvas.setPointerCapture(e.pointerId);
  } else {
    handleCityClick(x, y);
  }
});

canvas.addEventListener("pointermove", (e) => {
  const [x, y] = toMapCoords(e);
  if (editMode) drawCursor(x, y);
  if (painting) {
    if (editTarget === "terrain") paintTerrainTo(x, y);
    else if (editTarget === "border") paintBorderTo(x, y);
    return;
  }
  if (draggingCity >= 0 || !world) return;
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

function endPointer(e: PointerEvent): void {
  if (draggingCity >= 0) {
    const index = draggingCity;
    draggingCity = -1;
    const before = borderBefore;
    borderBefore = undefined;
    clearOverlay();
    if (!mesh || !elevation || !world || !civ || !before) return;
    const [x, y] = toMapCoords(e);
    const cell = findCell(mesh, x, y);
    if (cell === civ.cities[index]?.cell) {
      civ = before.civ; // 제자리에 놓으면 아무것도 하지 않은 것으로 (자동 배치 고정도 취소)
      return;
    }
    const error = moveCity(civ, index, cell, elevation, world.hydro.isLake);
    if (error) {
      civ = before.civ;
      setStatus(error, true);
      return;
    }
    editHistory.record(before);
    commit();
    return;
  }
  if (!painting) return;
  painting = false;
  lastPoint = undefined;
  if (editTarget === "border" && borderBefore) {
    editHistory.record(borderBefore);
    borderBefore = undefined;
  }
  commit(); // 지형을 칠한 뒤라면 여기서 도시·국가·도로까지 다시 배치한다
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", () => {
  if (!painting && draggingCity < 0) clearOverlay();
});

function restore(s: Snapshot): void {
  elevation = s.elevation;
  civ = s.civ;
  commit();
}

function undo(): void {
  if (!elevation) return;
  const prev = editHistory.undo(snap());
  if (prev) restore(prev);
}

function redo(): void {
  if (!elevation) return;
  const next = editHistory.redo(snap());
  if (next) restore(next);
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
  civ = undefined;
  generate(parsed.options, {
    restoreFrom: parsed.elevation,
    names: parsed.anchors ? { [parsed.anchors.nameStyle]: parsed.anchors } : {},
    civ: parsed.civ,
  });
  const extras = [edited ? "편집된 지형" : "", civ ? "직접 편집한 도시·국경" : ""].filter(Boolean).join(", ");
  setStatus(`${file.name}을(를) 불러왔습니다.${extras ? ` (${extras} 포함)` : ""}`);
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
// 지명 스타일은 지형과 독립된 난수열을 쓰므로 바꾸면 이름만 바뀐다 (편집한 지형·문명도 유지).
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
editorEl.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((tab) => {
  tab.addEventListener("click", () => {
    setEditTarget(tab.dataset.target as EditTarget);
    if (!editMode) setEditMode(true);
  });
});
document.querySelectorAll<HTMLInputElement>('input[name="tool"]').forEach((radio) => {
  radio.addEventListener("change", () => setTool(radio.value as BrushTool));
});
document.querySelectorAll<HTMLInputElement>('input[name="cityTool"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    cityTool = radio.value as CityTool;
    updateHint();
  });
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
  editHistory.record(snap());
  elevation = Float64Array.from(baseElevation);
  commit();
});
$("resetCiv").addEventListener("click", () => {
  if (!civ) return;
  if (!confirm("직접 편집한 도시·국경을 버리고 자동 배치로 돌아갈까요? (되돌리기로 복구할 수 있습니다)")) return;
  editHistory.record(snap());
  civ = undefined;
  commit();
});
$("renameState").addEventListener("click", () => {
  if (!world) return;
  const id = Number(paintStateEl.value);
  const state = world.states[id];
  if (!state) { setStatus("국가를 먼저 고르세요.", true); return; }
  const next = prompt("새 국가 이름", state.name);
  if (next === null || next.trim() === state.name) return;
  applyCivEdit((c) => renameState(c, id, next, options.nameStyle), "국가 이름을 바꿨습니다.");
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
  const suffix = edited || civ ? "_편집" : "";
  download(`${safeFileName(options.seed)}${suffix}.json`, new Blob([JSON.stringify(toJSON(world, civ))], { type: "application/json" }));
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
    setStatus(edited || civ
      ? "링크를 복사했습니다. 편집 내용은 링크에 담기지 않으니 함께 보내려면 'JSON 저장'을 쓰세요."
      : "현재 지도 링크를 복사했습니다.");
  } catch {
    setStatus("클립보드에 접근할 수 없습니다. 주소창의 링크를 직접 복사하세요.", true);
  }
});

// ── 시작 ─────────────────────────────────────────────────────────────
const initial: WorldOptions = { ...DEFAULT_OPTIONS, ...readHash() };
fillForm(initial);
setTool(brush.tool);
setEditTarget("terrain");
syncBrush();
setEditMode(false);
// 지도 라벨이 대체 글꼴로 그려지지 않도록 웹 글꼴을 먼저 기다린다 (실패해도 진행).
Promise.race([
  document.fonts.load('600 16px "Noto Serif KR"'),
  new Promise((r) => setTimeout(r, 2500)),
]).catch(() => undefined).finally(() => {
  const saved = loadSavedEdits(initial);
  generate(initial, saved ? { restoreFrom: saved.elevation, names: saved.names, civ: saved.civ } : {});
  if (saved && (edited || civ)) setStatus("이 브라우저에 저장된 편집 내용을 불러왔습니다. '지형 초기화'·'자동 배치로'로 되돌릴 수 있습니다.");
});
