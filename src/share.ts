// 편집한 지도를 링크에 담는다: 시드 지형에서 바뀐 고도 셀 + 지명 + 직접 편집한 문명·시설·자원을
// JSON → deflate-raw → base64url로 줄여 해시(#…&e=)에 붙인다. 받는 쪽은 JSON 파일을 불러올 때와 같은 검증을 거친다.
// 고도는 반올림하지 않는다: 아주 작은 차이도 강 경로·도시 배치를 바꿔 다른 지도가 되기 때문 (JSON 숫자는 Float64를 정확히 왕복한다).

import { civFromJSON, civToJSON, type CivState } from "./civedit.ts";
import { infraFromJSON, infraToJSON, isEmptyInfra, type Infra } from "./infra.ts";
import type { Mesh } from "./mesh.ts";
import { isEmptyResourceEdits, resourceEditsFromJSON, resourceEditsToJSON, type ResourceEdits } from "./resources.ts";
import {
  createElevation, createMesh, extractAnchors, optionsFromJSON, sanitizeAnchors, type NameAnchors, type WorldMap, type WorldOptions,
} from "./world.ts";

export const SHARE_FORMAT = "fantasy-map-share/v1";
/** 링크에 담을 수 있는 최대 길이 (글자). 이보다 길면 JSON 파일을 쓰게 한다. */
export const MAX_SHARE_CHARS = 60000;
/** 풀었을 때 최대 크기 (압축 폭탄 방지) */
const MAX_JSON_BYTES = 4 * 1024 * 1024;
/** 가장자리 셀은 항상 바다 (editor.ts·parseMapJSON과 같은 값) */
const EDGE_CEILING = -0.05;

export const canShare = (): boolean => typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

export interface SharedMap {
  options: WorldOptions;
  mesh: Mesh;
  elevation: Float64Array;
  anchors?: NameAnchors;
  civ?: CivState;
  infra?: Infra;
  resources?: ResourceEdits;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  writer.write(data as unknown as BufferSource).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("링크의 지도가 너무 큽니다.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const toBase64Url = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64Url = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("링크의 지도 값이 올바르지 않습니다.");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** 시드 지형(base)과 다른 셀만: 셀 번호는 앞 번호와의 차이, 값은 그대로 */
export function elevationDiff(base: Float64Array, elevation: Float64Array): { d: number[]; v: number[] } {
  const d: number[] = [], v: number[] = [];
  let last = -1;
  for (let i = 0; i < elevation.length; i++) {
    if (elevation[i] === base[i]) continue;
    d.push(i - last);
    v.push(elevation[i]);
    last = i;
  }
  return { d, v };
}

/** 지금 지도(world, 편집이 반영된 고도 포함)를 링크 조각으로 */
export async function encodeShare(
  world: WorldMap, base: Float64Array, civ?: CivState, infra?: Infra, resourceEdits?: ResourceEdits,
): Promise<string> {
  if (!canShare()) throw new Error("이 브라우저는 링크 압축을 지원하지 않습니다. 'JSON 저장'을 쓰세요.");
  const payload = {
    format: SHARE_FORMAT,
    options: world.options,
    elevation: elevationDiff(base, world.elevation),
    names: extractAnchors(world),
    ...(civ ? { civ: civToJSON(civ) } : {}),
    ...(infra && !isEmptyInfra(infra) ? { infra: infraToJSON(infra) } : {}),
    ...(resourceEdits && !isEmptyResourceEdits(resourceEdits) ? { resources: resourceEditsToJSON(resourceEdits) } : {}),
  };
  return toBase64Url(await pipe(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream("deflate-raw")));
}

/** 링크 조각 → 검증한 지도. 메시는 옵션으로 다시 만들고 바뀐 셀만 덮어쓴다. */
export async function decodeShare(s: string): Promise<SharedMap> {
  if (!canShare()) throw new Error("이 브라우저는 링크에 담긴 지도를 풀 수 없습니다.");
  if (s.length > MAX_SHARE_CHARS * 2) throw new Error("링크의 지도가 너무 큽니다.");
  let raw: Uint8Array;
  try {
    raw = await pipe(fromBase64Url(s), new DecompressionStream("deflate-raw"), MAX_JSON_BYTES);
  } catch (e) {
    throw e instanceof Error && /너무 큽니다|올바르지/.test(e.message) ? e : new Error("링크의 지도가 손상되었습니다 (일부가 잘렸을 수 있습니다).");
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error("링크의 지도가 손상되었습니다.");
  }
  const fail = (msg: string): never => { throw new Error(`링크의 지도를 읽을 수 없습니다: ${msg}`); };
  if (typeof data !== "object" || data === null || data.format !== SHARE_FORMAT) fail("지원하지 않는 형식입니다.");
  let options: WorldOptions;
  try { options = optionsFromJSON(data.options); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }

  const mesh = createMesh(options);
  const elevation = createElevation(mesh, options);
  const diff = (data.elevation ?? {}) as { d?: unknown; v?: unknown };
  if (!Array.isArray(diff.d) || !Array.isArray(diff.v) || diff.d.length !== diff.v.length || diff.d.length > mesh.count) fail("고도 정보가 올바르지 않습니다.");
  let cell = -1;
  (diff.d as unknown[]).forEach((step, k) => {
    const value = (diff.v as unknown[])[k];
    if (!Number.isInteger(step) || (step as number) < 1 || typeof value !== "number" || !Number.isFinite(value)) fail("고도 정보가 올바르지 않습니다.");
    cell += step as number;
    if (cell >= mesh.count) fail("고도 정보가 이 지도의 셀 수와 맞지 않습니다.");
    elevation[cell] = Math.max(-1, Math.min(1, value as number));
    if (mesh.isEdge[cell]) elevation[cell] = Math.min(elevation[cell], EDGE_CEILING);
  });

  const out: SharedMap = { options, mesh, elevation };
  const anchors = sanitizeAnchors(data.names);
  if (anchors && anchors.nameStyle === options.nameStyle) out.anchors = anchors;
  if (data.civ !== undefined) out.civ = civFromJSON(data.civ, mesh.count) ?? fail("편집한 문명 정보가 올바르지 않습니다.");
  if (data.infra !== undefined) out.infra = infraFromJSON(data.infra, mesh.count) ?? fail("도로·철도·시설 정보가 올바르지 않습니다.");
  if (data.resources !== undefined) out.resources = resourceEditsFromJSON(data.resources, mesh.count) ?? fail("자원 편집 정보가 올바르지 않습니다.");
  return out;
}
