import crypto from 'node:crypto';
import type { FindingSink } from '../rules/engine.js';
import { factsOf, type SiteContext } from './context.js';

/**
 * Content intelligence: term extraction, topic clusters, duplicates and cannibalisation.
 * Everything here is statistical and labelled heuristic; it never invents search volumes.
 */

const STOPWORDS = new Set(
  (
    // English
    'a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours ' +
    'get got also use using used new one two may like make many much via per vs etc com www http https home page ' +
    // Turkish
    've ile bir bu da de için gibi daha çok en mi mu mü ne o şu ama veya ya ki her olan olarak sonra önce kadar ise değil var yok nasıl neden ' +
    // German / French / Spanish (minimal)
    'der die das und ist nicht mit für auf ein eine den von zu im le la les et des un une du pour dans est el los las y en del por con para una'
  ).split(/\s+/),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

export interface ContentReport {
  topTerms: Array<{ term: string; pages: number }>;
  pageTerms: Array<{ url: string; terms: string[] }>;
  clusters: Array<{ key: string; pages: string[]; terms: string[] }>;
  cannibalization: Array<{ terms: string[]; pages: string[] }>;
  nearDuplicates: Array<{ a: string; b: string; similarity: number }>;
  exactDuplicates: string[][];
}

function shingles(words: string[], k = 5): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i + k <= words.length; i++) s.add(words.slice(i, i + k).join(' '));
  return s;
}

