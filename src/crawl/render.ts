import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { assertUrlAllowed, isAddressAllowed, type NetPolicy } from '../net/ssrf.js';
import { DEFAULT_USER_AGENT } from '../net/fetcher.js';

/**
 * Optional JavaScript rendering via Playwright. Playwright is NOT a dependency: users opt in with
 * `npm i -D playwright` (plus `npx playwright install chromium`). Without it, --render fails with
 * a clear message instead of silently degrading.
 *
 * Security: every request the page makes is checked against the same SSRF policy as the crawler;
 * disallowed requests are aborted. Downloads, popups and service workers are blocked.
 */
export interface Renderer {
  render: (url: string) => Promise<{ html: string; error?: string }>;
  close: () => Promise<void>;
}

interface PwPage {
  route: (pattern: string, handler: (route: PwRoute) => unknown) => Promise<void>;
  goto: (url: string, o: object) => Promise<unknown>;
  waitForLoadState: (state: string, o: object) => Promise<void>;
  content: () => Promise<string>;
  close: () => Promise<void>;
  on: (ev: 'popup', fn: (p: PwPage) => void) => void;
}
interface PwRoute {
  request: () => { url: () => string; resourceType: () => string };
  abort: () => Promise<void>;
  continue: () => Promise<void>;
}
interface PwBrowser {
  newContext: (o: object) => Promise<{ newPage: () => Promise<PwPage>; close: () => Promise<void> }>;
  close: () => Promise<void>;
}

/**
 * Resolve and validate the host before the browser connects. The browser resolves DNS again,
 * so a rebinding window remains in render mode; this is documented in docs/SECURITY.md.
 */
async function assertResolvable(host: string, policy: NetPolicy): Promise<void> {
  const h = host.replace(/^\[|\]$/g, '');
  if (isIP(h)) return;
  const addrs = await dns.lookup(h, { all: true });
  if (addrs.some((a) => !isAddressAllowed(a.address, policy))) throw new Error(`Blocked address for ${h}`);
}

export interface RenderStats {
  pages: number;
  blockedRequests: number;
  skippedResources: number;
}

/** Resource types that never affect the indexable DOM; skipping them saves bandwidth and time. */
const SKIPPED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
const MAX_REQUESTS_PER_PAGE = 300;

export async function createRenderer(policy: NetPolicy, timeoutMs = 30000): Promise<Renderer & { stats: RenderStats }> {
  let chromium: { launch: (o: object) => Promise<PwBrowser> };
  try {
    const modName = 'playwright';
    ({ chromium } = (await import(modName)) as { chromium: typeof chromium });
  } catch {
    throw new Error('--render requires Playwright: run "npm i -D playwright && npx playwright install chromium" in your project (or globally).');
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT, serviceWorkers: 'block', acceptDownloads: false, javaScriptEnabled: true });
  const stats: RenderStats = { pages: 0, blockedRequests: 0, skippedResources: 0 };
  return {
    stats,
    async render(url: string) {
      const page = await context.newPage();
      // Scripts may open popups/new windows; close them immediately (only this page's popups).
      page.on('popup', (p) => void p.close().catch(() => {}));
      stats.pages++;
      let requests = 0;
      try {
        await page.route('**/*', async (route) => {
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
            const u = assertUrlAllowed(req.url(), policy);
            await assertResolvable(u.hostname, policy);
            return route.continue();
          } catch {
            stats.blockedRequests++;
            return route.abort();
          }
        });
        // Wait for the DOM, then give scripts a bounded window to settle: sites with long-polling or
        // streaming connections never reach "networkidle".
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        return { html: await page.content() };
      } catch (e) {
        return { html: '', error: (e as Error).message.split('\n')[0] };
      } finally {
        await page.close();
      }
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
