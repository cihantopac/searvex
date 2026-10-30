# Product vision

**Searvex** — AI-powered search intelligence & optimization engine. Open source (Apache-2.0),
local-first, platform-independent.

## Problem

Developers and site owners face three gaps:

1. **Trust.** SEO advice is full of myths. Commercial tools hide their checks; prompt-only AI tools
   produce different answers on every run and cite nothing.
2. **Distance from code.** Crawlers report symptoms on URLs, but the fix lives in a layout file,
   a framework metadata API or a router. Mapping one to the other is manual work.
3. **AI search confusion.** Site owners cannot tell which AI crawlers matter, what blocking them does,
   or what can actually be measured.

## Product principles

1. **Deterministic core, agent on top.** Crawling, parsing, checks, scoring and fixes are code with
   tests. The agent explains, prioritises, researches and drafts — it never invents measurements.
2. **Every rule is sourced.** Official documentation URL, check date, engine scope, verification level,
   exceptions and a verification step. Engines are never mixed.
3. **Honest measurement.** Each finding is `verified`, `heuristic` or `unmeasurable`. Unmeasurable
   metrics (AI citations, field CWV without CrUX, traffic) are reported as such.
4. **Safe by default.** Read-only analyses, polite crawling, SSRF and filesystem protections,
   transactional code changes with verification and rollback, explicit approval for anything external.
5. **Code-aware.** Findings point to `file:line`; fixes follow the framework's own idioms.
6. **No guarantees, no spam.** No ranking/indexing/citation promises; no support for manipulative tactics.

## Target users

- Developers shipping marketing sites, SaaS apps, e-commerce and docs (Next.js, Astro, Nuxt, Laravel,
  WordPress, static generators).
- Technical SEOs who want reproducible, CI-friendly audits with sources.
- Agencies needing repeatable reports and safe fix workflows.

## Success criteria

Measured by verified functionality, research accuracy, security, performance and user value — not by
file or feature counts. See [quality.md](quality.md) for the criteria and current evidence.
