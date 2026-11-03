import {
  addWaterMoisture, classifyBiome, computeMoisture, computeTemperature, type Biome,
} from "./climate.ts";
import {
  buildRoads, distinctColor, expandStates, findPeaks, isCoastal, pickSpaced, settlementScore, stateColor, stateLabelCells,
  type City, type State,
} from "./civ.ts";
import { computeHydrology, extractRivers, type Hydrology } from "./hydrology.ts";
import { buildMesh, type Mesh } from "./mesh.ts";
import { NameGenerator, type NameStyle } from "./names.ts";
import { cellHash, subRng } from "./rng.ts";
import { civFromJSON, civToJSON, type CivState } from "./civedit.ts";
import { generateElevation } from "./terrain.ts";

export interface WorldOptions {
  seed: string;
  width: number;
  height: number;
  /** 목표 셀 수 (실제 수는 샘플링 결과에 따라 조금 다르다) */
  cells: number;
  landRatio: number;
  shape: "continent" | "archipelago";
  states: number;
  citiesPerState: number;
  nameStyle: NameStyle;
  /** 기후 전체를 따뜻하게(+)/춥게(-) 이동 */
  temperatureShift: number;
}

export const DEFAULT_OPTIONS: WorldOptions = {
  seed: "청운",
  width: 1200,
  height: 800,
  cells: 9000,
  landRatio: 0.42,
  shape: "continent",
  states: 6,
  citiesPerState: 5,
  nameStyle: "korean",
  temperatureShift: 0,
};

export interface River {
  cells: number[];
  /** 하구(마지막 셀)의 유량 */
  flux: number;
  name?: string;
}

export interface Peak {
  cell: number;
  name: string;
}

export interface WorldMap {
  options: WorldOptions;
  mesh: Mesh;
  elevation: Float64Array;
  temperature: Float64Array;
  moisture: Float64Array;
  biome: Biome[];
  hydro: Hydrology;
  rivers: River[];
  /** 셀별 소속 국가 (-1: 무소속 또는 바다) */
  owner: Int32Array;
  states: State[];
  cities: City[];
  roads: number[][];
  peaks: Peak[];
}

export function validateOptions(o: WorldOptions): void {
  const fail = (msg: string): never => { throw new RangeError(msg); };
  if (!o.seed.trim()) fail("시드가 비어 있습니다.");
  if (!(o.width >= 200 && o.width <= 4000 && o.height >= 200 && o.height <= 4000)) fail("지도 크기는 200~4000px이어야 합니다.");
  if (!(o.cells >= 500 && o.cells <= 40000)) fail("셀 수는 500~40000이어야 합니다.");
  if (!(o.landRatio >= 0.15 && o.landRatio <= 0.7)) fail("육지 비율은 0.15~0.7이어야 합니다.");
  if (!(Number.isInteger(o.states) && o.states >= 1 && o.states <= 30)) fail("국가 수는 1~30 정수여야 합니다.");
  if (!(Number.isInteger(o.citiesPerState) && o.citiesPerState >= 0 && o.citiesPerState <= 20)) fail("국가당 도시 수는 0~20 정수여야 합니다.");
  if (!(o.temperatureShift >= -0.4 && o.temperatureShift <= 0.4)) fail("기온 보정은 -0.4~0.4여야 합니다.");
}

/** 메시를 결정하는 옵션. 이 값이 같으면 메시를 재사용할 수 있다. */
export const meshKey = (o: WorldOptions): string => JSON.stringify([o.seed, o.width, o.height, o.cells]);
/** 시드 지형을 결정하는 옵션. 이 값이 바뀌면 편집한 고도를 유지할 수 없다. */
export const terrainKey = (o: WorldOptions): string => JSON.stringify([o.seed, o.width, o.height, o.cells, o.landRatio, o.shape]);

export function createMesh(options: WorldOptions): Mesh {
  return buildMesh(subRng(options.seed, "mesh"), options.width, options.height, options.cells);
}

