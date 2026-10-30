---
description: Apply safe, framework-aware SEO fixes to the current repository with Searvex - dry-run diff, explicit user approval, automatic verification and rollback. Drafts judgement-based changes (titles, descriptions, alt text) for review.
argument-hint: "[path] [--site-url https://example.com] [--lang en] [--only ruleId]"
allowed-tools: Bash(node *) Bash(searvex *) Bash(git status *) Bash(git diff *) Read Grep Glob Edit
---

Workflow — never skip the approval step:

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
4. **Verify.** Re-run `audit <path>` and report before/after for the affected rules.

Never modify `.env`/secret files, never commit or push unless the user asks, and keep changes minimal.
