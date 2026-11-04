import { civFromJSON, civToJSON, type CivState } from "../civedit.ts";
import { decodeElevation, encodeElevation } from "../editor.ts";
import { infraFromJSON, infraToJSON, isEmptyInfra, type Infra } from "../infra.ts";
import type { NameStyle } from "../names.ts";
import { sanitizeAnchors, type NameAnchors } from "../world.ts";

/** 편집 내용 브라우저 저장 (이 브라우저에만 남는 편의 기능) */
export const STORAGE_KEY = "fmg:edits:v1";

/** 저장소 접근 (localStorage와 같은 모양, 테스트에서는 메모리 구현을 넘긴다) */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface SavedEdits {
  elevation: Float64Array;
  names: Partial<Record<NameStyle, NameAnchors>>;
  civ?: CivState;
  infra?: Infra;
}

/**
 * 편집 내용을 저장한다. 편집한 것이 없으면(hasEdits=false) 지운다.
 * 저장소를 쓸 수 없는 환경(사생활 보호 모드, 용량 초과 등)에서는 조용히 건너뛴다.
 */
export function saveEdits(
  store: KeyValueStore, terrainKey: string, hasEdits: boolean, edits: SavedEdits,
): void {
  try {
    if (hasEdits) {
      store.setItem(STORAGE_KEY, JSON.stringify({
        terrainKey,
        data: encodeElevation(edits.elevation),
        names: edits.names,
        civ: edits.civ ? civToJSON(edits.civ) : undefined,
        infra: !edits.infra || isEmptyInfra(edits.infra) ? undefined : infraToJSON(edits.infra),
      }));
    } else {
      store.removeItem(STORAGE_KEY);
    }
  } catch {
    // 저장 실패는 편집을 막을 이유가 아니다.
  }
}

/**
 * 저장된 편집을 읽는다. 지형 키(시드·크기·셀 수 등)가 다르거나, 셀 수가 맞지 않거나,
 * 손상된 값이면 undefined. cellCount는 저장본이 이 지형의 것일 때만 부른다 (메시를 만드는 비용이 커서).
 */
export function loadSavedEdits(store: KeyValueStore, terrainKey: string, cellCount: () => number): SavedEdits | undefined {
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as {
      terrainKey?: unknown; data?: unknown; names?: Record<string, unknown>; civ?: unknown; infra?: unknown;
    };
    if (saved.terrainKey !== terrainKey || typeof saved.data !== "string") return undefined;
    const count = cellCount();
    const elevation = decodeElevation(saved.data, count);
    if (!elevation) return undefined;
    const names: Partial<Record<NameStyle, NameAnchors>> = {};
    for (const style of ["korean", "western"] as const) {
      const a = sanitizeAnchors(saved.names?.[style]);
      if (a && a.nameStyle === style) names[style] = a;
    }
    return {
      elevation, names,
      civ: saved.civ === undefined ? undefined : civFromJSON(saved.civ, count),
      infra: saved.infra === undefined ? undefined : infraFromJSON(saved.infra, count),
    };
  } catch {
    return undefined;
  }
}
