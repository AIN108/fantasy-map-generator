// 지도 옆 목록·정보 그리기: 국가 범례, 국경 칠하기·국가 없애기의 국가 목록, 자원 종류 목록, 셀 정보 (main.ts에서 옮김)

import { RESOURCE_CATEGORY_KO, RESOURCE_INFO, RESOURCE_KINDS, type ResourceCategory } from "../resources.ts";
import type { WorldMap } from "../world.ts";

/** 국가 범례: 색과 '이름 · 수도 이름' */
export function renderStateLegend(el: HTMLElement, w: WorldMap): void {
  el.replaceChildren(
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
export function renderStateOptions(select: HTMLSelectElement, w: WorldMap): void {
  const selected = select.value;
  const opts = w.states.map((s) => {
    const o = document.createElement("option");
    o.value = String(s.id);
    o.textContent = s.name;
    return o;
  });
  const none = document.createElement("option");
  none.value = "-1";
  none.textContent = "무소속 (지우기)";
  select.replaceChildren(...opts, none);
  if ([...select.options].some((o) => o.value === selected)) select.value = selected;
}

/** 국가 없애기에서 영토를 넘겨받을 곳: 무소속 + 고른 나라를 뺀 나머지. 고른 나라가 없으면 없애기 단추를 끈다. */
export function renderMergeOptions(mergeInto: HTMLSelectElement, paintState: HTMLSelectElement, deleteButton: HTMLButtonElement, w: WorldMap): void {
  const selected = mergeInto.value;
  const removing = Number(paintState.value);
  const none = document.createElement("option");
  none.value = "-1";
  none.textContent = "무소속";
  const opts = w.states.filter((s) => s.id !== removing).map((s) => {
    const o = document.createElement("option");
    o.value = String(s.id);
    o.textContent = s.name;
    return o;
  });
  mergeInto.replaceChildren(none, ...opts);
  if ([...mergeInto.options].some((o) => o.value === selected)) mergeInto.value = selected;
  deleteButton.disabled = !(removing >= 0 && w.states[removing]);
}

/** 자원 종류 목록: 분류별로 묶는다. */
export function renderResourceKindOptions(select: HTMLSelectElement): void {
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
  select.replaceChildren(...groups);
}

/** 셀 정보 (항목 이름 → 값)를 정의 목록으로 */
export function renderCellInfo(el: HTMLElement, info: Record<string, string>): void {
  el.replaceChildren(
    ...Object.entries(info).flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}
