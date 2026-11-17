// 편집 편의 단축키: [ ] 브러시 크기, 1~4 지형 도구, ? 단축키 목록과 그 창의 열기·닫기 단추 (main.ts에서 옮김)

import { BRUSH_TOOLS, type BrushTool } from "../editor.ts";
import { $, isTypingTarget } from "./dom.ts";
import { stepValue } from "./gestures.ts";
import type { EditTarget } from "./tool-hints.ts";

export interface ShortcutHost {
  editMode(): boolean;
  editTarget(): EditTarget;
  /** 브러시 크기 입력칸 (값을 바꾼 뒤 syncBrush로 반영한다) */
  brushSize: HTMLInputElement;
  syncBrush(): void;
  setTool(tool: BrushTool): void;
  status(text: string): void;
}

const TERRAIN_KEYS: BrushTool[] = ["raise", "lower", "flatten", "smooth"];

export function installShortcutKeys(host: ShortcutHost): void {
  const { brushSize } = host;
  // 글자 칸·목록에서는 쓰지 않는다
  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (isTypingTarget(target) || target?.tagName === "SELECT" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "?") {
      e.preventDefault();
      const help = $<HTMLDialogElement>("shortcutHelp");
      if (!help.open) help.showModal();
      return;
    }
    if (!host.editMode()) return;
    const editTarget = host.editTarget();
    if ((e.key === "[" || e.key === "]") && (editTarget === "terrain" || editTarget === "border")) {
      e.preventDefault();
      brushSize.value = String(stepValue(Number(brushSize.value), e.key === "]" ? 1 : -1, Number(brushSize.min), Number(brushSize.max), Number(brushSize.step)));
      host.syncBrush();
      return;
    }
    const n = TERRAIN_KEYS[Number(e.key) - 1];
    if (editTarget === "terrain" && /^[1-4]$/.test(e.key) && n) {
      e.preventDefault();
      host.setTool(n);
      host.status(`지형 도구: ${BRUSH_TOOLS[n].ko}`);
    }
  });
  $("shortcutHelpOpen").addEventListener("click", () => $<HTMLDialogElement>("shortcutHelp").showModal());
  $("shortcutHelpClose").addEventListener("click", () => $<HTMLDialogElement>("shortcutHelp").close());
}
