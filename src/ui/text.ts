/**
 * 목적격 조사: 마지막 글자에 받침이 있으면 '을', 없으면 '를'. 한글로 끝나지 않으면(서구풍 지명 등) '을(를)'.
 * "항구 '하늬항'"처럼 따옴표·괄호·공백으로 끝나면 그 앞 글자로 판단한다.
 */
export function eul(word: string): string {
  const w = word.replace(/['"’)\s]+$/u, "");
  const code = w.charCodeAt(w.length - 1) - 0xac00;
  if (!(code >= 0 && code <= 11171)) return "을(를)";
  return code % 28 === 0 ? "를" : "을";
}
