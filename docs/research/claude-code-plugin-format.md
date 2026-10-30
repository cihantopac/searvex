# Claude Code plugin format (verified 2026-10-30)

Sources: https://code.claude.com/docs/en/plugins/manifest-reference.md, …/plugins/components.md,
…/plugins/marketplace-reference.md, …/plugins/cli-reference.md, …/skills.md, …/sub-agents.md, …/mcp.md

- `.claude-plugin/plugin.json`: only `name` required (kebab-case). `homepage` must be a valid URL.
- Skills: `skills/<name>/SKILL.md` → `/<plugin>:<name>`. Commands (`commands/*.md`) are the legacy format; skills are recommended.
- A plugin skill's bare name "also invokes the skill unless another command already uses that name" —
  so `/searvex` *may* work via `skills/searvex`; it is not guaranteed. `/searvex:searvex` always works.
- `${CLAUDE_PLUGIN_ROOT}` is substituted in skill/command/agent Markdown bodies, hooks and MCP config —
  **not** in the Bash tool environment.
- Files in the plugin's top-level `bin/` are added to the Bash tool PATH while the plugin is enabled.
- Agents: `agents/*.md`, frontmatter `name`, `description`, optional `tools`, `model`.
- Marketplace: `.claude-plugin/marketplace.json` with `name`, `owner`, `plugins[{name, source: "./"}]`.
  Install: `/plugin marketplace add cihantopac/searvex` then `/plugin install searvex@searvex`.
- Validation: `claude plugin validate . [--strict] [--json]` (exit 0 ok, 1 fail, 2 error).
- Local dev: `claude --plugin-dir .`.
- Plugins do not run `npm install`; Searvex ships a **single-file bundle** (`dist/searvex.mjs`, committed in
  release artifacts) so the plugin works without installing dependencies.
