# pi-vpn — ephemeral Pi-only VPN

WireGuard + [wireproxy](https://github.com/octeep/wireproxy) userspace proxy. **Only Pi traffic is affected** (Pi AI HTTPS calls), not system-wide, not Chrome. Tunnel lives **only while `pi` runs** — no background service, no daemon left behind. Auto-expires after **7 days** (`~/.config/pi-vpn/expires-at`).

> Prefer launching via the `pi-vpn` wrapper — it sets `HTTP_PROXY` *before* Pi boots so Pi's `undici` dispatcher routes AI calls through WireGuard. Running plain `pi` still starts `wireproxy` via this extension, but the dispatcher may not pick it up until next launch.

## Install

```bash
# 1) ensure wireproxy is available (prebuilt binary — nix build segfaults on this host, so use release tarball):
curl -L -o /tmp/wireproxy_linux_amd64.tar.gz https://github.com/windtf/wireproxy/releases/download/v1.1.3/wireproxy_linux_amd64.tar.gz
mkdir -p ~/.local/bin
tar -xzf /tmp/wireproxy_linux_amd64.tar.gz -C /tmp/
cp /tmp/wireproxy ~/.local/bin/wireproxy
chmod +x ~/.local/bin/wireproxy
~/.local/bin/wireproxy -h
# already installed on this host: ~/.local/bin/wireproxy (v1.1.3)

# 2) get your Proton WireGuard config:
# https://account.protonvpn.com/downloads -> WireGuard -> download US server
# Save it as:
mkdir -p ~/.config/pi-vpn
cp ~/Downloads/*.conf ~/.config/pi-vpn/proton.conf
chmod 600 ~/.config/pi-vpn/proton.conf

# 3) wrapper (already placed at ~/.local/bin/pi-vpn — verify):
chmod +x ~/.local/bin/pi-vpn

# 4) extension auto-loads from /home/dracon/Dev/pi-plugins/extensions/pi-vpn (via pi settings)
#    or symlink into ~/.pi/agent/extensions/
ln -sfn /home/dracon/Dev/pi-plugins/extensions/pi-vpn ~/.pi/agent/extensions/pi-vpn

# 5) initialize 7-day window:
pi-vpn --refresh
```

## Usage

```bash
pi-vpn                      # launch pi with VPN on (killed on pi exit)
pi-vpn --refresh            # extend expiry +7d, regenerate wireproxy.conf, launch pi
pi-vpn --status             # expiry + proxy state, no pi launch
pi-vpn --help
pi-vpn --models "*"          # any pi flags pass through
```

Inside Pi:

```
/vpn status      # expiry, wireproxy state, egress IP, proxy URL
/vpn on          # start wireproxy (respects expiry)
/vpn off         # stop wireproxy
/vpn refresh     # regenerate wireproxy.conf + extend expiry 7d
/vpn check-ip    # egress IP via proxy
/vpn help
```

Footer status: `vpn:on|off|expired|no-conf`. Widget above editor shows expiry countdown.

## Files (`~/.config/pi-vpn/`)

| File | Purpose | Mode |
|------|---------|------|
| `proton.conf` | Raw WireGuard `.conf` from Proton dashboard (you place it) | `600` |
| `wireproxy.conf` | Generated: `WGConfig = proton.conf` + `Socks5 :19090` + `http :19091` | `600` |
| `expires-at` | Epoch seconds; `+7d` on refresh | `600` |
| `wireproxy.pid` | PID while running (removed on exit) | `600` |

Ports: `PI_VPN_HTTP_PORT` (default `19091`), `PI_VPN_SOCKS_PORT` (default `19090`).

Env: `PI_VPN_CONF` (default `~/.config/pi-vpn/proton.conf`), `PI_VPN_DIR` (default `~/.config/pi-vpn`), `HTTP_PROXY=http://127.0.0.1:19091`.

## How it works

1. `pi-vpn` (bash) checks `expires-at` → expired = abort with hint to `--refresh`.
2. Regenerates `wireproxy.conf` (`WGConfig` + proxies) from `proton.conf`.
3. Finds `wireproxy` (PATH `~/.local/bin/wireproxy` → `/nix/store/*-wireproxy-*/bin/wireproxy` → `nix-shell -p wireproxy`).
4. Starts `wireproxy -c wireproxy.conf` in background (userspace WireGuard, no root). Note: `wireproxy -d` daemon flag fails here (`open /dev/null: permission denied`), so we use `&` + pidfile + log instead.
5. Waits up to 30s for `:19091`, probes egress `https://ifconfig.me/ip` via proxy.
6. Exports `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:19091` then launches `~/.local/bin/pi "$@"` (no `exec` — so `trap EXIT` can kill `wireproxy`).
7. `trap EXIT` kills `wireproxy` on pi exit — **no leftover daemon**.
8. Pi's `undici.EnvHttpProxyAgent` routes all Pi-managed HTTPS through the proxy = WireGuard egress (Proton US). Chrome etc. unaffected.

Extension `session_start` also starts `wireproxy` if not already running (fallback for plain `pi`), and `session_shutdown` stops it if the extension started it. Widget/status keep you honest about expiry.

## Verify egress

```bash
pi-vpn --status
# inside pi:
# /vpn status
# /vpn check-ip
curl -x http://127.0.0.1:19091 https://ifconfig.me/ip
# vs direct:
curl https://ifconfig.me/ip
```

If both show same IP, check `proton.conf` `AllowedIPs` includes `0.0.0.0/0` and `wireproxy.conf` is correct.

## Notes / limitations

- **Pi AI only** by design. Bash tools spawned by Pi inherit `HTTP_PROXY` (so `curl` etc. also go via VPN) — that is intentional for consistency. System-wide `proton-us` (NetworkManager) is separate; this does not touch it.
- Userspace `wireproxy` TCP-only (`CONNECT`); UDP not supported (fine for HTTPS AI APIs).
- Binary is prebuilt `v1.1.3` at `~/.local/bin/wireproxy` (nix `wireproxy-1.0.10` segfaults on this host — avoid). Wrapper/extension also probe nix as fallback.
- After 7 days, `pi-vpn` refuses to start until `--refresh`. No auto-renew.
- If you already have system-wide Proton (you do: `proton-us`, table `52028`), you can keep it; this is additive and Pi-only.

## Troubleshooting

- `proton.conf MISSING` → download from Proton dashboard.
- `wireproxy not found` → re-install prebuilt (see Install step 1); `wireproxy -h` should work.
- Port already in use → `ss -tln | grep 19091`, or `pkill -f '[w]ireproxy -c ~/.config/pi-vpn/wireproxy.conf'; rm ~/.config/pi-vpn/wireproxy.pid`.
- Expired → `pi-vpn --refresh`.
- `openrouter.ai` / `ifconfig.me` timeout via wrapper → dummy/invalid `proton.conf` (peer `127.0.0.1:51820` will never handshake). Use real Proton `Endpoint`; egress probe will then succeed.
