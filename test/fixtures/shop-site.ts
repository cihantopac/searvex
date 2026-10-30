import { page, text, type Route } from '../helpers/server.js';

/**
 * Synthetic e-commerce site with deliberately planted, documented issues.
 * EXPECTED lists the rule ids an audit MUST report; CLEAN lists rule ids it must NOT report.
 */
export function shopSite(base: () => string): Record<string, Route> {
  const B = () => base();
  const nav = `<nav><a href="/">Home</a> <a href="/products/">Products</a> <a href="/products/widget">Widget</a> <a href="/products/gadget">Gadget</a> <a href="/blog/">Blog</a> <a href="/about">About</a> <a href="/old-widget">Old widget</a> <a href="/missing">Missing</a> <a href="/tr/">Türkçe</a> <span onclick="go()"><a>Menu</a></span></nav>`;
  const org = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Kitchens","url":"${'https://acme.example'}"}</script>`;
  return {
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: shopRobots(B()) },
    '/sitemap.xml': { headers: { 'content-type': 'application/xml' }, body: shopSitemap(B()) },
    '/': {
      body: page({
        title: 'Acme Kitchens — Professional kitchen equipment',
        head: `<meta name="description" content="Professional kitchen equipment tested in real restaurants."><link rel="canonical" href="${B()}/"><link rel="alternate" hreflang="en" href="${B()}/"><link rel="alternate" hreflang="tr" href="${B()}/tr/"><link rel="alternate" hreflang="x-default" href="${B()}/"><meta property="og:title" content="Acme Kitchens"><meta property="og:site_name" content="Acme Kitchens">${org}`,
        body: `${nav}<h1>Professional kitchen equipment</h1><h2>Why chefs choose Acme</h2>${text(200)}<h2>How do we test products?</h2>${text(80)}<img src="/hero.jpg" width="800" height="400" alt="Chef using an Acme oven">`,
      }),
    },
    '/products/': {
      body: page({ title: 'Products — Acme Kitchens', head: `<meta name="description" content="All products"><link rel="canonical" href="${B()}/products/">`, body: `${nav}<h1>Products</h1>${text(150)}<img src="/cat.jpg">` }),
    },
    '/products/widget': {
      body: page({
        title: 'Widget — Acme Kitchens',
        head: `<meta name="description" content="The widget"><link rel="canonical" href="/products/widget"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>`,
        body: `${nav}<h1>Widget</h1>${text(220)}`,
      }),
    },
    '/products/gadget': {
      body: page({
        title: 'Widget — Acme Kitchens', // duplicate title (planted)
        head: `<meta name="description" content="The gadget"><link rel="canonical" href="${B()}/products/gadget"><link rel="canonical" href="${B()}/products/gadget2"><meta name="keywords" content="gadget, kitchen"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Gadget",}</script>`,
        body: `${nav}<h1>Gadget</h1>${text(220)}`,
      }),
    },
    '/old-widget': { redirect: '/redirect-step' },
    '/redirect-step': { redirect: '/products/widget', status: 302 },
    '/blog/': {
      body: page({ title: 'Blog — Acme Kitchens', head: `<meta name="description" content="Kitchen guides"><link rel="canonical" href="${B()}/blog/">`, body: `${nav}<h1>Blog</h1><a href="/blog/care-guide">Care guide</a><a href="/blog/faq">FAQ</a>${text(120)}` }),
    },
    '/blog/care-guide': {
      body: page({
        title: 'How to care for your oven — Acme Kitchens',
        head: `<meta name="robots" content="noindex"><meta name="description" content="Care guide"><link rel="canonical" href="${B()}/blog/care-guide">`,
        body: `${nav}<h1>How to care for your oven</h1>${text(300)}`,
      }),
    },
    '/blog/faq': {
      body: page({
        title: 'FAQ — Acme Kitchens',
        head: `<meta name="description" content="Frequently asked questions"><link rel="canonical" href="${B()}/blog/faq"><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>`,
        body: `${nav}<h1>FAQ</h1>${text(180)}`,
      }),
    },
    '/about': {
      body: page({ title: 'About — Acme Kitchens', head: `<meta name="description" content="About us"><link rel="canonical" href="${B()}/about">`, body: `${nav}<h1>About</h1>${text(200)}` }),
    },
    '/tr/': {
      body: page({
        lang: 'tr',
        title: 'Acme Mutfak — Profesyonel mutfak ekipmanları',
        head: `<meta name="description" content="Profesyonel mutfak ekipmanları"><link rel="canonical" href="${B()}/tr/"><link rel="alternate" hreflang="tr" href="${B()}/tr/"><link rel="alternate" hreflang="en-UK" href="${B()}/en-uk/">`,
        body: `${nav}<h1>Profesyonel mutfak ekipmanları</h1>${text(200)}`,
      }),
    },
    '/en-uk/': {
      body: page({ title: 'Acme Kitchens UK', head: `<meta name="description" content="UK"><link rel="canonical" href="${B()}/en-uk/">`, body: `${nav}<h1>UK</h1>${text(200)}` }),
    },
    '/gone': {
      body: page({ title: 'Page not found — Acme Kitchens', body: `${nav}<h1>Page not found</h1>` }),
    },
    '/private/report': { body: page({ title: 'Private', body: 'secret' }) },
  };
}

export const SHOP_EXPECTED = [
  'redirect.chain', 'redirect.temporary-internal', 'links.broken-internal', 'duplicate.title', 'canonical.relative', 'canonical.multiple',
  'sd.invalid-json', 'sd.missing-required', 'sd.retired-type', 'meta.keywords-present', 'index.noindex-in-sitemap', 'index.noindex',
  'robots.blocked-sitemap-url', 'hreflang.invalid-code', 'hreflang.missing-return', 'img.alt-missing', 'index.soft-404',
  'links.uncrawlable', 'geo.ai-search-bot-blocked', 'geo.training-bots', 'geo.llms-txt', 'crawl.sitemap-orphan', 'perf.cwv-unmeasured',
];

/** Rules that must NOT fire on this site (false-positive guards). */
export const SHOP_CLEAN = ['robots.unreachable', 'robots.disallow-all', 'title.missing', 'mobile.viewport-missing', 'geo.search-bot-blocked', 'geo.organization-missing', 'http.server-error', 'redirect.loop', 'html.lang-missing'];

export function shopRobots(base: string): string {
  return `User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nSitemap: ${base}/sitemap.xml\n`;
}

export function shopSitemap(base: string): string {
  const urls = ['/', '/products/', '/products/widget', '/products/gadget', '/blog/', '/blog/care-guide', '/about', '/private/report', '/gone'];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${base}${u}</loc><lastmod>2026-10-01</lastmod></url>`).join('')}</urlset>`;
}
