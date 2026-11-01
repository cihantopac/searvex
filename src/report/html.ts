import type { AuditReport } from '../analyze/audit.js';
import type { KnowledgeBase } from '../rules/engine.js';
import { templatesOf } from '../analyze/priority.js';
import type { MonitorDiff } from '../commands/monitor.js';
import type { EcosystemReport } from '../commands/ecosystem.js';
import type { SearchPerformanceReport } from '../analyze/search-performance.js';
import type { FixPlan } from '../optimize/fixes.js';
import { AUDIT_SCRIPT, CLIENT_LIB, DIFF_VIEW, ECOSYSTEM_SCRIPT, MONITOR_SCRIPT, THEME_BOOT } from './client.js';
import { RULES_TR, UI } from './i18n.js';
import { buildRepairPrompt } from './prompt.js';
import { findingRef, optimizerAvailable, remediationOf, rootCauseGroups } from './remediation.js';
import { SEARVEX_VERSION } from '../net/fetcher.js';

/**
 * Self-contained interactive HTML reports (no external requests).
 * Security: crawled content is untrusted. Data is embedded as JSON with `<`, `>` and `&` escaped,
 * and the client renders exclusively through textContent / createElement — never innerHTML.
 * Every page shares one shell: English/Turkish switcher and Light/Dark/System theme, both remembered locally.
 */
export function safeJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const LIGHT = '--bg:#f5f7f6;--panel:#ffffff;--panel2:#eef3f2;--text:#13201f;--muted:#566563;--line:#dbe3e1;--accent:#0e4f55;--accent-ink:#ffffff;--accent-soft:#e1eeee;--coral:#b8432d;--crit:#b42318;--high:#b93815;--med:#946200;--low:#2459b8;--good:#1b7a3e;--info:#667085;--chip:#eef2f1;--shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);color-scheme:light';
const DARK = '--bg:#0e1615;--panel:#151f1e;--panel2:#1b2827;--text:#e6eeec;--muted:#9fb1ae;--line:#2a3937;--accent:#5ec4c6;--accent-ink:#06201f;--accent-soft:#16393a;--coral:#f08a74;--crit:#ff7b6e;--high:#ff9b5c;--med:#f2c14e;--low:#86b4ff;--good:#62d08d;--info:#9aa6b6;--chip:#202e2d;--shadow:0 1px 2px rgba(0,0,0,.4);color-scheme:dark';

