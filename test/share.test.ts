import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { civToJSON, renameCity, snapshotCiv } from "../src/civedit.ts";
import { applyBrush } from "../src/editor.ts";
import { emptyInfra, infraToJSON } from "../src/infra.ts";
import { findCell } from "../src/mesh.ts";
import { emptyResourceEdits } from "../src/resources.ts";
import { decodeShare, elevationDiff, encodeShare, MAX_SHARE_CHARS, SHARE_FORMAT } from "../src/share.ts";
import {
  applyInfra, applyResources, createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, extractAnchors, parseMapJSON, toJSON, type WorldOptions,
} from "../src/world.ts";

const OPTS: WorldOptions = { ...DEFAULT_OPTIONS, seed: "링크 공유", cells: 3000, width: 900, height: 600 };
const mesh = createMesh(OPTS);
const base = createElevation(mesh, OPTS);

/** 지형을 칠하고, 도시 이름을 바꾸고, 시설·자원을 놓은 지도 */
function editedMap() {
  const e = Float64Array.from(base);
  applyBrush(mesh, e, { tool: "raise", radius: 60, strength: 1 }, 450, 300);
  applyBrush(mesh, e, { tool: "lower", radius: 30, strength: 0.7 }, 200, 150);
  const first = deriveWorld(OPTS, mesh, e);
  const civ = snapshotCiv(first);
  assert.equal(renameCity(civ, 0, "링크시험", "korean"), null);
  const land = first.cities[1].cell;
  const infra = { ...emptyInfra(), facilities: [{ cell: land, kind: "castle" as const, name: "공유성" }] };
  const resources = { ...emptyResourceEdits(), added: [{ cell: land, kind: "gold" as const }] };
  const world = applyResources(applyInfra(deriveWorld(OPTS, mesh, e, false, extractAnchors(first), civ), infra), resources);
  return { e, civ, infra, resources, world };
}

describe("편집 공유 링크", () => {
  test("왕복: 고도는 비트 단위로 같고 문명·시설·자원 편집도 그대로 돌아온다", async () => {
    const m = editedMap();
    const link = await encodeShare(m.world, base, m.civ, m.infra, m.resources);
    assert.match(link, /^[A-Za-z0-9_-]+$/);
    assert.ok(link.length < MAX_SHARE_CHARS, `링크 길이 ${link.length}`);
    const back = await decodeShare(link);
    assert.deepEqual(back.options, OPTS);
    assert.deepEqual(back.elevation, m.e);
    assert.deepEqual(civToJSON(back.civ!), civToJSON(m.civ));
    assert.deepEqual(infraToJSON(back.infra!), infraToJSON(m.infra));
    assert.deepEqual(back.resources, m.resources);
  });

  test("링크로 연 지도는 JSON 파일로 연 지도와 같은 지명·도시·자원이 된다", async () => {
    const m = editedMap();
    const viaLink = await decodeShare(await encodeShare(m.world, base, m.civ, m.infra, m.resources));
    const viaJson = parseMapJSON(JSON.parse(JSON.stringify(toJSON(m.world, m.civ, m.infra, m.resources))));
    const build = (p: typeof viaLink) =>
      applyResources(applyInfra(deriveWorld(p.options, p.mesh, p.elevation, false, p.anchors, p.civ), p.infra!), p.resources!);
    const a = build(viaLink), b = build(viaJson);
    assert.deepEqual(a.cities, b.cities);
    assert.deepEqual(a.states.map((s) => s.name), b.states.map((s) => s.name));
    assert.deepEqual(a.rivers.map((r) => r.name), b.rivers.map((r) => r.name));
    assert.deepEqual(a.resources, b.resources);
    assert.equal(a.cities[0].name, "링크시험");
  });

  test("편집이 적으면 링크가 짧다: 바뀐 셀만 담는다", async () => {
    const e = Float64Array.from(base);
    const c = findCell(mesh, 450, 300);
    applyBrush(mesh, e, { tool: "raise", radius: 25, strength: 1 }, mesh.x[c], mesh.y[c]);
    const diff = elevationDiff(base, e);
    assert.ok(diff.d.length > 0 && diff.d.length < 100, `바뀐 셀 ${diff.d.length}개`);
    const link = await encodeShare(deriveWorld(OPTS, mesh, e), base);
    assert.ok(link.length < 6000, `링크 길이 ${link.length}`);
    assert.deepEqual((await decodeShare(link)).elevation, e);
  });

  test("잘리거나 고친 링크는 이유와 함께 거부한다", async () => {
    const m = editedMap();
    const link = await encodeShare(m.world, base, m.civ, m.infra, m.resources);
    await assert.rejects(decodeShare(link.slice(0, link.length / 2)), /손상/);
    await assert.rejects(decodeShare("@@@"), /올바르지 않습니다/);
    await assert.rejects(decodeShare("A".repeat(MAX_SHARE_CHARS * 2 + 1)), /너무 큽니다/);
    const pack = async (o: unknown): Promise<string> => {
      const bytes = new Uint8Array(await new Response(new Blob([JSON.stringify(o)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const good = { format: SHARE_FORMAT, options: OPTS, elevation: { d: [1], v: [0.5] } };
    assert.deepEqual((await decodeShare(await pack(good))).elevation[0], Math.min(0.5, mesh.isEdge[0] ? -0.05 : 0.5));
    await assert.rejects(decodeShare(await pack({ ...good, format: "other" })), /지원하지 않는 형식/);
    await assert.rejects(decodeShare(await pack({ ...good, options: { ...OPTS, states: 99 } })), /국가 수/);
    await assert.rejects(decodeShare(await pack({ ...good, elevation: { d: [mesh.count + 1], v: [0] } })), /셀 수/);
    await assert.rejects(decodeShare(await pack({ ...good, elevation: { d: [0], v: [0] } })), /고도 정보/);
    await assert.rejects(decodeShare(await pack({ ...good, elevation: { d: [1], v: ["높음"] } })), /고도 정보/);
    await assert.rejects(decodeShare(await pack({ ...good, civ: { cities: "x" } })), /문명/);
    // 압축 폭탄: 풀면 4MB를 넘는 글
    await assert.rejects(decodeShare(await pack({ ...good, pad: "가".repeat(2_000_000) })), /너무 큽니다/);
  });
});
