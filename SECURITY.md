# Security Policy

## Supported versions

| Version | Security fixes |
|---|---|
| 1.x, latest minor (currently 1.3) | Yes |
| Earlier 1.x minors | No: upgrade to the latest 1.x (minor releases keep the CLI and the report schema compatible, see [docs/schema.md](docs/schema.md)) |
| 0.x | No |

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on https://github.com/cihantopac/searvex.

Include affected version, reproduction steps and impact. We aim to acknowledge within 5 working days.

Areas of particular interest: SSRF or DNS-rebinding bypasses, path traversal or symlink escapes,
secret-file access, unsafe writes or rollback failures, XSS in HTML reports, crawler behaviour that
violates robots.txt or rate limits, and prompt-injection paths through crawled content.

The security model is documented in [docs/security.md](docs/security.md).
