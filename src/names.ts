import { pick, type Rng } from "./rng.ts";

export type NameStyle = "korean" | "western";
export type FeatureKind = "city" | "capital" | "state" | "river" | "mountain";

export interface NameContext {
  coastal?: boolean;
  river?: boolean;
  highland?: boolean;
}

// ── 한국어풍 ─────────────────────────────────────────────────────────
// 한자어 지명처럼 [앞 음절][뒤 음절]을 조합한다. 뒤 음절은 지형에 맞춰 고른다.
const KO_FIRST = [
  "가", "강", "건", "경", "계", "고", "곡", "광", "금", "기", "나", "남", "노", "단", "달", "담", "대", "덕",
  "도", "동", "두", "마", "매", "명", "모", "무", "문", "미", "백", "벽", "보", "봉", "부", "비", "사", "산",
  "삼", "상", "서", "석", "선", "설", "성", "소", "송", "수", "순", "승", "시", "신", "아", "안", "양", "여",
  "연", "영", "예", "오", "옥", "온", "완", "용", "우", "운", "원", "월", "유", "율", "은", "의", "이", "익",
  "인", "임", "자", "장", "정", "제", "조", "주", "죽", "지", "진", "창", "채", "천", "청", "초", "춘", "충",
  "칠", "태", "평", "포", "하", "학", "한", "함", "해", "향", "현", "형", "호", "홍", "화", "황", "회", "흥",
];
const KO_SECOND_CITY = ["주", "원", "안", "양", "성", "평", "곡", "릉", "읍", "촌", "덕", "계", "화", "림", "정", "창"];
const KO_SECOND_COAST = ["포", "진", "해", "도", "만", "항"];
const KO_SECOND_RIVER = ["천", "강", "나루", "수", "여울"];
const KO_SECOND_HIGH = ["산", "령", "봉", "곡", "재"];
const KO_STATE_SECOND = ["려", "라", "야", "제", "국", "한", "진", "주", "양", "연", "흥", "화", "명", "란"];
// 순우리말 이름 (가끔 섞어 쓴다)
const KO_NATIVE = [
  "가람", "누리", "미르", "아라", "마루", "여울", "너울", "노을", "하늬", "새봄", "다래", "소담", "온새",
  "별빛", "달빛", "윤슬", "물결", "바람", "구름", "솔빛", "들녘", "버들", "모래", "이슬", "한울", "새벽",
];
// 실제 주요 지명·국명과 똑같이 나오면 설정 몰입이 깨지므로 제외한다.
const KO_REAL = new Set([
  "경주", "전주", "광주", "나주", "상주", "충주", "청주", "공주", "원주", "양주", "진주", "제주", "남원",
  "수원", "안양", "평양", "한양", "강릉", "춘천", "포항", "목포", "여수", "동해", "남해", "서해", "고려",
  "신라", "가야", "백제", "조선", "대한", "한강", "금강", "부산", "대구", "인천", "울산", "안동", "영주",
  "정주", "의주", "해주", "개성", "함흥", "성주", "단양", "영양", "영천", "김천", "장성", "보성", "고성",
]);

function koreanBase(rng: Rng, kind: FeatureKind, ctx: NameContext): string {
  if (kind !== "state" && rng() < 0.15) return pick(rng, KO_NATIVE);
  const first = pick(rng, KO_FIRST);
  let pool = KO_SECOND_CITY;
  if (kind === "state") pool = KO_STATE_SECOND;
  else if (kind === "river") pool = ["", "", ...KO_FIRST]; // 강 이름은 2음절 + '강/천'
  else if (kind === "mountain") pool = KO_FIRST;
  else if (ctx.coastal && rng() < 0.6) pool = KO_SECOND_COAST;
  else if (ctx.river && rng() < 0.5) pool = KO_SECOND_RIVER;
  else if (ctx.highland && rng() < 0.5) pool = KO_SECOND_HIGH;
  const second = pick(rng, pool);
  return second === first ? first + pick(rng, KO_SECOND_CITY) : first + second;
}

