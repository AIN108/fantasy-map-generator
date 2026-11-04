import { drawResourceIcon } from "../render.ts";
import { RESOURCE_CATEGORY_KO, RESOURCE_INFO, RESOURCE_KINDS, type Resource, type ResourceCategory, type ResourceKind } from "../resources.ts";

const ICON_CSS_PX = 16;
const CATEGORIES: ResourceCategory[] = ["strategic", "luxury", "bonus"];

/** 자원 아이콘 하나를 작은 캔버스로 (범례·선택 목록 옆 미리보기용) */
export function resourceIconCanvas(kind: ResourceKind): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  c.width = c.height = Math.round(ICON_CSS_PX * dpr);
  c.style.width = c.style.height = `${ICON_CSS_PX}px`;
  const ctx = c.getContext("2d");
  if (ctx) {
    // 아이콘 지름 약 12(지도 단위)를 칸에 맞춘다
    const k = (ICON_CSS_PX * dpr) / 12.5;
    ctx.setTransform(k, 0, 0, k, (ICON_CSS_PX * dpr) / 2, (ICON_CSS_PX * dpr) / 2);
    drawResourceIcon(ctx, kind, 0, 0);
  }
  c.setAttribute("aria-hidden", "true");
  return c;
}

/**
 * 지도에 있는 자원을 분류별로 아이콘·이름·개수로 보여 준다. 보이지 않게 하려면 shown=false.
 * 전략 자원은 매장량 합계도 함께 적는다.
 */
export function renderResourceLegend(el: HTMLElement, resources: readonly Resource[], shown: boolean): void {
  el.hidden = !shown || resources.length === 0;
  if (el.hidden) { el.replaceChildren(); return; }
  const count = new Map<ResourceKind, { n: number; amount: number }>();
  for (const r of resources) {
    const c = count.get(r.kind) ?? { n: 0, amount: 0 };
    c.n++;
    c.amount += r.amount ?? 0;
    count.set(r.kind, c);
  }
  const groups = CATEGORIES.flatMap((cat) => {
    const kinds = RESOURCE_KINDS.filter((k) => RESOURCE_INFO[k].category === cat && count.has(k));
    if (kinds.length === 0) return [];
    const group = document.createElement("div");
    group.className = "resource-group";
    const title = document.createElement("strong");
    title.textContent = RESOURCE_CATEGORY_KO[cat];
    group.append(title);
    for (const k of kinds) {
      const c = count.get(k)!;
      const item = document.createElement("span");
      item.dataset.kind = k;
      item.title = cat === "strategic" ? `${RESOURCE_INFO[k].ko}: ${c.n}곳, 매장량 합계 ${c.amount}` : `${RESOURCE_INFO[k].ko}: ${c.n}곳`;
      item.append(resourceIconCanvas(k), `${RESOURCE_INFO[k].ko} ${c.n}`);
      group.append(item);
    }
    return [group];
  });
  el.replaceChildren(...groups);
}
