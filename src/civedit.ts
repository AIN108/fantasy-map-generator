import type { Mesh } from "./mesh.ts";
import { NameGenerator, type NameStyle } from "./names.ts";
import { subRng } from "./rng.ts";

/**
 * 사용자가 직접 편집하는 문명. 문명을 처음 편집하는 순간 자동 배치 결과를 이 형태로 고정하고,
 * 이후에는 자동 배치 대신 이 값을 그대로 쓴다 (지형을 다시 편집해도 도시·국경이 움직이지 않는다).
 */
export interface CivCity {
  cell: number;
  /** 지명 스타일별 이름. 아직 없는 스타일은 ensureCivNames가 채운다. */
  names: Partial<Record<NameStyle, string>>;
}

export interface CivStateDef {
  names: Partial<Record<NameStyle, string>>;
  color: string;
  /** cities 배열에서 수도의 인덱스 */
  capitalCity: number;
}

export interface CivState {
  cities: CivCity[];
  states: CivStateDef[];
  /** 셀별 소속 국가 (-1: 무소속) */
  owner: Int32Array;
}

/** 편집 결과를 화면용 월드에서 읽어 오기 위한 최소 정보 (world.ts와의 순환 의존을 피한다) */
interface WorldCivView {
  options: { nameStyle: NameStyle };
  owner: Int32Array;
  states: { name: string; color: string; capitalCell: number }[];
  cities: { cell: number; name: string }[];
}

/** 자동 배치된 현재 문명을 편집 가능한 형태로 고정한다. */
export function snapshotCiv(world: WorldCivView): CivState {
  const style = world.options.nameStyle;
  const cities: CivCity[] = world.cities.map((c) => ({ cell: c.cell, names: { [style]: c.name } }));
  const states: CivStateDef[] = world.states.map((s) => ({
    names: { [style]: s.name },
    color: s.color,
    capitalCity: cities.findIndex((c) => c.cell === s.capitalCell),
  }));
  return { cities, states, owner: Int32Array.from(world.owner) };
}

export function cloneCiv(civ: CivState): CivState {
  return {
    cities: civ.cities.map((c) => ({ cell: c.cell, names: { ...c.names } })),
    states: civ.states.map((s) => ({ names: { ...s.names }, color: s.color, capitalCity: s.capitalCity })),
    owner: Int32Array.from(civ.owner),
  };
}

export const isCapital = (civ: CivState, cityIndex: number): boolean =>
  civ.states.some((s) => s.capitalCity === cityIndex);

/** 해당 스타일의 이름이 없는 국가·도시에 새 이름을 붙인다 (기존 이름과 겹치지 않게). civ를 직접 바꾼다. */
export function ensureCivNames(civ: CivState, style: NameStyle, seed: string, extraReserved: Iterable<string> = []): void {
  const missing = civ.states.some((s) => !s.names[style]) || civ.cities.some((c) => !c.names[style]);
  if (!missing) return;
  const gen = new NameGenerator(subRng(seed, `names-civ:${style}:${civ.cities.length}`), style);
  for (const n of extraReserved) gen.reserve(n);
  for (const s of civ.states) if (s.names[style]) gen.reserve(s.names[style]!);
  for (const c of civ.cities) if (c.names[style]) gen.reserve(c.names[style]!);
  for (const s of civ.states) s.names[style] ??= gen.next("state");
  civ.cities.forEach((c, i) => { c.names[style] ??= gen.next(isCapital(civ, i) ? "capital" : "city"); });
}

// ── 편집 연산 ─────────────────────────────────────────────────────────
// 실패하면 이유를 담은 문자열을, 성공하면 null을 돌려준다 (화면 상태 표시에 그대로 쓴다).

export type EditResult = string | null;

const isSettleable = (elevation: Float64Array, isLake: Uint8Array, cell: number): boolean =>
  cell >= 0 && cell < elevation.length && elevation[cell] > 0 && !isLake[cell];

const cityAt = (civ: CivState, cell: number, except = -1): number =>
  civ.cities.findIndex((c, i) => i !== except && c.cell === cell);

