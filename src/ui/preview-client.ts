import type { PreviewInput, PreviewOutput, WorkerRequest, WorkerResponse } from "../preview.ts";
import type { WorldOptions } from "../world.ts";

/** Worker와 같은 모양 (테스트에서는 가짜를 넘긴다) */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  onmessage: ((e: { data: WorkerResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

export interface PreviewClientHooks {
  /** 미리보기 결과가 왔다 (취소되지 않은 최신 요청의 결과만) */
  result(output: PreviewOutput): void;
  /** 계산 중 오류 (예: 잘못된 입력). Worker는 계속 쓴다. */
  error(message: string): void;
  /** Worker가 죽었다. 이후 request()는 false를 돌려주니 메인 스레드에서 계산해야 한다. */
  fallback(natureOnly: boolean): void;
}

/**
 * 칠하기 미리보기를 Worker에 맡긴다. 한 번에 하나만 계산시키고, 그동안 들어온 요청은 마지막 것 하나로 합친다:
 * 결과가 오면 그때의 최신 상태로 다음 요청을 보내므로, 붓질이 빨라도 계산이 밀리지 않는다.
 */
export class PreviewClient {
  private worker: WorkerLike | undefined;
  private readonly hooks: PreviewClientHooks;
  private nextId = 1;
  /** 계산 중인 요청 id (없으면 0) */
  private inFlight = 0;
  private inFlightNatureOnly = true;
  /** 계산 중에 들어온 최신 요청. 보낼 때 입력을 만든다 (그 사이 바뀐 지형까지 반영되게). */
  private pending: { natureOnly: boolean; build: () => PreviewInput } | null = null;
  /** cancel() 이전에 보낸 요청의 결과는 버린다 */
  private validFrom = 1;

  constructor(worker: WorkerLike | undefined, hooks: PreviewClientHooks) {
    this.hooks = hooks;
    this.worker = worker;
    if (!worker) return;
    worker.onmessage = (e) => this.onMessage(e.data);
    worker.onerror = () => this.disable();
  }

  get available(): boolean { return !!this.worker; }

  /** 메시를 미리 만들어 두게 한다 (첫 붓질이 기다리지 않도록). */
  warm(options: WorldOptions): void {
    this.worker?.postMessage({ type: "mesh", options }, []);
  }

  /** 미리보기를 요청한다. Worker를 쓸 수 없으면 false (호출한 쪽이 직접 계산한다). */
  request(natureOnly: boolean, build: () => PreviewInput): boolean {
    if (!this.worker) return false;
    if (this.inFlight) {
      this.pending = { natureOnly, build };
      return true;
    }
    this.send(natureOnly, build);
    return true;
  }

  /** 지금까지의 요청을 버린다 (붓질을 마치고 최종 계산을 했거나, 지도가 바뀌었을 때). */
  cancel(): void {
    this.validFrom = this.nextId;
    this.pending = null;
  }

  private send(natureOnly: boolean, build: () => PreviewInput): void {
    const input = build();
    const id = this.nextId++;
    this.inFlight = id;
    this.inFlightNatureOnly = natureOnly;
    // 고도는 보낼 때마다 새로 복사한 배열이라 복사 없이 넘긴다.
    this.worker!.postMessage({ type: "preview", id, input }, [input.elevation.buffer as ArrayBuffer]);
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.id !== this.inFlight) return; // 이전 Worker 세대의 늦은 응답
    this.inFlight = 0;
    const current = msg.id >= this.validFrom;
    // 다음 계산을 먼저 시작시켜 두고(Worker가 계산하는 동안 메인은 그린다) 결과를 쓴다.
    const next = this.pending;
    this.pending = null;
    if (next) this.send(next.natureOnly, next.build);
    if (!current) return;
    if (msg.type === "error") this.hooks.error(msg.message);
    else this.hooks.result(msg.output);
  }

  private disable(): void {
    const natureOnly = this.pending?.natureOnly ?? this.inFlightNatureOnly;
    const hadWork = !!this.inFlight || !!this.pending;
    this.worker?.terminate();
    this.worker = undefined;
    this.inFlight = 0;
    this.pending = null;
    if (hadWork) this.hooks.fallback(natureOnly);
  }
}
