// Minimal client for the Huawei HiLink web API (E5576 and similar mobile WiFi routers).
// Responses are XML documents. Traffic and status only need a session cookie + CSRF
// token from /api/webserver/SesTokInfo; the connected-device list needs an admin login.

import { createHash } from 'node:crypto';

export interface Traffic {
  downRate: number; // bytes/s
  upRate: number; // bytes/s
  sessionDown: number; // bytes since connection start
  sessionUp: number;
  connectTime: number; // seconds
}

export interface Status {
  networkType: string;
  signal: number;
  maxSignal: number;
  batteryPercent: number | null;
  charging: boolean;
  wifiClients: number;
  connected: boolean;
}

export interface WifiHost {
  name: string;
  mac: string;
  ip: string; // IPv4 address (the router appends IPv6 addresses after ';')
  addressSource: string; // DHCP / Static; empty when the firmware doesn't report it
  connectedSeconds: number | null; // time since the device joined the Wi-Fi
}

export interface MobileSignal {
  rsrp: number | null; // dBm
  rsrq: number | null; // dB
  sinr: number | null; // dB
  rssi: number | null; // dBm
  band: string; // LTE band number, e.g. "7"
  bandwidth: string; // downlink channel width, e.g. "20MHz"
  cellId: string;
  pci: string; // physical cell id
}

export class LoginRequiredError extends Error {
  constructor() {
    super('admin login required');
  }
}

export class RouterError extends Error {
  readonly code: string;
  constructor(code: string, path: string) {
    super(`router returned error ${code} for ${path}`);
    this.code = code;
  }
}

// Session/token errors that are fixed by fetching a fresh token.
const TOKEN_ERRORS = new Set(['125001', '125002', '125003']);
const NO_RIGHTS = '100003';
// The router allows only a few admin sessions; it refuses new logins until one logs out or times out.
const SESSIONS_FULL = '108003';
const SESSIONS_FULL_RETRY_MS = 30_000;

const SESSIONS_FULL_MESSAGE = 'router admin sessions in use (logged in elsewhere?), retrying in 30s';

const LOGIN_ERRORS: Record<string, string> = {
  '108001': 'wrong admin username',
  '108002': 'wrong admin password',
  '108006': 'wrong admin username or password',
  '108007': 'too many login attempts, router locked login',
  '108010': 'too many login attempts, router locked login',
};

const errorCode = (xml: string) => xml.match(/<error>[\s\S]*?<code>(\d+)<\/code>/)?.[1];
const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const base64 = (s: string) => Buffer.from(s).toString('base64');
const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function parseFlatXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) out[m[1]] = m[2];
  return out;
}