export function moveCity(
  civ: CivState, index: number, cell: number, elevation: Float64Array, isLake: Uint8Array,
): EditResult {
  const city = civ.cities[index];
  if (!city) return "도시를 찾을 수 없습니다.";
  if (!isSettleable(elevation, isLake, cell)) return "바다나 호수에는 도시를 둘 수 없습니다.";
  if (cityAt(civ, cell, index) >= 0) return "그 자리에는 이미 다른 도시가 있습니다.";
  city.cell = cell;
  // 수도는 자기 나라 땅 위에 있어야 한다: 옮긴 자리를 그 나라 영토로 만든다.
  const state = civ.states.findIndex((s) => s.capitalCity === index);
  if (state >= 0) civ.owner[cell] = state;
  return null;
}

export function addCity(
  civ: CivState, cell: number, elevation: Float64Array, isLake: Uint8Array, style: NameStyle, seed: string,
): EditResult {
  if (!isSettleable(elevation, isLake, cell)) return "바다나 호수에는 도시를 둘 수 없습니다.";
  if (cityAt(civ, cell) >= 0) return "그 자리에는 이미 도시가 있습니다.";
  if (civ.cities.length >= 500) return "도시는 500개까지 둘 수 있습니다.";
  civ.cities.push({ cell, names: {} });
  ensureCivNames(civ, style, seed);
  return null;
}

export function deleteCity(civ: CivState, index: number): EditResult {
  if (!civ.cities[index]) return "도시를 찾을 수 없습니다.";
  if (isCapital(civ, index)) return "수도는 지울 수 없습니다. 다른 도시를 수도로 지정하거나 옮기세요.";
  civ.cities.splice(index, 1);
  for (const s of civ.states) if (s.capitalCity > index) s.capitalCity--;
  return null;
}

export const MAX_NAME_LENGTH = 20;

export function renameCity(civ: CivState, index: number, name: string, style: NameStyle): EditResult {
  const city = civ.cities[index];
  if (!city) return "도시를 찾을 수 없습니다.";
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) return "이름이 비어 있습니다.";
  if (clean.length > MAX_NAME_LENGTH) return `이름은 ${MAX_NAME_LENGTH}자 이하여야 합니다.`;
  const taken = civ.cities.some((c, i) => i !== index && c.names[style] === clean)
    || civ.states.some((s) => s.names[style] === clean);
  if (taken) return `'${clean}'은(는) 이미 쓰고 있는 이름입니다.`;
  city.names[style] = clean;
  return null;
}

export function renameState(civ: CivState, stateId: number, name: string, style: NameStyle): EditResult {
  const state = civ.states[stateId];
  if (!state) return "국가를 찾을 수 없습니다.";
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) return "이름이 비어 있습니다.";
  if (clean.length > MAX_NAME_LENGTH) return `이름은 ${MAX_NAME_LENGTH}자 이하여야 합니다.`;
  const taken = civ.states.some((s, i) => i !== stateId && s.names[style] === clean)
    || civ.cities.some((c) => c.names[style] === clean);
  if (taken) return `'${clean}'은(는) 이미 쓰고 있는 이름입니다.`;
  state.names[style] = clean;
  return null;
}

/** 도시를 그 도시가 속한 나라의 수도로 지정한다 (이전 수도는 일반 도시가 된다). */
export function makeCapital(civ: CivState, index: number): EditResult {
  const city = civ.cities[index];
  if (!city) return "도시를 찾을 수 없습니다.";
  const state = civ.owner[city.cell];
  if (state < 0 || !civ.states[state]) return "무소속 땅의 도시는 수도로 지정할 수 없습니다. 먼저 국경을 칠해 나라 땅으로 만드세요.";
  if (civ.states[state].capitalCity === index) return "이미 수도입니다.";
  if (isCapital(civ, index)) return "다른 나라의 수도입니다.";
  civ.states[state].capitalCity = index;
  return null;
}

/**
 * 원 안의 육지 셀을 stateId 나라 땅으로 칠한다 (-1이면 무소속).
 * 다른 나라 수도가 있는 셀은 건드리지 않는다 (수도가 자기 나라 밖에 놓이지 않게). 바뀐 셀 수를 돌려준다.
 */
