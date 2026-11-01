import crypto from 'node:crypto';
import type { FindingSink } from '../rules/engine.js';
import { factsOf, type SiteContext } from './context.js';
import { URL_RULES } from './inventory.js';

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
    // "İ".toLowerCase() is "i" + U+0307 (combining dot); drop it so Turkish words stay whole ("İlgili" → "ilgili").
    .replace(/\u0307/g, '')
    .normalize('NFKC')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

export interface ContentReport {
  topTerms: Array<{ term: string; pages: number }>;
  pageTerms: Array<{ url: string; terms: string[] }>;
  clusters: Array<{ key: string; pages: string[]; terms: string[] }>;
  cannibalization: Array<{ terms: string[]; pages: string[] }>;
  nearDuplicates: Array<{ a: string; b: string; similarity: number }>;
  exactDuplicates: string[][];
  /** Topically related indexable pages that do not link to each other (suggested direction from → to). */
  linkOpportunities?: Array<{ from: string; to: string; similarity: number; sharedTerms: string[]; toInlinks: number }>;
}

/** 32-bit FNV-1a; shingles are stored as numbers to keep memory and hashing cheap on large sites. */
function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function shingles(words: string[], k = 5): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i + k <= words.length; i++) s.add(fnv1a(words.slice(i, i + k).join(' ')));
  return s;
}

const MINHASH_N = 64;
function minhash(sh: Set<number>): Uint32Array {
  const sig = new Uint32Array(MINHASH_N).fill(0xffffffff);
  for (const x of sh) {
    // Two independent hashes derived from the shingle hash give the permutation family a + i·b.
    const a = x >>> 0;
    const b = (Math.imul(x ^ 0x9e3779b9, 0x85ebca6b) >>> 0) | 1;
    for (let i = 0; i < MINHASH_N; i++) {
      const v = (a + Math.imul(i, b)) >>> 0;
      if (v < sig[i]!) sig[i] = v;
    }
  }
  return sig;
}

