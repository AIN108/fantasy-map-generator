/**
 * 글자를 입력하는 중인 요소인지 (단축키를 처리하지 않을 곳).
 * 숫자 입력칸도 포함한다: 매장량에 "0"을 치다가 보기가 맞춤으로 돌아가거나 "e"로 편집 모드가 꺼지면 안 된다.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
  if (target.tagName !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return type === "text" || type === "number" || type === "search";
}

export type EditShortcut = "undo" | "redo" | "toggleEdit";

/**
 * 편집 단축키 (Ctrl/⌘+Z 되돌리기, Ctrl/⌘+Shift+Z·Ctrl/⌘+Y 다시 하기, E 편집 모드).
 * 목록(select)에 포커스가 있으면 E는 목록의 글자 찾기에 쓰이므로 편집 모드를 바꾸지 않는다 (확대 키와 같은 기준).
 */
export function editShortcut(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey">, onSelect: boolean,
): EditShortcut | undefined {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === "z") return e.shiftKey ? "redo" : "undo";
  if (mod && key === "y") return "redo";
  if (!mod && key === "e" && !onSelect) return "toggleEdit";
  return undefined;
}
