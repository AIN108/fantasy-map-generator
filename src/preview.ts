import type { LinkGraph } from "./civ.ts";
import type { CivState } from "./civedit.ts";
import type { Infra } from "./infra.ts";
import type { Mesh } from "./mesh.ts";
import { buildRenderCache, type RenderCache } from "./render.ts";
import type { ResourceEdits } from "./resources.ts";
import {
  applyInfra, applyResources, createMesh, deriveWorld, meshKey, natureOf, type NameAnchors, type Nature, type WorldMap, type WorldOptions,
} from "./world.ts";

/**
 * 칠하는 동안의 미리보기 계산 (기후·강·생태, 국경 칠하기면 문명까지 + 그리기 캐시).
 * Web Worker에서 돌려 메인 스레드는 그리기만 하게 한다. Worker를 쓸 수 없으면 같은 함수를 메인에서 부른다.
 */

/** 지도 데이터에서 메시를 뺀 것 (메시는 양쪽이 같은 옵션으로 각자 만든다: 크고 바뀌지 않으므로 보내지 않는다) */
export type WorldWithoutMesh = Omit<WorldMap, "mesh">;

export interface PreviewInput {
  options: WorldOptions;
  elevation: Float64Array;
  /** true: 지형만 (지형 붓), false: 문명까지 (국경 붓) */
  natureOnly: boolean;
  prior?: NameAnchors;
  civ?: CivState;
  links?: LinkGraph;
  infra: Infra;
  /** 직접 편집한 자원 */
  resources: ResourceEdits;
  /** natureKey(options, elevation): 같은 고도면 자연 계산을 다시 쓴다 (국경 칠하기는 고도가 그대로다) */
  natureKey: string;
}

export interface PreviewOutput { world: WorldWithoutMesh; cache: RenderCache; natureKey: string }

/** main.ts의 derive()와 같은 계산 (이름 기억·자동 도로 갱신 같은 부수 효과는 없다) */
export function computePreview(mesh: Mesh, input: PreviewInput, nature?: Nature): { world: WorldMap; cache: RenderCache } {
  const { options, elevation, natureOnly, prior, civ, links, infra, resources } = input;
  const world = applyResources(applyInfra(deriveWorld(options, mesh, elevation, natureOnly, prior, civ, links, nature), infra), resources);
  return { world, cache: buildRenderCache(world) };
}

export type WorkerRequest =
  | { type: "mesh"; options: WorldOptions }
  | { type: "preview"; id: number; input: PreviewInput };

export type WorkerResponse =
  | { type: "preview"; id: number; output: PreviewOutput }
  | { type: "error"; id: number; message: string };

/** Worker 쪽 상태: 마지막으로 만든 메시(메시 옵션이 같으면 재사용)와 마지막 자연 계산 */
export class PreviewWorkerState {
  private mesh: Mesh | undefined;
  private key = "";
  private nature: { key: string; value: Nature } | undefined;

  meshFor(options: WorldOptions): Mesh {
    const key = meshKey(options);
    if (!this.mesh || key !== this.key) {
      this.mesh = createMesh(options);
      this.key = key;
    }
    return this.mesh;
  }

  /** 요청 하나를 처리한다. 결과와 함께 옮길(복사하지 않을) 버퍼 목록을 돌려준다. */
  handle(req: WorkerRequest): { response?: WorkerResponse; transfer: ArrayBuffer[] } {
    if (req.type === "mesh") {
      this.meshFor(req.options);
      return { transfer: [] };
    }
    try {
      const { input } = req;
      const reuse = this.nature?.key === input.natureKey ? this.nature.value : undefined;
      const { world, cache } = computePreview(this.meshFor(input.options), input, reuse);
      this.nature = { key: input.natureKey, value: natureOf(world) };
      const { mesh: _mesh, ...rest } = world;
      // 고도는 요청마다 새로 받은 배열이라 복사 없이 돌려준다. 자연 배열은 다음 계산에 다시 쓰므로 복사해 보낸다.
      const transfer = rest.elevation.buffer instanceof ArrayBuffer ? [rest.elevation.buffer] : [];
      return { response: { type: "preview", id: req.id, output: { world: rest, cache, natureKey: input.natureKey } }, transfer };
    } catch (err) {
      return { response: { type: "error", id: req.id, message: err instanceof Error ? err.message : String(err) }, transfer: [] };
    }
  }
}