function jaccard(a: Set<number>, b: Set<number>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

export function runContentChecks(ctx: SiteContext, sink: FindingSink): ContentReport {
  const pages = ctx.indexable.map((p) => ({ p, f: factsOf(p)! }));
  /** Locale + first path segment, e.g. "/help", "en/help": templates and title patterns live per section. */
  const groupOf = (url: string) => {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const locale = segs[0] && /^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0]) ? segs.shift()! : '';
    return `${locale}/${segs[0] ?? ''}`;
  };


  // TF-IDF over title + headings + body.
  const docTerms = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  for (const { p, f } of pages) {
    const tf = new Map<string, number>();
    const weighted = [
      ...tokenize(f.title ?? '').flatMap((t) => [t, t, t]),
      // Headings in site chrome (footer "Product family", "Legal"…) repeat on every page: not page topics.
      ...f.headings.filter((h) => !h.chrome).flatMap((h) => tokenize(h.text).flatMap((t) => (h.level === 1 ? [t, t, t] : [t, t]))),
      ...tokenize(f.mainText.slice(0, 20000)),
    ];
    for (const t of weighted) tf.set(t, (tf.get(t) ?? 0) + 1);
    docTerms.set(p.url, tf);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, pages.length);
  const pageTerms: ContentReport['pageTerms'] = [];
  const vectors = new Map<string, Map<string, number>>();
  // Section template vocabulary ("Help centre", "Categories", "Related articles" on every help page) says
  // nothing about a page's topic: drop terms on at least 80% of the pages of the same section. (A lower
  // threshold also removes the shared subject of a topical blog, e.g. "mail" on a mail product's blog.)
  const secSize = new Map<string, number>();
  const secDf = new Map<string, Map<string, number>>();
  for (const [url, tf] of docTerms) {
    const g = groupOf(url);
    secSize.set(g, (secSize.get(g) ?? 0) + 1);
    const m = secDf.get(g) ?? secDf.set(g, new Map()).get(g)!;
    for (const t of tf.keys()) m.set(t, (m.get(t) ?? 0) + 1);
  }
  for (const [url, tf] of docTerms) {
    const g = groupOf(url);
    const gs = secSize.get(g)!;
    const sectionTemplate = (t: string) => gs >= 4 && (secDf.get(g)!.get(t) ?? 0) >= gs * 0.8;
    const scored = [...tf.entries()].map(([t, c]) => [t, c * Math.log(1 + N / (df.get(t) ?? 1))] as const).sort((a, b) => b[1] - a[1]);
    pageTerms.push({ url, terms: scored.slice(0, 8).map(([t]) => t) });
    // Topic vector: top 20 TF-IDF terms, excluding site vocabulary (on more than half of all pages).
    vectors.set(url, new Map(scored.filter(([t]) => (df.get(t) ?? 0) <= Math.max(3, N * 0.5) && !sectionTemplate(t)).slice(0, 20)));
  }
  const langOf = new Map(pages.map(({ p, f }) => [p.url, (f.lang ?? '').toLowerCase().split('-')[0]!]));
  const linkOpportunities = findLinkOpportunities(ctx, vectors, langOf);
  if (linkOpportunities.length) {
    sink.emit('links.internal-opportunity', linkOpportunities.slice(0, 50).map((o) => ({ url: o.to, observed: `link from ${o.from} (topic similarity ${Math.round(o.similarity * 100)}%: ${o.sharedTerms.slice(0, 4).join(', ')}); target has ${o.toInlinks} internal inlink(s)` })));
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
  const allSh = new Map<string, Set<number>>();
  for (const { p, f } of pages) {
    // Compare main content only: shared navigation/footer would make short pages look identical.
    const words = f.mainText.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length >= 50) allSh.set(p.url, shingles(words));
  }
  // Templates live per section and language (e.g. a help-centre sidebar on /help/* and another on /en/help/*),
  // so boilerplate frequency is counted within each locale+section group as well as site-wide.
  const siteDf = new Map<number, number>();
  const groupDf = new Map<string, Map<number, number>>();
  const groupSize = new Map<string, number>();
  for (const [url, s] of allSh) {
    const g = groupOf(url);
    groupSize.set(g, (groupSize.get(g) ?? 0) + 1);
    const gm = groupDf.get(g) ?? new Map<number, number>();
    groupDf.set(g, gm);
    for (const x of s) {
      siteDf.set(x, (siteDf.get(x) ?? 0) + 1);
      gm.set(x, (gm.get(x) ?? 0) + 1);
    }
  }
  const siteMin = Math.max(3, Math.ceil(allSh.size * 0.3));
  const sh = new Map<string, Set<number>>();
  const sigs = new Map<string, Uint32Array>();
  for (const [url, s] of allSh) {
    const g = groupOf(url);
    const gSize = groupSize.get(g) ?? 0;
    const gMin = Math.max(3, Math.ceil(gSize * 0.3));
    const gm = groupDf.get(g)!;
    const isBoilerplate = (x: number) => (allSh.size >= 5 && (siteDf.get(x) ?? 0) >= siteMin) || (gSize >= 5 && (gm.get(x) ?? 0) >= gMin);
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

  // Cannibalisation: indexable pages whose specific title/H1 terms strongly overlap.
  const groups = new Map<string, string[]>();
  const titleTerms = new Map<string, string[]>();
  const specificTerms = new Map<string, Set<string>>();
  const sectionTermDf = new Map<string, Map<string, number>>();
  const sectionPages = new Map<string, number>();
  for (const { p, f } of pages) {
    const terms = [...new Set([...tokenize(f.title ?? ''), ...tokenize(f.headings.find((h) => h.level === 1 && !h.chrome)?.text ?? '')])];
    titleTerms.set(p.url, terms);
    const g = groupOf(p.url);
    sectionPages.set(g, (sectionPages.get(g) ?? 0) + 1);
    const m = sectionTermDf.get(g) ?? new Map<string, number>();
    sectionTermDf.set(g, m);
    for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
  }
  // Legal documents (each product's privacy policy, refund terms …) share titles by design and do not
  // compete for searches; pages in different languages do not compete with each other either.
  const legal = URL_RULES.find(([, t]) => t === 'legal')![0];
  for (const { p } of pages) {
    if (legal.test(new URL(p.url).pathname)) continue;
    const terms = titleTerms.get(p.url)!;
    const section = groupOf(p.url);
    const gSize = sectionPages.get(section) ?? 0;
    // Remove brand terms that appear on most pages site-wide (e.g. "Acme" in every title) and section
    // template terms (e.g. every help article titled "… — Help centre").
    const specific = terms.filter((t) => ((df.get(t) ?? 0) < N * 0.5 || N < 4) && !(gSize >= 4 && (sectionTermDf.get(section)!.get(t) ?? 0) >= gSize * 0.5));
    if (specific.length >= 2) specificTerms.set(p.url, new Set(specific));
  }
  // Candidate pairs via an inverted index; pages collide when their specific title/H1 terms overlap
  // strongly (Jaccard ≥ 0.6 with at least two shared terms). Union-find groups chains of collisions.
  const index = new Map<string, string[]>();
  for (const [url, set] of specificTerms) for (const t of set) (index.get(t) ?? index.set(t, []).get(t)!).push(url);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const px = parent.get(x) ?? x;
    if (px === x) return x;
    const r = find(px);
    parent.set(x, r);
    return r;
  };
  const checked = new Set<string>();
  for (const urls of index.values()) {
    if (urls.length > 100) continue;
    for (let i = 0; i < urls.length; i++)
      for (let j = i + 1; j < urls.length; j++) {
        const a = urls[i]!, b = urls[j]!;
        const key = a < b ? a + '|' + b : b + '|' + a;
        if (checked.has(key)) continue;
        checked.add(key);
        if (langOf.get(a) !== langOf.get(b)) continue;
        const sa = specificTerms.get(a)!, sb = specificTerms.get(b)!;
        let shared = 0;
        for (const t of sa) if (sb.has(t)) shared++;
        if (shared >= 2 && shared / (sa.size + sb.size - shared) >= 0.6) parent.set(find(a), find(b));
      }
  }
  for (const url of specificTerms.keys()) {
    const root = find(url);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(url);
  }
  const cannibalization = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const sets = g.map((u) => specificTerms.get(u)!);
      const common = [...sets[0]!].filter((t) => sets.every((x) => x.has(t)));
      return { terms: (common.length ? common : [...sets[0]!]).slice(0, 4), pages: g };
    });
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

  return { topTerms, pageTerms, clusters, cannibalization, nearDuplicates, exactDuplicates, linkOpportunities: linkOpportunities.slice(0, 200) };
}

