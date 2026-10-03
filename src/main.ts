import { parseArgs } from 'node:util';
import { HuaweiClient, type MobileSignal, type Status, type Traffic, type WifiHost } from './api.ts';
import { renderArea, resample, type Sample } from './chart.ts';
import { formatBytes, formatDuration, formatRate, niceCeil } from './format.ts';
import {
  LTE_RSRP_BANDS,
  LTE_RSRQ_BANDS,
  LTE_SINR_BANDS,
  WIFI_RSSI_BANDS,
  WIFI_SNR_BANDS,
  rate,
  type Band,
} from './ratings.ts';
import { WifiMonitor } from './wifi.ts';

const HELP = `huawei-speed-tui — live upload/download charts for Huawei mobile WiFi

Usage: npm start -- [options]

Options:
  --host <url>          Router address (default: http://192.168.8.1)
  --interval <seconds>  Polling interval (default: 1)
  --window <seconds>    Initial chart time window (default: 60)
  --snapshot <seconds>  Collect for N seconds, print one frame and exit
  --user <name>         Router admin user (default: admin)
  --password <pw>       Router admin password, needed for the device list
                        (or set HUAWEI_PASSWORD; defaults to the built-in password)
  -h, --help            Show this help

The Wi-Fi signal panel (this Mac's link to the router) needs macOS and swiftc;
its helper is compiled into .cache/ on first run.

Keys: q quit · p pause · w cycle time window · s toggle shared scale`;

const WINDOWS = [60, 300, 900, 3600];
const STATUS_EVERY_MS = 10_000;
const HOSTS_EVERY_MS = 5_000;
const MOBILE_EVERY_MS = 2_000;
const DEFAULT_PASSWORD = 'REDACTED';