const MINHASH_N = 64;
function minhash(sh: Set<string>): Uint32Array {
  const sig = new Uint32Array(MINHASH_N).fill(0xffffffff);
  for (const s of sh) {
    const h = crypto.createHash('md5').update(s).digest();
    const a = h.readUInt32LE(0);
    const b = h.readUInt32LE(4) | 1;
    for (let i = 0; i < MINHASH_N; i++) {
      const v = (a + Math.imul(i, b)) >>> 0;
      if (v < sig[i]!) sig[i] = v;
    }
  }
  return sig;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

export function runContentChecks(ctx: SiteContext, sink: FindingSink): ContentReport {
  const pages = ctx.indexable.map((p) => ({ p, f: factsOf(p)! }));

  // TF-IDF over title + headings + body.
  const docTerms = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  for (const { p, f } of pages) {
    const tf = new Map<string, number>();
    const weighted = [
      ...tokenize(f.title ?? '').flatMap((t) => [t, t, t]),
      ...f.headings.flatMap((h) => tokenize(h.text).flatMap((t) => (h.level === 1 ? [t, t, t] : [t, t]))),
      ...tokenize(f.mainText.slice(0, 20000)),
    ];
    for (const t of weighted) tf.set(t, (tf.get(t) ?? 0) + 1);
    docTerms.set(p.url, tf);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, pages.length);
  const pageTerms: ContentReport['pageTerms'] = [];
  for (const [url, tf] of docTerms) {
    const scored = [...tf.entries()].map(([t, c]) => [t, c * Math.log(1 + N / (df.get(t) ?? 1))] as const).sort((a, b) => b[1] - a[1]);
    pageTerms.push({ url, terms: scored.slice(0, 8).map(([t]) => t) });
  }
  const topTerms = [...df.entries()]
    .filter(([, c]) => c >= Math.min(2, N) && c <= Math.max(2, N * 0.8))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([term, n]) => ({ term, pages: n }));

  // Low text (heuristic; excludes utility pages).
  const utility = /\/(contact|login|signin|sign-in|register|signup|cart|checkout|account|search|404|privacy|terms|legal|cookie|impressum|iletisim|giris)(\/|$|\?)/i;
  for (const { p, f } of pages) {
    // Hub pages (indexes, category lists) are mostly links by design: not "thin content".
    const linkDensity = f.mainWordCount ? (f.mainLinkWordCount ?? 0) / f.mainWordCount : 0;
    if (f.mainWordCount < 100 && linkDensity < 0.5 && !utility.test(new URL(p.finalUrl).pathname) && p !== ctx.homepage) {
      sink.emit('content.low-text', { url: p.url, observed: `${f.mainWordCount} words of main content (${f.wordCount} incl. navigation/footer)` });
    }
  }

  // Exact duplicates by normalised body hash.
  const byHash = new Map<string, string[]>();
  for (const { p, f } of pages) {
    if (f.mainWordCount < 30) continue;
    const h = crypto.createHash('sha1').update(f.mainText.toLowerCase()).digest('hex');
    const a = byHash.get(h);
    if (a) a.push(p.url);
    else byHash.set(h, [p.url]);
  }
  const exactDuplicates = [...byHash.values()].filter((g) => g.length > 1);
  for (const g of exactDuplicates) sink.emit('duplicate.content', { url: g[0], observed: `identical text on ${g.length} URLs: ${g.slice(0, 5).join(', ')}` });

  // Near-duplicates: MinHash + LSH banding (16 bands × 4 rows), then exact Jaccard on candidates.
  // Template (boilerplate) removal: shingles that recur on a large share of pages — sidebars, category
  // lists, CTAs inside <main> — are dropped before comparing, so pages are judged on unique content.
  const allSh = new Map<string, Set<string>>();
  for (const { p, f } of pages) {
    // Compare main content only: shared navigation/footer would make short pages look identical.
    const words = f.mainText.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length >= 50) allSh.set(p.url, shingles(words));
  }
  // Templates live per section and language (e.g. a help-centre sidebar on /help/* and another on /en/help/*),
  // so boilerplate frequency is counted within each locale+section group as well as site-wide.
  const groupOf = (url: string) => {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const locale = segs[0] && /^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0]) ? segs.shift()! : '';
    return `${locale}/${segs[0] ?? ''}`;
  };
  const siteDf = new Map<string, number>();
  const groupDf = new Map<string, Map<string, number>>();
  const groupSize = new Map<string, number>();
  for (const [url, s] of allSh) {
    const g = groupOf(url);
    groupSize.set(g, (groupSize.get(g) ?? 0) + 1);
    const gm = groupDf.get(g) ?? new Map<string, number>();
    groupDf.set(g, gm);
    for (const x of s) {
      siteDf.set(x, (siteDf.get(x) ?? 0) + 1);
      gm.set(x, (gm.get(x) ?? 0) + 1);
    }
  }
  const siteMin = Math.max(3, Math.ceil(allSh.size * 0.3));
  const sh = new Map<string, Set<string>>();
  const sigs = new Map<string, Uint32Array>();
  for (const [url, s] of allSh) {
    const g = groupOf(url);
    const gSize = groupSize.get(g) ?? 0;
    const gMin = Math.max(3, Math.ceil(gSize * 0.3));
    const gm = groupDf.get(g)!;
    const isBoilerplate = (x: string) => (allSh.size >= 5 && (siteDf.get(x) ?? 0) >= siteMin) || (gSize >= 5 && (gm.get(x) ?? 0) >= gMin);
    const unique = new Set([...s].filter((x) => !isBoilerplate(x)));
    // Too little unique text left to compare meaningfully (thin pages are covered by content.low-text).
    if (unique.size < 20) continue;
    sh.set(url, unique);
    sigs.set(url, minhash(unique));
  }
  const buckets = new Map<string, string[]>();
  for (const [url, sig] of sigs) {
    for (let b = 0; b < 16; b++) {
      const key = `${b}:${sig.slice(b * 4, b * 4 + 4).join(',')}`;
      const arr = buckets.get(key);
      if (arr) arr.push(url);
      else buckets.set(key, [url]);
    }
  }
  const exactSet = new Set(exactDuplicates.flat());
  const seenPairs = new Set<string>();
  const nearDuplicates: ContentReport['nearDuplicates'] = [];
  for (const urls of buckets.values()) {
    if (urls.length < 2 || urls.length > 200) continue;
    for (let i = 0; i < urls.length; i++)
      for (let j = i + 1; j < urls.length; j++) {
        const a = urls[i]!, b = urls[j]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        if (exactSet.has(a) && exactSet.has(b)) continue;
        const sim = jaccard(sh.get(a)!, sh.get(b)!);
        if (sim >= 0.9) nearDuplicates.push({ a, b, similarity: Math.round(sim * 100) / 100 });
      }
  }
  if (nearDuplicates.length) sink.emit('content.near-duplicate', nearDuplicates.slice(0, 50).map((d) => ({ url: d.a, observed: `${Math.round(d.similarity * 100)}% similar to ${d.b}` })));

  // Cannibalisation: same top-3 title/H1 term set across different indexable pages.
  const groups = new Map<string, string[]>();
  for (const { p, f } of pages) {
    const terms = [...new Set([...tokenize(f.title ?? ''), ...tokenize(f.headings.find((h) => h.level === 1)?.text ?? '')])];
    // Remove brand terms that appear on most pages (e.g. "Acme" in every title).
    const specific = terms.filter((t) => (df.get(t) ?? 0) < N * 0.5 || N < 4).slice(0, 3).sort();
    if (specific.length < 2) continue;
    const key = specific.join(' ');
    const g = groups.get(key);
    if (g) g.push(p.url);
    else groups.set(key, [p.url]);
  }
  const cannibalization = [...groups.entries()].filter(([, g]) => g.length > 1).map(([k, g]) => ({ terms: k.split(' '), pages: g }));
  for (const c of cannibalization) sink.emit('content.cannibalization', { url: c.pages[0], observed: `"${c.terms.join(' ')}" shared by ${c.pages.length} pages: ${c.pages.slice(0, 5).join(', ')}` });

  // Topic clusters: first path segment groups, labelled with their dominant terms.
  const clusterMap = new Map<string, string[]>();
  for (const { p } of pages) {
    const seg = new URL(p.finalUrl).pathname.split('/').filter(Boolean)[0] ?? '(root)';
    const a = clusterMap.get(seg);
    if (a) a.push(p.url);
    else clusterMap.set(seg, [p.url]);
  }
  const clusters = [...clusterMap.entries()]
    .map(([key, urls]) => {
      const counts = new Map<string, number>();
      for (const u of urls) for (const t of pageTerms.find((x) => x.url === u)?.terms ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
      return { key, pages: urls, terms: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t) };
    })
    .sort((a, b) => b.pages.length - a.pages.length);

  return { topTerms, pageTerms, clusters, cannibalization, nearDuplicates, exactDuplicates };
}
