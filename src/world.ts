import {
  addWaterMoisture, classifyBiome, computeMoisture, computeTemperature, type Biome,
} from "./climate.ts";
import {
  buildRoads, expandStates, findPeaks, isCoastal, pickSpaced, settlementScore, stateColor, stateLabelCells,
  type City, type State,
} from "./civ.ts";
import { computeHydrology, extractRivers, type Hydrology } from "./hydrology.ts";
import { buildMesh, type Mesh } from "./mesh.ts";
import { NameGenerator, type NameStyle } from "./names.ts";
import { subRng } from "./rng.ts";
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
 */
export function deriveWorld(
  options: WorldOptions, mesh: Mesh, elevation: Float64Array, natureOnly = false,
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
  const civRng = subRng(seed, "civ");
  const score = settlementScore(mesh, elevation, biome, hydro, civRng);
  let landCells = 0;
  for (let i = 0; i < mesh.count; i++) if (elevation[i] > 0) landCells++;
  const landArea = (landCells / mesh.count) * options.width * options.height;
  const capitalSpacing = Math.sqrt(landArea / options.states) * 0.75;
  const capitals = pickSpaced(mesh, score, options.states, capitalSpacing);

  const avgSpacing = Math.sqrt((options.width * options.height) / mesh.count);
  const owner = expandStates(mesh, biome, hydro, capitals, avgSpacing * 160);
  const townCount = capitals.length * options.citiesPerState;
  const towns = pickSpaced(mesh, score, townCount, capitalSpacing * 0.28, capitals);

  const names = new NameGenerator(subRng(seed, `names:${options.nameStyle}`), options.nameStyle);
  const labelCells = stateLabelCells(mesh, owner, capitals.length);
  const colorRng = subRng(seed, "colors");
  const states: State[] = capitals.map((cap, id) => ({
    id,
    name: names.next("state"),
    capitalCell: cap,
    color: stateColor(id, colorRng),
    labelCell: labelCells[id] >= 0 ? labelCells[id] : cap,
    cellCount: 0,
  }));
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
      name: names.next(capital ? "capital" : "city", { coastal, river: riverside, highland: elevation[cell] > 0.4 }),
    };
  };
  const cities: City[] = [...capitals.map((c) => makeCity(c, true)), ...towns.map((c) => makeCity(c, false))];

  const roads = buildRoads(mesh, biome, hydro, cities, subRng(seed, "roads"), capitalSpacing * 1.2);

  // 큰 강만 이름을 붙인다 (지도가 이름으로 뒤덮이지 않게).
  const namedRivers = [...rivers].filter((r) => r.cells.length >= 8).sort((a, b) => b.flux - a.flux).slice(0, 8);
  for (const r of namedRivers) r.name = names.next("river");

  const peaks: Peak[] = findPeaks(mesh, elevation, 6, capitalSpacing * 0.6).map((cell) => ({
    cell, name: names.next("mountain"),
  }));

  return { options, mesh, elevation, temperature, moisture, biome, hydro, rivers, owner, states, cities, roads, peaks };
}

/** 다른 프로젝트(TRPG·경제 시뮬레이터 등)에서 불러 쓰기 위한 JSON 내보내기 */
export function toJSON(world: WorldMap): object {
  const { mesh } = world;
  const round = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    format: "fantasy-map/v1",
    options: world.options,
    cells: Array.from({ length: mesh.count }, (_, i) => ({
      x: round(mesh.x[i]),
      y: round(mesh.y[i]),
      elevation: round(world.elevation[i]),
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
  };
}

/**
 * toJSON으로 저장한 지도를 다시 읽어 옵션과 (편집된) 고도를 돌려준다.
 * 외부 파일이므로 형식·범위를 검증하고, 메시를 다시 만들어 셀 수가 맞는지 확인한다.
 */
export function parseMapJSON(data: unknown): { options: WorldOptions; elevation: Float64Array; mesh: Mesh } {
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
  return { options, elevation, mesh };
}