const { values: args } = parseArgs({
  options: {
    host: { type: 'string', default: 'http://192.168.8.1' },
    interval: { type: 'string', default: '1' },
    window: { type: 'string', default: '60' },
    snapshot: { type: 'string' },
    user: { type: 'string', default: 'admin' },
    password: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const host = /^https?:\/\//.test(args.host) ? args.host : `http://${args.host}`;
const intervalMs = Math.max(250, Number(args.interval) * 1000 || 1000);
const client = new HuaweiClient(host, {
  username: args.user,
  password: args.password ?? process.env.HUAWEI_PASSWORD ?? DEFAULT_PASSWORD,
});

// ---- state ----------------------------------------------------------------

const samples: Sample[] = [];
let windowSec = Number(args.window) || 60;
let paused = false;
let pausedAt = 0;
let sharedScale = false;
let traffic: Traffic | undefined;
let status: Status | undefined;
let carrier = '';
let device = '';
let lastError = '';
let lastOk = 0;
let hosts: WifiHost[] | undefined;
let hostsError = '';
let mobile: MobileSignal | undefined;
let mobileAt = 0;
let mobileError = '';
const mobileSamples: { t: number; rsrp: number }[] = [];
const wifi = new WifiMonitor(new URL(host).hostname, intervalMs, (Math.max(...WINDOWS, windowSec) + 60) * 1000);

// ---- ANSI helpers ---------------------------------------------------------

const ESC = '\x1b[';
const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  down: `${ESC}36m`, // cyan
  up: `${ESC}35m`, // magenta
  inverse: `${ESC}7m`,
};
// Rating colours, indexed by rate().level: Poor … Excellent.
const RATING_COLORS = [`${ESC}31m`, `${ESC}38;5;208m`, `${ESC}33m`, `${ESC}32m`, `${ESC}92m`];
const paint = (color: string, s: string) => `${color}${s}${c.reset}`;

// ---- rendering ------------------------------------------------------------

// Width of the y-axis label column, e.g. "   500Kbps ┤" or "  Excellent ┤". Shared by all
// charts so their axes line up on the same grid.
const AXIS_W = 12;

function windowStats(key: 'down' | 'up', from: number) {
  let sum = 0;
  let n = 0;
  let peak = 0;
  for (const s of samples) {
    if (s.t < from) continue;
    sum += s[key];
    n++;
    peak = Math.max(peak, s[key]);
  }
  return { avg: n ? sum / n : 0, peak };
}

function axisLabel(bytesPerSec: number): string {
  // Compact unit labels for the axis: 500K, 2M, 1.5M, 1G
  const bits = bytesPerSec * 8;
  const [v, u] = bits >= 1e9 ? [bits / 1e9, 'G'] : bits >= 1e6 ? [bits / 1e6, 'M'] : [bits / 1e3, 'K'];
  const num = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return `${num}${u}bps`;
}

function timeLabel(sec: number): string {
  if (sec === 0) return 'now';
  return sec % 60 === 0 ? `-${sec / 60}m` : `-${formatDuration(sec)}`;
}

function renderPanel(
  key: 'down' | 'up',
  title: string,
  color: string,
  width: number,
  height: number,
  end: number,
  scaleMax: number,
): string[] {
  const cols = Math.max(1, width - AXIS_W);
  const windowMs = windowSec * 1000;
  const values = resample(samples, (s) => s[key], cols * 2, end, windowMs, intervalMs * 3 + 1000);
  const chart = renderArea(values, cols, height, scaleMax);

  const latest = samples.at(-1);
  const current = latest && end - latest.t < intervalMs * 3 + 1000 ? latest[key] : 0;
  const { avg, peak } = windowStats(key, end - windowMs);
  const session = key === 'down' ? traffic?.sessionDown : traffic?.sessionUp;
  const lines: string[] = [];

  lines.push(` ${paint(c.bold + color, title)}  ${paint(c.bold, formatRate(current))}`);
  lines.push(
    ` ${paint(c.dim, 'avg')} ${formatRate(avg)}   ${paint(c.dim, 'peak')} ${formatRate(peak)}` +
      (session !== undefined ? `   ${paint(c.dim, 'session')} ${formatBytes(session)}` : ''),
  );

  for (let r = 0; r < height; r++) {
    let label = '';
    if (r === 0) label = axisLabel(scaleMax);
    else if (r === Math.floor(height / 2) && height >= 5) label = axisLabel(scaleMax / 2);
    else if (r === height - 1) label = '0';
    const tick = label ? '┤' : '│';
    lines.push(paint(c.dim, `${label.padStart(AXIS_W - 2)} ${tick}`) + paint(color, chart[r]));
  }

  lines.push(timeAxis(cols, AXIS_W));
  return lines;
}

// X axis: time labels at the start, middle and end of the window.
function timeAxis(cols: number, indent: number): string {
  const axis = new Array(cols).fill(' ');
  const place = (pos: number, text: string) => {
    const at = Math.max(0, Math.min(cols - text.length, pos));
    for (let i = 0; i < text.length; i++) axis[at + i] = text[i];
  };
  place(0, timeLabel(windowSec));
  place(Math.floor(cols / 2 - 3), timeLabel(windowSec / 2));
  place(cols, 'now');
  return paint(c.dim, ' '.repeat(indent) + axis.join(''));
}

// ---- rated signal charts (LTE and Wi-Fi) ------------------------------------

function ratingText(rating: { label: string; level: number }): string {
  return paint(c.bold + RATING_COLORS[rating.level], rating.label);
}

// "-94 dBm Fair", with the rating coloured.
function rated(value: number, unit: string, bands: readonly Band[]): string {
  return `${value} ${unit} ${ratingText(rate(bands, value))}`;
}

interface RatedChart<T extends { t: number }> {
  title: string;
  subtitle: string;
  problem: string; // shown instead of the chart when set
  current: number | undefined;
  unit: string;
  bands: readonly Band[];
  min: number; // value at the bottom of the chart
  max: number; // value at the top
  samples: T[];
  value: (s: T) => number;
}

// Choose a y-axis row for each rating band label: ideally the row holding the band's
// midpoint, nudged so labels never share a row. With fewer rows than bands, label an
// evenly spaced subset (always including the best and worst).
function bandLabelRows(bands: readonly Band[], min: number, max: number, rows: number): Map<number, Band> {
  const rowSize = (max - min) / rows;
  const spans = bands
    .map((band, i) => ({ band, top: Math.min(i === 0 ? max : bands[i - 1].min, max), bottom: Math.max(band.min, min) }))
    .filter((b) => b.top > b.bottom);
  let shown = spans;
  if (rows < spans.length) {
    shown = Array.from({ length: rows }, (_, k) => spans[Math.round((k * (spans.length - 1)) / Math.max(1, rows - 1))]);
  }
  const placed = shown.map((b) => Math.floor((max - (b.top + b.bottom) / 2) / rowSize));
  // Forward pass keeps labels in order without overlap; backward pass keeps them on the chart.
  for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i], placed[i - 1] + 1);
  for (let i = placed.length - 1; i >= 0; i--) {
    placed[i] = Math.min(placed[i], i === placed.length - 1 ? rows - 1 : placed[i + 1] - 1);
  }
  return new Map(placed.map((row, i) => [row, shown[i].band]));
}

