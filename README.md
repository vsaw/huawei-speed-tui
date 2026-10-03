# huawei-speed-tui

Live terminal charts of mobile data download/upload speed for Huawei HiLink mobile WiFi
routers (built for the E5576-320). No runtime dependencies — Node runs the TypeScript directly.

```
npm install        # only needed for `npm run typecheck`
npm start          # connect to http://192.168.8.1
npm start -- --host 192.168.1.1 --interval 2 --window 900
npm start -- --snapshot 10   # collect 10 s, print one frame, exit
```

Requires Node ≥ 22.18 (native TypeScript type stripping).

Host, user and password can also come from the environment (`HUAWEI_HOST`, `HUAWEI_USER`,
`HUAWEI_PASSWORD`) or from a `.env` file in the current directory (git-ignored):

```dotenv
HUAWEI_HOST=192.168.8.1
HUAWEI_USER=admin
HUAWEI_PASSWORD=secret
```

Command-line options win over environment variables, which win over `.env`.

Keys: `q` quit · `p` pause · `w` cycle window (1m / 5m / 15m / 60m) · `s` toggle shared y-scale

At the bottom, a table lists the connected Wi-Fi devices: name, MAC address, IPv4 address,
address source (DHCP/static) and how long each has been connected. The device list needs the router admin
password: pass `--password` or set `HUAWEI_PASSWORD` (in the environment or `.env`); without it
the device list and LTE signal details are skipped. A rejected password is never retried, so the router won't lock the account.

Below the speed charts, an LTE signal chart shows the router's link to the cell tower (RSRP,
rated Excellent (≥ −80 dBm) · Good (≥ −90) · Fair (≥ −100) · Weak (≥ −110) · Poor), and a header
line summarises it: RSRP, RSRQ (Excellent ≥ −10 dB · Good ≥ −15 · Fair ≥ −20 · Poor) and SINR
(Excellent ≥ 20 dB · Good ≥ 13 · Fair ≥ 0 · Poor), plus band, bandwidth and cell. This comes from
`/api/device/signal` and needs the admin password.

Next to it, a Wi-Fi signal chart shows how strong this Mac's Wi-Fi link to the router
is, rated Excellent (≥ −50 dBm) · Good (≥ −60) · Fair (≥ −70) · Weak (≥ −80) · Poor, and a
second header line summarises the link (signal, signal-to-noise ratio rated Excellent (≥ 40 dB) ·
Good (≥ 25) · Fair (≥ 15) · Weak (≥ 10) · Poor, link rate, channel, band, Wi-Fi standard).
It reads CoreWLAN through `helpers/wifi-signal.swift`, which `npm run build` compiles into
`build/wifi-signal` (`npm start` runs the build first; it only recompiles when the source
changed), so it needs macOS and `swiftc` (Xcode Command Line Tools). It warns if the Mac reaches the
router through another interface than Wi-Fi.

Data comes from `/api/monitoring/traffic-statistics` (rates in bytes/s, shown as bits/s), with
carrier, network type, signal, battery and client count from `/api/monitoring/status` and
`/api/net/current-plmn`. None of these need the admin password.

## License

MIT, see [LICENSE](LICENSE).
