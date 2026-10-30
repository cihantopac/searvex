import { assertUrlAllowed, type NetPolicy } from '../net/ssrf.js';
import { DEFAULT_USER_AGENT } from '../net/fetcher.js';
import { startPolicyProxy, type PolicyProxy, type PolicyProxyStats } from '../net/policy-proxy.js';

/**
 * Optional JavaScript rendering via Playwright. Playwright is NOT a dependency: users opt in with
 * `npm i -D playwright` (plus `npx playwright install chromium`). Without it, --render fails with
 * a clear message instead of silently degrading.
 *
 * Isolation (see docs/security.md):
 * - All browser traffic goes through a local policy proxy (`policy-proxy.ts`) that applies the crawler's
 *   SSRF policy to every request, redirect hop, WebSocket and tunnel, and resolves DNS itself with
 *   connection-time validation. Loopback is not exempt from the proxy.
 * - WebRTC may not use non-proxied UDP, so it cannot reach hosts around the proxy.
 * - Each page renders in a fresh browser context (no cookies or storage carried between pages, as in
 *   Google's stateless rendering); downloads, service workers and popups are blocked.
 * - Context-level request interception skips images/media/fonts and caps requests per page; it also sees
 *   the first request of popups.
 * - Chromium's own sandbox is used where the OS allows it; otherwise the fallback is recorded in stats.
 */
export interface Renderer {
  render: (url: string) => Promise<{ html: string; error?: string }>;
  close: () => Promise<void>;
}

interface PwPage {
  goto: (url: string, o: object) => Promise<unknown>;
  waitForLoadState: (state: string, o: object) => Promise<void>;
  content: () => Promise<string>;
  close: () => Promise<void>;
}
interface PwRoute {
  request: () => { url: () => string; resourceType: () => string };
  abort: () => Promise<void>;
  continue: () => Promise<void>;
}
interface PwContext {
  newPage: () => Promise<PwPage>;
  route: (pattern: string, handler: (route: PwRoute) => unknown) => Promise<void>;
  on: (ev: 'page', fn: (p: PwPage) => void) => void;
  close: () => Promise<void>;
}
interface PwBrowser {
  newContext: (o: object) => Promise<PwContext>;
  close: () => Promise<void>;
}
type Chromium = { launch: (o: object) => Promise<PwBrowser> };

export interface RenderStats {
  pages: number;
  blockedRequests: number;
  skippedResources: number;
  /** Whether Chromium's sandbox was active (false when the OS does not allow it). */
  sandbox: boolean;
  proxy: PolicyProxyStats;
}

/** Resource types that never affect the indexable DOM; skipping them saves bandwidth and time. */
const SKIPPED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
const MAX_REQUESTS_PER_PAGE = 300;

export const BROWSER_ARGS = [
  // Send loopback through the proxy too (Chromium bypasses proxies for localhost by default).
  '--proxy-bypass-list=<-loopback>',
  // WebRTC: no UDP outside the proxy, so peer connections cannot reach internal hosts directly.
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  // Bound the JavaScript heap of hostile pages.
  '--js-flags=--max-old-space-size=512',
  '--disable-background-networking',
  '--disable-sync',
  '--no-first-run',
  '--disable-extensions',
];

async function launch(chromium: Chromium, proxy: PolicyProxy): Promise<{ browser: PwBrowser; sandbox: boolean }> {
  const base = { headless: true, args: BROWSER_ARGS, proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: '' } };
  try {
    return { browser: await chromium.launch({ ...base, chromiumSandbox: true }), sandbox: true };
  } catch {
    // Some Linux setups (containers, AppArmor-restricted user namespaces) cannot start the sandbox.
    return { browser: await chromium.launch({ ...base, chromiumSandbox: false }), sandbox: false };
  }
}

export async function createRenderer(policy: NetPolicy, timeoutMs = 30000): Promise<Renderer & { stats: RenderStats }> {
  let chromium: Chromium;
  try {
    const modName = 'playwright';
    ({ chromium } = (await import(modName)) as { chromium: Chromium });
  } catch {
    throw new Error('--render requires Playwright: run "npm i -D playwright && npx playwright install chromium" in your project (or globally).');
  }
  const proxy = await startPolicyProxy(policy);
  let browser: PwBrowser;
  let sandbox: boolean;
  try {
    ({ browser, sandbox } = await launch(chromium, proxy));
  } catch (e) {
    await proxy.close();
    throw e;
  }
  const stats: RenderStats = { pages: 0, blockedRequests: 0, skippedResources: 0, sandbox, proxy: proxy.stats };
  return {
    stats,
    async render(url: string) {
      stats.pages++;
      proxy.resetBudget();
      const context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT, serviceWorkers: 'block', acceptDownloads: false, javaScriptEnabled: true, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
      let requests = 0;
      let main: PwPage | undefined;
      // Scripts may open popups/new windows; close every page other than the one being rendered.
      context.on('page', (p) => {
        if (main && p !== main) void p.close().catch(() => {});
      });
      try {
        await context.route('**/*', async (route) => {
          const req = route.request();
          if (SKIPPED_RESOURCE_TYPES.has(req.resourceType())) {
            stats.skippedResources++;
            return route.abort();
          }
          if (++requests > MAX_REQUESTS_PER_PAGE) {
            stats.blockedRequests++;
            return route.abort();
          }
          try {
            // Fast static check; the proxy enforces the full policy (DNS, redirects, tunnels).
            assertUrlAllowed(req.url(), policy);
            return route.continue();
          } catch {
            stats.blockedRequests++;
            return route.abort();
          }
        });
        main = await context.newPage();
        // Wait for the DOM, then give scripts a bounded window to settle: sites with long-polling or
        // streaming connections never reach "networkidle".
        await main.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await main.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        return { html: await main.content() };
      } catch (e) {
        return { html: '', error: (e as Error).message.split('\n')[0] };
      } finally {
        await context.close().catch(() => {});
      }
    },
    async close() {
      await browser.close().catch(() => {});
      await proxy.close();
    },
  };
}