/** Title, stats, a chart `rows` high whose rows are coloured by rating band, and a time axis. */
function renderRatedPanel<T extends { t: number }>(p: RatedChart<T>, width: number, rows: number, end: number): string[] {
  // Value and rating come before the subtitle, so a narrow panel clips the subtitle first.
  if (p.problem || p.current === undefined) {
    return [` ${paint(c.bold, p.title)}   ${paint(c.dim, p.subtitle)}`, ` ${p.problem}`];
  }
  const current = `${paint(c.bold, `${p.current} ${p.unit}`)}  ${ratingText(rate(p.bands, p.current))}`;
  const lines = [` ${paint(c.bold, p.title)}  ${current}   ${paint(c.dim, p.subtitle)}`];

  const recent = p.samples.filter((s) => s.t >= end - windowSec * 1000).map(p.value);
  const avg = recent.length ? Math.round(recent.reduce((sum, v) => sum + v, 0) / recent.length) : p.current;
  const worst = recent.length ? Math.min(...recent) : p.current;
  lines.push(
    ` ${paint(c.dim, 'avg')} ${rated(avg, p.unit, p.bands)}   ${paint(c.dim, 'worst')} ${rated(worst, p.unit, p.bands)}`,
  );

  const cols = Math.max(1, width - AXIS_W);
  const range = p.max - p.min;
  const values = resample(p.samples, p.value, cols * 2, end, windowSec * 1000, intervalMs * 3 + 1000);
  // Shift onto 0…range; anything at or below the floor still shows a sliver.
  const chart = renderArea(
    values.map((v) => (v === null ? null : Math.min(Math.max(v - p.min, 0.1), range))),
    cols,
    rows,
    range,
  );

  // Colour every row by the rating band its level falls in, so the fill itself shows how
  // good the signal is, and label the bands on the y axis.
  const rowSize = range / rows;
  const labels = bandLabelRows(p.bands, p.min, p.max, rows);
  for (let row = 0; row < rows; row++) {
    const color = RATING_COLORS[rate(p.bands, p.max - (row + 0.5) * rowSize).level];
    const band = labels.get(row);
    const axis = band
      ? paint(RATING_COLORS[rate(p.bands, Math.max(band.min, p.min)).level], band.label.padStart(AXIS_W - 2)) +
        paint(c.dim, ' ┤')
      : paint(c.dim, `${' '.repeat(AXIS_W - 2)} │`);
    lines.push(axis + paint(color, chart[row]));
  }
  lines.push(timeAxis(cols, AXIS_W));
  return lines;
}

// Header line titles are padded to the same width so their values line up.
const headerTitle = (t: string) => paint(c.bold, t.padEnd(5));

// ---- LTE signal (the router's link to the cell tower) ------------------------

function mobileCurrent(): MobileSignal | undefined {
  return mobile && Date.now() - mobileAt < MOBILE_EVERY_MS * 3 + 1000 ? mobile : undefined;
}

// Why there is no reading to show, or '' if there is one.
function mobileProblem(): string {
  if (!client.canLogin) return paint(c.dim, 'signal details need the router admin password');
  if (mobileError) return paint(c.red, `⚠ ${mobileError}`);
  const m = mobileCurrent();
  if (!m) return paint(c.dim, 'loading…');
  if (m.rsrp === null) return paint(c.yellow, 'no LTE signal details (not on 4G?)');
  return '';
}

