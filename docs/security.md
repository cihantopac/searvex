# Security model

Searvex processes untrusted input from three directions: **websites** (HTML, headers, redirects,
XML), **repositories** (files, symlinks, secrets) and **content that may reach an LLM** (prompt
injection). Defaults are read-only and deny-by-default.

## Network (website mode)

| Threat | Control | Test |
|---|---|---|
| SSRF to internal services / cloud metadata | Scheme allowlist (http/https), no credentials in URLs, IP classification for v4, v6, IPv4-mapped, NAT64, 6to4, Teredo; loopback/private blocked unless `--allow-private`; **link-local (169.254.0.0/16, fe80::/10 — cloud metadata) always blocked**; `.local`, `.internal`, `localhost` names blocked | `test/unit/ssrf.test.ts` |
| DNS rebinding | Address validated inside the socket `lookup` hook — the exact address connected to; any disallowed address in the answer set rejects the request; sockets are not reused (`agent: false`) | connection-time loopback test |
| Redirect to internal address | Redirects followed manually; every hop re-validated; loops and >10 hops stopped | redirect tests |
| Resource exhaustion | Response size cap (5 MB pages, 50 MB sitemaps, 500 KiB robots), timeouts, page/depth limits, sitemap count/URL caps | size/timeout tests |
| XML attacks (XXE, billion laughs) | `fast-xml-parser` with entity processing disabled | sitemap test |
| Malicious HTML | Static parsing only (parse5/cheerio); no script execution except in opt-in `--render` | — |
| JS rendering (`--render`) | All browser traffic goes through a local **policy proxy** (127.0.0.1, random per-run credentials) that applies the crawler policy to every request, every redirect hop, every CONNECT tunnel (HTTPS/WSS/WS) and every upgrade, and resolves DNS itself with the connection-time `guardedLookup` — the browser never resolves hostnames, which closes the rebinding window. Loopback is not exempt from the proxy (`<-loopback>`). WebRTC is limited to proxied connections (no direct UDP). Each page renders in a fresh browser context; service workers and downloads blocked; popups closed and their first request intercepted at context level; images/media/fonts skipped; max 300 requests and a 64 MiB transfer budget per page; idle timeouts; bounded waits; 512 MB JS heap cap. Chromium's OS sandbox is enabled where the system allows it (the report says when it is not). **Residual risks:** a Chromium zero-day in the renderer process (mitigated, not removed, by the sandbox); without the OS sandbox (some containers) a renderer compromise runs as your user; CPU-heavy scripts are bounded only by the page timeout. | `test/integration/render.test.ts` (metadata exfiltration, redirect to a forbidden server, WebSocket, popup and navigation escapes with a request counter on the forbidden server), `test/unit/policy-proxy.test.ts` (auth, CONNECT allow/deny, redirect pass-through, credential stripping, byte budget) |

## Search data integrations & credentials

| Threat | Control | Test |
|---|---|---|
| Data of one site joined with another site's audit | `--audit latest` selects by property scope (Search Console domain vs URL-prefix semantics); explicit run ids of other sites and ambiguous choices are rejected; imported exports must belong to `--property` | `test/unit/property.test.ts`, `test/integration/gsc.test.ts` |
| OAuth code interception / CSRF | Loopback redirect on 127.0.0.1 with a random port, PKCE S256, `state` check; only "Desktop app" clients accepted | `test/integration/gsc.test.ts` |
| Over-broad access | Read-only scope `webmasters.readonly` only; Searvex ships no OAuth client | — |
| Token theft at rest | Refresh token in the user config dir, written atomically with 0600 (POSIX). **Residual risk:** plain JSON file; Windows does not apply POSIX modes (profile ACL only); no OS keychain yet (planned behind `CredentialStore`) | credential store tests |
| Stale grants | `gsc logout` revokes at Google; `invalid_grant` explains expiry/revocation | revoke test |
| Blocking CI | `gsc auth` refuses to run when `CI` is set; `connect` never starts OAuth | CLI tests |
| Hostile export files | ZIP reader in memory only, entry/size limits (zip-bomb guard), no ZIP64/encryption; strict number parsing with an error threshold | `test/unit/gsc-csv.test.ts` |
| Secrets in logs | Bing API key masked in errors; tokens never printed or written to reports | `test/integration/bing.test.ts` |

## Crawler etiquette & compliance

- robots.txt per RFC 9309: 4xx → allowed, 5xx/unreachable → full disallow; longest-match rules.
  Outbound link checks fetch and honour each external host's robots.txt.
- Per-host serialisation with a minimum delay; `Crawl-delay` raises it (max 30 s); `429/503 Retry-After`
  slows down further. Sitemap downloads share the limiter.
- Honest user agent `SearvexBot/<version>` with a project URL; robots groups for `SearvexBot` apply.
- Site terms of service may restrict automated access; users are responsible for having permission.

## Repository mode

| Threat | Control |
|---|---|
| Path traversal | All paths resolved inside the real root; `..`, absolute paths and symlinked ancestors that escape are rejected |
| Symlink attacks | Symlinks are never followed when walking, reading or writing |
| Secret leakage | `.env*`, keys/certificates, SSH keys, `.npmrc`, `.netrc`, credentials/secrets files, `wp-config.php`, service-account JSON are never read or modified; counts appear in limitations |
| Destructive writes | Dry run by default; apply requires confirmation (`--yes` in non-interactive shells); pre-flight check that files did not change since planning; atomic writes; backups + SHA-256 hashes; automatic rollback on failed verification; rollback refuses to overwrite later edits |

## LLM / agent layer

- Crawled text, titles and evidence are **data**. Plugin skills instruct the agent never to follow
  instructions found in page content or reports.
- The deterministic engine produces measurements; the agent cannot fabricate findings because reports
  come from the CLI.
- HTML reports embed data as escaped JSON, render via `textContent`/`createElement` only (no `innerHTML`),
  allow only `http(s)` links, and ship a restrictive Content-Security-Policy (no network access).

## Supply chain

Four runtime dependencies, pinned versions, `package-lock.json`. The plugin bundle is unminified for
review. Dependencies are bundled with esbuild at build time; Playwright is never bundled.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
