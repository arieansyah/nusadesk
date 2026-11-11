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
| `TURN_SECRET` | none | Shared secret with your TURN server (`static-auth-secret` in coturn). Enables TURN together with `TURN_URLS` |
| `TURN_URLS` | none | Comma-separated TURN URLs handed to the apps, e.g. `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp` |
| `TURN_TTL` | `86400` | Lifetime of the issued TURN credentials, in seconds |

Health check: `GET /health` → `{"ok":true,"online":<devices>,"sessions":<sessions>}`

## When connections fail: TURN

If a session fails with *"Koneksi peer-to-peer gagal"*, the networks block direct
peer-to-peer traffic (mobile data and many ISPs use CGNAT, office Wi-Fi often blocks
UDP). A TURN relay fixes this: when no direct path exists, the encrypted session goes
through the relay. The relay cannot read it (DTLS/SRTP end to end, and the password
proof is bound to both peers' certificates).

The signaling server hands every session short-lived TURN credentials (the
[TURN REST API](https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00)
scheme that coturn implements with `use-auth-secret`). No TURN password ships in the
app; you only set the same secret on both servers.

1. Run [coturn](https://github.com/coturn/coturn) on a machine with a public IP
   (it can be the same one). TURN cannot sit behind an HTTP proxy or the Cloudflare
   proxy: use a DNS-only record such as `turn.example.com`.

   ```bash
   SECRET=$(openssl rand -hex 32)
   docker run -d --name turn --restart unless-stopped --network host \
     coturn/coturn:4.18.0-alpine -n --listening-port=3478 \
     --min-port=49160 --max-port=49259 --realm=example.com \
     --use-auth-secret --static-auth-secret="$SECRET" \
     --fingerprint --no-tls --no-tcp-relay --no-multicast-peers \
     --denied-peer-ip=10.0.0.0-10.255.255.255 --denied-peer-ip=172.16.0.0-172.31.255.255 \
     --denied-peer-ip=192.168.0.0-192.168.255.255 --denied-peer-ip=127.0.0.0-127.255.255.255 \
     --log-file=stdout --simple-log --userdb=/tmp/turndb
   ```

   Behind 1:1 NAT (many cloud VPS have only a private address on the interface), add
   `--external-ip=<public-ip>/<private-ip>`. The `denied-peer-ip` ranges stop the
   relay from being used to reach your private networks. A complete, hardened example
   is the `turn` service in [`server/docker-compose.prod.yml`](../server/docker-compose.prod.yml).

2. Open UDP and TCP 3478 and the relay range UDP 49160-49259 in the firewall.

3. Give the signaling server the same secret and the TURN URLs:

   ```bash
   TURN_SECRET=$SECRET \
   TURN_URLS='turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp'
   ```

   (as `environment:` in `selfhost/docker-compose.yml`, or `-e` with `docker run`).
   The server log says `TURN relay turn:...` at startup when it is enabled.

In the viewer window the connection stats end with `relay` when a session goes through
TURN and `P2P` when it is direct. A relayed session uses roughly 1-5 Mbps of the TURN
server's bandwidth, depending on the quality mode.

To test a relay end to end, run the app tests with
`NUSADESK_E2E_TURN_URLS=turn:<host>:3478 NUSADESK_E2E_TURN_SECRET=<secret> npm test`
(in `app/`): one session is forced to use only relayed paths.

## Updating

```bash
cd nusadesk && git pull
cd server/selfhost && DOMAIN=remote.example.com docker compose up -d --build
```