export function paintTerritory(
  mesh: Mesh, civ: CivState, elevation: Float64Array, isLake: Uint8Array,
  cx: number, cy: number, radius: number, stateId: number,
): number {
  if (stateId >= civ.states.length || stateId < -1) return 0;
  const protectedCells = new Map<number, number>();
  civ.states.forEach((s, id) => {
    const c = civ.cities[s.capitalCity];
    if (c) protectedCells.set(c.cell, id);
  });
  const r2 = radius * radius;
  let changed = 0;
  for (let i = 0; i < mesh.count; i++) {
    const dx = mesh.x[i] - cx, dy = mesh.y[i] - cy;
    if (dx * dx + dy * dy >= r2) continue;
    if (!isSettleable(elevation, isLake, i)) continue;
    const guard = protectedCells.get(i);
    if (guard !== undefined && guard !== stateId) continue;
    if (civ.owner[i] !== stateId) {
      civ.owner[i] = stateId;
      changed++;
    }
  }
  return changed;
}

/** 지도 좌표에서 radius 안에 있는 가장 가까운 도시 인덱스 (바다에 잠긴 도시는 제외). 없으면 -1. */
export function hitCity(mesh: Mesh, civ: CivState, elevation: Float64Array, x: number, y: number, radius: number): number {
  let best = -1, bestD = radius * radius;
  civ.cities.forEach((c, i) => {
    if (elevation[c.cell] <= 0) return;
    const d = (mesh.x[c.cell] - x) ** 2 + (mesh.y[c.cell] - y) ** 2;
    if (d <= bestD) { bestD = d; best = i; }
  });
  return best;
}

// ── 저장 형식 ─────────────────────────────────────────────────────────

/** 브라우저 저장·JSON 내보내기용 일반 객체 (owner는 base64로 압축) */
export interface CivJSON {
  cities: { cell: number; names: Partial<Record<NameStyle, string>> }[];
  states: { names: Partial<Record<NameStyle, string>>; color: string; capitalCity: number }[];
  owner: string;
}

export function civToJSON(civ: CivState): CivJSON {
  const bytes = new Uint8Array(Int8Array.from(civ.owner).buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    cities: civ.cities.map((c) => ({ cell: c.cell, names: { ...c.names } })),
    states: civ.states.map((s) => ({ names: { ...s.names }, color: s.color, capitalCity: s.capitalCity })),
    owner: btoa(bin),
  };
}

/** 외부 입력(브라우저 저장·JSON)을 검증해 CivState로 만든다. 하나라도 어긋나면 undefined. */
export function civFromJSON(data: unknown, cellCount: number): CivState | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.cities) || !Array.isArray(o.states) || typeof o.owner !== "string") return undefined;
  if (o.cities.length > 500 || o.states.length > 30) return undefined;

  const names = (v: unknown): Partial<Record<NameStyle, string>> | undefined => {
    if (typeof v !== "object" || v === null) return undefined;
    const out: Partial<Record<NameStyle, string>> = {};
    for (const style of ["korean", "western"] as const) {
      const n = (v as Record<string, unknown>)[style];
      if (n === undefined) continue;
      if (typeof n !== "string" || !n.trim() || n.length > MAX_NAME_LENGTH * 3) return undefined;
      out[style] = n;
    }
    return out;
  };
  const cities: CivCity[] = [];
  for (const raw of o.cities) {
    const c = raw as Record<string, unknown>;
    const n = names(c?.names);
    if (!Number.isInteger(c?.cell) || (c.cell as number) < 0 || (c.cell as number) >= cellCount || !n) return undefined;
    cities.push({ cell: c.cell as number, names: n });
  }
  const states: CivStateDef[] = [];
  for (const raw of o.states) {
    const s = raw as Record<string, unknown>;
    const n = names(s?.names);
    const cap = s?.capitalCity;
    if (!n || typeof s.color !== "string" || !/^hsl\([\d.]+ \d+% \d+%\)$/.test(s.color)) return undefined;
    if (!Number.isInteger(cap) || (cap as number) < 0 || (cap as number) >= cities.length) return undefined;
    states.push({ names: n, color: s.color, capitalCity: cap as number });
  }
  if (new Set(states.map((s) => s.capitalCity)).size !== states.length) return undefined;

  let bin: string;
  try { bin = atob(o.owner); } catch { return undefined; }
  if (bin.length !== cellCount) return undefined;
  const owner = new Int32Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    const v = (bin.charCodeAt(i) << 24) >> 24; // Int8 부호 복원
    owner[i] = v >= 0 && v < states.length ? v : -1;
  }
  return { cities, states, owner };
}
