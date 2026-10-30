# Privacy

- **Local by default.** Crawl data, reports and backups stay in `.searvex/` on your machine. Searvex has
  no telemetry and no server component.
- **What leaves your machine:** HTTP requests to the sites you audit (and, with `--check-external`, to
  linked sites); and only when you configure them: the audited origin sent to the Chrome UX Report API
  (`SEARVEX_CRUX_API_KEY`), Search Console API queries for your property (`SEARVEX_GSC_TOKEN`).
- **Credentials:** API keys and tokens from environment variables are used per run and never written to
  reports. `searvex gsc auth` stores a Google refresh token (read-only Search Console scope) in your user
  config directory (0600 on macOS/Linux; on Windows it relies on your user profile's permissions);
  `searvex gsc logout` revokes it at Google and deletes it. `searvex gsc import` reads export files locally
  and sends nothing anywhere. The per-site search-data choice (`connect`) is stored next to the credentials,
  never in the repository. Searvex ships no OAuth client:
  you create your own "Desktop app" client, so no third party is involved.
- **Repository secrets** (`.env`, keys, credentials) are never read.
- **Reports may contain page content** (titles, excerpts, URLs) of audited sites. Treat them like the
  sites themselves when sharing.
- **Claude Code plugin:** when you use the plugin, the CLI's output (reports, file excerpts) is read by
  Claude as part of your session, under your Claude Code data settings. Searvex itself sends nothing to
  Anthropic.