function mobileHeader(): string {
  const problem = mobileProblem();
  if (problem) return ` ${headerTitle('LTE')}  ${problem}`;
  const m = mobileCurrent()!;
  const level = rate(LTE_RSRP_BANDS, m.rsrp!).level;
  const parts = [`${signalBars(level, 4, RATING_COLORS[level])} RSRP ${rated(m.rsrp!, 'dBm', LTE_RSRP_BANDS)}`];
  if (m.rsrq !== null) parts.push(`RSRQ ${rated(m.rsrq, 'dB', LTE_RSRQ_BANDS)}`);
  if (m.sinr !== null) parts.push(`SINR ${rated(m.sinr, 'dB', LTE_SINR_BANDS)}`);
  if (m.band) parts.push(`band ${m.band}`);
  if (m.bandwidth) parts.push(m.bandwidth);
  if (m.cellId) parts.push(`cell ${m.cellId}`);
  if (m.pci) parts.push(paint(c.dim, `PCI ${m.pci}`));
  return ` ${headerTitle('LTE')}  ` + parts.join(paint(c.dim, ' · '));
}

function renderMobilePanel(width: number, rows: number, end: number): string[] {
  return renderRatedPanel(
    {
      title: 'LTE signal',
      subtitle: 'RSRP · router ↔ cell tower',
      problem: mobileProblem(),
      current: mobileCurrent()?.rsrp ?? undefined,
      unit: 'dBm',
      bands: LTE_RSRP_BANDS,
      min: -120,
      max: -70,
      samples: mobileSamples,
      value: (s) => s.rsrp,
    },
    width,
    rows,
    end,
  );
}

// ---- Wi-Fi signal (this Mac's view of the link to the router) --------------

function wifiCurrent() {
  const r = wifi.latest;
  const fresh = r && Date.now() - wifi.latestAt < intervalMs * 3 + 1000;
  return fresh ? r : undefined;
}

// Why there is no reading to show, or '' if there is one.
function wifiProblem(): string {
  if (wifi.state === 'unavailable') return paint(c.red, `⚠ ${wifi.error}`);
  const r = wifiCurrent();
  if (wifi.state === 'starting' || !r) return paint(c.dim, 'starting Wi-Fi monitor (first run compiles a helper)…');
  if (!r.powerOn) return paint(c.yellow, 'Wi-Fi is turned off');
  if (r.rssi === undefined) return paint(c.yellow, 'not connected to a Wi-Fi network');
  return '';
}

function wifiHeader(): string {
  const problem = wifiProblem();
  if (problem) return ` ${headerTitle('Wi-Fi')}  ${problem}`;
  const r = wifiCurrent()!;
  const rssi = r.rssi!;
  const level = rate(WIFI_RSSI_BANDS, rssi).level;
  const parts = [`${signalBars(level, 4, RATING_COLORS[level])} ${rated(rssi, 'dBm', WIFI_RSSI_BANDS)}`];
  if (r.noise !== undefined) parts.push(`SNR ${rated(rssi - r.noise, 'dB', WIFI_SNR_BANDS)}`);
  if (r.txRate !== undefined) parts.push(`link ${r.txRate} Mbps`);
  const channel = [r.channel !== undefined ? `ch ${r.channel}` : '', r.band, r.width].filter(Boolean).join(' · ');
  if (channel) parts.push(channel);
  if (r.phy) parts.push(r.phy);
  if (wifi.routeInterface && wifi.routeInterface !== r.interface) {
    parts.push(paint(c.yellow, `⚠ router reached via ${wifi.routeInterface}, not Wi-Fi (${r.interface})`));
  } else if (r.interface) {
    parts.push(paint(c.dim, r.interface));
  }
  return ` ${headerTitle('Wi-Fi')}  ` + parts.join(paint(c.dim, ' · '));
}

function renderWifiPanel(width: number, rows: number, end: number): string[] {
  return renderRatedPanel(
    {
      title: 'Wi-Fi signal',
      subtitle: 'this Mac ↔ router',
      problem: wifiProblem(),
      current: wifiCurrent()?.rssi,
      unit: 'dBm',
      bands: WIFI_RSSI_BANDS,
      min: -90,
      max: -30,
      samples: wifi.samples,
      value: (s) => s.rssi,
    },
    width,
    rows,
    end,
  );
}

