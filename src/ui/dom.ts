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