const BASE_CSS = `:root{${LIGHT}}
:root[data-theme=dark]{${DARK}}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;padding-bottom:84px}
a{color:var(--accent);text-underline-offset:2px}code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.top{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;justify-content:space-between;max-width:1240px;margin:auto;padding:20px 16px 8px}
.brand{min-width:0}.wordmark{display:block;font-weight:700;font-size:15px;letter-spacing:-.01em;color:var(--accent);margin-bottom:6px}.wordmark i{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--coral);margin-left:2px}.kicker{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--accent)}
h1{font-size:20px;margin:0;overflow-wrap:anywhere;line-height:1.3}.muted{color:var(--muted)}.small{font-size:12.5px}
.controls{display:flex;gap:8px;flex-wrap:wrap}.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}
.seg button{background:none;border:0;color:var(--muted);padding:6px 10px;font:inherit;font-size:12.5px;cursor:pointer;min-height:32px}.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--accent);color:var(--accent-ink);font-weight:600}
button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tabs{display:flex;gap:2px;max-width:1240px;margin:8px auto 0;padding:0 16px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:thin;position:sticky;top:0;background:var(--bg);z-index:5}
.tabs button{background:none;border:0;padding:10px 12px;color:var(--muted);cursor:pointer;font:inherit;border-bottom:2px solid transparent;white-space:nowrap}
.tabs button[aria-selected=true]{color:var(--text);border-color:var(--accent);font-weight:600}.tabs .count{margin-left:6px;background:var(--chip);border-radius:999px;padding:0 7px;font-size:11.5px}
main{max-width:1240px;margin:auto;padding:12px 16px 32px}.panel{display:none}.panel.active{display:block}
.h2{margin:22px 0 8px}h2{font-size:16px;margin:0}.h2 p{margin:2px 0 0}h3{font-size:13.5px;margin:0 0 8px}h4{font-size:13px;margin:14px 0 6px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:12px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;gap:12px;align-items:center;box-shadow:var(--shadow)}
.card .label{display:block;color:var(--muted);font-size:12.5px}.card b{display:block;font-size:24px;line-height:1.2;font-variant-numeric:tabular-nums}.card .sub{display:block;color:var(--muted);font-size:11.5px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.card.score{grid-column:span 2}.card.alert b{color:var(--crit)}.gauge .gtrack{fill:none;stroke:var(--chip);stroke-width:8}.gauge .gfill{fill:none;stroke-width:8;stroke-linecap:round}
.gfill.good{stroke:var(--good)}.gfill.medium{stroke:var(--med)}.gfill.critical{stroke:var(--crit)}.gfill.info{stroke:var(--info)}
.notice{background:var(--accent-soft);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:10px 14px;margin:12px 0}.notice ul{margin:4px 0 0;padding-left:18px}
.pillars{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.pillar{background:var(--panel);border:1px solid var(--line);border-top:4px solid var(--info);border-radius:12px;padding:10px 12px;text-align:left;color:var(--text);font:inherit;cursor:pointer}
.pillar.good{border-top-color:var(--good)}.pillar.medium{border-top-color:var(--med)}.pillar.critical{border-top-color:var(--crit)}
.pillar .label{display:block;font-size:12.5px;color:var(--muted)}.pillar b{display:block;font-size:22px}.pillar .sub{font-size:11.5px;color:var(--muted)}
.prio{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.plist{padding-left:22px}.plist li{margin:8px 0}
.pcard{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--info);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow)}.pcard h3{font-size:14px;margin:8px 0 4px}.pcard p{margin:4px 0}
.pcard[data-sev=critical],.finding[data-sev=critical]{border-left-color:var(--crit)}.pcard[data-sev=high],.finding[data-sev=high]{border-left-color:var(--high)}.pcard[data-sev=medium],.finding[data-sev=medium]{border-left-color:var(--med)}.pcard[data-sev=low],.finding[data-sev=low]{border-left-color:var(--low)}
.prow{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.pscore{font-weight:700;font-size:12px;color:var(--accent)}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px;margin:14px 0}
.chart{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow)}.chart h3{color:var(--muted);font-weight:600}
.bar{display:grid;grid-template-columns:minmax(80px,40%) 1fr 56px;align-items:center;gap:8px;margin:4px 0;font-size:12.5px}.bar span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar b{font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
.track{background:var(--chip);border-radius:4px;height:10px;overflow:hidden}.fill{height:100%;background:var(--accent);border-radius:4px}
.stack{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--chip);gap:2px}.stack .fill{border-radius:0}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;font-size:12.5px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;background:var(--info)}
.critical{background:var(--crit)}.high{background:var(--high)}.medium{background:var(--med)}.low{background:var(--low)}.info{background:var(--info)}.good{background:var(--good)}.accent{background:var(--accent)}
.pillar.good,.pillar.medium,.pillar.critical{background:var(--panel)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.filters select,.filters input[type=search],.dialog select{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit;font-size:13px;min-height:34px;max-width:100%}
.filters input[type=search]{flex:1 1 220px}.check{display:inline-flex;gap:6px;align-items:center;font-size:13px}
.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 8px}.spacer{flex:1}
.btn{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer;min-height:34px}.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}.btn.ghost{background:transparent}
.remlegend{margin:0 0 6px}.remlegend summary{cursor:pointer;color:var(--muted)}.remlegend p{margin:4px 0;color:var(--muted)}
.finding{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--info);border-radius:10px;margin:8px 0;padding:10px 12px}
.finding>input,.grow>input,.prow input{margin-top:4px;width:17px;height:17px;accent-color:var(--accent)}
.fdet>summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}.fdet>summary::-webkit-details-marker{display:none}
.fdet>summary::before{content:"▸";color:var(--muted)}.fdet[open]>summary::before{content:"▾"}.ftitle{font-weight:600}.chips{display:inline-flex;flex-wrap:wrap;gap:4px}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 8px;font-size:11.5px;color:var(--muted);white-space:nowrap}
.chip.sev-critical{color:var(--crit)}.chip.sev-high{color:var(--high)}.chip.sev-medium{color:var(--med)}.chip.sev-low{color:var(--low)}
.chip.rem-auto{color:var(--good);font-weight:600}.chip.rem-agent{color:var(--low)}.chip.rem-manual{color:var(--med)}.chip.accent{color:var(--accent);background:var(--accent-soft);font-weight:600}
.chip.review-confirmed{color:var(--crit)}.chip.review-rejected{color:var(--good)}.chip.review-fixed{color:var(--good)}
.fbody{padding:6px 0 2px}.fbody p{margin:6px 0}.group{border-top:1px solid var(--line);padding:6px 0}.grow{display:grid;grid-template-columns:auto 1fr;gap:8px}
.group summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.gkind{font-size:12px;color:var(--muted)}
.ev{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;margin:4px 0;padding-left:10px;border-left:2px solid var(--line)}.ref{color:var(--muted)}
.review{background:var(--panel2);border-radius:8px;padding:6px 10px}.sources ul{margin:4px 0;padding-left:18px}
table{width:100%;border-collapse:collapse;background:var(--panel);font-size:13px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);overflow-wrap:break-word;word-break:break-word;vertical-align:top}td code{white-space:nowrap}th{color:var(--muted);font-weight:600;background:var(--panel2)}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;margin:8px 0}.ok{color:var(--good)}.bad{color:var(--crit);font-weight:600}
.delta-up{color:var(--crit);font-weight:600}.delta-down{color:var(--good);font-weight:600}
.botgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}.bot{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:13px;border-bottom:1px dashed var(--line)}
details.more{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:10px 0}details.more>summary{cursor:pointer;font-weight:600}
ul{padding-left:18px}
#actionbar{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px max(16px,calc((100vw - 1240px)/2 + 16px));background:var(--panel);border-top:1px solid var(--line);box-shadow:0 -2px 10px rgba(0,0,0,.08)}
#actionbar:empty{display:none}#actionbar.on{border-top:2px solid var(--accent)}.abinfo{display:flex;flex-direction:column}
#modal{display:none}#modal.on{display:flex;position:fixed;inset:0;z-index:30;background:rgba(5,12,12,.55);align-items:center;justify-content:center;padding:16px}
.dialog{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:14px;width:min(900px,100%);max-height:100%;display:flex;flex-direction:column;padding:16px;gap:8px;box-shadow:0 10px 40px rgba(0,0,0,.3)}
.dhead,.dfoot{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dialog p{margin:0}
.dialog textarea{width:100%;min-height:50vh;flex:1;resize:vertical;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
footer{max-width:1240px;margin:auto;padding:0 16px 24px;color:var(--muted);font-size:12px}
@media (max-width:640px){h1{font-size:17px}.card.score{grid-column:auto}.card b{font-size:20px}.bar{grid-template-columns:minmax(70px,42%) 1fr 44px}.top{padding-top:14px}
#modal.on{padding:0}.dialog{border-radius:0;height:100%}.dialog textarea{min-height:0}.finding{padding:8px 10px}}
@media print{.tabs,#actionbar,.controls,.filters,.toolbar{display:none}.panel{display:block}}
`;

