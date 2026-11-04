import {
  addCity, cloneCiv, createState, deleteCity, deleteState, ensureCivNames, makeCapital,
  moveCity, paintTerritory, renameCity, renameState, snapshotCiv, type CivState, type EditResult,
} from "./civedit.ts";
import { applyBrush, BRUSH_TOOLS, EditHistory, type Brush, type BrushTool } from "./editor.ts";
import {
  addFacility, addPath, addPort, addSeaRoute, addSpan, cloneInfra, toggleSpanMode, hitSpan, MAX_SPAN_LENGTH, moveSpan, spanLinks,
  SPAN_MODE_KO, type SpanMode, type SpanPart, emptyInfra, eraseAt, FACILITY_INFO, hitPoint,
  isEmptyInfra, movePoint, routePath, routeSea, type FacilityKind, type Infra, type PointKind,
} from "./infra.ts";
import { findCell, type Mesh } from "./mesh.ts";
import type { NameStyle } from "./names.ts";
import type { PreviewInput, PreviewOutput } from "./preview.ts";
import {
  addResource, cloneResourceEdits, emptyResourceEdits, hitResource, isEmptyResourceEdits, isResourceKind, removeResource,
  RESOURCE_CATEGORY_KO, RESOURCE_INFO, RESOURCE_KINDS, type ResourceCategory, type ResourceEdits, type ResourceKind,
} from "./resources.ts";
import {
  buildRenderCache, DEFAULT_LAYERS, describeCell, drawBridgeSpan, drawTunnelSpan, type Layers, type RenderCache,
} from "./render.ts";
import { fillForm, formatHash, formatters, parseHash, RANGE_FIELDS, readForm } from "./ui/options.ts";
import { loadSavedEdits, saveEdits as saveEdits_, type KeyValueStore } from "./ui/storage.ts";
import { isTypingTarget } from "./ui/dom.ts";
import { renderResourceLegend } from "./ui/resource-legend.ts";
import { eul } from "./ui/text.ts";
import { PreviewClient, type WorkerLike } from "./ui/preview-client.ts";
import {
  BORDER_HINT, CITY_TOOL_HINTS, INFRA_TOOL_HINTS, RESOURCE_TOOL_HINTS, type CityTool, type EditTarget, type InfraTool,
  type ResourceTool,
} from "./ui/tool-hints.ts";
import { Viewport } from "./ui/viewport.ts";
import {
  applyInfra, applyResources, createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, extractAnchors, meshKey, mergeAnchors, parseMapJSON,
  natureKey, natureOf, terrainKey, toJSON, validateOptions, type NameAnchors, type Nature, type WorldMap, type WorldOptions,
} from "./world.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소가 없습니다.`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>("map");
const form = $<HTMLFormElement>("controls");
const statusEl = $("status");
const infoEl = $("cellInfo");
const legendEl = $("legend");
const editorEl = $("editor");
const mapWrap = canvas.parentElement!;
const paintStateEl = $<HTMLSelectElement>("paintState");
const mergeIntoEl = $<HTMLSelectElement>("mergeInto");
const resourceKindEl = $<HTMLSelectElement>("resourceKind");
const resourceLegendEl = $("resourceLegend");

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
/** 사용자가 그린 도로·철도와 놓은 항구·시설물 */
let infra: Infra = emptyInfra();
/** 자동 배치한 천연자원 위에 얹은 직접 편집 (놓은 자원, 지운 자동 자원) */
let resourceEdits: ResourceEdits = emptyResourceEdits();
/** 자동으로 만든 도로 (도로를 처음 편집할 때 이 값을 고정한다) */
let autoRoads: number[][] = [];
/**
 * 지명 스타일별 이름 기억. 다시 계산할 때 같은 자리의 국가·도시·강·봉우리가 이 이름을 물려받는다.
 * 지형 자체가 바뀌면(시드 변경) 비운다.
 */
let nameMemory: Partial<Record<NameStyle, NameAnchors>> = {};
let world: WorldMap | undefined;
let cache: RenderCache | undefined;
let layers: Layers = { ...DEFAULT_LAYERS };

/** 되돌리기 단위: 지형과 문명을 함께 보관한다. */
interface Snapshot { elevation: Float64Array; civ?: CivState; infra: Infra; resources: ResourceEdits }
const copySnapshot = (s: Snapshot): Snapshot => ({
  elevation: Float64Array.from(s.elevation), civ: s.civ && cloneCiv(s.civ), infra: cloneInfra(s.infra),
  resources: cloneResourceEdits(s.resources),
});
const editHistory = new EditHistory<Snapshot>(50, copySnapshot);

let editMode = false;
let editTarget: EditTarget = "terrain";
let cityTool: CityTool = "move";
let infraTool: InfraTool = "road";
let resourceTool: ResourceTool = "add";
const brush: Brush = { tool: "raise", radius: 45, strength: 0.5 };

/** 지도 그리기와 확대·이동. 확대·이동 상태는 지도 데이터와 무관한 보기 설정이라 저장·되돌리기에 넣지 않는다. */
const viewport = new Viewport(canvas, $<HTMLCanvasElement>("overlay"), {
  zoomIn: $<HTMLButtonElement>("zoomIn"),
  zoomOut: $<HTMLButtonElement>("zoomOut"),
  zoomReset: $<HTMLButtonElement>("zoomReset"),
  level: $("zoomLevel"),
}, {
  scene: () => (world && cache ? { world, cache, layers } : undefined),
  editMode: () => editMode,
  editDown: (e) => onEditPointerDown(e),
  editMove: (e) => onEditPointerMove(e),
  editEnd: (e) => endPointer(e),
  editCancel: () => cancelPointerEdit(),
  viewChanged: (x, y) => {
    if (editMode && x !== undefined && y !== undefined) drawCursor(x, y);
    else viewport.clearOverlay();
  },
  pointerLeave: () => {
    if (!painting && draggingCity < 0 && routeStart < 0 && !draggingPoint && !draggingSpan) viewport.clearOverlay();
  },
});

