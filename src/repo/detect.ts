import fs from 'node:fs';
import path from 'node:path';

export type Framework =
  | 'nextjs-app' | 'nextjs-pages' | 'astro' | 'nuxt' | 'sveltekit' | 'remix' | 'gatsby' | 'vite-spa' | 'cra-spa'
  | 'laravel' | 'wordpress-theme' | 'hugo' | 'jekyll' | 'eleventy' | 'static-html' | 'unknown';

export interface Detection {
  framework: Framework;
  /** Frameworks found, strongest first (monorepos can contain several apps). */
  candidates: Array<{ framework: Framework; root: string; evidence: string }>;
  /** Server-rendered or statically generated HTML is produced by default. */
  rendersHtml: boolean;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'composer';
  workspaces: string[];
}

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function has(dir: string, ...names: string[]): boolean {
  return names.some((n) => fs.existsSync(path.join(dir, n)));
}

const SSR: Framework[] = ['nextjs-app', 'nextjs-pages', 'astro', 'nuxt', 'sveltekit', 'remix', 'gatsby', 'laravel', 'wordpress-theme', 'hugo', 'jekyll', 'eleventy', 'static-html'];

/** Detect the framework of a single app directory. */
export function detectApp(dir: string, rel = '.'): Array<{ framework: Framework; root: string; evidence: string }> {
  const out: Array<{ framework: Framework; root: string; evidence: string }> = [];
  const pkg = readJson<Pkg>(path.join(dir, 'package.json'));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps['next']) {
    const appDir = has(dir, 'app', 'src/app');
    out.push({ framework: appDir ? 'nextjs-app' : 'nextjs-pages', root: rel, evidence: `next@${deps['next']}${appDir ? ' + app/ directory' : ''}` });
  } else if (deps['astro']) out.push({ framework: 'astro', root: rel, evidence: `astro@${deps['astro']}` });
  else if (deps['nuxt'] || deps['nuxt3']) out.push({ framework: 'nuxt', root: rel, evidence: `nuxt@${deps['nuxt'] ?? deps['nuxt3']}` });
  else if (deps['@sveltejs/kit']) out.push({ framework: 'sveltekit', root: rel, evidence: '@sveltejs/kit' });
  else if (deps['@remix-run/react'] || deps['@react-router/dev']) out.push({ framework: 'remix', root: rel, evidence: 'remix / react-router framework' });
  else if (deps['gatsby']) out.push({ framework: 'gatsby', root: rel, evidence: 'gatsby' });
  else if (deps['@11ty/eleventy']) out.push({ framework: 'eleventy', root: rel, evidence: '@11ty/eleventy' });
  else if (deps['react-scripts']) out.push({ framework: 'cra-spa', root: rel, evidence: 'react-scripts (client-side rendering)' });
  else if (deps['vite'] && (deps['react'] || deps['vue'] || deps['svelte'] || deps['solid-js'])) out.push({ framework: 'vite-spa', root: rel, evidence: 'vite + UI library without SSR framework' });
  const composer = readJson<{ require?: Record<string, string> }>(path.join(dir, 'composer.json'));
  if (composer?.require?.['laravel/framework']) out.push({ framework: 'laravel', root: rel, evidence: `laravel/framework@${composer.require['laravel/framework']}` });
  if (has(dir, 'style.css') && has(dir, 'functions.php')) out.push({ framework: 'wordpress-theme', root: rel, evidence: 'style.css + functions.php' });
  if (has(dir, 'wp-content/themes')) out.push({ framework: 'wordpress-theme', root: rel, evidence: 'wp-content/themes' });
  if (has(dir, 'hugo.toml', 'hugo.yaml', 'config.toml') && has(dir, 'content', 'layouts')) out.push({ framework: 'hugo', root: rel, evidence: 'hugo config + content/' });
  if (has(dir, '_config.yml') && has(dir, '_layouts', '_posts')) out.push({ framework: 'jekyll', root: rel, evidence: '_config.yml + _layouts' });
  return out;
}

export function detect(root: string): Detection {
  const candidates = detectApp(root);
  const pkg = readJson<Pkg>(path.join(root, 'package.json'));
  const ws = Array.isArray(pkg?.workspaces) ? pkg!.workspaces : pkg?.workspaces?.packages ?? [];
  const pnpmWs = fs.existsSync(path.join(root, 'pnpm-workspace.yaml')) ? (fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').match(/-\s*['"]?([^'"\n]+)['"]?/g) ?? []).map((l) => l.replace(/^-\s*['"]?|['"]?$/g, '')) : [];
  const patterns = [...ws, ...pnpmWs];
  const workspaces: string[] = [];
  for (const pattern of patterns.length ? patterns : ['apps/*', 'packages/*', 'sites/*']) {
    const base = pattern.replace(/\/\*+$/, '');
    const dir = path.join(root, base);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const children = pattern.endsWith('*') ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name)) : [base];
    for (const c of children) {
      const found = detectApp(path.join(root, c), c);
      if (found.length) workspaces.push(c);
      candidates.push(...found);
    }
  }
  const htmlFiles = ['index.html', 'public/index.html', 'dist/index.html', 'out/index.html', 'build/index.html', '_site/index.html'].filter((f) => fs.existsSync(path.join(root, f)));
  if (!candidates.length && htmlFiles.length) candidates.push({ framework: 'static-html', root: '.', evidence: htmlFiles.join(', ') });
  const framework = candidates[0]?.framework ?? 'unknown';
  const packageManager = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : has(root, 'bun.lockb', 'bun.lock') ? 'bun' : has(root, 'package-lock.json') ? 'npm' : has(root, 'composer.lock') ? 'composer' : undefined;
  return { framework, candidates, rendersHtml: SSR.includes(framework), packageManager, workspaces };
}
