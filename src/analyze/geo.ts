import { botAccessMatrix, type BotAccess } from '../crawl/robots.js';
import type { FindingSink } from '../rules/engine.js';
import { factsOf, isNoindex, robotsDirectives, type SiteContext } from './context.js';
import { typedNodes } from './structured-data.js';

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
      substantiveText: f.wordCount >= 150,
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
  const entityNames: Record<string, number> = {};
  for (const p of ctx.htmlPages) {
    const f = factsOf(p)!;
    const names = new Set<string>();
    for (const b of f.jsonLd) {
      for (const n of typedNodes(b.data)) {
        const t = ([] as unknown[]).concat(n['@type'] ?? []);
        if ((t.includes('Organization') || t.includes('WebSite') || t.includes('Corporation')) && typeof n['name'] === 'string') names.add(n['name'].trim());
      }
    }
    if (f.openGraph['og:site_name']) names.add(f.openGraph['og:site_name'].trim());
    for (const n of names) entityNames[n] = (entityNames[n] ?? 0) + 1;
  }
  const distinct = Object.keys(entityNames);
  const normalized = new Set(distinct.map((n) => n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')));
  if (normalized.size > 1) sink.emit('geo.entity-inconsistent', { observed: distinct.map((n) => `"${n}" ×${entityNames[n]}`).join(', ') });

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
