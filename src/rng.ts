// 시드 기반 난수와 노이즈. 같은 시드 → 같은 지도를 보장하기 위해 Math.random을 쓰지 않는다.

export type Rng = () => number;

/** 문자열 시드를 32비트 상태값 4개로 섞는다 (xmur3). */
function hashSeed(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** sfc32: 빠르고 주기가 긴 32비트 PRNG. [0, 1) 실수를 반환한다. */
export function createRng(seed: string): Rng {
  const next = hashSeed(seed);
  let a = next(), b = next(), c = next(), d = next();
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** 단계별로 독립적인 난수열을 쓰기 위한 하위 RNG (예: 지형을 바꿔도 지명은 그대로 유지). */
export function subRng(seed: string, stage: string): Rng {
  return createRng(`${seed}::${stage}`);
}

export const randRange = (rng: Rng, min: number, max: number): number => min + rng() * (max - min);
export const randInt = (rng: Rng, min: number, maxExclusive: number): number =>
  Math.floor(randRange(rng, min, maxExclusive));
export const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

/** 2D 심플렉스 노이즈. 순열 테이블을 시드 RNG로 섞어 시드마다 다른 지형을 만든다. */
export function createNoise2D(rng: Rng): (x: number, y: number) => number {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const grad = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;

  return (xin: number, yin: number): number => {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;

    const corner = (gi: number, x: number, y: number): number => {
      const tt = 0.5 - x * x - y * y;
      if (tt < 0) return 0;
      const g = grad[gi % 8];
      return tt * tt * tt * tt * (g[0] * x + g[1] * y);
    };
    const n0 = corner(perm[ii + perm[jj]], x0, y0);
    const n1 = corner(perm[ii + i1 + perm[jj + j1]], x1, y1);
    const n2 = corner(perm[ii + 1 + perm[jj + 1]], x2, y2);
    return 70 * (n0 + n1 + n2); // 대략 [-1, 1]
  };
}

/** 여러 옥타브를 겹친 fBm 노이즈, [-1, 1] 근처 값. */
export function fbm(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number,
  persistence = 0.5,
  lacunarity = 2,
): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * 셀 번호만으로 정해지는 [0, 1) 난수. 순서대로 꺼내 쓰는 RNG와 달리, 일부 셀이 바뀌어도
 * 다른 셀의 값이 밀리지 않는다 (지형 편집 후 먼 곳의 도시가 움직이지 않게 하는 용도).
 */
export function cellHash(seed: string, stage: string): (i: number) => number {
  const base = createRng(`${seed}::${stage}`)();
  const salt = Math.floor(base * 4294967296) >>> 0;
  return (i: number): number => {
    // splitmix32
    let z = (salt + Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}