/** Text wordmark only: the product mark is still being designed (branding/), so no icon is invented here. */
const MARK = '<span class="wordmark" aria-label="Searvex">Searvex<i></i></span>';

/** Self-contained page: strict CSP, data embedded as escaped JSON, rendering through CLIENT_LIB. */
export function htmlPage(title: string, payload: Record<string, unknown>, script: string): string {
  const t = title.replace(/[<>&"]/g, '');
  const data = { i18n: UI, version: SEARVEX_VERSION, ...payload };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${t}</title>
<script>${THEME_BOOT}</script>
<style>
${BASE_CSS}</style>
</head>
<body>
<header class="top"><div class="brand">${MARK}<div><div class="kicker" id="kicker"></div><h1 id="t"></h1><div class="muted small" id="meta"></div></div></div><div class="controls" id="controls"></div></header>
<nav class="tabs" role="tablist" id="tabs"></nav>
<main id="main"></main>
<footer id="foot"></footer>
<div id="actionbar" role="region" aria-live="polite"></div>
<div id="modal"></div>
<script type="application/json" id="data">${safeJson(data)}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent);
${CLIENT_LIB}${script}
boot();
})();
</script>
</body>
</html>`;
}

/** Issues grouped by URL template: where one layout fix removes many findings. */
export function templateView(r: AuditReport): Array<{ pattern: string; issues: Array<{ ruleId: string; title: string; severity: string; pages: number }>; pages: number }> {
  const by = new Map<string, Array<{ ruleId: string; title: string; severity: string; pages: number }>>();
  for (const f of r.findings) {
    if (f.severity === 'info') continue;
    const urls = f.evidence.map((e) => e.url ?? e.file).filter((u): u is string => !!u);
    const tpl = f.templates ?? (r.mode === 'repository' ? fileGroups(f.evidence) : templatesOf(urls));
    for (const t of tpl) (by.get(t.pattern) ?? by.set(t.pattern, []).get(t.pattern)!).push({ ruleId: f.ruleId, title: f.title, severity: f.severity, pages: t.pages });
  }
  return [...by].map(([pattern, issues]) => ({ pattern, issues: issues.sort((a, b) => b.pages - a.pages), pages: Math.max(...issues.map((i) => i.pages)) }))
    .sort((a, b) => b.issues.length - a.issues.length || b.pages - a.pages).slice(0, 60);
}

function fileGroups(evidence: AuditReport['findings'][number]['evidence']): Array<{ pattern: string; pages: number }> {
  const m = new Map<string, number>();
  for (const e of evidence) if (e.file) m.set(e.file, (m.get(e.file) ?? 0) + 1);
  return [...m].map(([pattern, pages]) => ({ pattern, pages }));
}

/** A structured agent review of a finding, stored next to the audit (never replaces scanner evidence). */
export interface FindingReview {
  ruleId: string;
  /** Stable occurrence reference (`ruleId#hash`); absent when the review covers the whole rule. */
  ref?: string;
  status: 'confirmed' | 'rejected' | 'fixed';
  note?: string;
  reviewer?: string;
  at: string;
}

