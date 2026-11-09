# Security Policy

NusaDesk gives another person control over a computer, so security reports are taken
seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:
**Security → Report a vulnerability** on
[github.com/arieansyah/nusadesk](https://github.com/arieansyah/nusadesk/security/advisories/new).

Include what you found, how to reproduce it, the affected version, and the impact you
expect. You will get an acknowledgement within 7 days. Please give us a reasonable
time to release a fix before disclosing publicly; we will credit you unless you prefer
otherwise.

## Supported versions

Only the latest release receives security fixes.

## Scope

In scope:
- the desktop app (`app/`): authentication, input injection, screen capture, file and
  clipboard handling, Electron configuration
- the signaling server (`server/`): pairing, rate limiting, lockouts
- the end-to-end authentication protocol (password proof bound to DTLS fingerprints,
  verification code)

Out of scope: social engineering (someone sharing their ID and password with an
attacker), denial of service through sheer traffic volume, and third-party servers
run by other people.

The design is described in [README.md → Security model](README.md#security-model).
