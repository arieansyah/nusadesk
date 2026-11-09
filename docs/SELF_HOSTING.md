# Self-hosting the signaling server

The NusaDesk app has no built-in server: you run one and enter its address in the
app (first-run screen or *Settings → Signaling server*). All devices that should
reach each other must use the **same** server.

The server is tiny (one Node.js process). It only pairs device IDs and relays WebRTC
signaling. Screen, input, files and passwords flow peer-to-peer and never touch it.

## Option A: internet, automatic HTTPS (recommended)

Requirements: a machine with Docker, a domain/subdomain pointing at it (A/AAAA
record), TCP ports 80 and 443 open.

```bash
git clone https://github.com/arieansyah/nusadesk.git
cd nusadesk/server/selfhost
DOMAIN=remote.example.com docker compose up -d
curl https://remote.example.com/health      # {"ok":true,...}
```

App setting: `wss://remote.example.com`

[Caddy](https://caddyserver.com) obtains and renews the TLS certificate. Data (device-ID
ownership) is kept in the `signaling-data` volume.

## Option B: behind an existing reverse proxy

Run only the server container, then proxy WebSocket traffic to port 8787.

```bash
cd nusadesk/server
docker build -t nusadesk-server .
docker run -d --name nusadesk --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -e TRUST_PROXY=1 -v nusadesk-data:/data \
  --read-only --tmpfs /tmp --cap-drop ALL nusadesk-server
```

**nginx:**

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 3600s;
}
```

**Traefik (Docker labels):**

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.nusadesk.rule=Host(`remote.example.com`)
  - traefik.http.services.nusadesk.loadbalancer.server.port=8787
```

**Cloudflare (proxied):** WebSockets work out of the box. The server pings every 30 s,
so idle connections stay open. With `TRUST_PROXY=1` the real client IP is taken from
`CF-Connecting-IP`.

> Only set `TRUST_PROXY=1` when clients **cannot** reach the container directly.
> Otherwise they could spoof `X-Forwarded-For` and dodge the per-IP limits.

## Option C: local network only

```bash
cd nusadesk/server
docker compose up -d --build     # or: npm install && npm start
```

App setting: `ws://<server-lan-ip>:8787`. Traffic stays inside your network; `ws://`
is unencrypted between the apps and the server, but sessions themselves are still
end-to-end encrypted and passwords are never sent to the server.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `NUSADESK_DB` | `./devices.json` (`/data/devices.json` in Docker) | Device-ID ownership store |
| `TRUST_PROXY` | off | `1` = take the client IP from `CF-Connecting-IP` / `X-Forwarded-For` |
| `LIMIT_SOCKETS_PER_IP` | `20` | Concurrent connections per IP |
| `LIMIT_NEW_IDS_PER_IP` | `20` | New device IDs per IP per hour |
| `LIMIT_CONNECT_PER_IP` | `20` | Connection requests per IP per minute |
| `MAX_DEVICES` | `200000` | Maximum stored device IDs |

Health check: `GET /health` → `{"ok":true,"online":<devices>,"sessions":<sessions>}`

## When connections fail: TURN

If the session stays at "Membuat koneksi…" and then fails, a firewall or symmetric NAT
is blocking direct peer-to-peer traffic. A TURN relay (for example
[coturn](https://github.com/coturn/coturn)) fixes this. TURN uses UDP/TCP 3478 (+ a
relay port range), so it cannot sit behind an HTTP proxy or the Cloudflare proxy.
Add it to `ICE_SERVERS` in `app/src/host.js` and `app/src/viewer.js`:

```js
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'pass' },
];
```

(Making TURN configurable in the UI is on the roadmap.)

## Updating

```bash
cd nusadesk && git pull
cd server/selfhost && DOMAIN=remote.example.com docker compose up -d --build
```
