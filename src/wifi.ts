// This Mac's view of its Wi-Fi link to the router, read through CoreWLAN by a small
// Swift helper (helpers/wifi-signal.swift). The helper is compiled on first use and
// cached in .cache/; it needs macOS and swiftc (Xcode Command Line Tools).

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SOURCE = fileURLToPath(new URL('../helpers/wifi-signal.swift', import.meta.url));
const CACHE_DIR = fileURLToPath(new URL('../.cache/', import.meta.url));
const BINARY = `${CACHE_DIR}wifi-signal`;
const ROUTE_EVERY_MS = 30_000;

export interface WifiReading {
  interface: string;
  powerOn: boolean;
  // The rest is only present while associated with a network.
  rssi?: number; // dBm
  noise?: number; // dBm
  txRate?: number; // Mbps
  channel?: number;
  band?: string;
  width?: string;
  phy?: string;
}

export interface SignalSample {
  t: number;
  rssi: number;
}

export class WifiMonitor {
  state: 'starting' | 'running' | 'unavailable' = 'starting';
  error = '';
  latest: WifiReading | undefined;
  latestAt = 0;
  readonly samples: SignalSample[] = [];
  /** Interface the Mac uses to reach the router, to tell whether Wi-Fi is that link. */
  routeInterface: string | undefined;

  private readonly routerHost: string;
  private readonly intervalMs: number;
  private readonly keepMs: number;
  private child: ChildProcess | undefined;
  private routeTimer: NodeJS.Timeout | undefined;

  constructor(routerHost: string, intervalMs: number, keepMs: number) {
    this.routerHost = routerHost;
    this.intervalMs = intervalMs;
    this.keepMs = keepMs;
  }

  async start(): Promise<void> {
    if (process.platform !== 'darwin') return this.fail('Wi-Fi signal is only available on macOS');
    try {
      await this.compile();
    } catch {
      return this.fail('could not compile the Wi-Fi helper (install Xcode Command Line Tools: xcode-select --install)');
    }

    const child = spawn(BINARY, [String(this.intervalMs)], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    child.on('error', () => this.fail('could not start the Wi-Fi helper'));
    child.on('exit', () => {
      if (this.child === child) this.fail('Wi-Fi helper stopped');
    });
    createInterface({ input: child.stdout! }).on('line', (line) => this.onReading(line));
    this.state = 'running';

    void this.checkRoute();
    this.routeTimer = setInterval(() => void this.checkRoute(), ROUTE_EVERY_MS);
  }

  stop(): void {
    clearInterval(this.routeTimer);
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  private fail(message: string): void {
    this.stop();
    this.state = 'unavailable';
    this.error = message;
  }

  private async compile(): Promise<void> {
    const [src, bin] = await Promise.all([stat(SOURCE), stat(BINARY).catch(() => undefined)]);
    if (bin && bin.mtimeMs >= src.mtimeMs) return;
    await mkdir(CACHE_DIR, { recursive: true });
    await run('swiftc', ['-O', SOURCE, '-o', BINARY], { timeout: 180_000 });
  }

  private onReading(line: string): void {
    let reading: WifiReading;
    try {
      reading = JSON.parse(line);
    } catch {
      return;
    }
    const now = Date.now();
    this.latest = reading;
    this.latestAt = now;
    if (reading.rssi !== undefined) this.samples.push({ t: now, rssi: reading.rssi });
    while (this.samples.length && this.samples[0].t < now - this.keepMs) this.samples.shift();
  }

  private async checkRoute(): Promise<void> {
    try {
      const { stdout } = await run('route', ['-n', 'get', this.routerHost], { timeout: 5000 });
      this.routeInterface = stdout.match(/interface:\s*(\S+)/)?.[1];
    } catch {
      this.routeInterface = undefined;
    }
  }
}