function signalBars(level: number, max: number, color = c.green): string {
  const bars = '▁▂▃▅▇';
  let out = '';
  for (let i = 0; i < max; i++) {
    const ch = bars[Math.min(i, bars.length - 1)];
    out += i < level ? paint(color, ch) : paint(c.dim, ch);
  }
  return out;
}

function header(): string {
  const parts: string[] = [paint(c.bold, device || 'Huawei Mobile WiFi')];
  if (carrier) parts.push(carrier);
  if (status) {
    parts.push(status.connected ? status.networkType : paint(c.red, 'disconnected'));
    parts.push(signalBars(status.signal, status.maxSignal));
    if (status.batteryPercent !== null) {
      const pct = status.batteryPercent;
      const col = pct <= 20 ? c.red : pct <= 40 ? c.yellow : '';
      parts.push(`${status.charging ? '⚡' : '🔋'}${paint(col, `${pct}%`)}`);
    }
    parts.push(`${status.wifiClients} client${status.wifiClients === 1 ? '' : 's'}`);
  }
  if (traffic) parts.push(`connected ${formatDuration(traffic.connectTime)}`);
  return ' ' + parts.join(paint(c.dim, ' · '));
}

function footer(): string {
  const win = WINDOWS.map((w) => (w === windowSec ? paint(c.inverse, ` ${timeLabel(w).slice(1)} `) : ` ${timeLabel(w).slice(1)} `)).join('');
  const keys = `${paint(c.bold, 'q')} quit  ${paint(c.bold, 'p')} ${paused ? 'resume' : 'pause'}  ${paint(c.bold, 'w')} window${win}  ${paint(c.bold, 's')} ${sharedScale ? 'shared' : 'separate'} scale`;
  let state: string;
  if (paused) state = paint(c.yellow + c.bold, 'PAUSED');
  else if (lastError) state = paint(c.red, `⚠ ${lastError}`);
  else if (lastOk) state = paint(c.dim, `updated ${new Date(lastOk).toLocaleTimeString()}`);
  else state = paint(c.dim, `connecting to ${host}…`);
  return ` ${keys}   ${state}`;
}

