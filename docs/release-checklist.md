# v1.0.0 release-readiness checklist

Resumable checklist for the v1.0.0 release candidate. A criterion is ✅ only with the evidence listed next
to it (a test, a command output, a real-world run recorded in [quality.md](quality.md)). The version
number in `package.json` changes to 1.0.0 only when every **blocking** row is ✅ or explicitly moved out of
the v1.0.0 scope in [limitations.md](limitations.md).

Status: ✅ verified · 🔄 in progress · ⬜ open · ⛔ blocked on the owner (external accounts) · ➖ out of v1.0 scope

## Scope decision for v1.0.0

| Area | v1.0.0 | Evidence required |
|---|---|---|
| Website audit (crawl, technical SEO, structured data, GEO, content, reports) | in scope | fixtures + independent real sites |
| Repository audit + optimizer (dry run, apply, verify, rollback) | in scope | fixtures + real repositories |
| Research, ecosystem, monitor | in scope | fixtures + real sites |
| `--render` (Playwright, optional dependency) | in scope | render CI job + adversarial tests |
| Search Console CSV/ZIP import | in scope | real TR + EN exports from the owner |
| Search Console API (own Desktop OAuth client) | in scope only after a live run | live OAuth, refresh, revoke, property list, report |
| Bing Webmaster API (API key) | in scope only after a live run | live report on a verified site |
| CrUX API | in scope only after a live run | live origin query |
| GA4, Yandex Webmaster, PSI/Lighthouse, AI-search performance data | ➖ (documented as not implemented) | — |

An integration without a live run is shipped as **experimental** (documented, not advertised as
supported) rather than delaying the release — owner decision 2026-10-31. Marked in the README table,
`searvex --help` and [limitations.md](limitations.md).

## P0 — security, correctness, data integrity (blocking)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| S1 | Search data is never joined with an audit of another website — every command | ✅ | `property.test.ts`, `gsc.test.ts`; `monitor --import` / `--site-url` / `SEARVEX_GSC_SITE` / `--baseline` now checked (`monitor-property.test.ts`, 9 cases) |
| S2 | An export that cannot be attributed to a website is refused (no pages table and no `--property`) | ✅ | `monitor-property.test.ts` |
| S3 | SSRF: private, loopback, link-local, metadata (v4/v6/NAT64/mapped), numeric encodings, trailing-dot local names, credentials in URLs | ✅ | `ssrf.test.ts` (47 cases); connection-time DNS check verified against `*.nip.io` rebinding names (0 hits on the local server) |
| S4 | Renderer: redirects, WebSockets, popups, frames, WebRTC cannot reach forbidden targets | ✅ | `render.test.ts` isolation suite (forbidden server receives 0 requests) |
| S5 | Renderer: a page whose scripts never yield or allocate without bound cannot stall the audit | ✅ | Found in this round (render hung > 40 s, indefinitely); hard per-page deadline + browser restart; `render.test.ts` resource-limit suite |
| S6 | Optimizer: an interrupted apply is recoverable (journal before first write) | ✅ | `repository.test.ts` "recovers an interrupted apply" |
| S7 | Optimizer: failed verification never overwrites edits made after apply | ✅ | auto-undo no longer uses `force`; conflicting files are listed instead |
| S8 | Optimizer: partial write failures leave the tree byte-identical | ✅ | `repository.test.ts` "undoes a partially applied change" |
| S9 | Optimizer: line endings and file modes preserved | ✅ | CRLF and permission-bit tests |
| S10 | Credentials never appear in logs, reports or run directories | ✅ | `gsc.test.ts` leak scan: all console output + every run file of an authorised session; 0 occurrences |
| S11 | Credential storage reviewed (file 0600 + OS keychain option) | ✅ | opt-in keychain via OS tools, no new dependencies; `credentials.test.ts`; real macOS Keychain run locally; real DPAPI in Windows CI |
| S12 | Rule base re-verified against current official sources; heuristics labelled | 🔄 | `rules check-sources` run + manual review of changed sources |
| S13 | Dependency audit and licence check clean | ⬜ | `npm audit --omit=dev`, licence list in the release notes |

## P1 — product completeness

| # | Criterion | Status | Evidence |
|---|---|---|---|
| P1 | Real-world audit round on the permitted 7-site product family (raw + render) | ⬜ | quality.md round 6 |
| P2 | Independent sites (not the product family) audited and reviewed for false positives | ⬜ | ≥ 5 sites of different types |
| P3 | Local repositories audited (Laravel, React, Next.js, monorepo) | ⬜ | owner's local projects, results anonymised |
| P4 | Facet / pagination / parameter-explosion detection documented with its limits | ✅ | `crawl.facet-explosion`, `pagination.canonical-to-first` |
| P5 | Research distinguishes market hypotheses from verified demand | 🔄 | labels in research output; review in this round |
| P6 | GEO: no score is presented as a prediction of AI citations | 🔄 | wording review of reports and skills |
| P7 | Onboarding: Google / CSV / skip offered exactly; non-interactive defaults to skip | ✅ | `connect` tests; plugin skill text |

## Distribution & release engineering

| # | Criterion | Status | Evidence |
|---|---|---|---|
| D1 | Clean install of the packed tarball on Linux, macOS, Windows | ✅ (CI) | `clean-install` job; extend to all three OSes |
| D2 | Bundled plugin CLI equals the sources | ✅ | `bundle-in-sync` CI job |
| D3 | `claude plugin validate .` passes; plugin icon and marketplace metadata complete | 🔄 | icon missing |
| D4 | Versions and claims consistent across package, plugin, README, CHANGELOG, docs | ✅ (automated) | `docs-consistency.test.ts`, `version.test.ts` |
| D5 | Performance and memory measured for small / medium / large sites | ⬜ | `npm run benchmark` results in quality.md |
| D6 | Reproducible package: two builds produce the same tarball contents | ⬜ | hash comparison script |
| D7 | Release notes, changelog, security assessment, final readiness report | ⬜ | `docs/release-notes-1.0.0.md` |
| D8 | Owner approval for npm publish and GitHub release | ⛔ | never done without explicit approval |

## Blocked on the owner

See the private owner guide (`.searvex/setup/OWNER_ACTION_PLAN_TR.md`, not in the repository). Live runs
need: a Desktop OAuth client and verified Search Console properties, real Search Console CSV exports
(Turkish and English UI), a Bing Webmaster API key, a CrUX API key, and the parent directory of the local
repositories to audit.