function koreanName(rng: Rng, kind: FeatureKind, ctx: NameContext): string {
  const base = koreanBase(rng, kind, ctx);
  switch (kind) {
    case "state": return `${base}국`;
    case "river": return base.length >= 2 && rng() < 0.7 ? `${base}강` : `${base}천`;
    case "mountain": return `${base}${pick(rng, ["산", "산", "봉", "령"])}`;
    default: return base;
  }
}

// ── 서구 판타지풍 ────────────────────────────────────────────────────
// 직접 지은 이름들로 학습한 2차 문자 마르코프 체인. 실제 고유명사는 학습 목록에 넣지 않았다.
const WESTERN_CORPUS = [
  "aldoria", "belcaren", "corvalis", "drayholm", "elmaris", "faldren", "galvorn", "harrowmere", "istrel",
  "jorvane", "kaldris", "lormere", "maravel", "norhaven", "oskaria", "pellanor", "quenmar", "ravendell",
  "solvane", "tarnwick", "ulmara", "valcrest", "wyndmoor", "ysolde", "zaraveth", "ashford", "brindle",
  "caldmoor", "dunmere", "elderwyn", "fenhollow", "glenmarch", "highmoor", "ironvale", "kestrel", "larkspire",
  "mistral", "oakhaven", "rookmere", "silverfen", "thornwall", "umberlee", "westmarch", "aravell", "selvane",
  "morcadia", "thalassa", "virelle", "estmoor", "carrowin", "dravenna", "orrindal", "pallesk", "tavaris",
];

type Chain = Map<string, string[]>;
let westernChain: Chain | undefined;

function buildChain(corpus: readonly string[]): Chain {
  const chain: Chain = new Map();
  for (const word of corpus) {
    const w = `^^${word}$`;
    for (let i = 0; i + 2 < w.length; i++) {
      const key = w.slice(i, i + 2);
      const list = chain.get(key) ?? [];
      list.push(w[i + 2]);
      chain.set(key, list);
    }
  }
  return chain;
}

function westernBase(rng: Rng): string {
  westernChain ??= buildChain(WESTERN_CORPUS);
  for (let attempt = 0; attempt < 50; attempt++) {
    let s = "^^";
    while (s.length < 14) {
      const options = westernChain.get(s.slice(-2));
      if (!options) break;
      const c = pick(rng, options);
      if (c === "$") break;
      s += c;
    }
    const word = s.slice(2);
    // 너무 짧거나 길거나, 학습 목록과 똑같으면 다시 뽑는다.
    if (word.length >= 4 && word.length <= 10 && !WESTERN_CORPUS.includes(word)) {
      return word[0].toUpperCase() + word.slice(1);
    }
  }
  return "Nameless";
}

function westernName(rng: Rng, kind: FeatureKind): string {
  const base = westernBase(rng);
  switch (kind) {
    case "river": return `${base} River`;
    case "mountain": return `Mount ${base}`;
    default: return base;
  }
}

/** 지도 하나 안에서 이름이 겹치지 않게 관리하는 생성기 */
export class NameGenerator {
  private used = new Set<string>();
  private readonly rng: Rng;
  private readonly style: NameStyle;

  constructor(rng: Rng, style: NameStyle) {
    this.rng = rng;
    this.style = style;
  }

  /** 이미 쓰인 이름(이전 지도에서 물려받은 이름 등)을 등록해 새 이름과 겹치지 않게 한다. */
  reserve(name: string): void {
    this.used.add(name);
  }

  next(kind: FeatureKind, ctx: NameContext = {}): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const name = this.style === "korean" ? koreanName(this.rng, kind, ctx) : westernName(this.rng, kind);
      const core = this.style === "korean" ? name.replace(/(국|강|천|산|봉|령)$/, "") : name;
      if (this.used.has(name) || (this.style === "korean" && KO_REAL.has(core))) continue;
      this.used.add(name);
      return name;
    }
    // 이름 공간이 바닥나는 경우는 사실상 없지만, 무한 루프 대신 번호를 붙인다.
    const fallback = `${kind}-${this.used.size + 1}`;
    this.used.add(fallback);
    return fallback;
  }
}

export const KOREAN_REAL_NAMES: ReadonlySet<string> = KO_REAL;
