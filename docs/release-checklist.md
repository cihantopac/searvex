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
| Search Console CSV/ZIP import | ✅ **supported** | real TR + EN exports of the same domain property (2026-11-01): identical analysis; 2 data-integrity defects found and fixed |
| Search Console API (own Desktop OAuth client) | ✅ **supported** | live 2026-11-01: OAuth, refresh, keychain storage, property list, pagination, report, CSV parity, leak scan; revoke mock-tested only (owner kept the grant) |
| Bing Webmaster API (API key) | 🔄 experimental | live 2026-11-01: key storage, sites, reports, errors, leak scan ✅; parsing of real non-empty query/page data pending (the 8 sites have no Bing impressions yet) |
| CrUX API | ✅ **supported** | live 2026-11-01: key storage, 10 origins (7 without data → not measured), parsing identical to raw JSON, audit integration, errors, leak scan |
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
| S12 | Rule base re-verified against current official sources; heuristics labelled | ✅ | `rules check-sources` 2026-11-01: 64 sources, 0 need review (one bot challenge, previous verified snapshot kept); Google's hreflang language-code wording re-read and the rule adjusted (quality.md round 8); 90 rules, 0 validation errors |
| S13 | Dependency audit and licence check clean | ✅ | `npm audit` (runtime and dev): 0 vulnerabilities; 36 bundled runtime packages, all MIT/ISC/BSD-2-Clause; licence texts in `THIRD_PARTY_NOTICES.md` (CI checks it is current) |

## P1 — product completeness

| # | Criterion | Status | Evidence |
|---|---|---|---|
| P1 | Real-world audit round on the permitted 7-site product family (raw + render) | ✅ | quality.md round 7: raw (4 defects fixed, before/after) and `--render` (3 defects fixed; client-side locale switch confirmed in a real browser) |
| P2 | Independent sites (not the product family) audited and reviewed for false positives | ✅ | 6 sites of different types (quality.md round 8); 2 defects fixed |
| P3 | Local repositories audited (Laravel, React, Next.js, monorepo) | ✅ | 5 local repositories (Next.js, Laravel + static monorepo, 3 CLI tools): 11 defects fixed, quality.md round 6; plus 4 open-source repositories in earlier rounds. Not covered: the product-family repositories (on the owner's Windows PC) |
| P4 | Facet / pagination / parameter-explosion detection documented with its limits | ✅ | `crawl.facet-explosion`, `pagination.canonical-to-first` |
| P5 | Research distinguishes market hypotheses from verified demand | ✅ | research report marks content gaps as hypotheses (coverage, not demand); the research skill labels each opportunity Hypothesis / Verified demand and ranks connected search data first |
| P6 | GEO: no score is presented as a prediction of AI citations | ✅ | wording scan of sources, reports, skills, agents and rules: the clarity score is labelled "heuristic, not a citation predictor"; AI citations are "not measured" |
| P7 | Onboarding: Google / CSV / skip offered exactly; non-interactive defaults to skip | ✅ | `connect` tests; plugin skill text |

## Distribution & release engineering

| # | Criterion | Status | Evidence |
|---|---|---|---|
| D1 | Clean install of the packed tarball on Linux, macOS, Windows | ✅ | local clean install (37 packages, CLI driven end to end); `clean-install` CI job on all three OSes |
| D2 | Bundled plugin CLI equals the sources | ✅ | `bundle-in-sync` CI job |
| D3 | `claude plugin validate .` passes; plugin icon and marketplace metadata complete | ⛔ | validation passes; the only warning is the missing icon. The directory takes the icon only on first submission, so it must be the owner's final brand mark (brand work in progress). Not blocking for npm; blocking for directory submission |
| D4 | Versions and claims consistent across package, plugin, README, CHANGELOG, docs | ✅ (automated) | `docs-consistency.test.ts`, `version.test.ts` |
| D5 | Performance and memory measured for small / medium / large sites | ✅ | 500 / 5,000 / 20,000 / 50,000 pages (1.1 GB at 50k); no regression vs v0.7.0 under identical load; real sites 13–111 s at polite settings (quality.md) |
| D6 | Reproducible package: two builds produce the same tarball contents | ✅ | two clean builds + `npm pack`: 202 files, identical SHA-256; no private files in the package |
| D7 | Release notes, changelog, security assessment, final readiness report | ✅ | [release-notes-1.0.0.md](release-notes-1.0.0.md), CHANGELOG 1.0.0, [security.md](security.md), readiness report below |
| D8 | Owner approval for npm publish and GitHub release | ✅ | approved 2026-11-01; `searvex-seo@1.0.0` published by the owner, GitHub release v1.0.0 created |

## Readiness report (2026-11-01)

**Recommendation: ready for a 1.0.0 release once the owner approves publishing** (D8). Every blocking
criterion above is ✅ with evidence. Open items and why they do not block 1.0.0:

| Item | Status | Why not blocking |
|---|---|---|
| Bing Webmaster | experimental | works end to end live; real non-empty data not yet available on the owner's sites. Documented as experimental everywhere |
| `gsc logout` revocation | mock-tested | the owner kept the live grant; the CLI explains manual removal if Google does not confirm |
| Plugin directory icon | owner's brand decision | npm and marketplace installs work without it; required only for directory submission |
| Product-family repositories | not audited | on another machine; the same frameworks were validated on other repositories |
| Login-protected routes in repository mode | limitation | documented; affects low-severity metadata findings only |

Security assessment: no known release-blocking defect. Residual risks (documented in security.md): browser
zero-days in `--render` (mitigated by the OS sandbox and the policy proxy), a page can use one CPU core until its
deadline, the default credential file is plain JSON readable by the same user (the keychain store is opt-in).

Release steps that need the owner: merge the readiness PR, approve `npm publish` of `searvex-seo@1.0.0` and the
GitHub release `v1.0.0` (tag + these release notes).
