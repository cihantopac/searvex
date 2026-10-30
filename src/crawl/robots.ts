import robotsParserModule from 'robots-parser';
import { safeFetch, type FetchOptions } from '../net/fetcher.js';

interface RobotsParser {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}

// robots-parser is CommonJS (`module.exports = fn`) while its typings declare an ES default export.
const robotsParser = robotsParserModule as unknown as (url: string, body: string) => RobotsParser;

/**
 * Known crawlers and their documented purpose. Purpose matters: blocking a training crawler
 * does not remove a site from AI search answers, and blocking a search crawler can.
 * Sources are listed in knowledge/bots.json; this table only carries the tokens.
 */
export type BotPurpose = 'search' | 'ai-training' | 'ai-search' | 'user-fetch';

export interface BotInfo {
  token: string;
  operator: string;
  purpose: BotPurpose;
  /** Official documentation URL; null when the operator publishes none. */
  docs: string | null;
}

const OPENAI = 'https://developers.openai.com/api/docs/bots';
const ANTHROPIC = 'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler';
const PERPLEXITY = 'https://docs.perplexity.ai/docs/resources/perplexity-crawlers';
const APPLE = 'https://support.apple.com/en-us/119829';
const GOOGLE = 'https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers';
const META = 'https://developers.facebook.com/documentation/sharing/webmasters/web-crawlers';
const AMAZON = 'https://developer.amazon.com/amazonbot';

export const KNOWN_BOTS: BotInfo[] = [
  { token: 'Googlebot', operator: 'Google', purpose: 'search', docs: GOOGLE },
  { token: 'Google-Extended', operator: 'Google', purpose: 'ai-training', docs: GOOGLE },
  { token: 'Bingbot', operator: 'Microsoft', purpose: 'search', docs: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0' },
  { token: 'YandexBot', operator: 'Yandex', purpose: 'search', docs: 'https://yandex.com/support/webmaster/en/controlling-robot/robots-txt.html' },
  { token: 'GPTBot', operator: 'OpenAI', purpose: 'ai-training', docs: OPENAI },
  { token: 'OAI-SearchBot', operator: 'OpenAI', purpose: 'ai-search', docs: OPENAI },
  { token: 'ChatGPT-User', operator: 'OpenAI', purpose: 'user-fetch', docs: OPENAI },
  { token: 'ClaudeBot', operator: 'Anthropic', purpose: 'ai-training', docs: ANTHROPIC },
  { token: 'Claude-SearchBot', operator: 'Anthropic', purpose: 'ai-search', docs: ANTHROPIC },
  { token: 'Claude-User', operator: 'Anthropic', purpose: 'user-fetch', docs: ANTHROPIC },
  { token: 'PerplexityBot', operator: 'Perplexity', purpose: 'ai-search', docs: PERPLEXITY },
  { token: 'Perplexity-User', operator: 'Perplexity', purpose: 'user-fetch', docs: PERPLEXITY },
  { token: 'Applebot', operator: 'Apple', purpose: 'search', docs: APPLE },
  { token: 'Applebot-Extended', operator: 'Apple', purpose: 'ai-training', docs: APPLE },
  { token: 'CCBot', operator: 'Common Crawl', purpose: 'ai-training', docs: 'https://commoncrawl.org/ccbot' },
  { token: 'meta-externalagent', operator: 'Meta', purpose: 'ai-training', docs: META },
  { token: 'Amazonbot', operator: 'Amazon', purpose: 'ai-training', docs: AMAZON },
  { token: 'Amzn-SearchBot', operator: 'Amazon', purpose: 'ai-search', docs: AMAZON },
  { token: 'Bytespider', operator: 'ByteDance', purpose: 'ai-training', docs: null },
];

export interface RobotsInfo {
  url: string;
  status: number;
  fetched: boolean;
  /** 4xx (except 429) means "no restrictions" per RFC 9309; 5xx/unreachable means "assume full disallow". */
  state: 'ok' | 'missing' | 'unreachable' | 'error';
  raw: string;
  sizeBytes: number;
  sitemaps: string[];
  error?: string;
  isAllowed(url: string, ua: string): boolean;
  crawlDelay(ua: string): number | undefined;
}

/** Google documents a 500 KiB processing limit for robots.txt. */
export const ROBOTS_MAX_BYTES = 500 * 1024;

export function parseRobots(robotsUrl: string, body: string, status: number): RobotsInfo {
  const parser = robotsParser(robotsUrl, body);
  return {
    url: robotsUrl,
    status,
    fetched: true,
    state: 'ok',
    raw: body,
    sizeBytes: Buffer.byteLength(body),
    sitemaps: parser.getSitemaps(),
    isAllowed: (u, ua) => parser.isAllowed(u, ua) ?? true,
    crawlDelay: (ua) => parser.getCrawlDelay(ua),
  };
}

export async function fetchRobots(origin: string, opts: FetchOptions = {}): Promise<RobotsInfo> {
  const robotsUrl = new URL('/robots.txt', origin).toString();
  const res = await safeFetch(robotsUrl, { ...opts, maxBytes: ROBOTS_MAX_BYTES * 2 });
  if (res.error || res.status === 0) {
    return { ...parseRobots(robotsUrl, '', 0), fetched: false, state: 'unreachable', error: res.error, isAllowed: () => false };
  }
  if (res.status >= 500 || res.status === 429) {
    // RFC 9309 §2.3.1.4: unreachable => crawler MUST assume complete disallow.
    return { ...parseRobots(robotsUrl, '', res.status), state: 'unreachable', isAllowed: () => false };
  }
  if (res.status >= 400) {
    // RFC 9309 §2.3.1.3: unavailable => crawler MAY access any resources.
    return { ...parseRobots(robotsUrl, '', res.status), state: 'missing' };
  }
  return parseRobots(robotsUrl, res.body, res.status);
}

export interface BotAccess {
  bot: BotInfo;
  homepageAllowed: boolean;
  /** True when a group explicitly names this token (vs. inheriting the `*` group). */
  explicit: boolean;
}

export function botAccessMatrix(robots: RobotsInfo, homepage: string): BotAccess[] {
  const lower = robots.raw.toLowerCase();
  return KNOWN_BOTS.map((bot) => ({
    bot,
    homepageAllowed: robots.isAllowed(homepage, bot.token),
    explicit: new RegExp(`^\\s*user-agent\\s*:\\s*${bot.token.toLowerCase().replace(/[-]/g, '\\-')}\\s*$`, 'm').test(lower),
  }));
}
