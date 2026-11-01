---
description: Single step 6 of the /searvex workflow - Apply safe, framework-aware SEO fixes to the current repository with Searvex - dry-run diff, explicit user approval, automatic verification and rollback. Drafts judgement-based changes (titles, descriptions, alt text) for review.
argument-hint: "[path] [--site-url https://example.com] [--lang en] [--only ruleId]"
allowed-tools: Bash(node *) Bash(searvex *) Bash(git status *) Bash(git diff *) Read Grep Glob Edit
---

Workflow — never skip the approval step. Keep messages short: show what will change and ask; put long diffs
in a summary (files and one line each), not in the chat.

If the user pasted a **Searvex repair prompt** (generated from the HTML report), follow its steps: re-inspect
the source, reject false positives, fix root causes once, use the listed `optimize --only …` command for the
automatic part, and report per reference. Record verdicts with
`node "${CLAUDE_PLUGIN_ROOT}/dist/searvex.mjs" review <runId> <ref> confirmed|rejected|fixed --note "…"` so the
report shows them next to the original evidence.

1. **Dry run.** `node "${CLAUDE_PLUGIN_ROOT}/dist/searvex.mjs" optimize ${ARGUMENTS:-.}`
   If the output says the site URL or language is unknown, ask the user for them and re-run with
   `--site-url` / `--lang`. Show the user the automatic fixes and the `plan.patch` diff (summarise long diffs).
2. **Ask for approval** of the automatic fixes. Only after a clear yes, run the same command with
   `--apply --yes`. Searvex verifies the result and rolls back automatically if verification fails.
   Report the change id and the undo command (`rollback <changeId> <path>`).
3. **Judgement tasks** (titles, descriptions, alt text, headings, content, Organization schema):
   - Read the referenced files and the page's real content. Draft concrete changes that follow the
     project's conventions (framework metadata API, components, i18n files).
   - Use only facts that exist in the codebase or that the user confirms. No keyword stuffing,
     no invented claims, no misleading structured data.
   - Show the drafts as a diff and apply them with Edit only after the user approves.
4. **Verify.** Re-run `audit <path>` and report before/after for the affected rules in a few lines: fixed,
   remaining, rejected as false positive, needs manual action. Link the new `report.html` (its "Changes"
   tab shows the difference to the previous run).

Never modify `.env`/secret files, never commit or push unless the user asks, and keep changes minimal.
