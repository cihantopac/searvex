import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { laravelAuthRanges, laravelRoutePrivate, matcherPrefixes, nextPrivacy } from '../../src/repo/private-routes.js';
import { auditRepository } from '../../src/repo/audit.js';
import { summaryText } from '../../src/cli.js';

const dirs: string[] = [];
const repo = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-private-'));
  dirs.push(dir);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const WEB_PHP = `<?php
use Illuminate\\Support\\Facades\\Route;

Route::get('/', fn () => view('home'));
Route::get('/pricing', fn () => view('pricing'));

Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('/dashboard', fn () => view('dashboard'));
    Route::prefix('settings')->group(function () {
        Route::get('/profile', fn () => view('profile'));
    });
});

Route::group(['middleware' => 'auth:sanctum'], function () {
    Route::get('/billing', fn () => view('billing'));
});

Route::get('/orders', fn () => view('orders'))->middleware('auth');
Route::get('/blog', fn () => view('blog'))->middleware('throttle:60,1');
`;

describe('G4: detecting login-protected routes', () => {
  it('Laravel: auth middleware groups (nested, legacy array) and route chains', () => {
    const ranges = laravelAuthRanges(WEB_PHP);
    const at = (route: string) => laravelRoutePrivate(WEB_PHP, WEB_PHP.indexOf(`Route::get('${route}'`), ranges);
    expect(at('/')).toBeNull();
    expect(at('/pricing')).toBeNull();
    expect(at('/dashboard')).toBe('auth middleware group');
    expect(at('/profile')).toBe('auth middleware group');
    expect(at('/billing')).toBe('auth middleware group');
    expect(at('/orders')).toBe('auth middleware on the route');
    expect(at('/blog')).toBeNull();
  });

  it('Next.js matchers: simple paths and Clerk route matchers, never regex catch-alls', () => {
    expect(matcherPrefixes(`export const config = { matcher: ['/dashboard/:path*', '/account'] }`)).toEqual(['/dashboard', '/account']);
    expect(matcherPrefixes(`const isProtected = createRouteMatcher(['/admin(.*)'])`)).toEqual(['/admin']);
    expect(matcherPrefixes(`export const config = { matcher: ['/((?!api|_next/static|favicon.ico).*)'] }`)).toEqual([]);
    expect(matcherPrefixes(`export const config = { matcher: '/' }`)).toEqual([]);
  });

  it('Next.js: middleware without an auth signal (i18n) protects nothing', () => {
    const files = [{ rel: 'middleware.ts' }];
    const why = nextPrivacy('.', files, () => `import createMiddleware from 'next-intl/middleware'; export const config = { matcher: ['/dashboard/:path*'] }`);
    expect(why('/dashboard', 'app/dashboard/page.tsx')).toBeNull();
  });
});

describe('G4: repository audit', () => {
  it('Next.js: suppresses metadata findings on private routes and lists them', () => {
    const dir = repo({
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }),
      'app/layout.tsx': `export const metadata = { title: 'Acme' };\nexport default function L({ children }) { return <html lang="en"><body>{children}</body></html>; }`,
      'app/page.tsx': `export default function Home() { return <main>Home</main>; }`,
      'app/about/page.tsx': `export default function About() { return <main>About</main>; }`,
      'app/dashboard/page.tsx': `export default function D() { return <main>Dashboard</main>; }`,
      'app/dashboard/reports/page.tsx': `export default function R() { return <main>Reports</main>; }`,
      'app/(account)/layout.tsx': `import { auth } from '@/auth';\nimport { redirect } from 'next/navigation';\nexport default async function A({ children }) { const s = await auth(); if (!s) redirect('/login'); return children; }`,
      'app/(account)/settings/page.tsx': `export default function S() { return <main>Settings</main>; }`,
      'middleware.ts': `import { getToken } from 'next-auth/jwt';\nexport async function middleware(req) { const t = await getToken({ req }); if (!t) return Response.redirect(new URL('/login', req.url)); }\nexport const config = { matcher: ['/dashboard/:path*'] };`,
    });
    const { report } = auditRepository(dir);
    expect(report.privateRoutes?.map((r) => r.route).sort()).toEqual(['/dashboard', '/dashboard/reports', '/settings']);
    expect(report.privateRoutes?.find((r) => r.route === '/settings')?.reason).toMatch(/login-redirecting layout app\/\(account\)\/layout\.tsx/);
    expect(report.privateRoutes?.find((r) => r.route === '/dashboard')?.reason).toMatch(/auth middleware middleware\.ts \(matcher \/dashboard\)/);
    const desc = report.findings.find((f) => f.ruleId === 'description.missing')!;
    const files = desc.evidence.map((e) => e.file);
    expect(files).toEqual(expect.arrayContaining(['app/page.tsx', 'app/about/page.tsx']));
    expect(files.some((f) => /dashboard|settings/.test(f ?? ''))).toBe(false);
    expect(desc.count).toBe(2);
    expect(desc.affected?.count).toBe(2);
    expect(report.limitations.join(' ')).toMatch(/3 route\(s\) need a login.*not reported/);
    expect(summaryText(report, [])).toMatch(/Private routes \(login required; metadata and indexability not checked\): 3/);
  });

  it('Laravel: lists private routes without dropping findings of the shared route file', () => {
    const dir = repo({
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
      'artisan': '#!/usr/bin/env php',
      'routes/web.php': WEB_PHP,
      'resources/views/layouts/app.blade.php': '<!doctype html><html><head><title>@yield("title")</title></head><body>@yield("content")</body></html>',
    });
    const { report } = auditRepository(dir);
    expect(report.privateRoutes?.map((r) => r.route).sort()).toEqual(['/billing', '/dashboard', '/orders', '/profile']);
  });
});
