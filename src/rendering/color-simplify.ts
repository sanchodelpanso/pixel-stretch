/**
 * Reduce a sampled row of colours to `count` solid stripes.
 *
 * Neighbouring columns are merged bottom-up, always joining the adjacent pair
 * whose merge adds the least colour variance (Ward's criterion), so similar
 * runs fold together first and strong edges survive longest. Each stripe is
 * then filled with its average colour. Colours are compared premultiplied by
 * alpha, so transparent gaps stay their own stripes instead of dragging
 * neighbouring colours towards black.
 *
 * With `blend`, each border between stripes becomes a linear gradient about
 * that many columns wide, narrowed where a stripe is too thin to give up that
 * much of itself.
 *
 * `row` is straight-alpha RGBA, `columns` wide. Returns a new row, or the same
 * one when there is nothing to merge.
 */
export function simplifyRow(
  row: Uint8ClampedArray,
  columns: number,
  count: number,
  blend = 0,
): Uint8ClampedArray {
  const target = Math.max(1, Math.round(count));
  if (!(target < columns)) return row;

  const size = new Float64Array(columns).fill(1);
  const red = new Float64Array(columns);
  const green = new Float64Array(columns);
  const blue = new Float64Array(columns);
  const alpha = new Float64Array(columns);
  const next = new Int32Array(columns);
  const previous = new Int32Array(columns);
  const version = new Int32Array(columns);
  const alive = new Uint8Array(columns).fill(1);

  for (let i = 0; i < columns; i++) {
    const a = row[i * 4 + 3] / 255;
    red[i] = row[i * 4] * a;
    green[i] = row[i * 4 + 1] * a;
    blue[i] = row[i * 4 + 2] * a;
    alpha[i] = a * 255;
    next[i] = i + 1 < columns ? i + 1 : -1;
    previous[i] = i - 1;
  }

  /** Variance added by merging segment `left` with the one after it. */
  const mergeCost = (left: number, right: number): number => {
    const nl = size[left];
    const nr = size[right];
    const dr = red[left] / nl - red[right] / nr;
    const dg = green[left] / nl - green[right] / nr;
    const db = blue[left] / nl - blue[right] / nr;
    const da = alpha[left] / nl - alpha[right] / nr;
    return ((nl * nr) / (nl + nr)) * (dr * dr + dg * dg + db * db + da * da);
  };

  const heap = new MergeHeap();
  const offer = (left: number) => {
    const right = next[left];
    if (left < 0 || right < 0) return;
    heap.push({ cost: mergeCost(left, right), left, right, leftVersion: version[left], rightVersion: version[right] });
  };
  for (let i = 0; i < columns - 1; i++) offer(i);

  let segments = columns;
  while (segments > target && heap.size > 0) {
    const { left, right, leftVersion, rightVersion } = heap.pop();
    // Skip pairs a previous merge has already changed.
    if (!alive[left] || !alive[right] || next[left] !== right) continue;
    if (version[left] !== leftVersion || version[right] !== rightVersion) continue;

    size[left] += size[right];
    red[left] += red[right];
    green[left] += green[right];
    blue[left] += blue[right];
    alpha[left] += alpha[right];
    version[left]++;
    alive[right] = 0;
    next[left] = next[right];
    if (next[right] >= 0) previous[next[right]] = left;
    segments--;

    offer(previous[left]);
    offer(left);
  }

  const out = new Uint8ClampedArray(row.length);
  /** Write a premultiplied mix of two stripes' average colours into column `i`. */
  const paint = (i: number, from: number, to: number, t: number) => {
    const mix = (values: Float64Array) => (values[from] / size[from]) * (1 - t) + (values[to] / size[to]) * t;
    const a = mix(alpha);
    const weight = a > 0 ? 255 / a : 0;
    out[i * 4] = mix(red) * weight;
    out[i * 4 + 1] = mix(green) * weight;
    out[i * 4 + 2] = mix(blue) * weight;
    out[i * 4 + 3] = a;
  };

  for (let head = 0; head >= 0; head = next[head]) {
    for (let i = head; i < head + size[head]; i++) paint(i, head, head, 0);
  }

  if (blend > 0) {
    for (let head = 0; next[head] >= 0; head = next[head]) {
      const right = next[head];
      // Half the gradient on each side, never more than half of either stripe,
      // so neighbouring borders can't overlap.
      const half = Math.min(blend / 2, size[head] / 2, size[right] / 2);
      const border = right;
      for (let i = Math.ceil(border - half - 0.5); i < border + half - 0.5; i++) {
        const t = (i + 0.5 - (border - half)) / (2 * half);
        paint(i, head, right, Math.max(0, Math.min(1, t)));
      }
    }
  }
  return out;
}

interface MergeCandidate {
  cost: number;
  left: number;
  right: number;
  leftVersion: number;
  rightVersion: number;
}

/** Binary min-heap of merge candidates, cheapest first. */
class MergeHeap {
  private items: MergeCandidate[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: MergeCandidate): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].cost <= item.cost) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = item;
  }

  pop(): MergeCandidate {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= items.length) break;
        const right = left + 1;
        const child = right < items.length && items[right].cost < items[left].cost ? right : left;
        if (items[child].cost >= last.cost) break;
        items[i] = items[child];
        i = child;
      }
      items[i] = last;
    }
    return top;
  }
}
