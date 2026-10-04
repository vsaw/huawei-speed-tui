// Latency and packet loss to a host on the internet, measured by the system `ping`
// running continuously in the background.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

const RESTART_AFTER_MS = 5_000;

export interface PingSample {
  t: number;
  seq: number;
  rtt: number | null; // ms; null if the packet was lost
}

export class PingMonitor {
  /** Last thing ping complained about; cleared by the next reply. */
  error = '';
  readonly samples: PingSample[] = [];
  readonly target: string;
  readonly intervalMs: number;

  private readonly keepMs: number;
  private child: ChildProcess | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(target: string, intervalMs: number, keepMs: number) {
    this.target = target;
    // Unprivileged ping refuses intervals below a second on some systems.
    this.intervalMs = Math.max(1000, intervalMs);
    this.keepMs = keepMs;
  }

  start(): void {
    this.stopped = false;
    // -n: no reverse DNS lookups. -O (Linux): report each unanswered packet, as macOS
    // does by default ("Request timeout for icmp_seq N").
    const args = ['-n', '-i', String(this.intervalMs / 1000)];
    if (process.platform === 'linux') args.push('-O');
    args.push(this.target);

    const child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.on('error', () => {
      this.error = 'could not run ping';
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      // Most likely the name didn't resolve (no internet yet); keep trying.
      this.error = stderr.trim().split('\n').at(-1)?.replace(/^ping: /, '') || 'ping stopped';
      if (!this.stopped) this.restartTimer = setTimeout(() => this.start(), RESTART_AFTER_MS);
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-500);
      const last = stderr.trim().split('\n').at(-1);
      if (last) this.error = last.replace(/^ping: /, '');
    });
    createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line));
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  private onLine(line: string): void {
    const seq = Number(line.match(/icmp_seq[= ](\d+)/)?.[1]);
    if (Number.isNaN(seq)) return;
    const now = Date.now();
    const time = line.match(/time[=<]([\d.]+) ?ms/);
    if (time) {
      this.error = '';
      const rtt = Number(time[1]);
      // A reply that arrives after ping already reported the packet as lost was only late.
      const late = this.samples.findLast((s) => s.seq === seq && s.rtt === null && now - s.t < 60_000);
      if (late) late.rtt = rtt;
      else this.samples.push({ t: now, seq, rtt });
    } else if (/timeout|no answer/i.test(line)) {
      this.samples.push({ t: now, seq, rtt: null });
    }
    while (this.samples.length && this.samples[0].t < now - this.keepMs) this.samples.shift();
  }
}
