import { describe, expect, it } from 'vitest';
import { analyzeEcosystem, renderEcosystemMarkdown, type SiteSnapshot } from '../../src/commands/ecosystem.js';
import type { AuditReport } from '../../src/analyze/audit.js';

function site(host: string, o: Partial<SiteSnapshot> & { lang?: string; hreflang?: string[]; findings?: string[] } = {}): SiteSnapshot {
  const report = {
    target: `https://${host}/`,
    crawl: { crawled: 10 },
    scores: { overall: 90 },
    inventory: {
      languages: { [o.lang ?? 'en']: 10 },
      hreflangLanguages: o.hreflang ?? [],
      businessModel: { label: 'SaaS / software product', confidence: 'high' },
      offerings: [],
    },
    findings: (o.findings ?? []).map((ruleId) => ({ ruleId, title: ruleId, severity: 'medium', confidence: 'verified', count: 5 })),
  } as unknown as AuditReport;
  return { host, url: report.target, report, outbound: {}, siteNames: [], orgNames: [], parents: [], children: [], terms: [], ...o };
}

describe('ecosystem analysis', () => {
  const parent = site('group.example', { siteNames: ['GROUP'], orgNames: ['GROUP'], outbound: { 'chat.example': 3 }, terms: ['software', 'company', 'teams'] });
  const chat = site('chat.example', {
    siteNames: ['CHAT'], orgNames: ['CHAT'], parents: [{ name: 'GROUP', url: 'https://group.example/' }], outbound: { 'group.example': 2 },
    terms: ['messages', 'channels', 'teams', 'share', 'files', 'invite'], hreflang: ['en', 'de'], findings: ['title.multiple'],
  });
  const mail = site('mail.example', {
    siteNames: ['MAIL'], orgNames: ['GROUP'], parents: [{ name: 'GRUP', url: 'https://group.example/' }],
    terms: ['messages', 'channels', 'teams', 'share', 'files', 'inbox'], findings: ['title.multiple'],
  });
  const r = analyzeEcosystem([parent, chat, mail]);
  const msgs = r.observations.map((o) => o.message);

  it('flags parents that do not reference their products in structured data', () => {
    expect(msgs.some((m) => m.includes('group.example does not reference CHAT'))).toBe(true);
  });

  it('flags a child naming its parent differently from the parent site', () => {
    expect(msgs.some((m) => m.includes('names its parent "GRUP"'))).toBe(true);
  });

  it('flags a product that uses the parent name as its own Organization', () => {
    expect(msgs.some((m) => m.includes('mail.example (site name "MAIL") describes its Organization as "GROUP"'))).toBe(false); // GROUP is a parent (allowed) …
    const lone = analyzeEcosystem([parent, site('x.example', { siteNames: ['X'], orgNames: ['OTHER'] })]);
    expect(lone.observations.some((o) => o.message.includes('describes its Organization as "OTHER"'))).toBe(true);
  });

  it('builds the cross-link matrix and reports missing parent links and backlinks', () => {
    expect(r.links['group.example']!['chat.example']).toBe(3);
    expect(msgs.some((m) => m.includes('group.example has no crawled links to mail.example'))).toBe(true);
    expect(msgs.some((m) => m.includes('mail.example do not link back to group.example'))).toBe(true);
  });

  it('reports topic overlap between same-language sites as heuristic, ignoring brand terms', () => {
    const o = r.observations.find((x) => x.kind === 'overlap')!;
    expect(o.confidence).toBe('heuristic');
    expect(o.sites.sort()).toEqual(['chat.example', 'mail.example']);
  });

  it('groups issues shared across the family', () => {
    expect(r.sharedIssues[0]).toMatchObject({ ruleId: 'title.multiple', sites: 2 });
  });

  it('reports language coverage gaps', () => {
    expect(msgs.some((m) => m.includes('mail.example declares no hreflang alternates'))).toBe(true);
  });

  it('renders markdown with all sections', () => {
    const md = renderEcosystemMarkdown(r);
    for (const h of ['## Sites', '## Cross-links', '### Entity & brand graph', '### Topic overlap', '## Limitations']) expect(md).toContain(h);
  });
});
