# Research log

Research notes behind Searvex design decisions. Every rule in `knowledge/rules/*.json` must
cite an official source; these notes record *how* sources were verified and what is uncertain.

| File | Topic | Date |
|---|---|---|
| [official-sources-2026-10.md](official-sources-2026-10.md) | Verification of search-engine facts against official docs | 2026-10-30 |
| [competitors-2026-10.md](competitors-2026-10.md) | Competitor & OSS landscape, differentiation | 2026-10-30 |
| [name-availability-2026-10.md](name-availability-2026-10.md) | Name / package / domain availability for "Searvex" | 2026-10-30 |
| [claude-code-plugin-format.md](claude-code-plugin-format.md) | Claude Code plugin, skill, agent, marketplace format | 2026-10-30 |

Verification levels used throughout:
- **fetched** — the official page was fetched and the statement read directly.
- **excerpt** — the page could not be fetched (e.g. Bing help pages render client-side); the
  statement was confirmed from search-engine excerpts of the official URL. Treat as lower confidence
  and re-verify manually when possible.
- **unverified** — no official documentation found. Such facts are never encoded as active rules.