/** 칠하기 미리보기 계산을 맡을 Worker. 만들 수 없는 환경이면 메인 스레드에서 계산한다. */
function createPreviewWorker(): WorkerLike | undefined {
  try {
    // Vite가 이 형태(new Worker(new URL(...), { type: "module" }))를 보고 Worker를 따로 묶는다.
    return new Worker(new URL("./preview.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
  } catch {
    return undefined;
  }
}

const previewClient = new PreviewClient(createPreviewWorker(), {
  result: (output) => showPreview(output),
  error: (message) => setStatus(message, true),
  fallback: (natureOnly) => { if (painting) queueSyncPreview(natureOnly); },
});

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
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
  renderMergeTargets();
}

/** 국가 없애기에서 영토를 넘겨받을 곳: 무소속 + 고른 나라를 뺀 나머지 */
function renderMergeTargets(): void {
  if (!world) return;
  const selected = mergeIntoEl.value;
  const removing = Number(paintStateEl.value);
  const none = document.createElement("option");
  none.value = "-1";
  none.textContent = "무소속";
  const opts = world.states.filter((s) => s.id !== removing).map((s) => {
    const o = document.createElement("option");
    o.value = String(s.id);
    o.textContent = s.name;
    return o;
  });
  mergeIntoEl.replaceChildren(none, ...opts);
  if ([...mergeIntoEl.options].some((o) => o.value === selected)) mergeIntoEl.value = selected;
  $<HTMLButtonElement>("deleteState").disabled = !(removing >= 0 && world.states[removing]);
}

function updateEditButtons(): void {
  $<HTMLButtonElement>("undo").disabled = !editHistory.canUndo;
  $<HTMLButtonElement>("redo").disabled = !editHistory.canRedo;
  $<HTMLButtonElement>("resetEdits").disabled = !edited;
  $<HTMLButtonElement>("resetCiv").disabled = !civ;
  $<HTMLButtonElement>("resetRoads").disabled = infra.roads === undefined;
  $<HTMLButtonElement>("resetResources").disabled = isEmptyResourceEdits(resourceEdits);
}

/**
 * 다시 계산할 때의 입력. 지형을 칠하는 동안 Worker에 보낼 때는 elevation을 복사한다 (보내는 동안에도 계속 칠하므로).
 */
function deriveInput(m: Mesh, e: Float64Array, natureOnly: boolean, copy: boolean): PreviewInput {
  if (civ) ensureCivNames(civ, options.nameStyle, options.seed);
  // 자동 도로가 다리·터널을 길로 쓰도록 연결을 넘긴다. 호수 여부는 직전 계산 결과를 쓴다
  // (지형을 바꾼 직후 한 번은 오래된 값일 수 있지만, 다리 양 끝이 호수가 되는 경우는 드물다).
  const lakes = world && world.mesh === m ? world.hydro.isLake : new Uint8Array(m.count);
  const links = spanLinks({ mesh: m, elevation: e, biome: [], hydro: { isLake: lakes, isRiver: lakes } }, infra, "road");
  return {
    options, elevation: copy ? Float64Array.from(e) : e, natureOnly, prior: nameMemory[options.nameStyle], civ, links, infra,
    resources: resourceEdits, natureKey: natureKey(options, e),
  };
}

/**
 * 마지막으로 계산한 자연(기후·수계·생태·강). 고도가 그대로인 편집(도시·국경·시설·지명 스타일)이나
 * 칠하기 미리보기가 이미 최종 지형으로 계산해 둔 경우에는 다시 계산하지 않는다.
 */
let natureCache: { key: string; nature: Nature } | undefined;

/**
 * 현재 메시·고도(·편집한 문명)로 기후부터 문명까지 다시 계산해 그린다.
 * natureOnly: 지형 브러시로 칠하는 중에는 지형·강·생태만 빠르게 갱신한다.
 */
function derive(natureOnly = false): void {
  if (!mesh || !elevation) return;
  // 이 계산이 최신이다: 칠하는 동안 Worker에 맡긴 미리보기가 늦게 와도 버린다.
  previewClient.cancel();
  try {
    const t0 = performance.now();
    const input = deriveInput(mesh, elevation, natureOnly, false);
    const { prior } = input;
    const reuse = natureCache?.key === input.natureKey ? natureCache.nature : undefined;
    const derived = deriveWorld(options, mesh, elevation, natureOnly, prior, input.civ, input.links, reuse);
    natureCache = { key: input.natureKey, nature: natureOf(derived) };
    if (!natureOnly) {
      nameMemory[options.nameStyle] = mergeAnchors(extractAnchors(derived), prior);
      autoRoads = derived.roads;
    }
    world = applyResources(applyInfra(derived, infra), resourceEdits);
    cache = buildRenderCache(world);
    viewport.setMapSize(options.width, options.height);
    viewport.syncBacking();
    viewport.draw(painting); // 칠하는 중이면 빠르게, 손을 뗀 뒤(commit)에는 선명하게
    if (natureOnly) return;
    renderLegend(world);
    renderResourceLegend(resourceLegendEl, world.resources, layers.resources);
    renderPaintStates(world);
    history.replaceState(null, "", formatHash(options));
    const notes = [
      edited ? "지형 편집됨" : "", civ ? "도시·국경 직접 편집됨" : "", infra.roads ? "도로 고정됨" : "",
    ].filter(Boolean);
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
  opts: {
    restoreFrom?: Float64Array; names?: Partial<Record<NameStyle, NameAnchors>>; civ?: CivState; infra?: Infra;
    resources?: ResourceEdits;
  } = {},
): void {
  try {
    // 범위를 벗어난 옵션(URL로 들어온 값 등)으로 메시부터 만들면 셀 수에 따라 수십 초 멈출 수 있다.
    validateOptions(next);
    const nextTerrainKey = terrainKey(next);
    const restoring = !!opts.restoreFrom;
    if (hasEdits() && nextTerrainKey !== currentTerrainKey && !restoring) {
      const ok = confirm("시드·육지 비율·지형·정밀도를 바꾸면 편집한 지형·도시·국경·시설이 사라집니다. 계속할까요?\n(필요하면 먼저 'JSON 저장'으로 보관하세요.)");
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
      infra = opts.infra ?? emptyInfra();
      resourceEdits = opts.resources ?? emptyResourceEdits();
    }
    derive();
    previewClient.warm(options); // Worker가 메시를 미리 만들어 두게 한다
    saveEdits();
    updateEditButtons();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

const differs = (a: Float64Array, b: Float64Array): boolean => a.some((v, i) => Math.abs(v - b[i]) > 1e-3);
const hasEdits = (): boolean => edited || !!civ || !isEmptyInfra(infra) || !isEmptyResourceEdits(resourceEdits);

// ── 편집 내용 브라우저 저장 (이 브라우저에만 남는 편의 기능) ─────────
/** 사생활 보호 모드 등에서는 localStorage에 접근만 해도 예외가 날 수 있다. */
function browserStore(): KeyValueStore | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

function saveEdits(): void {
  const store = browserStore();
  if (!store || !elevation) return;
  saveEdits_(store, currentTerrainKey, hasEdits(), { elevation, names: nameMemory, civ, infra, resources: resourceEdits });
}

/** 시작할 때 이 브라우저에 저장된 편집을 읽는다. 옵션이 잘못됐으면 없는 것으로 (오류는 generate가 보여 준다). */
function loadStartupEdits(o: WorldOptions): ReturnType<typeof loadSavedEdits> {
  const store = browserStore();
  if (!store) return undefined;
  try { validateOptions(o); } catch { return undefined; }
  return loadSavedEdits(store, terrainKey(o), () => createMesh(o).count);
}

// ── 편집 모드·도구 ──────────────────────────────────────────────────
function setEditMode(on: boolean): void {
  editMode = on;
  $<HTMLInputElement>("editMode").checked = on;
  editorEl.classList.toggle("active", on);
  mapWrap.classList.toggle("editing", on);
  if (!on) viewport.clearOverlay();
}

function updateHint(): void {
  const hint = editTarget === "terrain"
    ? BRUSH_TOOLS[brush.tool].hint
    : editTarget === "city"
      ? CITY_TOOL_HINTS[cityTool]
      : editTarget === "infra"
        ? INFRA_TOOL_HINTS[infraTool]
        : editTarget === "resource"
          ? RESOURCE_TOOL_HINTS[resourceTool]
          : BORDER_HINT;
  const civNote = (editTarget === "city" || editTarget === "border") && !civ
    ? " (처음 편집하면 자동 배치를 멈추고 지금 상태를 고정합니다)"
    : editTarget === "infra" && (infraTool === "road" || infraTool === "erase") && !infra.roads
      ? " (도로를 처음 편집하면 자동 도로를 지금 상태로 고정합니다)"
      : "";
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
  const pointTool = target === "city" || target === "infra" || target === "resource";
  $("brushFields").hidden = pointTool;
  $("strengthField").hidden = target !== "terrain";
  mapWrap.classList.toggle("city-tool", pointTool);
  syncInfraFields();
  syncResourceFields();
  updateHint();
}

function syncInfraFields(): void {
  $("facilityKindField").hidden = infraTool !== "facility";
  $("spanModeField").hidden = infraTool !== "bridge" && infraTool !== "tunnel";
  $("featureNameField").hidden = infraTool !== "facility" && infraTool !== "port";
}

/** 자원 놓기에서만 종류를, 전략 자원일 때만 매장량을 고른다. */
function syncResourceFields(): void {
  $("resourceKindField").hidden = resourceTool !== "add";
  $("resourceAmountField").hidden = resourceTool !== "add" || RESOURCE_INFO[selectedResourceKind()].category !== "strategic";
}

function selectedResourceKind(): ResourceKind {
  const v = resourceKindEl.value;
  return isResourceKind(v) ? v : "iron";
}

/** 자원 종류 목록: 분류별로 묶는다. */
function fillResourceKinds(): void {
  const groups = (["strategic", "luxury", "bonus"] as ResourceCategory[]).map((cat) => {
    const g = document.createElement("optgroup");
    g.label = RESOURCE_CATEGORY_KO[cat];
    for (const k of RESOURCE_KINDS.filter((kind) => RESOURCE_INFO[kind].category === cat)) {
      const o = document.createElement("option");
      o.value = k;
      const site = RESOURCE_INFO[k].site;
      o.textContent = RESOURCE_INFO[k].ko + (site === "water" ? " (바다·호수)" : site === "any" ? " (육지·바다)" : "");
      g.append(o);
    }
    return g;
  });
  resourceKindEl.replaceChildren(...groups);
}

function setTool(tool: BrushTool): void {
  brush.tool = tool;
  const radio = document.querySelector<HTMLInputElement>(`input[name="tool"][value="${tool}"]`);
  if (radio) radio.checked = true;
  updateHint();
}

/** 편집 대상에 맞는 커서를 덧그린다 (브러시 원, 도시 강조, 끌고 있는 도시의 새 위치). */
function drawCursor(x: number, y: number): void {
  viewport.clearOverlay();
  if (!editMode || !world) return;
  if (editTarget === "infra") {
    drawInfraCursor(x, y);
    return;
  }
  if (editTarget === "resource") {
    const hit = hitResource(world.mesh, world.resources, x, y, viewport.hitRadius());
    if (resourceTool === "erase" && hit >= 0) viewport.strokeCircle(world.mesh.x[hit], world.mesh.y[hit], 8);
    else {
      const c = findCell(world.mesh, x, y);
      viewport.strokeCircle(world.mesh.x[c], world.mesh.y[c], 6, [3, 3]);
    }
    return;
  }
  if (editTarget !== "city") {
    viewport.strokeCircle(x, y, brush.radius);
    return;
  }
  if (draggingCity >= 0 && civ && mesh) {
    const from = civ.cities[draggingCity].cell;
    const to = findCell(mesh, x, y);
    const o = viewport.octx;
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
    viewport.strokeCircle(world.mesh.x[c.cell], world.mesh.y[c.cell], 10);
  } else if (cityTool === "add") {
    viewport.strokeCircle(x, y, 5, [3, 3]);
  }
}

function drawInfraCursor(x: number, y: number): void {
  if (!world || !mesh) return;
  const o = viewport.octx;
  if (draggingPoint) {
    const item = draggingPoint.kind === "port" ? infra.ports[draggingPoint.index] : infra.facilities[draggingPoint.index];
    if (!item) return;
    const to = findCell(mesh, x, y);
    o.setLineDash([4, 4]);
    o.strokeStyle = "rgba(0,0,0,0.6)";
    o.lineWidth = 1;
    o.beginPath();
    o.moveTo(mesh.x[item.cell], mesh.y[item.cell]);
    o.lineTo(mesh.x[to], mesh.y[to]);
    o.stroke();
    o.setLineDash([]);
    viewport.strokeCircle(mesh.x[to], mesh.y[to], 8);
    return;
  }
  if (isSpanTool() && routeStart >= 0) {
    const end = findCell(mesh, x, y);
    const [ax, ay, bx, by] = [mesh.x[routeStart], mesh.y[routeStart], mesh.x[end], mesh.y[end]];
    const tooLong = Math.hypot(bx - ax, by - ay) > MAX_SPAN_LENGTH;
    o.globalAlpha = tooLong ? 0.4 : 0.9;
    if (infraTool === "bridge") drawBridgeSpan(o, ax, ay, bx, by, spanMode()); else drawTunnelSpan(o, ax, ay, bx, by, spanMode());
    o.globalAlpha = 1;
    viewport.strokeCircle(ax, ay, 5);
    return;
  }
  if (isLineTool() && routeStart >= 0) {
    if (routePreview && routePreview.length >= 2) {
      o.beginPath();
      o.moveTo(mesh.x[routePreview[0]], mesh.y[routePreview[0]]);
      for (const c of routePreview) o.lineTo(mesh.x[c], mesh.y[c]);
      o.lineWidth = 4;
      o.strokeStyle = "rgba(255,255,255,0.85)";
      o.stroke();
      o.lineWidth = 2;
      o.strokeStyle = infraTool === "rail" ? "#2b2b2b" : infraTool === "sea" ? "rgba(18,38,78,0.95)" : "rgba(110,70,40,0.95)";
      o.stroke();
    }
    viewport.strokeCircle(mesh.x[routeStart], mesh.y[routeStart], 5);
    return;
  }
  if (infraTool === "sea") {
    const port = snapToPort(x, y);
    if (port >= 0) viewport.strokeCircle(mesh.x[port], mesh.y[port], 10);
    else viewport.strokeCircle(x, y, 6, [3, 3]);
    return;
  }
  if (infraTool === "toggleMode") {
    const span = hitSpan(mesh, infra, x, y, viewport.hitRadius());
    if (span) {
      const sp = (span.kind === "bridge" ? infra.bridges : infra.tunnels)[span.index];
      o.lineWidth = 7;
      o.strokeStyle = "rgba(255,255,255,0.55)";
      o.beginPath();
      o.moveTo(mesh.x[sp.a], mesh.y[sp.a]);
      o.lineTo(mesh.x[sp.b], mesh.y[sp.b]);
      o.stroke();
    } else viewport.strokeCircle(x, y, 6, [3, 3]);
    return;
  }
  if (infraTool === "move") {
    if (draggingSpan) {
      const cells = movedSpanCells(x, y);
      if (!cells) return;
      const [a, b] = cells;
      const tooLong = Math.hypot(mesh.x[b] - mesh.x[a], mesh.y[b] - mesh.y[a]) > MAX_SPAN_LENGTH;
      o.globalAlpha = tooLong ? 0.4 : 0.9;
      const mode = (draggingSpan.kind === "bridge" ? infra.bridges : infra.tunnels)[draggingSpan.index]?.mode ?? "road";
      if (draggingSpan.kind === "bridge") drawBridgeSpan(o, mesh.x[a], mesh.y[a], mesh.x[b], mesh.y[b], mode);
      else drawTunnelSpan(o, mesh.x[a], mesh.y[a], mesh.x[b], mesh.y[b], mode);
      o.globalAlpha = 1;
      return;
    }
    const hit = hitPoint(mesh, infra, x, y, viewport.hitRadius());
    const item = hit && (hit.kind === "port" ? infra.ports[hit.index] : infra.facilities[hit.index]);
    if (item) { viewport.strokeCircle(mesh.x[item.cell], mesh.y[item.cell], 10); return; }
    const span = hitSpan(mesh, infra, x, y, viewport.hitRadius());
    if (span) {
      const sp = (span.kind === "bridge" ? infra.bridges : infra.tunnels)[span.index];
      if (span.part === "body") {
        o.lineWidth = 6;
        o.strokeStyle = "rgba(255,255,255,0.5)";
        o.beginPath();
        o.moveTo(mesh.x[sp.a], mesh.y[sp.a]);
        o.lineTo(mesh.x[sp.b], mesh.y[sp.b]);
        o.stroke();
      } else {
        const c = span.part === "a" ? sp.a : sp.b;
        viewport.strokeCircle(mesh.x[c], mesh.y[c], 7);
      }
    }
    return;
  }
  const city = infraTool === "road" || infraTool === "rail" ? nearestWorldCity(x, y) : -1;
  if (city >= 0) viewport.strokeCircle(mesh.x[world.cities[city].cell], mesh.y[world.cities[city].cell], 10);
  else viewport.strokeCircle(x, y, infraTool === "erase" ? viewport.hitRadius() : 6, [3, 3]);
}

/** 끄는 동안 미리보기 경로를 프레임당 한 번만 계산한다 */
function queueRoutePreview(x: number, y: number): void {
  routeQueued = true;
  requestAnimationFrame(() => {
    if (!routeQueued || routeStart < 0 || !world) return;
    routeQueued = false;
    if (infraTool === "sea") {
      const end = snapToPort(x, y);
      routePreview = end >= 0 ? routeSea(world, routeStart, end) : null;
    } else {
      const mode = infraTool === "rail" ? "rail" : "road";
      routePreview = routePath(world, routeStart, snapToCity(x, y), mode, spanLinks(world, world, mode));
    }
    drawCursor(x, y);
  });
}

/** 화면에 보이는 도시 중 커서와 가장 가까운 것 (world.cities 인덱스) */
function nearestWorldCity(x: number, y: number): number {
  if (!world) return -1;
  const r2 = viewport.hitRadius() ** 2;
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
  return { elevation: elevation!, civ, infra, resources: resourceEdits };
}

/** 편집 연산을 되돌리기 기록과 함께 실행한다. 실패하면 기록을 남기지 않고 false. */
function applyCivEdit(edit: (c: CivState) => EditResult, success?: string): boolean {
  if (!elevation) return false;
  const before: Snapshot = copySnapshot(snap());
  const target = ensureCiv();
  if (!target) return false;
  const error = edit(target);
  if (error) {
    // 실패한 편집이 자동 배치→직접 편집 전환만 일으키지 않도록 원래 상태로 돌린다.
    civ = before.civ;
    setStatus(error, true);
    return false;
  }
  editHistory.record(before);
  commit();
  if (success) setStatus(success);
  return true;
}

/** 시설 편집을 되돌리기 기록과 함께 실행한다. 실패하면 원래대로 두고 false. */
function applyInfraEdit(edit: (inf: Infra) => EditResult, success?: string): boolean {
  const before = copySnapshot(snap());
  const error = edit(infra);
  if (error) {
    infra = before.infra;
    setStatus(error, true);
    return false;
  }
  editHistory.record(before);
  commit();
  if (success) setStatus(success);
  return true;
}

/** 자원 편집을 되돌리기 기록과 함께 실행한다. 실패하면 원래대로 두고 false. */
function applyResourceEdit(edit: (r: ResourceEdits) => EditResult, success?: string): boolean {
  const before = copySnapshot(snap());
  const error = edit(resourceEdits);
  if (error) {
    resourceEdits = before.resources;
    setStatus(error, true);
    return false;
  }
  editHistory.record(before);
  commit();
  if (success) setStatus(success);
  return true;
}

function handleResourceClick(x: number, y: number): void {
  if (!world || !mesh) return;
  if (resourceTool === "erase") {
    const cell = hitResource(mesh, world.resources, x, y, viewport.hitRadius());
    let removed: string | null = null;
    applyResourceEdit((r) => {
      removed = cell >= 0 ? removeResource(r, world!.resources, world!.autoResources, cell) : null;
      return removed ? null : "지울 자원이 없습니다. 자원 아이콘 가까이를 눌러 주세요.";
    });
    if (removed) setStatus(`${removed}${eul(removed)} 지웠습니다.`);
    return;
  }
  const cell = findCell(mesh, x, y);
  const kind = selectedResourceKind();
  const { ko } = RESOURCE_INFO[kind];
  const replaced = world.resources.find((r) => r.cell === cell);
  const amount = Number($<HTMLInputElement>("resourceAmount").value);
  applyResourceEdit(
    (r) => addResource(world!, r, world!.autoResources, cell, kind, amount),
    replaced && replaced.kind !== kind
      ? `${RESOURCE_INFO[replaced.kind].ko}${eul(RESOURCE_INFO[replaced.kind].ko)} ${ko}(으)로 바꿨습니다.`
      : `${ko}${eul(ko)} 놓았습니다.`,
  );
}

/** 도로·철도 끝점: 도시 근처면 도시 셀에 붙인다 */
function snapToCity(x: number, y: number): number {
  const visible = nearestWorldCity(x, y);
  return visible >= 0 ? world!.cities[visible].cell : findCell(mesh!, x, y);
}

/** 끌고 있는 다리·터널을 (x, y)에 놓았을 때의 새 양 끝 셀 */
function movedSpanCells(x: number, y: number): [number, number] | null {
  if (!draggingSpan || !mesh) return null;
  const s = (draggingSpan.kind === "bridge" ? infra.bridges : infra.tunnels)[draggingSpan.index];
  if (!s) return null;
  if (draggingSpan.part === "a") return [findCell(mesh, x, y), s.b];
  if (draggingSpan.part === "b") return [s.a, findCell(mesh, x, y)];
  const dx = x - draggingSpan.grabX, dy = y - draggingSpan.grabY;
  return [findCell(mesh, mesh.x[s.a] + dx, mesh.y[s.a] + dy), findCell(mesh, mesh.x[s.b] + dx, mesh.y[s.b] + dy)];
}

/** 항로 끝점: 가까운 (보이는) 항구 셀, 없으면 -1 */
function snapToPort(x: number, y: number): number {
  if (!world || !mesh) return -1;
  const r2 = viewport.hitRadius() ** 2;
  let best = -1, bestD = r2;
  for (const p of world.ports) {
    const d = (mesh.x[p.cell] - x) ** 2 + (mesh.y[p.cell] - y) ** 2;
    if (d <= bestD) { bestD = d; best = p.cell; }
  }
  return best;
}

const isLineTool = (): boolean => infraTool === "road" || infraTool === "rail" || infraTool === "sea";
const isSpanTool = (): boolean => infraTool === "bridge" || infraTool === "tunnel";
const spanMode = (): SpanMode => ($<HTMLSelectElement>("spanMode").value === "rail" ? "rail" : "road");

function takeFeatureName(): string | undefined {
  const input = $<HTMLInputElement>("featureName");
  const name = input.value.trim();
  input.value = "";
  return name || undefined;
}

function handleInfraClick(x: number, y: number): void {
  if (!world || !mesh) return;
  const cell = findCell(mesh, x, y);
  if (infraTool === "port") {
    applyInfraEdit((inf) => addPort(world!, inf, cell, takeFeatureName()), "항구를 놓았습니다.");
  } else if (infraTool === "facility") {
    const kind = $<HTMLSelectElement>("facilityKind").value as FacilityKind;
    applyInfraEdit((inf) => addFacility(world!, inf, cell, kind, takeFeatureName()), `${FACILITY_INFO[kind]?.ko ?? "시설"}${eul(FACILITY_INFO[kind]?.ko ?? "시설")} 놓았습니다.`);
  } else if (infraTool === "toggleMode") {
    const hit = hitSpan(mesh, infra, x, y, viewport.hitRadius());
    if (!hit) { setStatus("용도를 바꿀 다리·터널을 눌러 주세요.", true); return; }
    const span = (hit.kind === "bridge" ? infra.bridges : infra.tunnels)[hit.index];
    const label = hit.kind === "bridge" ? "다리" : "터널";
    const before = SPAN_MODE_KO[span.mode];
    const result = { rerouted: 0, broken: 0 };
    const ok = applyInfraEdit((inf) => toggleSpanMode(world!, inf, hit.kind, hit.index, result));
    if (ok) {
      const after = before === "도로" ? "철도" : "도로";
      const notes = [
        result.rerouted > 0 ? `지나던 ${before} ${result.rerouted}개는 다른 길로 다시 이었습니다.` : "",
        result.broken > 0 ? `${before} ${result.broken}개는 다른 길이 없어 끊겨 그려집니다.` : "",
      ].filter(Boolean).join(" ");
      setStatus(`${before}용 ${label}${eul(label)} ${after}용으로 바꿨습니다.${notes ? ` ${notes}` : ""}`);
    }
  } else if (infraTool === "erase") {
    let removed: string | null = null;
    applyInfraEdit((inf) => {
      removed = eraseAt(mesh!, inf, x, y, viewport.hitRadius(), autoRoads, world!);
      return removed ? null : "지울 시설이 없습니다. 항구·시설물·도로·철도 가까이를 눌러 주세요.";
    });
    if (removed) {
      const what = removed as string;
      setStatus(what.startsWith("자동")
        ? `${what}${eul(what)} 숨겼습니다. 되돌리기로 다시 보이게 할 수 있습니다.`
        : `${what}${eul(what)} 지웠습니다.`);
    }
  }
}

// ── 포인터 입력 ──────────────────────────────────────────────────────
let painting = false;
let lastPoint: [number, number] | undefined;
let flattenTarget = 0;
let previewQueued = false;
let draggingCity = -1;
/** 도로·철도를 끌고 있을 때 출발 셀과 미리보기 경로 */
let routeStart = -1;
let routePreview: number[] | null = null;
let routeQueued = false;
/** 이동 도구로 끌고 있는 항구·시설물 */
let draggingPoint: { kind: PointKind; index: number } | null = null;
/** 이동 도구로 끌고 있는 다리·터널 (끝 하나 또는 몸통 전체), 잡은 지점의 지도 좌표 */
let draggingSpan: { kind: "bridge" | "tunnel"; index: number; part: SpanPart; grabX: number; grabY: number } | null = null;
let borderBefore: Snapshot | undefined;

/**
 * 칠하는 동안의 미리보기. Worker가 있으면 맡기고(메인 스레드는 그리기만), 없으면 프레임당 한 번 직접 계산한다.
 */
function queuePreview(natureOnly: boolean): void {
  // 입력은 Worker가 받을 수 있게 됐을 때 그 순간의 지형으로 만든다 (계산 중에 들어온 붓질까지 반영).
  if (mesh && elevation && previewClient.request(natureOnly, () => deriveInput(mesh!, elevation!, natureOnly, true))) return;
  queueSyncPreview(natureOnly);
}

function queueSyncPreview(natureOnly: boolean): void {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    derive(natureOnly);
  });
}

/** Worker가 계산한 미리보기를 그린다. 메시는 보내지 않으므로 메인의 것을 붙인다. */
function showPreview(output: PreviewOutput): void {
  if (!mesh || !painting) return;
  world = { ...output.world, mesh };
  cache = output.cache;
  natureCache = { key: output.natureKey, nature: natureOf(world) };
  viewport.draw(true);
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
    if (!confirm(`'${name}'${eul(name)} 지울까요?`)) return;
    applyCivEdit((c) => deleteCity(c, civIndex(c)), `'${name}'${eul(name)} 지웠습니다.`);
  } else if (cityTool === "rename") {
    const next = prompt("새 도시 이름", name);
    if (next === null || next.trim() === name) return;
    applyCivEdit((c) => renameCity(c, civIndex(c), next, style), "이름을 바꿨습니다.");
  } else if (cityTool === "capital") {
    applyCivEdit((c) => makeCapital(c, civIndex(c)), `'${name}'${eul(name)} 수도로 정했습니다.`);
  } else if (cityTool === "newState") {
    // 무소속 땅에 세울 때 가져갈 범위: 나라 하나가 차지할 법한 면적의 반지름 절반쯤
    const claim = Math.sqrt((options.width * options.height * options.landRatio) / Math.max(1, world.states.length + 1)) * 0.5;
    const ok = applyCivEdit((c) => createState(mesh!, c, civIndex(c), elevation!, world!.hydro.isLake, style, options.seed, claim));
    if (ok && world) {
      // 새 나라는 항상 목록 끝에 붙는다: 국경 탭에서 바로 다듬을 수 있게 선택해 둔다.
      const created = world.states[world.states.length - 1];
      paintStateEl.value = String(created.id);
      renderMergeTargets();
      setStatus(`'${name}'${eul(name)} 수도로 하는 새 나라 '${created.name}'${eul(created.name)} 세웠습니다. 국경 탭에서 영토를 다듬을 수 있습니다.`);
    }
  }
}

function onEditPointerDown(e: PointerEvent): void {
  if (!editMode || e.button !== 0 || !mesh || !elevation || !world) return;
  e.preventDefault();
  const [x, y] = viewport.toMapCoords(e);
  if (editTarget === "resource") {
    handleResourceClick(x, y);
    return;
  }
  if (editTarget === "infra") {
    if (infraTool === "road" || infraTool === "rail") {
      routeStart = snapToCity(x, y);
      routePreview = null;
      viewport.capturePointer(e.pointerId);
    } else if (isSpanTool()) {
      routeStart = findCell(mesh, x, y);
      viewport.capturePointer(e.pointerId);
    } else if (infraTool === "sea") {
      const start = snapToPort(x, y);
      if (start < 0) { setStatus("항로는 항구에서 시작합니다. 항구를 눌러 끌어 주세요.", true); return; }
      routeStart = start;
      routePreview = null;
      viewport.capturePointer(e.pointerId);
    } else if (infraTool === "move") {
      draggingPoint = hitPoint(mesh, infra, x, y, viewport.hitRadius());
      if (!draggingPoint) {
        const span = hitSpan(mesh, infra, x, y, viewport.hitRadius());
        if (!span) { setStatus("옮길 항구·시설물·다리·터널을 눌러 끌어 주세요.", true); return; }
        draggingSpan = { ...span, grabX: x, grabY: y };
      }
      viewport.capturePointer(e.pointerId);
    } else {
      handleInfraClick(x, y);
    }
    return;
  }
  if (editTarget === "terrain") {
    viewport.capturePointer(e.pointerId);
    editHistory.record(snap());
    flattenTarget = elevation[findCell(mesh, x, y)];
    painting = true;
    lastPoint = undefined;
    paintTerrainTo(x, y);
  } else if (editTarget === "border") {
    borderBefore = copySnapshot(snap());
    if (!ensureCiv()) return;
    viewport.capturePointer(e.pointerId);
    painting = true;
    lastPoint = undefined;
    paintBorderTo(x, y);
  } else if (cityTool === "move") {
    const visible = nearestWorldCity(x, y);
    if (visible < 0) return;
    const before: Snapshot = copySnapshot(snap());
    const c = ensureCiv();
    if (!c) return;
    draggingCity = c.cities.findIndex((cc) => cc.cell === world!.cities[visible].cell);
    borderBefore = before;
    viewport.capturePointer(e.pointerId);
  } else {
    handleCityClick(x, y);
  }
}

function onEditPointerMove(e: PointerEvent): void {
  const [x, y] = viewport.toMapCoords(e);
  if (editMode) drawCursor(x, y);
  if (routeStart >= 0) {
    if (!isSpanTool()) queueRoutePreview(x, y);
    return;
  }
  if (draggingPoint || draggingSpan) return;
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
}

function endPointer(e: PointerEvent): void {
  if (draggingSpan) {
    const [x, y] = viewport.toMapCoords(e);
    const cells = movedSpanCells(x, y);
    const target = draggingSpan;
    draggingSpan = null;
    viewport.clearOverlay();
    if (!cells || !world) return;
    const span = (target.kind === "bridge" ? infra.bridges : infra.tunnels)[target.index];
    if (!span || (span.a === cells[0] && span.b === cells[1])) return;
    const label = `${SPAN_MODE_KO[span.mode]} ${target.kind === "bridge" ? "다리" : "터널"}`;
    const what = SPAN_MODE_KO[span.mode];
    const result = { rerouted: 0, broken: 0 };
    const ok = applyInfraEdit((inf) => moveSpan(world!, inf, target.kind, target.index, cells[0], cells[1], result));
    if (ok) {
      const moved = target.part === "body" ? `${label}${eul(label)} 옮겼습니다.` : `${label} 끝을 옮겼습니다.`;
      const followed = result.rerouted > 0 ? ` 지나던 ${what} ${result.rerouted}개가 따라갔습니다.` : "";
      const broken = result.broken > 0 ? ` ${what} ${result.broken}개는 새 자리로 이어지지 않아 끊겨 그려집니다.` : "";
      setStatus(moved + followed + broken);
    }
    return;
  }
  if (draggingPoint) {
    const target = draggingPoint;
    draggingPoint = null;
    viewport.clearOverlay();
    if (!world || !mesh) return;
    const [x, y] = viewport.toMapCoords(e);
    const cell = findCell(mesh, x, y);
    const item = target.kind === "port" ? infra.ports[target.index] : infra.facilities[target.index];
    if (!item || item.cell === cell) return;
    const result = { droppedRoutes: 0 };
    const ok = applyInfraEdit((inf) => movePoint(world!, inf, target.kind, target.index, cell, result));
    if (ok) {
      const what = target.kind === "port" ? "항구를" : "시설물을";
      setStatus(result.droppedRoutes > 0
        ? `${what} 옮겼습니다. 새 자리에서 이어지지 않는 항로 ${result.droppedRoutes}개를 지웠습니다.`
        : `${what} 옮겼습니다.`);
    }
    return;
  }
  if (routeStart >= 0) {
    const start = routeStart;
    routeStart = -1;
    routePreview = null;
    routeQueued = false;
    viewport.clearOverlay();
    if (!world || !mesh) return;
    const [x, y] = viewport.toMapCoords(e);
    if (isSpanTool()) {
      const kind = infraTool === "bridge" ? "bridge" : "tunnel";
      const end = findCell(mesh, x, y);
      const mode = spanMode();
      const label = `${SPAN_MODE_KO[mode]} ${kind === "bridge" ? "다리" : "터널"}`;
      applyInfraEdit((inf) => addSpan(world!, inf, kind, start, end, mode), `${label}${eul(label)} 놓았습니다.`);
      return;
    }
    if (infraTool === "sea") {
      const end = snapToPort(x, y);
      if (end < 0) { setStatus("항로는 다른 항구에서 끝나야 합니다. 항구 위에서 놓아 주세요.", true); return; }
      const sea = routeSea(world, start, end);
      if (!sea) { setStatus("두 항구를 잇는 바닷길이 없습니다 (같은 항구이거나 바다가 이어지지 않음).", true); return; }
      applyInfraEdit((inf) => addSeaRoute(inf, sea), "항로를 놓았습니다.");
      return;
    }
    const mode = infraTool === "rail" ? "rail" : "road";
    const path = routePath(world, start, snapToCity(x, y), mode, spanLinks(world, world, mode));
    if (!path) {
      setStatus("바다·호수로 막혀 있거나 물 위에서 시작·끝나는 경로는 만들 수 없습니다.", true);
      return;
    }
    applyInfraEdit((inf) => addPath(inf, mode, path, autoRoads), mode === "rail" ? "철도를 놓았습니다." : "도로를 놓았습니다.");
    return;
  }
  if (draggingCity >= 0) {
    const index = draggingCity;
    draggingCity = -1;
    const before = borderBefore;
    borderBefore = undefined;
    viewport.clearOverlay();
    if (!mesh || !elevation || !world || !civ || !before) return;
    const [x, y] = viewport.toMapCoords(e);
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
/**
 * 하던 편집(칠하기·끌기)을 없던 일로 한다. 한 손가락으로 편집하다가 두 번째 손가락이 닿아
 * 확대·이동으로 넘어갈 때 쓴다.
 */
function cancelPointerEdit(): void {
  let changed = false;
  if (painting) {
    painting = false;
    lastPoint = undefined;
    if (editTarget === "terrain") {
      const before = editHistory.discardLast();
      if (before) { elevation = before.elevation; changed = true; }
    } else if (borderBefore) {
      civ = borderBefore.civ;
      borderBefore = undefined;
      changed = true;
    }
  }
  if (draggingCity >= 0) {
    draggingCity = -1;
    if (borderBefore) civ = borderBefore.civ; // 끌기를 시작하며 자동 배치를 고정했다면 그것도 취소
    borderBefore = undefined;
  }
  routeStart = -1;
  routePreview = null;
  routeQueued = false;
  draggingPoint = null;
  draggingSpan = null;
  viewport.clearOverlay();
  if (changed) commit();
}

function restore(s: Snapshot): void {
  elevation = s.elevation;
  civ = s.civ;
  infra = s.infra;
  resourceEdits = s.resources;
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
  infra = emptyInfra();
  resourceEdits = emptyResourceEdits();
  generate(parsed.options, {
    restoreFrom: parsed.elevation,
    names: parsed.anchors ? { [parsed.anchors.nameStyle]: parsed.anchors } : {},
    civ: parsed.civ,
    infra: parsed.infra,
    resources: parsed.resources,
  });
  const extras = [
    edited ? "편집된 지형" : "", civ ? "직접 편집한 도시·국경" : "", isEmptyInfra(infra) ? "" : "도로·철도·시설",
    isEmptyResourceEdits(resourceEdits) ? "" : "직접 편집한 자원",
  ].filter(Boolean).join(", ");
  setStatus(`${file.name}${eul(file.name)} 불러왔습니다.${extras ? ` (${extras} 포함)` : ""}`);
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
    viewport.draw();
    if (key === "resources" && world) renderResourceLegend(resourceLegendEl, world.resources, layers.resources);
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
document.querySelectorAll<HTMLInputElement>('input[name="infraTool"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    infraTool = radio.value as InfraTool;
    syncInfraFields();
    updateHint();
  });
});
document.querySelectorAll<HTMLInputElement>('input[name="resourceTool"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    resourceTool = radio.value as ResourceTool;
    syncResourceFields();
    updateHint();
  });
});
resourceKindEl.addEventListener("change", syncResourceFields);
$("resetResources").addEventListener("click", () => {
  if (isEmptyResourceEdits(resourceEdits)) return;
  if (!confirm("직접 놓거나 지운 자원을 버리고 자동 배치로 돌아갈까요? (되돌리기로 복구할 수 있습니다)")) return;
  editHistory.record(copySnapshot(snap()));
  resourceEdits = emptyResourceEdits();
  commit();
});
$("resetRoads").addEventListener("click", () => {
  if (infra.roads === undefined) return;
  if (!confirm("직접 그리거나 지운 도로를 버리고 자동 도로로 돌아갈까요? (철도·항구·시설물은 그대로입니다)")) return;
  editHistory.record(copySnapshot(snap()));
  infra = { ...infra, roads: undefined };
  commit();
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
paintStateEl.addEventListener("change", renderMergeTargets);
$("deleteState").addEventListener("click", () => {
  if (!world) return;
  const id = Number(paintStateEl.value);
  const state = world.states[id];
  if (!state) { setStatus("없앨 국가를 먼저 고르세요.", true); return; }
  const merge = Number(mergeIntoEl.value);
  const dest = merge >= 0 ? `'${world.states[merge]?.name}'에 합칩니다` : "무소속이 됩니다";
  if (!confirm(`'${state.name}'${eul(state.name)} 없앨까요? 영토는 ${dest}. 수도였던 도시는 일반 도시로 남습니다. (되돌리기로 복구할 수 있습니다)`)) return;
  applyCivEdit((c) => deleteState(c, id, merge), `'${state.name}'${eul(state.name)} 없앴습니다.`);
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

// 편집 단축키 (확대·이동 키는 Viewport가 먼저 처리한다)
document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (isTypingTarget(target)) return;
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
  // 확대해서 보고 있어도 지도 전체를 원래 크기로 저장한다.
  viewport.exportCanvas().toBlob((blob) => blob && download(`${safeFileName(options.seed)}.png`, blob), "image/png");
});
$("exportJson").addEventListener("click", () => {
  if (!world) return;
  const suffix = hasEdits() ? "_편집" : "";
  download(`${safeFileName(options.seed)}${suffix}.json`, new Blob([JSON.stringify(toJSON(world, civ, infra, resourceEdits))], { type: "application/json" }));
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
    setStatus(hasEdits()
      ? "링크를 복사했습니다. 편집 내용은 링크에 담기지 않으니 함께 보내려면 'JSON 저장'을 쓰세요."
      : "현재 지도 링크를 복사했습니다.");
  } catch {
    setStatus("클립보드에 접근할 수 없습니다. 주소창의 링크를 직접 복사하세요.", true);
  }
});

// ── 시작 ─────────────────────────────────────────────────────────────
const initial: WorldOptions = { ...DEFAULT_OPTIONS, ...parseHash(location.hash) };
fillForm(initial);
fillResourceKinds();
setTool(brush.tool);
setEditTarget("terrain");
syncBrush();
setEditMode(false);
// 지도 라벨이 대체 글꼴로 그려지지 않도록 웹 글꼴을 먼저 기다린다 (실패해도 진행).
Promise.race([
  document.fonts.load('600 16px "Noto Serif KR"'),
  new Promise((r) => setTimeout(r, 2500)),
]).catch(() => undefined).finally(() => {
  const saved = loadStartupEdits(initial);
  generate(initial, saved
    ? { restoreFrom: saved.elevation, names: saved.names, civ: saved.civ, infra: saved.infra, resources: saved.resources }
    : {});
  if (saved && hasEdits()) setStatus("이 브라우저에 저장된 편집 내용을 불러왔습니다. '지형 초기화'·'자동 배치로'로 되돌릴 수 있습니다.");
});