export function createElevation(mesh: Mesh, options: WorldOptions): Float64Array {
  return generateElevation(mesh, subRng(options.seed, "terrain"), options);
}

/** 시드와 옵션으로 지도 전체를 만든다. 같은 입력이면 항상 같은 결과. */
export function generateWorld(input: Partial<WorldOptions> = {}): WorldMap {
  const options: WorldOptions = { ...DEFAULT_OPTIONS, ...input };
  validateOptions(options);
  const mesh = createMesh(options);
  return deriveWorld(options, mesh, createElevation(mesh, options));
}

/**
 * 주어진 메시·고도(시드 지형이든 사용자가 편집한 지형이든)에서 기후·수계·생태·문명을 계산한다.
 * natureOnly면 문명(도시·국가·도로·지명)을 건너뛴다. 브러시로 칠하는 동안의 빠른 미리보기용.
 * prior를 주면 같은 자리에 있는 국가·도시·강·봉우리가 이전 이름(국가는 색까지)을 물려받는다.
 * civ를 주면 도시·국가·국경을 자동 배치하지 않고 사용자가 편집한 값을 그대로 쓴다.
 */
export function deriveWorld(
  options: WorldOptions, mesh: Mesh, elevation: Float64Array, natureOnly = false, prior?: NameAnchors,
  civ?: CivState,
): WorldMap {
  validateOptions(options);
  if (elevation.length !== mesh.count) {
    throw new RangeError(`고도 배열 길이(${elevation.length})가 셀 수(${mesh.count})와 다릅니다.`);
  }
  const { seed } = options;

  // 단계마다 별도 난수열을 써서, 예를 들어 지명 스타일만 바꿔도 지형은 그대로 유지되게 한다.
  const temperature = computeTemperature(mesh, elevation, subRng(seed, "temperature"), options.temperatureShift);
  const moisture = computeMoisture(mesh, elevation, subRng(seed, "moisture"));

  // 강수량 ≈ 습도. 강 기준 유량은 셀 수에 비례하게 잡아 해상도가 달라도 강 밀도가 비슷하게.
  const riverThreshold = Math.max(6, mesh.count / 900);
  const hydro = computeHydrology(mesh, elevation, moisture, riverThreshold);
  const water = new Uint8Array(mesh.count);
  for (let i = 0; i < mesh.count; i++) water[i] = hydro.isRiver[i] | hydro.isLake[i];
  addWaterMoisture(mesh, moisture, water);

  const biome: Biome[] = new Array(mesh.count);
  for (let i = 0; i < mesh.count; i++) {
    biome[i] = classifyBiome(elevation[i], temperature[i], moisture[i], hydro.isLake[i] === 1, isCoastal(mesh, elevation, i));
  }

  const rivers: River[] = extractRivers(mesh, hydro, elevation).map((cells) => ({
    cells,
    flux: hydro.flux[cells[cells.length - 2] ?? cells[0]],
  }));

  if (natureOnly) {
    return {
      options, mesh, elevation, temperature, moisture, biome, hydro, rivers,
      owner: new Int32Array(mesh.count).fill(-1), states: [], cities: [], roads: [], peaks: [],
    };
  }

  // ── 문명 ──
  // 셀 번호 기반 난수를 써서, 지형 일부를 편집해도 먼 곳의 도시 후보 점수는 그대로 유지한다.
  const score = settlementScore(mesh, elevation, biome, hydro, cellHash(seed, "civ"));
  // 수도 간격은 실제 육지 면적이 아니라 목표 육지 비율로 정한다 (편집으로 면적이 변해도 배치가 흔들리지 않게).
  const landArea = options.landRatio * options.width * options.height;
  const capitalSpacing = Math.sqrt(landArea / options.states) * 0.75;
  const capitals = pickSpaced(mesh, score, options.states, capitalSpacing);

  const avgSpacing = Math.sqrt((options.width * options.height) / mesh.count);
  const owner = expandStates(mesh, biome, hydro, capitals, avgSpacing * 160);
  const townCount = capitals.length * options.citiesPerState;
  const towns = pickSpaced(mesh, score, townCount, capitalSpacing * 0.28, capitals);
  const cityCells = [...capitals, ...towns];
  const namedRivers = [...rivers].filter((r) => r.cells.length >= 8).sort((a, b) => b.flux - a.flux).slice(0, 8);
  const peakCells = findPeaks(mesh, elevation, 6, capitalSpacing * 0.6);

  if (civ) {
    return deriveEditedCiv(options, mesh, elevation, biome, hydro, civ, {
      temperature, moisture, rivers, namedRivers, peakCells, capitalSpacing, prior,
    });
  }

  // 이전 지도의 이름을 물려받을 대상을 먼저 정하고, 물려받은 이름을 예약한 뒤 나머지에만 새 이름을 붙인다.
  const usePrior = prior && prior.nameStyle === options.nameStyle ? prior : undefined;
  const inherit = usePrior
    ? matchAnchors(mesh, usePrior, { capitals, owner, cityCells, namedRivers, peakCells, capitalSpacing })
    : undefined;
  const names = new NameGenerator(subRng(seed, `names:${options.nameStyle}`), options.nameStyle);
  if (inherit) {
    for (const n of [...inherit.states.values()].map((s) => s.name)) names.reserve(n);
    for (const n of [...inherit.cities.values(), ...inherit.rivers.values(), ...inherit.peaks.values()]) names.reserve(n);
  }

  const labelCells = stateLabelCells(mesh, owner, capitals.length);
  const colorRng = subRng(seed, "colors");
  const usedColors = inherit ? [...inherit.states.values()].map((s) => s.color) : [];
  const states: State[] = capitals.map((cap, id) => {
    const old = inherit?.states.get(id);
    return {
      id,
      name: old?.name ?? names.next("state"),
      capitalCell: cap,
      color: old?.color ?? (inherit ? distinctColor(usedColors) : stateColor(id, colorRng)),
      labelCell: labelCells[id] >= 0 ? labelCells[id] : cap,
      cellCount: 0,
    };
  });
  for (let i = 0; i < mesh.count; i++) if (owner[i] >= 0) states[owner[i]].cellCount++;

  const makeCity = (cell: number, capital: boolean): City => {
    const coastal = isCoastal(mesh, elevation, cell);
    const riverside = hydro.isRiver[cell] === 1;
    return {
      cell,
      capital,
      state: owner[cell],
      coastal,
      riverside,
      name: inherit?.cities.get(cell)
        ?? names.next(capital ? "capital" : "city", { coastal, river: riverside, highland: elevation[cell] > 0.4 }),
    };
  };
  const cities: City[] = [...capitals.map((c) => makeCity(c, true)), ...towns.map((c) => makeCity(c, false))];

  const pairHash = cellHash(seed, "roads");
  const roads = buildRoads(mesh, biome, hydro, cities, (a, b) => pairHash(Math.min(a, b) * 65536 + Math.max(a, b)), capitalSpacing * 1.2);

  // 큰 강만 이름을 붙인다 (지도가 이름으로 뒤덮이지 않게).
  namedRivers.forEach((r, k) => { r.name = inherit?.rivers.get(k) ?? names.next("river"); });

  const peaks: Peak[] = peakCells.map((cell) => ({ cell, name: inherit?.peaks.get(cell) ?? names.next("mountain") }));

  return { options, mesh, elevation, temperature, moisture, biome, hydro, rivers, owner, states, cities, roads, peaks };
}

