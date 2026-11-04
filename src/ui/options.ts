import { DEFAULT_OPTIONS, type WorldOptions } from "../world.ts";

/** 범위 입력으로 고르는 옵션 */
export const RANGE_FIELDS = ["landRatio", "states", "citiesPerState", "temperatureShift", "cells"] as const;
export type RangeField = (typeof RANGE_FIELDS)[number];

export const formatters: Record<RangeField, (v: number) => string> = {
  landRatio: (v) => `${Math.round(v * 100)}%`,
  states: (v) => `${v}`,
  citiesPerState: (v) => `${v}`,
  temperatureShift: (v) => (v === 0 ? "보통" : v > 0 ? `따뜻 +${v.toFixed(2)}` : `추움 ${v.toFixed(2)}`),
  cells: (v) => v.toLocaleString("ko-KR"),
};

/**
 * URL 해시(#seed=…&style=…)를 옵션으로 읽는다. 알 수 없는 값은 버린다
 * (범위 검사는 지도를 만들 때 validateOptions가 한다).
 */
export function parseHash(hash: string): Partial<WorldOptions> {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
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

/** 옵션 → URL 해시 (앞의 # 포함). 링크로 같은 지도를 공유하는 데 쓴다. */
export function formatHash(o: WorldOptions): string {
  const p = new URLSearchParams({
    seed: o.seed, style: o.nameStyle, shape: o.shape,
    landRatio: String(o.landRatio), states: String(o.states), citiesPerState: String(o.citiesPerState),
    temperatureShift: String(o.temperatureShift), cells: String(o.cells),
  });
  return `#${p}`;
}

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 요소가 없습니다.`);
  return el as T;
};

export function fillForm(o: WorldOptions): void {
  byId<HTMLInputElement>("seed").value = o.seed;
  byId<HTMLSelectElement>("nameStyle").value = o.nameStyle;
  byId<HTMLSelectElement>("shape").value = o.shape;
  for (const key of RANGE_FIELDS) {
    byId<HTMLInputElement>(key).value = String(o[key]);
    byId(`${key}Out`).textContent = formatters[key](o[key]);
  }
}

export function readForm(): WorldOptions {
  const num = (id: RangeField): number => Number(byId<HTMLInputElement>(id).value);
  return {
    ...DEFAULT_OPTIONS,
    seed: byId<HTMLInputElement>("seed").value.trim(),
    nameStyle: byId<HTMLSelectElement>("nameStyle").value === "western" ? "western" : "korean",
    shape: byId<HTMLSelectElement>("shape").value === "archipelago" ? "archipelago" : "continent",
    landRatio: num("landRatio"),
    states: num("states"),
    citiesPerState: num("citiesPerState"),
    temperatureShift: num("temperatureShift"),
    cells: num("cells"),
  };
}