/**
 * Internal-linking opportunities: pairs of indexable pages with similar topic vectors (cosine ≥ 0.3, ≥ 2
 * shared terms) and no link in either direction. Direction: from the better-linked page to the weaker one.
 * Each target gets at most 3 suggestions; near-identical pairs (similarity > 0.9) are left to duplicate checks.
 * Pages declaring different languages are never paired.
 */
export function findLinkOpportunities(ctx: SiteContext, vectors: Map<string, Map<string, number>>, langOf?: Map<string, string>): NonNullable<ContentReport['linkOpportunities']> {
  // Pages in different declared languages are alternates for different readers, not link candidates.
  const otherLanguage = (a: string, b: string) => {
    const la = langOf?.get(a), lb = langOf?.get(b);
    return !!la && !!lb && la !== lb;
  };
  const norm = new Map<string, number>();
  for (const [u, v] of vectors) norm.set(u, Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0)) || 1);
  const index = new Map<string, string[]>();
  for (const [u, v] of vectors) for (const t of v.keys()) (index.get(t) ?? index.set(t, []).get(t)!).push(u);
  const outlinks = new Map<string, Set<string>>();
  for (const [target, sources] of ctx.inlinks) for (const s of sources) (outlinks.get(s) ?? outlinks.set(s, new Set()).get(s)!).add(target);
  const links = (a: string, b: string) => outlinks.get(a)?.has(b) || outlinks.get(b)?.has(a);
  const inl = (u: string) => ctx.reachIn.get(u)?.size ?? 0;
  const seen = new Set<string>();
  const out: NonNullable<ContentReport['linkOpportunities']> = [];
  for (const urls of index.values()) {
    if (urls.length > 200) continue;
    for (let i = 0; i < urls.length; i++)
      for (let j = i + 1; j < urls.length; j++) {
        const a = urls[i]!, b = urls[j]!;
        const key = a < b ? a + '|' + b : b + '|' + a;
        if (seen.has(key)) continue;
        seen.add(key);
        if (otherLanguage(a, b)) continue;
        const va = vectors.get(a)!, vb = vectors.get(b)!;
        let dot = 0;
        const shared: string[] = [];
        for (const [t, w] of va) {
          const w2 = vb.get(t);
          if (w2 !== undefined) {
            dot += w * w2;
            shared.push(t);
          }
        }
        const sim = dot / (norm.get(a)! * norm.get(b)!);
        if (shared.length < 2 || sim < 0.3 || sim > 0.9 || links(a, b)) continue;
        const [from, to] = inl(a) >= inl(b) ? [a, b] : [b, a];
        out.push({ from, to, similarity: Math.round(sim * 100) / 100, sharedTerms: shared.slice(0, 6), toInlinks: inl(to) });
      }
  }
  out.sort((x, y) => x.toInlinks - y.toInlinks || y.similarity - x.similarity);
  const perTarget = new Map<string, number>();
  return out.filter((o) => {
    const n = perTarget.get(o.to) ?? 0;
    if (n >= 3) return false;
    perTarget.set(o.to, n + 1);
    return true;
  });
}