// Terminal columns a code point occupies: 0 for combining marks and zero-width
// characters, 2 for emoji and East Asian wide characters, 1 otherwise.
function charWidth(cp: number): number {
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x231a || cp === 0x231b || cp === 0x23f0 || cp === 0x23f3 ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x26a1 || cp === 0x26aa || cp === 0x26ab || cp === 0x26bd || cp === 0x26be ||
    cp === 0x26d4 || cp === 0x26ea || cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd ||
    cp === 0x2705 || cp === 0x2728 || cp === 0x274c || cp === 0x2757 || cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

// Pad or clip a line containing ANSI escapes to exactly `width` terminal columns.
function fit(line: string, width: number): string {
  let out = '';
  let visible = 0;
  for (let i = 0; i < line.length; ) {
    const esc = line.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (visible + w > width) break;
    out += ch;
    visible += w;
    i += ch.length;
  }
  return out + c.reset + ' '.repeat(width - visible);
}

const PANEL_GAP = 3;

function deviceTable(width: number, maxRows: number): string[] {
  const title = paint(c.bold, ' Wi-Fi devices');
  if (!client.canLogin) {
    return [`${title}  ${paint(c.dim, 'set HUAWEI_PASSWORD (router admin password) to list connected devices')}`];
  }
  if (hostsError) return [`${title}  ${paint(c.red, `⚠ ${hostsError}`)}`];
  if (!hosts) return [`${title}  ${paint(c.dim, 'loading…')}`];
  if (hosts.length === 0) return [`${title}  ${paint(c.dim, 'no devices connected')}`];

  // Column widths include the 2-space gap before each column. When space is tight,
  // drop Source first, then MAC address.
  const NAME_MIN = 16;
  const IP_W = 17;
  const CONNECTED_W = 11;
  let macW = 19;
  let sourceW = 8;
  const fixed = () => 1 + IP_W + CONNECTED_W + macW + sourceW;
  if (fixed() + NAME_MIN > width) sourceW = 0;
  if (fixed() + NAME_MIN > width) macW = 0;
  const nameW = Math.max(NAME_MIN, Math.min(32, width - fixed()));
  const col = (text: string, w: number) => (w ? `  ${fit(text, w - 2)}` : '');
  const row = (name: string, mac: string, ip: string, source: string, connected: string) =>
    ` ${fit(name, nameW)}${col(mac, macW)}${col(ip, IP_W)}${col(source, sourceW)}${col(connected, CONNECTED_W)}`;

  const lines = [
    paint(c.bold, row(`Wi-Fi device (${hosts.length})`, 'MAC address', 'IP address', 'Source', 'Connected')),
  ];
  const shown = hosts.length > maxRows - 1 ? Math.max(0, maxRows - 2) : hosts.length;
  for (const h of hosts.slice(0, shown)) {
    lines.push(
      row(
        h.name || paint(c.dim, '(unnamed)'),
        h.mac,
        h.ip || paint(c.dim, '—'),
        h.addressSource || paint(c.dim, '—'),
        h.connectedSeconds !== null ? formatDuration(h.connectedSeconds) : paint(c.dim, '—'),
      ),
    );
  }
  if (shown < hosts.length) lines.push(paint(c.dim, ` … ${hosts.length - shown} more`));
  return lines;
}

function frame(width: number, height: number): string[] {
  // Layout, top to bottom: 3 header lines, blank, download | upload, blank,
  // LTE signal | Wi-Fi signal, blank, device table, blank, footer. Each chart panel has
  // a title, a stats line and a time axis around its chart rows.
  const FIXED = 3 + 1 + 3 + 1 + 3 + 1 + 1 + 1;
  const wantTable = hosts && hosts.length ? hosts.length + 1 : 1;
  const tableRows = Math.max(1, Math.min(wantTable, height - FIXED - 5)); // keep ≥ 5 chart rows
  const free = Math.max(0, height - FIXED - tableRows);
  const signalRows = Math.max(2, Math.floor(free * 0.4));
  const chartRows = Math.max(3, free - signalRows);
  // Both columns get exactly the same width; any odd column is left empty on the right.
  const panelW = Math.max(1, Math.floor((width - PANEL_GAP) / 2));
  // Start the gap and the right column at absolute screen columns (CSI n G) instead of
  // relying on the left column's text width. Terminals disagree on the width of some
  // characters (box drawing, arrows, emoji), and that must never shift the right column.
  // Writing the gap also blanks anything the left column spilled into it.
  const gap = `${ESC}${panelW + 1}G${' '.repeat(PANEL_GAP)}${ESC}${panelW + PANEL_GAP + 1}G`;
  const end = paused ? pausedAt : Date.now();
  const from = end - windowSec * 1000;

  // Round the scale in bits/s so axis labels are 1/2/5 Mbps etc.; never scale below
  // 1 Mbps so idle noise stays small.
  const scale = (peakBytes: number) => niceCeil(Math.max(1e6, peakBytes * 8)) / 8;
  const downMax = scale(windowStats('down', from).peak);
  const upMax = scale(windowStats('up', from).peak);
  const both = Math.max(downMax, upMax);

  const down = renderPanel('down', '↓ Download', c.down, panelW, chartRows, end, sharedScale ? both : downMax);
  const up = renderPanel('up', '↑ Upload', c.up, panelW, chartRows, end, sharedScale ? both : upMax);
  const panels = down.map((l, i) => fit(l, panelW) + gap + fit(up[i], panelW));

  const lte = renderMobilePanel(panelW, signalRows, end);
  const wlan = renderWifiPanel(panelW, signalRows, end);
  const signals = Array.from(
    { length: signalRows + 3 },
    (_, i) => fit(lte[i] ?? '', panelW) + gap + fit(wlan[i] ?? '', panelW),
  );

  const table = deviceTable(width, tableRows);

  return [header(), mobileHeader(), wifiHeader(), '', ...panels, '', ...signals, '', ...table, '', footer()];
}

function draw() {
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  // Clip every line to the screen: with auto-wrap off, overflowing text would otherwise
  // pile up in the last column.
  const lines = frame(width, height)
    .slice(0, height)
    .map((l) => fit(l, width));
  process.stdout.write(`${ESC}H` + lines.map((l) => l + `${ESC}K`).join('\r\n') + `${ESC}J`);
}

// ---- polling --------------------------------------------------------------

let lastStatus = 0;

async function pollStatus() {
  lastStatus = Date.now();
  const [s, p, d] = await Promise.allSettled([
    client.status(),
    carrier ? Promise.resolve(carrier) : client.carrier(),
    device ? Promise.resolve(device) : client.deviceName(),
  ]);
  if (s.status === 'fulfilled') status = s.value;
  if (p.status === 'fulfilled') carrier = p.value;
  if (d.status === 'fulfilled') device = d.value;
}

let lastHosts = 0;

async function pollHosts() {
  lastHosts = Date.now();
  try {
    hosts = await client.wifiHosts();
    hostsError = '';
  } catch (e) {
    hostsError = e instanceof Error ? (e.name === 'TimeoutError' ? 'router not responding' : e.message) : String(e);
  }
}

let lastMobile = 0;

async function pollMobile() {
  lastMobile = Date.now();
  try {
    const m = await client.mobileSignal();
    mobile = m;
    mobileAt = Date.now();
    mobileError = '';
    if (m.rsrp !== null) mobileSamples.push({ t: mobileAt, rsrp: m.rsrp });
  } catch (e) {
    mobileError = e instanceof Error ? (e.name === 'TimeoutError' ? 'router not responding' : e.message) : String(e);
  }
}

async function poll() {
  try {
    traffic = await client.traffic();
    samples.push({ t: Date.now(), down: traffic.downRate, up: traffic.upRate });
    lastOk = Date.now();
    lastError = '';
  } catch (e) {
    lastError = e instanceof Error ? (e.name === 'TimeoutError' ? 'router not responding' : e.message) : String(e);
  }
  if (Date.now() - lastStatus >= STATUS_EVERY_MS) await pollStatus().catch(() => {});
  if (client.canLogin && Date.now() - lastHosts >= HOSTS_EVERY_MS) await pollHosts();
  if (client.canLogin && Date.now() - lastMobile >= MOBILE_EVERY_MS) await pollMobile();

  // Keep enough history for the largest window.
  const cutoff = Date.now() - (WINDOWS.at(-1)! + 60) * 1000;
  while (samples.length && samples[0].t < cutoff) samples.shift();
  while (mobileSamples.length && mobileSamples[0].t < cutoff) mobileSamples.shift();
}

// ---- main -----------------------------------------------------------------

async function snapshot(seconds: number) {
  await wifi.start();
  const until = Date.now() + seconds * 1000;
  do {
    await poll();
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() < until);
  const lines = frame(
    process.stdout.columns || Number(process.env.COLUMNS) || 100,
    process.stdout.rows || Number(process.env.LINES) || 30,
  );
  console.log(lines.join('\n'));
  wifi.stop();
  await client.logout().catch(() => {});
}

function interactive() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('This program needs an interactive terminal (or use --snapshot).');
    process.exit(1);
  }

  // Alternate screen, hidden cursor, no line wrap (long lines are clipped, not wrapped).
  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?7l${ESC}2J`);
  const cleanup = () => {
    wifi.stop();
    process.stdout.write(`${ESC}?7h${ESC}?25h${ESC}?1049l`);
  };
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    cleanup();
    await client.logout().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('uncaughtException', (e) => {
    cleanup();
    console.error(e);
    process.exit(1);
  });

  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    switch (key) {
      case 'q':
      case '\x03': // ctrl-c
      case '\x1b':
        void quit();
        return;
      case 'p':
        paused = !paused;
        pausedAt = Date.now();
        break;
      case 'w':
        windowSec = WINDOWS[(WINDOWS.indexOf(windowSec) + 1) % WINDOWS.length];
        break;
      case 's':
        sharedScale = !sharedScale;
        break;
    }
    draw();
  });
  process.stdout.on('resize', () => {
    process.stdout.write(`${ESC}2J`);
    draw();
  });

  const loop = async () => {
    await poll();
    draw();
    setTimeout(loop, intervalMs);
  };
  draw();
  void wifi.start().then(draw);
  void loop();
}

if (!WINDOWS.includes(windowSec)) {
  WINDOWS.push(windowSec);
  WINDOWS.sort((a, b) => a - b);
}

if (args.snapshot) await snapshot(Number(args.snapshot) || 5);
else interactive();