/**
 * 사용자가 편집한 문명(civ)으로 국가·도시·도로를 만든다. 바다·호수가 된 셀은 무소속으로,
 * 물에 잠긴 도시는 숨긴다 (civ에는 남겨 두어 땅이 다시 생기면 돌아오게 한다).
 */
function deriveEditedCiv(
  options: WorldOptions, mesh: Mesh, elevation: Float64Array, biome: Biome[], hydro: Hydrology, civ: CivState,
  rest: {
    temperature: Float64Array; moisture: Float64Array; rivers: River[]; namedRivers: River[];
    peakCells: number[]; capitalSpacing: number; prior?: NameAnchors;
  },
): WorldMap {
  const style = options.nameStyle;
  const habitable = (i: number): boolean => elevation[i] > 0 && !hydro.isLake[i];
  const owner = new Int32Array(mesh.count);
  for (let i = 0; i < mesh.count; i++) {
    const o = civ.owner[i] ?? -1;
    owner[i] = habitable(i) && o >= 0 && o < civ.states.length ? o : -1;
  }
  const capitalCells = new Set(civ.states.map((s) => civ.cities[s.capitalCity]?.cell));
  const labelCells = stateLabelCells(mesh, owner, civ.states.length);
  const states: State[] = civ.states.map((s, id) => {
    const cap = civ.cities[s.capitalCity]?.cell ?? -1;
    return {
      id,
      name: s.names[style] ?? `국가 ${id + 1}`,
      capitalCell: cap,
      color: s.color,
      labelCell: labelCells[id] >= 0 ? labelCells[id] : cap,
      cellCount: 0,
    };
  });
  for (let i = 0; i < mesh.count; i++) if (owner[i] >= 0) states[owner[i]].cellCount++;

  const cities: City[] = civ.cities
    .filter((c) => c.cell >= 0 && c.cell < mesh.count && habitable(c.cell))
    .map((c) => ({
      cell: c.cell,
      name: c.names[style] ?? "이름 없음",
      capital: capitalCells.has(c.cell),
      state: owner[c.cell],
      coastal: isCoastal(mesh, elevation, c.cell),
      riverside: hydro.isRiver[c.cell] === 1,
    }));

  const pairHash = cellHash(options.seed, "roads");
  const roads = buildRoads(mesh, biome, hydro, cities, (a, b) => pairHash(Math.min(a, b) * 65536 + Math.max(a, b)), rest.capitalSpacing * 1.2);

  // 강·봉우리는 자동 배치 때와 같은 방식으로 이름을 유지하되, 국가·도시 이름과 겹치지 않게 한다.
  const usePrior = rest.prior && rest.prior.nameStyle === style ? rest.prior : undefined;
  const inherit = usePrior
    ? matchAnchors(mesh, usePrior, {
      capitals: [], owner, cityCells: [], namedRivers: rest.namedRivers, peakCells: rest.peakCells,
      capitalSpacing: rest.capitalSpacing,
    })
    : undefined;
  const names = new NameGenerator(subRng(options.seed, `names:${style}:nature`), style);
  for (const n of [...states.map((s) => s.name), ...cities.map((c) => c.name)]) names.reserve(n);
  if (inherit) for (const n of [...inherit.rivers.values(), ...inherit.peaks.values()]) names.reserve(n);
  rest.namedRivers.forEach((r, k) => { r.name = inherit?.rivers.get(k) ?? names.next("river"); });
  const peaks: Peak[] = rest.peakCells.map((cell) => ({ cell, name: inherit?.peaks.get(cell) ?? names.next("mountain") }));

  return {
    options, mesh, elevation, temperature: rest.temperature, moisture: rest.moisture, biome, hydro,
    rivers: rest.rivers, owner, states, cities, roads, peaks,
  };
}

