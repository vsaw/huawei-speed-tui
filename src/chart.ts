// Braille area chart: every terminal cell holds a 2×4 grid of dots, so a chart
// `cols` cells wide and `rows` cells tall has cols*2 data columns and rows*4 levels.

// Dot bit for [x][y] within a cell, y counted from the top.
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

export interface Sample {
  t: number; // ms epoch
  down: number; // bytes/s
  up: number;
}

/**
 * Resample time series into `n` evenly spaced buckets covering the window ending at `end`.
 * Bucket boundaries are aligned to multiples of the bucket width (not to `end`), so a
 * sample stays in the same bucket across redraws and only the newest bucket changes;
 * otherwise averaged history jitters as the boundaries slide. Buckets with samples get
 * their average; empty buckets repeat the previous value (the router only refreshes its
 * rate every second or two). Buckets before the first sample, or after a polling gap
 * of more than `gapMs`, are null.
 */
export function resample<T extends { t: number }>(
  samples: T[],
  value: (s: T) => number,
  n: number,
  end: number,
  windowMs: number,
  gapMs: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(n).fill(null);
  const step = windowMs / n;
  // The last bucket is the one containing `end`.
  const start = (Math.floor(end / step) - n + 1) * step;
  let i = 0;
  let last: T | undefined;
  for (let b = 0; b < n; b++) {
    const bucketEnd = start + (b + 1) * step;
    let sum = 0;
    let count = 0;
    while (i < samples.length && samples[i].t < bucketEnd) {
      if (samples[i].t >= bucketEnd - step) {
        sum += value(samples[i]);
        count++;
      }
      last = samples[i];
      i++;
    }
    if (count > 0) out[b] = sum / count;
    else if (last && bucketEnd - last.t <= gapMs) out[b] = value(last);
  }
  return out;
}

/** Render values (length cols*2) as `rows` lines of braille characters, filled from the bottom. */
export function renderArea(values: (number | null)[], cols: number, rows: number, max: number): string[] {
  const levels = rows * 4;
  const grid: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let x = 0; x < cols * 2; x++) {
    const v = values[x];
    if (v == null) continue;
    let h = Math.round((v / max) * levels);
    if (v > 0 && h === 0) h = 1;
    h = Math.min(h, levels);
    for (let level = 0; level < h; level++) {
      const yFromTop = levels - 1 - level;
      grid[Math.floor(yFromTop / 4)][Math.floor(x / 2)] |= DOT[x % 2][yFromTop % 4];
    }
  }
  return grid.map((row) => row.map((bits) => (bits ? String.fromCharCode(0x2800 + bits) : ' ')).join(''));
}
