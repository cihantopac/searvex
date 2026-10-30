// Builds the single-file plugin bundle (dist/searvex.mjs) so the Claude Code plugin and
// `npx`-less usage work without installing node_modules.
import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/searvex.mjs',
  legalComments: 'linked',
  // Playwright stays optional and is resolved at runtime from the user's project.
  external: ['playwright'],
  banner: {
    js: `// Searvex ${pkg.version} — Apache-2.0 — https://github.com/cihantopac/searvex\nimport { createRequire as __searvexCreateRequire } from 'node:module';\nconst require = __searvexCreateRequire(import.meta.url);`,
  },
  logLevel: 'info',
});