// ── 이름 유지 ─────────────────────────────────────────────────────────

/**
 * 다시 계산할 때 물려줄 이름 정보. 같은 메시 위의 셀 번호로 위치를 나타낸다.
 * 브라우저 저장·JSON에 그대로 넣을 수 있도록 작은 일반 객체로 유지한다.
 */
export interface NameAnchors {
  nameStyle: NameStyle;
  states: { capitalCell: number; name: string; color: string }[];
  cities: { cell: number; name: string }[];
  rivers: { cells: number[]; name: string }[];
  peaks: { cell: number; name: string }[];
}

export function extractAnchors(world: WorldMap): NameAnchors {
  return {
    nameStyle: world.options.nameStyle,
    states: world.states.map((s) => ({ capitalCell: s.capitalCell, name: s.name, color: s.color })),
    cities: world.cities.map((c) => ({ cell: c.cell, name: c.name })),
    rivers: world.rivers.flatMap((r) => (r.name ? [{ cells: r.cells, name: r.name }] : [])),
    peaks: world.peaks.map((p) => ({ cell: p.cell, name: p.name })),
  };
}

interface Inherited {
  /** 새 국가 id → 물려받을 이름·색 */
  states: Map<number, { name: string; color: string }>;
  /** 새 도시 셀 → 이름 */
  cities: Map<number, string>;
  /** namedRivers 순번 → 이름 */
  rivers: Map<number, string>;
  /** 새 봉우리 셀 → 이름 */
  peaks: Map<number, string>;
}