export interface ReportExtras {
  /** Repository fix plan: findings with a concrete patch are labelled automatic. */
  plan?: Pick<FixPlan, 'fixes'> | null;
  diff?: MonitorDiff | null;
  search?: SearchPerformanceReport | null;
  reviews?: FindingReview[];
  repository?: { path: string; framework?: string; siteUrl?: string; lang?: string };
}

export function renderHtml(r: AuditReport, kb: KnowledgeBase, extras: ReportExtras = {}): string {
  const rules: Record<string, unknown> = {};
  for (const f of r.findings) {
    const rule = kb.rules.get(f.ruleId);
    rules[f.ruleId] = {
      title: rule?.title ?? f.title,
      fix: rule?.fix ?? f.fix,
      verify: rule?.verify,
      sources: rule?.sources.map((s) => ({ title: s.title, url: s.url, checked: s.checked })) ?? [],
      tr: RULES_TR[f.ruleId],
    };
  }
  const findings = r.findings.map((f) => ({ ...f, evidence: f.evidence.map((e) => ({ ...e, ref: findingRef(f.ruleId, e) })) }));
  const rem: Record<string, string> = {};
  const opt: Record<string, boolean> = {};
  for (const f of r.findings) {
    rem[f.ruleId] = remediationOf(f.ruleId, extras.plan);
    opt[f.ruleId] = optimizerAvailable(f.ruleId);
  }
  const repository = extras.repository ?? (r.mode === 'repository' ? { path: r.target } : undefined);
  const payload = {
    report: { ...r, findings, inventory: { ...r.inventory, pages: r.inventory.pages.slice(0, 2000) } },
    rules,
    groups: rootCauseGroups(r),
    rem,
    opt,
    templates: templateView(r),
    ctx: { repository: repository ?? null },
    diff: extras.diff ?? null,
    search: extras.search ?? null,
    reviews: extras.reviews ?? [],
  };
  const prompt = `var buildRepairPrompt=(${buildRepairPrompt.toString().replace(/<\//g, '<\\/')});\n`;
  return htmlPage(`Searvex — ${r.target}`, payload, prompt + DIFF_VIEW + AUDIT_SCRIPT);
}

/** Before/after view of two audits of the same site (searvex monitor). */
export function renderMonitorHtml(d: MonitorDiff): string {
  const rules: Record<string, unknown> = {};
  for (const x of [...d.newFindings, ...d.resolved, ...d.worsened, ...d.improved]) rules[x.ruleId] = { title: x.title, tr: RULES_TR[x.ruleId] };
  return htmlPage(`Searvex monitor — ${d.target}`, { diff: d, rules }, DIFF_VIEW + MONITOR_SCRIPT);
}

/** Multi-site (brand family) view: entities, cross-link matrix, overlap and shared issues. */
export function renderEcosystemHtml(e: EcosystemReport): string {
  return htmlPage('Searvex ecosystem', { eco: e }, ECOSYSTEM_SCRIPT);
}
