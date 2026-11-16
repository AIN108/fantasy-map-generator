/** 지도 데이터와 무관한 장소 검색. 원본 순서와 객체는 바꾸지 않는다. */
export interface SearchPlace {
  key: string;
  category: string;
  name: string;
  detail: string;
  keywords?: string;
  number?: number;
}

const normalize = (s: string): string => s.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();

export function searchPlaces<T extends SearchPlace>(places: readonly T[], query: string, category = "all"): T[] {
  const q = normalize(query);
  const words = q.split(" ").filter(Boolean);
  // 번호(number)가 있는 장소는 "1"로 10·11번까지 찾지 않고 정확히 일치시킨다.
  // 이 앱의 장소(places.ts)에는 번호가 없어 지금은 쓰이지 않는다 (번호가 없으면 아래 낱말 검색으로 넘어간다).
  const numbered = /^(\d+)(?:번)?$/.exec(q);
  const byNumber = numbered && places.some((p) => p.number !== undefined && (category === "all" || p.category === category)) ? Number(numbered[1]) : undefined;
  return places.filter((p) => {
    if (category !== "all" && p.category !== category) return false;
    if (byNumber !== undefined) return p.number === byNumber;
    const text = normalize(`${p.name} ${p.detail} ${p.keywords ?? ""}`);
    return words.every((word) => text.includes(word));
  }).sort((a, b) => rank(a.name, q) - rank(b.name, q));
}

function rank(name: string, query: string): number {
  const n = normalize(name);
  return !query || n === query ? 0 : n.startsWith(query) ? 1 : n.includes(query) ? 2 : 3;
}