/**
 * (새 항목, 이전 항목, 비용) 후보를 비용이 작은 순으로 배정한다. 새 항목 하나에 이름 하나,
 * 그리고 같은 이름은 한 곳에만 붙인다 (이름 기억에는 같은 이름이 여러 위치로 남아 있을 수 있다).
 */
function greedyAssign(pairs: [number, number, number][], nameOf: (old: number) => string): Map<number, number> {
  pairs.sort((a, b) => a[2] - b[2]);
  const usedNew = new Set<number>(), usedName = new Set<string>();
  const out = new Map<number, number>();
  for (const [n, o] of pairs) {
    const name = nameOf(o);
    if (usedNew.has(n) || usedName.has(name)) continue;
    usedNew.add(n);
    usedName.add(name);
    out.set(n, o);
  }
  return out;
}

/** 새로 계산한 국가·도시·강·봉우리를 이전 이름 정보와 짝짓는다. */
function matchAnchors(
  mesh: Mesh,
  prior: NameAnchors,
  next: {
    capitals: number[]; owner: Int32Array; cityCells: number[]; namedRivers: River[]; peakCells: number[]; capitalSpacing: number;
  },
): Inherited {
  const valid = (c: number): boolean => Number.isInteger(c) && c >= 0 && c < mesh.count;
  const dist = (a: number, b: number): number => Math.hypot(mesh.x[a] - mesh.x[b], mesh.y[a] - mesh.y[b]);

  // 국가: 이전 수도를 영토 안에 품은 국가가 우선, 그다음은 수도끼리 가까운 순서
  const statePairs: [number, number, number][] = [];
  prior.states.forEach((o, oi) => {
    if (!valid(o.capitalCell)) return;
    next.capitals.forEach((cap, ni) => {
      const d = dist(cap, o.capitalCell);
      if (next.owner[o.capitalCell] === ni) statePairs.push([ni, oi, d]);
      else if (d < next.capitalSpacing * 0.6) statePairs.push([ni, oi, d + 1e6]);
    });
  });
  const states = new Map<number, { name: string; color: string }>();
  for (const [ni, oi] of greedyAssign(statePairs, (o) => prior.states[o].name)) states.set(ni, { name: prior.states[oi].name, color: prior.states[oi].color });

  // 도시: 가까운 이전 도시 (도시 간 최소 간격보다 가까울 때만 같은 도시로 본다)
  const cityRadius = next.capitalSpacing * 0.28;
  const cityPairs: [number, number, number][] = [];
  next.cityCells.forEach((cell, ni) => {
    prior.cities.forEach((o, oi) => {
      if (!valid(o.cell)) return;
      const d = dist(cell, o.cell);
      if (d < cityRadius) cityPairs.push([ni, oi, d]);
    });
  });
  const cities = new Map<number, string>();
  for (const [ni, oi] of greedyAssign(cityPairs, (o) => prior.cities[o].name)) cities.set(next.cityCells[ni], prior.cities[oi].name);

  // 강: 겹치는 셀이 새 강 길이의 30% 이상인 이전 강 (많이 겹칠수록 우선)
  const riverPairs: [number, number, number][] = [];
  next.namedRivers.forEach((r, ni) => {
    const cells = new Set(r.cells);
    prior.rivers.forEach((o, oi) => {
      let shared = 0;
      for (const c of o.cells) if (cells.has(c)) shared++;
      if (shared >= Math.max(2, r.cells.length * 0.3)) riverPairs.push([ni, oi, -shared]);
    });
  });
  const rivers = new Map<number, string>();
  for (const [ni, oi] of greedyAssign(riverPairs, (o) => prior.rivers[o].name)) rivers.set(ni, prior.rivers[oi].name);

  // 봉우리: 가까운 이전 봉우리
  const peakPairs: [number, number, number][] = [];
  next.peakCells.forEach((cell, ni) => {
    prior.peaks.forEach((o, oi) => {
      if (!valid(o.cell)) return;
      const d = dist(cell, o.cell);
      if (d < next.capitalSpacing * 0.3) peakPairs.push([ni, oi, d]);
    });
  });
  const peaks = new Map<number, string>();
  for (const [ni, oi] of greedyAssign(peakPairs, (o) => prior.peaks[o].name)) peaks.set(next.peakCells[ni], prior.peaks[oi].name);

  return { states, cities, rivers, peaks };
}


