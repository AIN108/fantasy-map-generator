// 내보내기·불러오기 단추: PNG 저장, JSON 저장·불러오기, 링크 복사 (main.ts에서 옮김)

import type { CivState } from "../civedit.ts";
import { isEmptyInfra, type Infra } from "../infra.ts";
import { isEmptyResourceEdits, type ResourceEdits } from "../resources.ts";
import { canShare, encodeShare, MAX_SHARE_CHARS, type SharedMap } from "../share.ts";
import { parseMapJSONText, toJSON, type WorldMap, type WorldOptions } from "../world.ts";
import { $ } from "./dom.ts";
import { formatHash } from "./options.ts";
import { eul } from "./text.ts";

export interface ExportHost {
  world(): WorldMap | undefined;
  options(): WorldOptions;
  /** 시드로 만든 원래 지형 (편집 링크는 이것과의 차이를 담는다) */
  baseElevation(): Float64Array | undefined;
  civ(): CivState | undefined;
  infra(): Infra;
  resourceEdits(): ResourceEdits;
  /** 지형을 편집했는가 */
  edited(): boolean;
  /** 지형·문명·시설·자원 중 하나라도 편집했는가 */
  hasEdits(): boolean;
  /** 확대와 상관없이 지도 전체를 원래 크기로 그린 캔버스 */
  exportCanvas(): HTMLCanvasElement;
  /** 읽어 검증한 지도로 바꾼다. 만들었으면 true */
  openLoadedMap(map: SharedMap): boolean;
  status(text: string, isError?: boolean): void;
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeFileName = (s: string): string => s.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "map";
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export function createExportPanel(host: ExportHost): void {
  async function importFile(file: File): Promise<void> {
    if (file.size > MAX_IMPORT_BYTES) throw new Error("파일이 너무 큽니다 (20MB 이하만 불러올 수 있습니다).");
    const parsed = parseMapJSONText(await file.text());
    // 아래에서 편집 상태를 비우므로 generate()의 확인이 뜨지 않는다. 비우기 전에 여기서 묻는다.
    if (host.hasEdits() && !confirm(`${file.name}${eul(file.name)} 불러오면 지금 편집한 지형·도시·국경·시설·자원이 사라집니다. 계속할까요?\n(필요하면 먼저 'JSON 저장'으로 보관하세요.)`)) {
      host.status("불러오기를 취소했습니다.");
      return;
    }
    host.openLoadedMap(parsed);
    const extras = [
      host.edited() ? "편집된 지형" : "", host.civ() ? "직접 편집한 도시·국경" : "", isEmptyInfra(host.infra()) ? "" : "도로·철도·시설",
      isEmptyResourceEdits(host.resourceEdits()) ? "" : "직접 편집한 자원",
    ].filter(Boolean).join(", ");
    host.status(`${file.name}${eul(file.name)} 불러왔습니다.${extras ? ` (${extras} 포함)` : ""}`);
  }

  $("exportPng").addEventListener("click", () => {
    if (!host.world()) return;
    // 확대해서 보고 있어도 지도 전체를 원래 크기로 저장한다.
    host.exportCanvas().toBlob((blob) => blob && download(`${safeFileName(host.options().seed)}.png`, blob), "image/png");
  });
  $("exportJson").addEventListener("click", () => {
    const world = host.world();
    if (!world) return;
    const suffix = host.hasEdits() ? "_편집" : "";
    download(`${safeFileName(host.options().seed)}${suffix}.json`, new Blob([JSON.stringify(toJSON(world, host.civ(), host.infra(), host.resourceEdits()))], { type: "application/json" }));
  });
  $("importJson").addEventListener("click", () => $<HTMLInputElement>("importFile").click());
  $<HTMLInputElement>("importFile").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) importFile(file).catch((err) => host.status(err instanceof Error ? err.message : String(err), true));
  });
  $("copyLink").addEventListener("click", async () => {
    let link = location.href;
    let note = "현재 지도 링크를 복사했습니다.";
    const world = host.world(), baseElevation = host.baseElevation();
    if (host.hasEdits() && world && baseElevation) {
      // 편집한 지도는 바뀐 고도·지명·문명·시설·자원을 줄여 링크 끝(&e=…)에 담는다.
      if (!canShare()) {
        note = "링크를 복사했습니다. 이 브라우저는 편집 내용을 링크에 담을 수 없으니 함께 보내려면 'JSON 저장'을 쓰세요.";
      } else {
        let data: string;
        try {
          data = await encodeShare(world, baseElevation, host.civ(), host.infra(), host.resourceEdits());
        } catch (err) {
          host.status(`편집한 지도를 링크로 만들지 못했습니다 (${err instanceof Error ? err.message : String(err)}). 'JSON 저장'을 쓰세요.`, true);
          return;
        }
        if (data.length > MAX_SHARE_CHARS) {
          note = `편집 내용이 너무 많아(${data.length.toLocaleString("ko-KR")}자) 링크에 담지 못하고 옵션만 담았습니다. 함께 보내려면 'JSON 저장'을 쓰세요.`;
        } else {
          link = `${location.href.split("#")[0]}${formatHash(host.options())}&e=${data}`;
          note = `편집한 지형·지명·도시·국경·시설·자원까지 담은 링크를 복사했습니다 (${link.length.toLocaleString("ko-KR")}자).`
            + (link.length > 8000 ? " 일부 메신저에서는 긴 링크가 잘릴 수 있습니다." : "");
        }
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      host.status(note);
    } catch {
      host.status("클립보드에 접근할 수 없습니다. 주소창의 링크를 직접 복사하세요.", true);
    }
  });
}
