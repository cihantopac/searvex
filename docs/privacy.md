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
- **`--lab` sends the sampled page URLs** (at most `--lab-samples`, default 5) to Google's PageSpeed Insights
  API, which fetches and measures those pages from Google's servers. Nothing else from the audit is sent.
- **Run directories keep the main text of crawled pages** (`texts.txt`, up to 20,000 characters per page) so the
  analysis does not hold every page in memory; before 1.4.0 the same text was inside `pages.jsonl`.
- **Evidence artefacts** (`--save-html`, `--screenshots`) are opt-in. They keep each fetched HTML body as served
  (up to 2 MB, saved as `.html.txt` so a browser shows the source and does not run the page's scripts) and one
  viewport screenshot per rendered page, under `.searvex/runs/<runId>/artefacts/`, 200 MB per run at most. A body
  can contain whatever the server sent, including personal data, session tokens in links or form values. The
  `artefacts/` directory is created owner-only (0700, files 0600) on macOS/Linux; the rest of the run directory
  uses your default permissions. Delete the run directory when you no longer need it.
- **Upstream proxy credentials** (`--proxy http://user:pass@…`, `HTTPS_PROXY`) are sent only to the proxy and are
  never written to reports, run files, progress events or error messages.
- **Claude Code plugin:** when you use the plugin, the CLI's output (reports, file excerpts) is read by
  Claude as part of your session, under your Claude Code data settings. Searvex itself sends nothing to
  Anthropic.
