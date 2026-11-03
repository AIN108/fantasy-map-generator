import { findCell } from "./mesh.ts";
import { buildRenderCache, DEFAULT_LAYERS, describeCell, renderWorld, type Layers, type RenderCache } from "./render.ts";
import { DEFAULT_OPTIONS, generateWorld, toJSON, type WorldMap, type WorldOptions } from "./world.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소가 없습니다.`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>("map");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("Canvas 2D를 사용할 수 없습니다.");
const form = $<HTMLFormElement>("controls");
const statusEl = $("status");
const infoEl = $("cellInfo");
const legendEl = $("legend");

const RANGE_FIELDS = ["landRatio", "states", "citiesPerState", "temperatureShift", "cells"] as const;
type RangeField = (typeof RANGE_FIELDS)[number];
const formatters: Record<RangeField, (v: number) => string> = {
  landRatio: (v) => `${Math.round(v * 100)}%`,
  states: (v) => `${v}`,
  citiesPerState: (v) => `${v}`,
  temperatureShift: (v) => (v === 0 ? "보통" : v > 0 ? `따뜻 +${v.toFixed(2)}` : `추움 ${v.toFixed(2)}`),
  cells: (v) => v.toLocaleString("ko-KR"),
};

let world: WorldMap | undefined;
let cache: RenderCache | undefined;
let layers: Layers = { ...DEFAULT_LAYERS };

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

function generate(options: WorldOptions): void {
  try {
    const t0 = performance.now();
    world = generateWorld(options);
    cache = buildRenderCache(world);
    canvas.width = options.width;
    canvas.height = options.height;
    draw();
    renderLegend(world);
    writeHash(world.options);
    setStatus(`셀 ${world.mesh.count.toLocaleString("ko-KR")}개 · 국가 ${world.states.length} · 도시 ${world.cities.length} · ${Math.round(performance.now() - t0)}ms`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function randomSeed(): string {
  const words = ["청운", "백야", "적설", "은하", "흑림", "금파", "월영", "해무", "남풍", "북극", "옥천", "현무"];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeFileName = (s: string): string => s.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "map";

// ── 이벤트 ───────────────────────────────────────────────────────────
form.addEventListener("submit", (e) => {
  e.preventDefault();
  generate(readForm());
});
for (const key of RANGE_FIELDS) {
  $<HTMLInputElement>(key).addEventListener("input", (e) => {
    $(`${key}Out`).textContent = formatters[key](Number((e.target as HTMLInputElement).value));
  });
}
// 지명 스타일은 지형과 독립된 난수열을 쓰므로 바꾸면 이름만 바뀐다.
$<HTMLSelectElement>("nameStyle").addEventListener("change", () => generate(readForm()));
$("random").addEventListener("click", () => {
  $<HTMLInputElement>("seed").value = randomSeed();
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

canvas.addEventListener("mousemove", (e) => {
  if (!world) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
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

$("exportPng").addEventListener("click", () => {
  if (!world) return;
  canvas.toBlob((blob) => blob && download(`${safeFileName(world!.options.seed)}.png`, blob), "image/png");
});
$("exportJson").addEventListener("click", () => {
  if (!world) return;
  download(`${safeFileName(world.options.seed)}.json`, new Blob([JSON.stringify(toJSON(world))], { type: "application/json" }));
});
$("copyLink").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus("현재 지도 링크를 복사했습니다.");
  } catch {
    setStatus("클립보드에 접근할 수 없습니다. 주소창의 링크를 직접 복사하세요.", true);
  }
});

// ── 시작 ─────────────────────────────────────────────────────────────
const initial: WorldOptions = { ...DEFAULT_OPTIONS, ...readHash() };
fillForm(initial);
// 지도 라벨이 대체 글꼴로 그려지지 않도록 웹 글꼴을 먼저 기다린다 (실패해도 진행).
Promise.race([
  document.fonts.load('600 16px "Noto Serif KR"'),
  new Promise((r) => setTimeout(r, 2500)),
]).catch(() => undefined).finally(() => generate(initial));
