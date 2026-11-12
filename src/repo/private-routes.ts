import path from 'node:path';

/**
 * Login-protected routes in repository mode (plan G4). Pages behind a login are not indexed by search engines, so
 * their metadata and indexability findings are noise; they are listed as private routes instead.
 *
 * Detection is static and deliberately conservative: a route is private only when the source shows an auth guard
 * that clearly covers it. Anything ambiguous (a catch-all middleware matcher, a regex matcher) stays public.
 */

/** Middleware arguments that require a logged-in user in Laravel (`auth`, `auth:sanctum`, `verified`). */
const LARAVEL_AUTH = /['"](auth(?::[\w-]+)?|verified)['"]/;

/**
 * Character ranges of a Laravel route file covered by an auth middleware: `Route::middleware('auth')->…->group(
 * function () { … })` and the legacy `Route::group(['middleware' => 'auth'], function () { … })`.
 */
export function laravelAuthRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of src.matchAll(/->group\s*\(\s*(?:static\s+)?function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?\{|Route::group\s*\(\s*\[([^\]]*)\]\s*,\s*(?:static\s+)?function\s*\([^)]*\)\s*\{/g)) {
    const statementStart = Math.max(src.lastIndexOf(';', m.index), src.lastIndexOf('{', m.index - 1), src.lastIndexOf('}', m.index - 1)) + 1;
    const head = m[1] !== undefined ? `'middleware' => [${m[1]}]` : src.slice(statementStart, m.index);
    const guarded = m[1] !== undefined ? /['"]middleware['"]\s*=>\s*\[?[^\]]*/.test(head) && LARAVEL_AUTH.test(m[1]!) : /->middleware\s*\(|Route::middleware\s*\(/.test(head) && LARAVEL_AUTH.test(head.slice(head.search(/middleware\s*\(/)));
    if (!guarded) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = src.length;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    ranges.push([open, end]);
  }
  return ranges;
}

/** Whether the Laravel route defined at `index` is behind an auth middleware (group or its own chain). */
export function laravelRoutePrivate(src: string, index: number, ranges: Array<[number, number]>): string | null {
  if (ranges.some(([a, b]) => index > a && index < b)) return "auth middleware group";
  const end = src.indexOf(';', index);
  const statement = src.slice(index, end === -1 ? undefined : end);
  const mw = statement.search(/->middleware\s*\(/);
  return mw !== -1 && LARAVEL_AUTH.test(statement.slice(mw)) ? 'auth middleware on the route' : null;
}

/** Signals that a Next.js middleware or layout enforces a login. */
const NEXT_AUTH_SIGNAL = /\b(auth\s*\(|getToken\s*\(|getServerSession\s*\(|currentUser\s*\(|withAuth\s*\(|clerkMiddleware|authMiddleware|\.protect\s*\(|getSession\s*\(|getUser\s*\()/;
const LOGIN_REDIRECT = /redirect\s*\(\s*[`'"]\/?(login|log-in|signin|sign-in|auth)\b/i;

/** Route prefixes from simple matcher strings (`/dashboard/:path*`, `/account`, `/admin(.*)`); regex forms are skipped. */
export function matcherPrefixes(src: string): string[] {
  const literals: string[] = [];
  const blocks = [...src.matchAll(/matcher\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/g), ...src.matchAll(/createRouteMatcher\s*\(\s*(\[[^\]]*\])/g)];
  for (const b of blocks) for (const l of b[1]!.matchAll(/['"`]([^'"`]+)['"`]/g)) literals.push(l[1]!);
  const out: string[] = [];
  for (const raw of literals) {
    const p = raw.replace(/\(\.\*\)$/, '').replace(/\/:[\w]+[*+?]?$/, '');
    // Negative lookaheads and other regex forms match "everything except …": too broad to call private.
    if (!p.startsWith('/') || /[()[\]?*+|\\]/.test(p) || p === '/') continue;
    out.push(p.replace(/\/$/, ''));
  }
  return [...new Set(out)];
}

/**
 * Next.js privacy: routes matched by an auth middleware (`middleware.ts` with a simple `matcher` or Clerk's
 * `createRouteMatcher`), and routes under a layout that redirects anonymous users to a login page.
 */
export function nextPrivacy(appRoot: string, files: Array<{ rel: string }>, read: (f: string) => string): (route: string, file: string) => string | null {
  const rel = (p: string) => (appRoot === '.' ? p : `${appRoot}/${p}`);
  const mwFile = files.find((f) => [rel('middleware.ts'), rel('middleware.js'), rel('src/middleware.ts'), rel('src/middleware.js')].includes(f.rel));
  const mwSrc = mwFile ? read(mwFile.rel) : '';
  const prefixes = mwFile && NEXT_AUTH_SIGNAL.test(mwSrc) ? matcherPrefixes(mwSrc) : [];
  const guardedDirs = files
    .filter((f) => /(^|\/)layout\.(tsx|jsx|ts|js)$/.test(f.rel))
    .filter((f) => {
      const s = read(f.rel);
      return NEXT_AUTH_SIGNAL.test(s) && LOGIN_REDIRECT.test(s);
    })
    .map((f) => ({ dir: path.posix.dirname(f.rel) + '/', file: f.rel }));
  return (route, file) => {
    const p = prefixes.find((x) => route === x || route.startsWith(x + '/'));
    if (p) return `auth middleware ${mwFile!.rel} (matcher ${p})`;
    const g = guardedDirs.find((d) => file.startsWith(d.dir));
    return g ? `login-redirecting layout ${g.file}` : null;
  };
}

/** Rules about metadata and indexability: meaningless for pages behind a login. */
export const PRIVATE_SUPPRESSED = /^(title|description|canonical|index|social|hreflang|h1)\./;
