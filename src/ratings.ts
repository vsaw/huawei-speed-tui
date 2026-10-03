// Human-readable ratings for signal measurements. Each scale lists its bands best first;
// a value gets the first band whose `min` it reaches. Thresholds follow the usual rules
// of thumb for Wi-Fi and LTE.

export type Rating = 'Excellent' | 'Good' | 'Fair' | 'Weak' | 'Poor';

export interface Band {
  min: number;
  label: Rating;
}

// Wi-Fi RSSI (dBm): above -50 is as good as it gets, below -80 connections drop and crawl.
export const WIFI_RSSI_BANDS: readonly Band[] = [
  { min: -50, label: 'Excellent' },
  { min: -60, label: 'Good' },
  { min: -70, label: 'Fair' },
  { min: -80, label: 'Weak' },
  { min: -Infinity, label: 'Poor' },
];

// Wi-Fi signal-to-noise ratio (dB): above 40 dB the link runs at full speed; below 15 dB
// rates drop sharply, and below 10 dB the connection barely works.
export const WIFI_SNR_BANDS: readonly Band[] = [
  { min: 40, label: 'Excellent' },
  { min: 25, label: 'Good' },
  { min: 15, label: 'Fair' },
  { min: 10, label: 'Weak' },
  { min: -Infinity, label: 'Poor' },
];

// LTE RSRP (dBm): reference signal power, the main LTE "signal strength" figure.
export const LTE_RSRP_BANDS: readonly Band[] = [
  { min: -80, label: 'Excellent' },
  { min: -90, label: 'Good' },
  { min: -100, label: 'Fair' },
  { min: -110, label: 'Weak' },
  { min: -Infinity, label: 'Poor' },
];

// LTE RSRQ (dB): signal quality including load and interference from other cells.
export const LTE_RSRQ_BANDS: readonly Band[] = [
  { min: -10, label: 'Excellent' },
  { min: -15, label: 'Good' },
  { min: -20, label: 'Fair' },
  { min: -Infinity, label: 'Poor' },
];

// LTE SINR (dB): signal vs. interference + noise; the main limit on speed.
export const LTE_SINR_BANDS: readonly Band[] = [
  { min: 20, label: 'Excellent' },
  { min: 13, label: 'Good' },
  { min: 0, label: 'Fair' },
  { min: -Infinity, label: 'Poor' },
];

// 0 (Poor) … 4 (Excellent), so scales with fewer bands still map to the same colours.
const LEVELS: Record<Rating, number> = { Poor: 0, Weak: 1, Fair: 2, Good: 3, Excellent: 4 };

export function rate(bands: readonly Band[], value: number): { label: Rating; level: number } {
  const band = bands.find((b) => value >= b.min) ?? bands[bands.length - 1];
  return { label: band.label, level: LEVELS[band.label] };
}
