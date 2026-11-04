import { PreviewWorkerState, type WorkerRequest, type WorkerResponse } from "./preview.ts";

// 칠하기 미리보기 계산 전용 Worker. 계산은 preview.ts에 있고, 여기서는 메시지만 잇는다.
// (tsconfig가 DOM 타입을 쓰므로 webworker 타입 대신 필요한 모양만 적는다: 두 lib는 함께 쓸 수 없다.)
interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
}

const state = new PreviewWorkerState();
const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const { response, transfer } = state.handle(e.data);
  if (response) scope.postMessage(response, transfer);
};
