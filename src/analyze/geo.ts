import { botAccessMatrix, type BotAccess } from '../crawl/robots.js';
import type { FindingSink } from '../rules/engine.js';
import { factsOf, isNoindex, robotsDirectives, type SiteContext } from './context.js';

export interface LlmsTxtStatus {
  url: string;
  present: boolean;
  status: number;
  bytes: number;
}

export interface AnswerabilityScore {
  url: string;
  /** 0–100. A heuristic clarity signal, NOT a prediction of AI citation or ranking. */
  score: number;
  signals: Record<string, boolean>;
}

export interface GeoReport {
  bots: Array<{ token: string; operator: string; purpose: string; allowed: boolean; explicit: boolean; docs: string | null }>;
  llmsTxt?: LlmsTxtStatus;
  entityNames: Record<string, number>;
  answerability: { average: number; pages: AnswerabilityScore[] };
  snippetRestricted: string[];
  citations: { measured: false; reason: string } | { measured: true; source: string; rows: number };
  notes: string[];
}

function answerability(ctx: SiteContext): AnswerabilityScore[] {
  const out: AnswerabilityScore[] = [];
  for (const p of ctx.indexable) {
    const f = factsOf(p)!;
    const s = f.structure;
    const signals = {
      descriptiveTitle: !!f.title && f.title.split(/\s+/).length >= 3,
      hasH1: f.headings.some((h) => h.level === 1),
      sectioned: f.headings.filter((h) => h.level === 2).length >= 2,
      questionHeadings: s.questionHeadings > 0,
      conciseParagraphs: s.paragraphs > 0 && s.avgParagraphWords <= 80,
      listsOrTables: s.lists + s.tables > 0,
      datedOrAuthored: s.hasPublishedDate || s.hasAuthor,
      structuredData: f.jsonLd.some((b) => !b.error),
      substantiveText: f.mainWordCount >= 150,
    };
    const vals = Object.values(signals);
    out.push({ url: p.url, score: Math.round((vals.filter(Boolean).length / vals.length) * 100), signals });
  }
  return out;
}

