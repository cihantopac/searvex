import type { Finding } from '../core/types.js';
import type { CrawlResult, PageRecord } from '../crawl/crawler.js';
import type { PageData } from '../extract/html.js';
import type { FindingSink, KnowledgeBase } from '../rules/engine.js';
import { factsOf, isNoindex, isSelfCanonical, resolveRecord, robotsDirectives, type SiteContext } from './context.js';

/**
 * Pre-launch profile (--pre-launch): the site is audited as it will be once it goes live.
 *
 * - Pages that are noindex now (meta robots or X-Robots-Tag, often set on purpose before launch) are
 *   evaluated as indexable, so every check that only runs on indexable pages still runs and the score's
 *   page base is not collapsed to zero. Their noindex is reported as a launch-checklist item instead.
 * - Findings of rules tagged `environment: server` (the test server) or `launch` (a deliberate pre-launch
 *   state) get a `context` and leave the score, --fail-on, the priorities and monitor regressions.
 */
export interface LaunchView {
  /** The crawl with noindex directives removed. */
  result: CrawlResult;
  /** Noindex directives per URL, as crawled. */
  noindex: Map<string, string[]>;
}

const NOINDEX = new Set(['noindex', 'none']);

function strip(d: string[]): string[] {
  // "none" = noindex, nofollow: keep the nofollow part.
  return d.flatMap((x) => (x === 'none' ? ['nofollow'] : NOINDEX.has(x) ? [] : [x]));
}

function stripData(d: PageData | undefined): PageData | undefined {
  if (!d) return d;
  return { ...d, metaRobots: strip(d.metaRobots), botRobots: Object.fromEntries(Object.entries(d.botRobots).map(([k, v]) => [k, strip(v)])) };
}

export function asLaunched(result: CrawlResult): LaunchView {
  const noindex = new Map<string, string[]>();
  const pages = result.pages.map((p): PageRecord => {
    if (!isNoindex(p)) return p;
    noindex.set(p.url, [...new Set(robotsDirectives(p, ['googlebot', 'bingbot']))]);
    return {
      ...p,
      xRobots: strip(p.xRobots),
      xRobotsByBot: Object.fromEntries(Object.entries(p.xRobotsByBot).map(([k, v]) => [k, strip(v)])),
      data: stripData(p.data),
      rendered: stripData(p.rendered),
    };
  });
  return { result: { ...result, pages }, noindex };
}

/** Report the noindex that `asLaunched` removed, as the technical checks would have (launch checklist). */
export function emitLaunchNoindex(ctx: SiteContext, noindex: Map<string, string[]>, sink: FindingSink): void {
  for (const p of ctx.pages) {
    const directives = noindex.get(p.url);
    if (!directives || !factsOf(p) || p.status !== 200 || p.redirects.length) continue;
    sink.emit('index.noindex', { url: p.url, observed: directives.join(', ') });
    if (p.inSitemap) sink.emit('index.noindex-in-sitemap', { url: p.url });
  }
  for (const p of ctx.htmlPages) {
    const canonical = factsOf(p)?.canonical;
    if (!canonical || isSelfCanonical(p)) continue;
    const target = resolveRecord(ctx, canonical);
    if (target && !target.blockedByRobots && target.status === 200 && !target.redirects.length && noindex.has(target.url)) sink.emit('canonical.target-noindex', { url: p.url, observed: canonical });
  }
}

/** Mark findings of environment-tagged rules; they are kept and shown separately. */
export function applyPreLaunch(findings: Finding[], kb: KnowledgeBase): void {
  for (const f of findings) {
    const env = kb.rules.get(f.ruleId)?.environment;
    if (!env) continue;
    f.context = env === 'server' ? 'environment' : 'launch-checklist';
    delete f.priority;
  }
}
