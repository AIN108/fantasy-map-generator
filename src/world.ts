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

/** 시드와 옵션으로 지도 전체를 만든다. 같은 입력이면 항상 같은 결과. */
export function generateWorld(input: Partial<WorldOptions> = {}): WorldMap {
  const options: WorldOptions = { ...DEFAULT_OPTIONS, ...input };
  validateOptions(options);
  const { seed } = options;

  // 단계마다 별도 난수열을 써서, 예를 들어 지명 스타일만 바꿔도 지형은 그대로 유지되게 한다.
  const mesh = buildMesh(subRng(seed, "mesh"), options.width, options.height, options.cells);
  const elevation = generateElevation(mesh, subRng(seed, "terrain"), options);
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