/** 외부(브라우저 저장·JSON)에서 읽은 이름 정보를 검증한다. 형식이 틀린 항목은 버린다. */
export function sanitizeAnchors(data: unknown): NameAnchors | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const o = data as Record<string, unknown>;
  if (o.nameStyle !== "korean" && o.nameStyle !== "western") return undefined;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 60;
  const int = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null).slice(0, 2000) : [];
  return {
    nameStyle: o.nameStyle,
    states: list(o.states).flatMap((s) =>
      int(s.capitalCell) && str(s.name) && typeof s.color === "string" && /^hsl\([\d.]+ \d+% \d+%\)$/.test(s.color)
        ? [{ capitalCell: s.capitalCell, name: s.name, color: s.color }] : []),
    cities: list(o.cities).flatMap((c) => (int(c.cell) && str(c.name) ? [{ cell: c.cell, name: c.name }] : [])),
    rivers: list(o.rivers).flatMap((r) =>
      Array.isArray(r.cells) && r.cells.every(int) && str(r.name) ? [{ cells: r.cells as number[], name: r.name }] : []),
    peaks: list(o.peaks).flatMap((p) => (int(p.cell) && str(p.name) ? [{ cell: p.cell, name: p.name }] : [])),
  };
}

/** 다른 프로젝트(TRPG·경제 시뮬레이터 등)에서 불러 쓰기 위한 JSON 내보내기 */
export function toJSON(world: WorldMap, civ?: CivState): object {
  const { mesh } = world;
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    format: "fantasy-map/v1",
    options: world.options,
    cells: Array.from({ length: mesh.count }, (_, i) => ({
      x: round(mesh.x[i]),
      y: round(mesh.y[i]),
      // 고도는 반올림하지 않는다: 아주 작은 차이도 강 경로·도시 배치를 바꿔 다른 지도가 되기 때문
      elevation: world.elevation[i],
      temperature: round(world.temperature[i]),
      moisture: round(world.moisture[i]),
      biome: world.biome[i],
      state: world.owner[i],
      river: world.hydro.isRiver[i] === 1,
    })),
    states: world.states.map(({ id, name, capitalCell, color, cellCount }) => ({ id, name, capitalCell, color, cellCount })),
    cities: world.cities.map((c) => ({ ...c, x: round(mesh.x[c.cell]), y: round(mesh.y[c.cell]) })),
    rivers: world.rivers.filter((r) => r.name).map((r) => ({ name: r.name, cells: r.cells })),
    roads: world.roads,
    peaks: world.peaks,
    // 문명을 직접 편집한 지도면 편집 내용(지명 스타일별 이름 포함)을 함께 저장한다.
    ...(civ ? { civ: civToJSON(civ) } : {}),
  };
}

/**
 * toJSON으로 저장한 지도를 다시 읽어 옵션과 (편집된) 고도를 돌려준다.
 * 외부 파일이므로 형식·범위를 검증하고, 메시를 다시 만들어 셀 수가 맞는지 확인한다.
 */
