# Contributing to NusaDesk

Thanks for helping! Issues and pull requests are welcome in **English or Bahasa Indonesia**.

## Getting started

```bash
git clone https://github.com/arieansyah/nusadesk.git
cd nusadesk/server && npm install && npm start          # local signaling server
cd ../app && npm install
NUSADESK_SERVER=ws://localhost:8787 npm start           # dev run of the app
```

Two instances on one machine (host + viewer) for manual testing:

```bash
NUSADESK_PROFILE=a NUSADESK_SERVER=ws://localhost:8787 npm start
NUSADESK_PROFILE=b NUSADESK_SERVER=ws://localhost:8787 NUSADESK_FAKE_SCREEN=1 npm start
```

`NUSADESK_*` switches only work in a dev run (`npm start`); installed builds ignore them.

## Before opening a pull request

```bash
cd server && npm test      # must pass
cd app && npm test         # end-to-end test, must pass (macOS or Windows desktop session)
```

- Keep changes focused; one topic per PR.
- No new runtime dependencies without discussion (open an issue first).
- Anything touching authentication, the signaling protocol, input injection or file
  handling needs a short note on the security impact in the PR description.
- UI text is currently Indonesian. New strings should be Indonesian too, until
  translations exist.
- Code style: plain modern JavaScript (no build step, no framework), 2-space indent,
  comments explain *why*.

## Project layout

```
app/                Electron desktop app (host + viewer in one)
  src/main.js       main process: config, signaling, auth checks, input injection, files
  src/host.js       host side: screen capture, WebRTC, data channels
  src/viewer.js     viewer window: remote screen, input capture
  src/transfer.js   file transfer over WebRTC data channels
  src/secure.js     WebCrypto helpers (password proof, verification code)
  test/e2e.js       end-to-end test
server/             signaling server (Node.js + ws)
  test/security.js  server security tests
  selfhost/         Docker Compose + Caddy for self-hosting
docs/               documentation
```

## Reporting security issues

Please **do not** open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[AGPL-3.0](LICENSE), the license of this project.
