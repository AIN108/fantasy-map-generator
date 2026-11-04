import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { snapshotCiv } from "../src/civedit.ts";
import { emptyInfra } from "../src/infra.ts";
import { computePreview, PreviewWorkerState, type PreviewInput, type WorkerRequest, type WorkerResponse } from "../src/preview.ts";
import { PreviewClient, type WorkerLike } from "../src/ui/preview-client.ts";
import {
  createElevation, createMesh, DEFAULT_OPTIONS, deriveWorld, natureKey, natureOf, toJSON, type WorldOptions,
} from "../src/world.ts";

const OPTS: WorldOptions = { ...DEFAULT_OPTIONS, seed: "미리보기", cells: 3000, width: 900, height: 600 };
const mesh = createMesh(OPTS);
const elevation = createElevation(mesh, OPTS);
const json = (w: Parameters<typeof toJSON>[0]) => JSON.stringify(toJSON(w));

describe("자연 계산 재사용", () => {
  test("같은 고도의 자연을 넘겨도 결과가 똑같다 (자동 배치·직접 편집한 문명)", () => {
    const fresh = deriveWorld(OPTS, mesh, elevation);
    const reused = deriveWorld(OPTS, mesh, elevation, false, undefined, undefined, undefined, natureOf(deriveWorld(OPTS, mesh, elevation, true)));
    assert.equal(json(reused), json(fresh));

    const civ = snapshotCiv(fresh);
    const western = { ...OPTS, nameStyle: "western" as const };
    const a = deriveWorld(western, mesh, elevation, false, undefined, civ);
    // 앞선 계산에서 강에 붙은 한국어 이름이 다음 계산으로 새지 않는다
    const b = deriveWorld(western, mesh, elevation, false, undefined, civ, undefined, natureOf(fresh));
    assert.equal(json(b), json(a));
  });

  test("natureKey는 고도 값이 하나만 달라도 바뀌고, 같은 값의 사본이면 같다", () => {
    const copy = Float64Array.from(elevation);
    assert.equal(natureKey(OPTS, copy), natureKey(OPTS, elevation));
    copy[123] += 1e-9;
    assert.notEqual(natureKey(OPTS, copy), natureKey(OPTS, elevation));
    assert.notEqual(natureKey({ ...OPTS, temperatureShift: 0.1 }, elevation), natureKey(OPTS, elevation));
    assert.notEqual(natureKey({ ...OPTS, seed: "다른" }, elevation), natureKey(OPTS, elevation));
  });
});

const input = (e: Float64Array, natureOnly = true): PreviewInput => ({
  options: OPTS, elevation: Float64Array.from(e), natureOnly, infra: emptyInfra(), natureKey: natureKey(OPTS, e),
});

describe("Worker 계산", () => {
  test("Worker 쪽 결과는 메인에서 직접 계산한 것과 같고, 국경 칠하기처럼 고도가 같으면 자연을 다시 쓴다", () => {
    const state = new PreviewWorkerState();
    const civ = snapshotCiv(deriveWorld(OPTS, mesh, elevation));
    for (let round = 0; round < 2; round++) {
      const req: WorkerRequest = { type: "preview", id: round + 1, input: { ...input(elevation, false), civ } };
      const { response, transfer } = state.handle(req);
      assert.equal(response?.type, "preview");
      if (response?.type !== "preview") return;
      assert.ok(transfer.every((b) => b === response.output.world.elevation.buffer), "고도 버퍼만 넘긴다");
      const direct = computePreview(mesh, { ...input(elevation, false), civ });
      assert.equal(json({ ...response.output.world, mesh }), json(direct.world));
      assert.deepEqual(response.output.cache, direct.cache);
    }
  });

  test("계산 오류는 오류 응답으로 돌려준다", () => {
    const state = new PreviewWorkerState();
    const bad = { ...input(elevation), elevation: new Float64Array(5) };
    const { response } = state.handle({ type: "preview", id: 7, input: bad });
    assert.equal(response?.type, "error");
    assert.equal(response?.id, 7);
  });
});

/** 보낸 요청을 쌓아 두고, 테스트가 원할 때 응답하는 가짜 Worker */
class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  onmessage: ((e: { data: WorkerResponse }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  postMessage(message: WorkerRequest): void { this.sent.push(message); }
  terminate(): void { this.terminated = true; }
  reply(id: number): void {
    const req = this.sent.find((r) => r.type === "preview" && r.id === id);
    assert.ok(req && req.type === "preview");
    const { world, cache } = computePreview(mesh, req.input);
    const { mesh: _m, ...rest } = world;
    this.onmessage?.({ data: { type: "preview", id, output: { world: rest, cache, natureKey: req.input.natureKey } } });
  }
  previews(): Extract<WorkerRequest, { type: "preview" }>[] {
    return this.sent.filter((r): r is Extract<WorkerRequest, { type: "preview" }> => r.type === "preview");
  }
}

describe("미리보기 요청 합치기", () => {
  const setup = () => {
    const worker = new FakeWorker();
    const results: string[] = [];
    const fallbacks: boolean[] = [];
    const client = new PreviewClient(worker, {
      result: (o) => results.push(o.natureKey),
      error: () => results.push("error"),
      fallback: (n) => fallbacks.push(n),
    });
    return { worker, client, results, fallbacks };
  };

  test("계산 중에 온 요청은 마지막 하나만, 응답이 온 뒤의 최신 입력으로 보낸다", () => {
    const { worker, client, results } = setup();
    let e = Float64Array.from(elevation);
    const build = () => input(e);
    assert.equal(client.request(true, build), true);
    assert.equal(worker.previews().length, 1);
    for (let k = 0; k < 5; k++) { e = Float64Array.from(e, (v, i) => (i === k ? v + 0.01 : v)); client.request(true, build); }
    assert.equal(worker.previews().length, 1, "계산 중에는 더 보내지 않는다");
    worker.reply(1);
    assert.equal(results.length, 1);
    const second = worker.previews()[1];
    assert.ok(second);
    assert.equal(second.input.natureKey, natureKey(OPTS, e), "보낼 때의 최신 고도");
    worker.reply(second.id);
    assert.equal(results.length, 2);
    assert.equal(worker.previews().length, 2, "기다리는 요청이 없으면 더 보내지 않는다");
  });

  test("cancel() 뒤에 도착한 이전 요청의 결과는 버린다", () => {
    const { worker, client, results } = setup();
    client.request(true, () => input(elevation));
    client.request(true, () => input(elevation));
    client.cancel();
    worker.reply(1);
    assert.deepEqual(results, []);
    assert.equal(worker.previews().length, 1, "취소한 대기 요청은 보내지 않는다");
    client.request(true, () => input(elevation));
    worker.reply(2);
    assert.equal(results.length, 1);
  });

  test("Worker가 죽으면 끄고, 하던 일이 있었으면 메인 계산으로 넘긴다", () => {
    const { worker, client, fallbacks } = setup();
    client.request(false, () => input(elevation, false));
    worker.onerror?.(new Error("boom"));
    assert.equal(worker.terminated, true);
    assert.equal(client.available, false);
    assert.deepEqual(fallbacks, [false]);
    assert.equal(client.request(true, () => input(elevation)), false);
  });

  test("Worker가 없으면 request()는 false", () => {
    const client = new PreviewClient(undefined, { result: () => {}, error: () => {}, fallback: () => {} });
    assert.equal(client.available, false);
    assert.equal(client.request(true, () => input(elevation)), false);
  });
});