export function parseMapJSON(
  data: unknown,
): { options: WorldOptions; elevation: Float64Array; mesh: Mesh; anchors?: NameAnchors; civ?: CivState } {
  const fail = (msg: string): never => { throw new Error(`지도 파일을 읽을 수 없습니다: ${msg}`); };
  if (typeof data !== "object" || data === null) fail("JSON 객체가 아닙니다.");
  const obj = data as Record<string, unknown>;
  if (obj.format !== "fantasy-map/v1") fail(`지원하지 않는 형식입니다 (${String(obj.format)}).`);
  if (typeof obj.options !== "object" || obj.options === null) fail("options가 없습니다.");
  if (!Array.isArray(obj.cells)) fail("cells가 없습니다.");

  const raw = obj.options as Record<string, unknown>;
  const options: WorldOptions = { ...DEFAULT_OPTIONS };
  if (typeof raw.seed === "string") options.seed = raw.seed.slice(0, 40);
  for (const key of ["width", "height", "cells", "landRatio", "states", "citiesPerState", "temperatureShift"] as const) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) options[key] = v;
  }
  if (raw.shape === "continent" || raw.shape === "archipelago") options.shape = raw.shape;
  if (raw.nameStyle === "korean" || raw.nameStyle === "western") options.nameStyle = raw.nameStyle;
  validateOptions(options);

  const mesh = createMesh(options);
  const cells = obj.cells as unknown[];
  if (cells.length !== mesh.count) fail(`셀 수가 맞지 않습니다 (파일 ${cells.length}, 재생성 ${mesh.count}).`);
  const elevation = new Float64Array(mesh.count);
  cells.forEach((c, i) => {
    const e = (c as Record<string, unknown> | null)?.elevation;
    if (typeof e !== "number" || !Number.isFinite(e)) fail(`${i}번 셀의 고도 값이 올바르지 않습니다.`);
    elevation[i] = Math.max(-1, Math.min(1, e as number));
    if (mesh.isEdge[i]) elevation[i] = Math.min(elevation[i], -0.05);
  });
  // 저장할 때의 이름을 그대로 되살리기 위해 이름 정보도 읽는다 (없거나 틀리면 새로 생성).
  const anchors = sanitizeAnchors({
    nameStyle: options.nameStyle, states: obj.states, cities: obj.cities, rivers: obj.rivers, peaks: obj.peaks,
  });
  let civ: CivState | undefined;
  if (obj.civ !== undefined) {
    civ = civFromJSON(obj.civ, mesh.count);
    if (!civ) fail("편집한 문명(civ) 정보가 올바르지 않습니다.");
  }
  return { options, elevation, mesh, anchors, civ };
}

/**
 * 최신 이름 정보 앞에 두고 이전 기억을 덧붙인다. (이름, 위치)가 같은 항목만 합쳐서,
 * 편집 중 옮겨 간 이름도 원래 위치 기록을 잃지 않게 한다. 그래야 되돌렸을 때 원래 자리가 원래 이름을 찾는다.
 * 같은 이름이 두 곳에 붙는 것은 배정 단계(greedyAssign)에서 막는다. 오래된 항목부터 limit개를 넘으면 버린다.
 */
export function mergeAnchors(latest: NameAnchors, memory?: NameAnchors, limit = 600): NameAnchors {
  if (!memory || memory.nameStyle !== latest.nameStyle) return latest;
  const merge = <T extends { name: string }>(a: T[], b: T[], where: (t: T) => number): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of [...a, ...b]) {
      const key = `${item.name}@${where(item)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  };
  return {
    nameStyle: latest.nameStyle,
    states: merge(latest.states, memory.states, (s) => s.capitalCell),
    cities: merge(latest.cities, memory.cities, (c) => c.cell),
    rivers: merge(latest.rivers, memory.rivers, (r) => r.cells[r.cells.length - 1] ?? -1),
    peaks: merge(latest.peaks, memory.peaks, (p) => p.cell),
  };
}