export function runGeoChecks(ctx: SiteContext, sink: FindingSink, llms?: LlmsTxtStatus): GeoReport {
  const notes: string[] = [];
  const matrix: BotAccess[] = ctx.crawl.robots.state === 'ok' || ctx.crawl.robots.state === 'missing' ? botAccessMatrix(ctx.crawl.robots, ctx.crawl.startUrl) : [];
  for (const b of matrix) {
    if (b.homepageAllowed) continue;
    if (b.bot.token === 'Googlebot' || b.bot.token === 'Bingbot') sink.emit('geo.search-bot-blocked', { url: ctx.crawl.robots.url, observed: `${b.bot.token} disallowed` });
    if (b.bot.purpose === 'ai-search' && ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot'].includes(b.bot.token)) {
      sink.emit('geo.ai-search-bot-blocked', { url: ctx.crawl.robots.url, observed: `${b.bot.token} (${b.bot.operator}) disallowed${b.explicit ? '' : ' via * group'}` });
    }
  }
  const training = matrix.filter((b) => b.bot.purpose === 'ai-training');
  if (training.length) {
    sink.emit('geo.training-bots', {
      url: ctx.crawl.robots.url,
      observed: training.map((b) => `${b.bot.token}: ${b.homepageAllowed ? 'allowed' : 'blocked'}`).join(', '),
    });
  }
  if (ctx.crawl.robots.state === 'unreachable') notes.push('robots.txt unreachable: AI crawler access could not be evaluated (RFC 9309 treats this as full disallow).');

  const snippetRestricted: string[] = [];
  for (const p of ctx.htmlPages) {
    if (isNoindex(p)) continue;
    const d = robotsDirectives(p, ['googlebot', 'bingbot']);
    const restricted = d.filter((x) => x === 'nosnippet' || x === 'max-snippet:0' || x === 'noarchive' || x === 'nocache');
    if (restricted.length) {
      snippetRestricted.push(p.url);
      sink.emit('geo.snippet-restricted', { url: p.url, observed: restricted.join(', ') });
    }
  }

  if (llms) sink.emit('geo.llms-txt', { url: llms.url, observed: llms.present ? `present (${llms.bytes} bytes) — not used by Google; no scoring impact` : `absent (HTTP ${llms.status}) — no scoring impact` });

  // Entity consistency: organisation / site names declared across pages.
  // Names are compared per role: the site/product name (WebSite.name, og:site_name) and the publishing
  // organisation (top-level Organization.name). A product site naming its parent company (e.g. via
  // parentOrganization) is not an inconsistency; nested nodes are therefore ignored.
  const entityNames: Record<string, number> = {};
  const roles: Record<'site' | 'organization', Map<string, Set<string>>> = { site: new Map(), organization: new Map() };
  const norm = (n: string) => n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const note = (role: 'site' | 'organization', name: string, url: string) => {
    const k = norm(name);
    if (!k) return;
    entityNames[name] = (entityNames[name] ?? 0) + 1;
    const set = roles[role].get(k) ?? new Set();
    set.add(`${name}|${url}`);
    roles[role].set(k, set);
  };
  for (const p of ctx.htmlPages) {
    const f = factsOf(p)!;
    for (const b of f.jsonLd) {
      const data = b.data as Record<string, unknown> | unknown[] | null;
      const roots = Array.isArray(data) ? data : data && Array.isArray((data as Record<string, unknown>)['@graph']) ? ((data as Record<string, unknown>)['@graph'] as unknown[]) : [data];
      for (const n of roots) {
        if (!n || typeof n !== 'object') continue;
        const node = n as Record<string, unknown>;
        const t = ([] as unknown[]).concat(node['@type'] ?? []);
        if (typeof node['name'] !== 'string') continue;
        if (t.includes('WebSite')) note('site', node['name'].trim(), p.url);
        else if (t.some((x) => typeof x === 'string' && /Organization|Corporation|LocalBusiness|OnlineStore|OnlineBusiness/.test(x))) note('organization', node['name'].trim(), p.url);
      }
    }
    if (f.openGraph['og:site_name']) note('site', f.openGraph['og:site_name'].trim(), p.url);
  }
  for (const role of ['site', 'organization'] as const) {
    if (roles[role].size > 1) {
      const variants = [...roles[role].values()].map((set) => {
        const [name, url] = [...set][0]!.split('|');
        return `"${name}" on ${set.size} page(s), e.g. ${url}`;
      });
      sink.emit('geo.entity-inconsistent', { observed: `${role === 'site' ? 'site name (WebSite / og:site_name)' : 'organization name'}: ${variants.join('; ')}` });
    }
  }

  const pages = answerability(ctx);
  const average = pages.length ? Math.round(pages.reduce((a, p) => a + p.score, 0) / pages.length) : 0;
  const weak = pages.filter((p) => p.score < 50);
  if (weak.length) sink.emit('geo.answerability', weak.slice(0, 50).map((p) => ({ url: p.url, observed: `clarity signals ${p.score}/100; missing: ${Object.entries(p.signals).filter(([, v]) => !v).map(([k]) => k).join(', ')}` })));

  sink.emit('geo.citations-unmeasured', { observed: 'No AI citation data source configured' });
  notes.push('Answerability is a heuristic clarity signal. Google states AI Overviews/AI Mode require no special optimisation; no citation or ranking prediction is made.');

  return {
    bots: matrix.map((b) => ({ token: b.bot.token, operator: b.bot.operator, purpose: b.bot.purpose, allowed: b.homepageAllowed, explicit: b.explicit, docs: b.bot.docs })),
    llmsTxt: llms,
    entityNames,
    answerability: { average, pages: pages.sort((a, b) => a.score - b.score).slice(0, 200) },
    snippetRestricted,
    citations: { measured: false, reason: 'No AI citation integration configured (Bing AI Performance export or Search Console data can be imported).' },
    notes,
  };
}
