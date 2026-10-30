# Security Policy

## Supported versions

Only the latest release receives security fixes during the 0.x series.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on https://github.com/cihantopac/searvex.

Include affected version, reproduction steps and impact. We aim to acknowledge within 5 working days.

Areas of particular interest: SSRF or DNS-rebinding bypasses, path traversal or symlink escapes,
secret-file access, unsafe writes or rollback failures, XSS in HTML reports, crawler behaviour that
violates robots.txt or rate limits, and prompt-injection paths through crawled content.

The security model is documented in [docs/security.md](docs/security.md).
