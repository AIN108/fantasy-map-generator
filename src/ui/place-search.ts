import { searchPlaces, type SearchPlace } from "../search.ts";

const MAX_RESULTS = 50;

/** 검색은 보기만 바꾼다. 지도 생성·편집·저장에는 관여하지 않는다. */
export function createPlaceSearch<T extends SearchPlace>(
  categories: readonly { value: string; label: string }[], onSelect: (place: T) => void,
): { setPlaces(places: readonly T[]): void } {
  const input = document.getElementById("placeQuery") as HTMLInputElement;
  const category = document.getElementById("placeCategory") as HTMLSelectElement;
  const clear = document.getElementById("placeClear") as HTMLButtonElement;
  const results = document.getElementById("placeResults")!;
  const count = document.getElementById("placeCount")!;
  let places: readonly T[] = [];
  let expanded = false;
  category.append(...categories.map((c) => {
    const option = document.createElement("option");
    option.value = c.value;
    option.textContent = c.label;
    return option;
  }));

  function render(): void {
    const active = expanded || !!input.value.trim() || category.value !== "all";
    const matches = searchPlaces(places, input.value, category.value);
    count.textContent = !active ? `${places.length}곳 · 이름이나 종류로 찾아보세요.`
      : !matches.length ? "검색 결과가 없습니다. 검색어나 종류를 바꿔 보세요."
        : `${matches.length}곳${matches.length > MAX_RESULTS ? ` · 앞 ${MAX_RESULTS}곳 표시, 검색어로 좁혀 주세요.` : ""}`;
    clear.disabled = !active;
    results.hidden = !active || !matches.length;
    results.replaceChildren(...(active ? matches.slice(0, MAX_RESULTS) : []).map((p) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const name = document.createElement("strong");
      name.textContent = `${p.number !== undefined ? `${p.number}번 · ` : ""}${p.name}`;
      const detail = document.createElement("small");
      detail.textContent = p.detail;
      button.append(name, detail);
      button.addEventListener("click", () => onSelect(p));
      li.append(button);
      return li;
    }));
  }
  function reset(): void {
    input.value = "";
    category.value = "all";
    expanded = false;
    render();
    input.focus();
  }
  input.addEventListener("input", () => { expanded = false; render(); });
  category.addEventListener("change", () => { expanded = false; render(); });
  clear.addEventListener("click", reset);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); reset(); }
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      expanded = true;
      render();
      const first = results.querySelector<HTMLButtonElement>("button");
      if (e.key === "Enter") first?.click(); else first?.focus();
    }
  });
  results.addEventListener("keydown", (e) => {
    // 결과 버튼의 실행 키가 지도 편집의 '길 완성' 같은 단축키로도 쓰이지 않게 한다.
    if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); input.focus(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    e.stopPropagation();
    const buttons = [...results.querySelectorAll<HTMLButtonElement>("button")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = i + (e.key === "ArrowDown" ? 1 : -1);
    if (next < 0) input.focus(); else buttons[Math.min(next, buttons.length - 1)]?.focus();
  });
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.key !== "/") return;
    if (document.querySelector("dialog[open]")) return;
    if (target instanceof HTMLElement && (target.closest("input, textarea, select") || target.isContentEditable)) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  return { setPlaces(next) { places = next; render(); } };
}
