# NusaDesk

**Open-source, self-hostable remote desktop for macOS and Windows.**
Connect to another computer by its 9-digit ID, see its screen in real time, control
mouse and keyboard, sync the clipboard and send files, all peer-to-peer and
end-to-end encrypted. You run the small signaling server yourself.

🇮🇩 [Baca dalam Bahasa Indonesia](README.id.md)

> **Status:** early release (v1.x). It works and is tested, but has not had an
> external security audit yet. Read the [security model](#security-model) before
> using it for anything sensitive.

## Features

- **9-digit device ID** and a **session password** that changes on every launch
- **Approval prompt**: without a password, the person at the computer must click *Accept*
- **Unattended access** with a permanent password (stored as a derived key in Keychain / DPAPI)
- **Real-time screen** over WebRTC (H.264, falls back to VP9/VP8), P2P, DTLS-SRTP encrypted
- **Full remote control**: mouse, scroll, right click, drag, every key incl. modifiers
- **File transfer** both ways: button or drag & drop, progress, accept/decline, received files are marked as downloaded from the internet
- **Clipboard**: one-off "send clipboard", plus opt-in two-way sync
- **Multi-monitor**, quality modes, view-only mode, full screen, live connection stats
- **Verification code** on both screens to detect a man-in-the-middle
- **Always-on-top bar** on the controlled computer with a *Disconnect* button

## How it works

```
 ┌──────────── Viewer ────────────┐         ┌──────────── Host ─────────────┐
 │ viewer.js  <video> + input     │◀═══════▶│ host.js   screen capture       │
 │                                │ WebRTC  │ main.js   OS input injection   │
 └───────────────┬────────────────┘  P2P    └───────────────┬────────────────┘
                 │      SDP / ICE (JSON over WebSocket)      │
                 └───────────────▶  signaling server  ◀──────┘
                                (pairs IDs, relays signaling only)
```

| Part | Technology |
|---|---|
| Desktop app (`app/`) | Electron, plain HTML/CSS/JS, WebRTC, [`@jitsi/robotjs`](https://github.com/jitsi/robotjs) for input |
| Signaling server (`server/`) | Node.js + [`ws`](https://github.com/websockets/ws), Docker |

The signaling server only introduces the two devices and relays connection
metadata. **Screen, input, files and passwords never pass through it.**

## Quick start

### 1. Run a signaling server

Every device that should reach each other must use the same server.

```bash
# Internet (automatic HTTPS with Caddy; needs a domain pointing at the machine)
cd server/selfhost
DOMAIN=remote.example.com docker compose up -d
# → wss://remote.example.com

# Local network only
cd server
docker compose up -d --build
# → ws://<this-machine-ip>:8787
```

Details, reverse-proxy examples and TURN: [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

### 2. Install the app

Download an installer from [Releases](https://github.com/arieansyah/nusadesk/releases)
or [build it yourself](#building). On first launch, enter your server address
(`wss://…` or `ws://…`).

| Platform | File |
|---|---|
| macOS Apple Silicon | `NusaDesk-<version>-arm64.dmg` |
| macOS Intel | `NusaDesk-<version>.dmg` |
| Windows | `NusaDesk.Setup.<version>.exe` (installer) or `NusaDesk.<version>.exe` (portable) |

The builds are not code-signed yet. On macOS open the app with *right click → Open*.
On Windows choose *More info → Run anyway*.

**macOS permissions:** to be controlled, the host needs **Screen Recording** and
**Accessibility** (*System Settings → Privacy & Security*). The app shows a banner
with a shortcut when one is missing.

### 3. Connect

1. On the computer to be controlled: share its **ID** and **session password**
   (or leave the password out and click *Accept* when the request arrives).
2. On your computer: enter the ID (and the password), then click **Connect**.
3. Optional: check that both screens show the same **verification code**.

## Development

Requirements: Node.js 22+ (and Docker to run the server image).

```bash
# signaling server
cd server && npm install && npm start            # ws://localhost:8787

# app (dev run; the NUSADESK_SERVER override only works in dev)
cd app && npm install
NUSADESK_SERVER=ws://localhost:8787 npm start
```

Tests:

```bash
cd server && npm test   # security rules: lockouts, rate limits, no password relay
cd app && npm test      # end-to-end: server + two app instances (fake screen):
                        # auth ok / wrong password, verification code, file transfer,
                        # quarantine flag, encrypted unattended key
```

### Building

```bash
cd app
npm run dist:mac        # dist/NusaDesk-<v>-arm64.dmg, dist/NusaDesk-<v>.dmg
npm run dist:win        # dist/NusaDesk Setup <v>.exe, portable .exe
```

To ship a build that already points at your server:

```bash
npx electron-builder --mac -c.extraMetadata.nusadeskDefaultServer=wss://remote.example.com
```

Pushing a tag `v*` builds macOS and Windows installers in GitHub Actions and attaches
them to a GitHub Release (`.github/workflows/release.yml`).

## Security model

- **Passwords never reach the server.** Both sides derive
  `K = PBKDF2-SHA256(password, salt, 210 000)`. Once the encrypted WebRTC connection
  exists, the viewer sends `HMAC(K, nonce | host DTLS fingerprint | viewer DTLS fingerprint)`
  inside it. A server that swaps certificates (man-in-the-middle) produces a proof that
  fails, and the host shares nothing (screen, input, clipboard, files) until a proof
  verifies.
- **Verification code:** both sides show a 6-digit code derived from both DTLS
  fingerprints. Different codes mean the connection is being intercepted. This is the
  protection for approval-mode sessions, which have no shared secret.
- **Server limits:** per-IP rate limits (connections, new IDs, requests, message
  floods), at most 3 pending requests per host, wrong-password lockout for 15 min
  (5 per IP+host, 20 per IP, 50 per host), device-ID ownership keys, inactive IDs
  expire after 180 days.
- **App hardening:** Electron fuses (no `RunAsNode`, `NODE_OPTIONS`, `--inspect`;
  asar integrity), context isolation + sandbox, CSP, navigation and pop-ups blocked,
  `NUSADESK_*` dev switches ignored by installed builds.
- **Privacy:** clipboard sync is off by default, incoming files from the host need
  consent, received files get the macOS quarantine flag / Windows Mark-of-the-Web,
  the host can disable incoming files.

**Known limitations:**
- Builds are not code-signed/notarized and there is no auto-update yet.
- Someone controlling your signaling server and intercepting a password proof could
  try to guess the password offline. Use long passwords: the active attack itself
  fails and is visible.
- Peer-to-peer means both public IP addresses are visible to each other.
- Some networks block direct connections; a TURN server is then required.

Found a vulnerability? Please follow [SECURITY.md](SECURITY.md). Don't open a public issue.

## Roadmap ideas

Audio, chat, session recording, remote file browser and folder transfer, TURN
configuration in the UI, Linux host support, UI translations (the UI is currently in
Indonesian), code signing and auto-update. Contributions welcome!

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

NusaDesk is licensed under the [GNU Affero General Public License v3.0](LICENSE)
(`AGPL-3.0-only`). If you modify it and offer it to others, including as a hosted
service, you must publish your changes under the same license.