export interface ClientOptions {
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export class HuaweiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly username: string;
  private readonly password: string | undefined;
  private session: string | undefined;
  private token: string | undefined;
  private loggedIn = false;
  private loginPromise: Promise<void> | undefined;
  // Set once the router rejects our credentials; we never retry, to avoid locking the account.
  private loginError: string | undefined;
  private loginRetryAt = 0;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.username = options.username ?? 'admin';
    this.password = options.password;
  }

  get canLogin(): boolean {
    return this.password !== undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
    if (this.session) headers.Cookie = this.session;
    if (this.token) headers.__RequestVerificationToken = this.token;
    return headers;
  }

  private captureCookie(res: Response): void {
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('SessionID='));
    if (cookie) this.session = cookie.split(';')[0];
  }

  private async refreshToken(): Promise<void> {
    // While logged in, keep the session cookie and only fetch a token for it.
    const res = await fetch(`${this.baseUrl}/api/webserver/SesTokInfo`, {
      headers: this.loggedIn && this.session ? { Cookie: this.session } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.captureCookie(res);
    const data = parseFlatXml(await res.text());
    if (!this.loggedIn && data.SesInfo) {
      this.session = data.SesInfo.startsWith('SessionID=') ? data.SesInfo : `SessionID=${data.SesInfo}`;
    }
    this.token = data.TokInfo;
  }

  login(): Promise<void> {
    this.loginPromise ??= this.doLogin().finally(() => (this.loginPromise = undefined));
    return this.loginPromise;
  }

  private async doLogin(): Promise<void> {
    if (this.password === undefined) throw new LoginRequiredError();
    if (this.loginError) throw new Error(this.loginError);
    if (Date.now() < this.loginRetryAt) throw new Error(SESSIONS_FULL_MESSAGE);

    // Start from a fresh anonymous session.
    this.loggedIn = false;
    this.session = undefined;
    this.token = undefined;
    await this.refreshToken();
    const token = this.token ?? '';

    const state = parseFlatXml(await this.request('user/state-login'));
    const password =
      state.password_type === '4'
        ? base64(sha256Hex(this.username + base64(sha256Hex(this.password)) + token))
        : base64(this.password);
    const body =
      '<?xml version="1.0" encoding="UTF-8"?><request>' +
      `<Username>${xmlEscape(this.username)}</Username><Password>${password}</Password>` +
      `<password_type>${state.password_type || '0'}</password_type></request>`;

    const res = await fetch(`${this.baseUrl}/api/user/login`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.captureCookie(res);
    const code = errorCode(await res.text());
    if (code === SESSIONS_FULL) {
      // Not a credentials problem, so retry later instead of giving up.
      this.loginRetryAt = Date.now() + SESSIONS_FULL_RETRY_MS;
      throw new Error(SESSIONS_FULL_MESSAGE);
    }
    if (code) {
      this.loginError = LOGIN_ERRORS[code] ?? `login failed (error ${code})`;
      throw new Error(this.loginError);
    }
    this.loggedIn = true;
    await this.refreshToken();
  }

  /** End the admin session so it doesn't count against the router's session limit. */
  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    await this.refreshToken();
    await fetch(`${this.baseUrl}/api/user/logout`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: '<?xml version="1.0" encoding="UTF-8"?><request><Logout>1</Logout></request>',
      signal: AbortSignal.timeout(1500),
    });
    this.loggedIn = false;
    this.session = undefined;
    this.token = undefined;
  }

  /** GET an API path and return the raw XML, refreshing the token or logging in as needed. */
  async request(path: string, retry = true): Promise<string> {
    if (!this.token) await this.refreshToken();
    const res = await fetch(`${this.baseUrl}/api/${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.captureCookie(res);

    const body = await res.text();
    const code = errorCode(body);
    if (!code) return body;
    if (retry && TOKEN_ERRORS.has(code)) {
      // The session is stale: start over anonymously; privileged calls log in again on demand.
      this.loggedIn = false;
      this.session = undefined;
      this.token = undefined;
      return this.request(path, false);
    }
    if (code === NO_RIGHTS) {
      if (!this.canLogin) throw new LoginRequiredError();
      if (retry) {
        await this.login();
        return this.request(path, false);
      }
    }
    throw new RouterError(code, path);
  }

  async get(path: string): Promise<Record<string, string>> {
    return parseFlatXml(await this.request(path));
  }

  async traffic(): Promise<Traffic> {
    const d = await this.get('monitoring/traffic-statistics');
    return {
      downRate: Number(d.CurrentDownloadRate) || 0,
      upRate: Number(d.CurrentUploadRate) || 0,
      sessionDown: Number(d.CurrentDownload) || 0,
      sessionUp: Number(d.CurrentUpload) || 0,
      connectTime: Number(d.CurrentConnectTime) || 0,
    };
  }

  async status(): Promise<Status> {
    const d = await this.get('monitoring/status');
    const battery = d.BatteryPercent === undefined || d.BatteryPercent === '' ? null : Number(d.BatteryPercent);
    return {
      networkType: networkTypeName(d.CurrentNetworkTypeEx ?? d.CurrentNetworkType ?? ''),
      signal: Number(d.SignalIcon) || 0,
      maxSignal: Number(d.maxsignal) || 5,
      batteryPercent: battery,
      charging: d.BatteryStatus === '1',
      wifiClients: Number(d.CurrentWifiUser) || 0,
      connected: d.ConnectionStatus === '901',
    };
  }

  async carrier(): Promise<string> {
    const d = await this.get('net/current-plmn');
    return d.ShortName || d.FullName || '';
  }

  async wifiHosts(): Promise<WifiHost[]> {
    let xml: string;
    try {
      // lan/HostInfo is the only list that includes AddressSource.
      xml = await this.request('lan/HostInfo');
    } catch (e) {
      // Older firmware only has wlan/host-list.
      if (!(e instanceof RouterError) || e.code === NO_RIGHTS) throw e;
      xml = await this.request('wlan/host-list');
    }
    const hosts: WifiHost[] = [];
    for (const m of xml.matchAll(/<Host>([\s\S]*?)<\/Host>/g)) {
      const h = parseFlatXml(m[1]);
      if (h.Active === '0') continue; // lan/HostInfo also lists recently disconnected devices
      if (h.InterfaceType && !/wireless|wlan|wifi|ssid/i.test(h.InterfaceType)) continue;
      const mac = (h.MacAddress || '').toUpperCase();
      const name = h.ActualName || h.HostName || '';
      hosts.push({
        // Devices without a hostname are reported under their MAC (as AA-BB-CC-...).
        name: name.replace(/-/g, ':').toUpperCase() === mac ? '' : name,
        mac,
        ip: (h.IpAddress || '').split(';')[0],
        addressSource: h.AddressSource || '',
        connectedSeconds: h.AssociatedTime ? Number(h.AssociatedTime) : null,
      });
    }
    return hosts;
  }

  /** LTE radio measurements (needs the admin login). */
  async mobileSignal(): Promise<MobileSignal> {
    const d = await this.get('device/signal');
    // Values carry units, e.g. "-94dBm" or "-10.0dB"; empty when not applicable.
    const num = (v: string | undefined) => {
      const n = Number.parseFloat(v ?? '');
      return Number.isFinite(n) ? n : null;
    };
    return {
      rsrp: num(d.rsrp),
      rsrq: num(d.rsrq),
      sinr: num(d.sinr),
      rssi: num(d.rssi),
      band: d.band ?? '',
      bandwidth: (d.dlbandwidth ?? '').replace(/(\d)MHz/, '$1 MHz'),
      cellId: d.cell_id ?? '',
      pci: d.pci ?? '',
    };
  }

  async deviceName(): Promise<string> {
    const d = await this.get('device/basic_information');
    return d.devicename || d.spreadname_en || '';
  }
}

// CurrentNetworkTypeEx codes as used by the HiLink web UI.
const NETWORK_TYPES: Record<string, string> = {
  '0': 'No service',
  '1': '2G GSM',
  '2': '2G GPRS',
  '3': '2G EDGE',
  '41': '3G WCDMA',
  '42': '3G HSDPA',
  '43': '3G HSUPA',
  '44': '3G HSPA',
  '45': '3G HSPA+',
  '46': '3G DC-HSPA+',
  '19': '4G LTE',
  '101': '4G LTE',
  '1011': '4G+ LTE-A',
  '111': '5G NR',
};

function networkTypeName(code: string): string {
  return NETWORK_TYPES[code] ?? (code ? `type ${code}` : 'unknown');
}
