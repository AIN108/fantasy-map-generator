/** 우선순위(작을수록 먼저)와 정수 값을 담는 이진 최소 힙. Dijkstra·A*·priority-flood에서 공용. */
export class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    const keys = this.keys, values = this.values;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  /** 가장 작은 key의 [key, value]를 꺼낸다. 비어 있으면 undefined. */
  pop(): [number, number] | undefined {
    const keys = this.keys, values = this.values;
    if (keys.length === 0) return undefined;
    const topKey = keys[0], topValue = values[0];
    const lastKey = keys.pop()!, lastValue = values.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        keys[i] = keys[c];
        values[i] = values[c];
        i = c;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return [topKey, topValue];
  }
}
