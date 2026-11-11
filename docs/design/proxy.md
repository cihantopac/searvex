# Design note: upstream (corporate) proxy

Status: **proposal, awaiting owner approval** (1.3.0 plan D1b, decision O7). Implementation (plan E1) starts only
after approval. Tracks Frameva SEARVEX-007.

## Problem

Some users can reach the internet only through an HTTP(S) proxy (corporate networks, CI runners, sandboxed
engines such as Frameva's). Searvex connects directly today, so it cannot audit anything from those networks.

A proxy changes the security model. Today, `guardedLookup` checks the **exact address the socket connects to**,
inside the socket `lookup` hook ([docs/security.md](../security.md)), which closes the DNS-rebinding window.
Through a proxy, the proxy resolves the name and connects: Searvex never sees the connected address. The proxy may
also sit inside a network with internal services Searvex must never reach on a user's behalf.

## Goals

- Audit public sites from behind a proxy, for `audit`, `geo`, `monitor`, `run`, `research`, `ecosystem`,
  `--check-external`, `rules check-sources` and `--render`.
- Keep every existing control (`--allow-private`, `--allow-host`, `--deny-host`, `--ports`, robots.txt, rate
  limits) unchanged in meaning.
- Never let the proxy become a way to reach private or internal targets.

Non-goals: SOCKS proxies, PAC files, NTLM/Kerberos proxy authentication, proxy chains.

## Proposal

### Configuration

- `--proxy <url>`: `http://host:port` or `https://host:port`. Userinfo (`http://user:pass@host:port`) is accepted
  for Basic proxy authentication only.
- Environment: `HTTPS_PROXY` / `https_proxy`, then `HTTP_PROXY` / `http_proxy`, and `NO_PROXY` / `no_proxy`. An
  explicit `--proxy` wins over the environment, and `--proxy none` ignores it.
- `NO_PROXY`: comma-separated host suffixes (`.example.com`, `example.com`), exact IPs, `host:port`, or `*`.
  URLs that match go direct, with today's controls.

### CONNECT only

Every request through the proxy, `http:` and `https:`, uses a `CONNECT host:port` tunnel. Searvex never sends
absolute-form `GET http://…` requests to the proxy.

- One code path for both schemes: the policy decision is always made on `host:port` before `CONNECT`.
- TLS runs end to end between Searvex and the site (SNI and certificate checks against the real host name). The
  proxy cannot read or change HTTPS traffic, and it never sees `Authorization` or cookies.
- The proxy cannot serve cached or rewritten HTTP responses as if they came from the site.

### The proxy endpoint itself

- Scheme `http:` or `https:` only. With `https:`, the TLS connection to the proxy is verified like any other.
- The proxy may be a private address (corporate proxies usually are): it was configured explicitly, so
  `--allow-private` does not apply to it.
- It may **never** be link-local or a cloud metadata address (169.254.0.0/16, fe80::/10), and never a host
  denied by `--deny-host`. An environment proxy must also pass this check; a bad one is a usage error (exit `2`)
  that names the variable.
- Proxy credentials are sent only to the proxy (`Proxy-Authorization`). They are never logged, and they are
  redacted from `meta.json`, reports, `--progress` events and errors.

### No private targets through the proxy

The SSRF policy is checked on the **target before `CONNECT`**:

1. Static checks as today: scheme, `--ports`, `--allow-host` / `--deny-host`, IP literals, local host names.
2. A private, loopback or reserved IP literal is **never** sent through the proxy. With `--allow-private` it
   goes direct (a local dev server); without it, it is blocked as today.
3. **Local pre-resolution.** Searvex resolves the host name itself with the same rules as `guardedLookup`. If
   any answer is not allowed (private, loopback, link-local, reserved), the URL is blocked before `CONNECT`. This
   catches internal names that also resolve inside the user's network.
4. Then `CONNECT <hostname>:<port>`. The proxy resolves the name again.

**Residual risk (documented):** between step 3 and the proxy's own lookup, or when the proxy's DNS view differs
from the local one (split-horizon DNS), the proxy may resolve a name to an internal address. Searvex cannot
observe that. Two mitigations are proposed:

- `--proxy-resolve local` (strict mode): `CONNECT` to the IP address Searvex resolved and validated, while TLS
  still uses the host name for SNI and certificate checks. This keeps today's rebinding guarantee, but it breaks
  proxies that filter by host name and networks where local DNS cannot resolve public names. Default:
  `--proxy-resolve proxy`, which is the four steps above.
- If local resolution fails (a DNS-less sandbox), step 3 is skipped only when the user passes
  `--proxy-resolve proxy`. The report then says that targets were resolved by the proxy and not checked by
  Searvex.

### `--render`

The local policy proxy stays the browser's only exit. Its upstream connections, which are today
`net.connect(..., lookup: guardedLookup)`, become `CONNECT` tunnels through the upstream proxy. The same
target checks apply to every request, redirect hop and WebSocket. The browser never learns the upstream proxy or
its credentials.

### Errors and exit codes

| Situation | Result |
|---|---|
| Proxy URL invalid, link-local, denied, or an unsupported scheme | Usage error, exit `2` |
| Proxy answers `407` (credentials missing or wrong) | Usage error, exit `2`: "proxy authentication failed" |
| Proxy unreachable (DNS, TCP, TLS to the proxy) | Runtime error, exit `3`: "proxy unreachable"; not reported as the site being unreachable |
| Proxy refuses `CONNECT` to the target (403, 502, 504) | That URL fails with `proxy refused CONNECT (HTTP n)`; for the start URL it is `crawl.status: "unreachable"`, exit `4`, with the proxy named in `crawl.error` |

### Reporting

The report states that a proxy was used (`crawl.proxy: { host, resolve: 'proxy' | 'local' }`, without
credentials), and the limitations list the residual DNS risk in `proxy` mode. Response times measured through a
proxy include the proxy hop; the report says so next to TTFB.

## Tests (for E1)

- A local `CONNECT` proxy fixture that counts requests and records `CONNECT` targets.
- `https:` and `http:` targets go through `CONNECT`, and no absolute-form request reaches the proxy.
- Private IP literal, `localhost`, and a host name that resolves to 127.0.0.1 are blocked before `CONNECT` (the
  fixture sees no request). With `--allow-private`, a local target goes direct.
- `--deny-host`, `--allow-host` and `--ports` are applied before `CONNECT`.
- `NO_PROXY` bypass: suffix, exact host, `*`.
- `--proxy-resolve local` sends `CONNECT <ip>:<port>`, and TLS still validates the host name.
- `407`, an unreachable proxy and a refused `CONNECT` give the documented exit codes. Credentials appear in no
  output file, event or error.
- `--render` through the upstream proxy: browser requests leave only through the policy proxy, then the
  upstream proxy.
- An environment proxy pointing at 169.254.169.254 is rejected.

## Decisions for the owner

1. Approve **CONNECT-only** (no absolute-form HTTP through the proxy).
2. Default resolution mode: **`proxy`** (pre-resolve locally, then `CONNECT` by host name; works with
   host-filtering proxies; small documented residual risk), or **`local`** (strict, may break some proxies).
   Recommendation: `proxy` by default, `local` opt-in.
3. Honour `HTTPS_PROXY` / `NO_PROXY` from the environment by default (recommended: yes, as most CLI tools do;
   `--proxy none` opts out).
4. Proxy authentication: Basic only in E1 (recommended); NTLM/Kerberos stays out of scope.
