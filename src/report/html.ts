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
import { FAVICON_URI, LOGO_SVG } from './brand.js';
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

// Design tokens. Colour follows a 60/30/10 rule: neutral surfaces (60), the brand teal for structure and data (30),
// coral only for actions and critical/high severity (10). No other hues.
const LIGHT = '--bg:#f7f4ee;--surface:#ffffff;--sunken:#f1ede5;--line:#e6e0d4;--line-2:#d6cfc1;--text:#13201f;--muted:#5b6664;--faint:#8b9492;--brand:#0e4f55;--brand-2:#2f6f74;--brand-3:#7fa7a9;--brand-soft:#e4eeed;--brand-ink:#ffffff;--accent:#b8432d;--accent-hover:#9c3623;--accent-soft:#f6e4de;--accent-ink:#ffffff;--mark:#0e4f55;--caret:#b8432d;--ring:0 0 0 3px rgba(184,67,45,.28);--shadow:0 1px 2px rgba(19,32,31,.04),0 8px 24px -14px rgba(19,32,31,.14);--dock:#13201f;--dock-ink:#f7f4ee;color-scheme:light';
const DARK = '--bg:#0e1615;--surface:#141f1e;--sunken:#111a19;--line:#22302e;--line-2:#30413f;--text:#eef0ec;--muted:#a1adaa;--faint:#6f7c79;--brand:#8cc7c1;--brand-2:#5e9d98;--brand-3:#3d6b68;--brand-soft:#172b2a;--brand-ink:#0e1615;--accent:#e2705a;--accent-hover:#ec8a76;--accent-soft:#2f1d19;--accent-ink:#1a0d0a;--mark:#f6f1e7;--caret:#c9533b;--ring:0 0 0 3px rgba(226,112,90,.32);--shadow:0 1px 2px rgba(0,0,0,.35);--dock:#eef0ec;--dock-ink:#0e1615;color-scheme:dark';

const BASE_CSS = `:root{${LIGHT}}
:root[data-theme=dark]{${DARK}}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;padding-bottom:110px}
a{color:var(--brand);text-underline-offset:3px}a:hover{color:var(--accent)}
code{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
button,select,input,textarea{font:inherit;color:inherit}
button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible,textarea:focus-visible{outline:none;box-shadow:var(--ring);border-radius:8px}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
.muted{color:var(--muted)}.small{font-size:13px}.spacer{flex:1}
/* header */
.top{padding-top:26px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px 16px;flex-wrap:wrap}
.logo{display:block;height:22px;width:auto}.logo .m{fill:var(--mark)}.logo .c{fill:var(--caret)}
.controls{display:flex;gap:6px;flex-wrap:wrap}
.seg{display:inline-flex;background:var(--sunken);border:1px solid var(--line);border-radius:999px;padding:2px}
.seg button{border:0;background:none;padding:4px 11px;border-radius:999px;font-size:12.5px;color:var(--muted);cursor:pointer;min-height:28px}
.seg button:hover{color:var(--text)}.seg button[aria-pressed=true]{background:var(--surface);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.1)}
.head{padding-top:34px}.kicker{font-size:12.5px;font-weight:600;color:var(--brand);letter-spacing:.01em}
h1{margin:4px 0 6px;font-size:34px;line-height:1.15;font-weight:650;letter-spacing:-.025em;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:13.5px;display:flex;flex-wrap:wrap;align-items:baseline;gap:0 4px}
.runinfo summary{cursor:pointer;list-style:none;text-decoration:underline dotted;text-underline-offset:3px;width:max-content}.runinfo summary::-webkit-details-marker{display:none}
.runinfo[open]{flex-basis:100%}.runinfo .kv{margin-top:10px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 16px}
.tabs{position:sticky;top:0;z-index:10;margin-top:22px;background:var(--bg);background:color-mix(in srgb,var(--bg) 86%,transparent);-webkit-backdrop-filter:saturate(1.6) blur(14px);backdrop-filter:saturate(1.6) blur(14px);border-bottom:1px solid var(--line)}
.tabs .wrap{display:flex;gap:26px;overflow-x:auto;scrollbar-width:none}.tabs .wrap::-webkit-scrollbar{display:none}
.tabs button{border:0;background:none;padding:14px 0 13px;color:var(--muted);cursor:pointer;font-size:14.5px;border-bottom:2px solid transparent;white-space:nowrap}
.tabs button:hover{color:var(--text)}.tabs button[aria-selected=true]{color:var(--text);font-weight:600;border-color:var(--brand)}.tabs .count{color:var(--faint);font-weight:400;margin-left:5px}
main.wrap{padding-top:36px;padding-bottom:24px}.panel{display:none}.panel.active{display:block}
/* type + sections */
.h2{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:44px 0 14px}.panel>.h2:first-child,.panel>.notice+.h2{margin-top:8px}
h2{font-size:19px;margin:0;font-weight:600;letter-spacing:-.012em}h3{font-size:15px;margin:22px 0 8px;font-weight:600}h4{font-size:13px;margin:14px 0 6px;color:var(--muted);font-weight:600}
.hintbtn{width:18px;height:18px;border-radius:50%;border:1px solid var(--line-2);background:none;color:var(--muted);font:600 11px/16px Georgia,serif;font-style:italic;cursor:pointer;padding:0;text-align:center}
.hintbtn:hover,.hintbtn[aria-expanded=true]{border-color:var(--brand);color:var(--brand)}
.hinttext{flex-basis:100%;margin:0;color:var(--muted);font-size:13.5px;max-width:760px}
.link{border:0;background:none;color:var(--brand);cursor:pointer;font-size:14px;padding:2px 0}.link:hover{color:var(--accent)}
.prose{max-width:780px}.prose li{margin:4px 0}ul{padding-left:20px}
.empty{color:var(--muted);background:var(--surface);border:1px dashed var(--line-2);border-radius:14px;padding:18px 20px;margin:0}
.notice{background:var(--brand-soft);border-radius:12px;padding:12px 16px;margin:0 0 20px;font-size:14px}
.surface{background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.pad{padding:18px 22px}
/* hero */
.hero{display:grid;grid-template-columns:auto 1fr;gap:36px;align-items:center;padding:30px 34px}
.ring{position:relative;flex:none}.ring svg{display:block}.ring .rt{fill:none;stroke:var(--sunken);stroke-width:10}.ring .rf{fill:none;stroke:var(--brand);stroke-width:10;stroke-linecap:round}.ring.low .rf{stroke:var(--accent)}
.ring .val{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}.ring b{font-size:40px;font-weight:650;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.ring.na b{font-size:24px;color:var(--muted)}
.ring small{font-size:11.5px;color:var(--muted);margin-top:4px}
.herotext h2{font-size:23px;letter-spacing:-.018em}.herotext>p{margin:6px 0 0}
.stats{display:flex;flex-wrap:wrap;gap:14px 40px;margin-top:22px}.stat b{display:block;font-size:25px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.2}.stat span{font-size:13px;color:var(--muted)}.stat.hot b{color:var(--accent)}
.statrow{padding:22px 26px;margin-bottom:8px}.statrow .stats{margin:0}
.gaps{margin-top:18px;font-size:13.5px;color:var(--muted)}.gaps summary{cursor:pointer;list-style:none;width:max-content}.gaps summary::-webkit-details-marker{display:none}.gaps summary::after{content:" ›";color:var(--faint)}.gaps[open] summary::after{content:" ⌄"}.gaps ul{margin:8px 0 0}
/* lists + rows */
.list{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}.list+.list{margin-top:12px}.list.isempty{background:none;border:0;box-shadow:none}
.listhead{padding:12px 20px;font-size:13.5px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:6px;flex-wrap:wrap}.listhead b{color:var(--text)}.pad-x{padding:8px 20px 0;margin:0}
.item+.item,.row+.row{border-top:1px solid var(--line)}
.row{display:grid;grid-template-columns:18px 10px minmax(0,1fr);gap:14px;align-items:center;padding:0 0 0 20px;transition:background .15s}
.row:hover{background:var(--sunken)}.row.static{padding:14px 20px;grid-template-columns:0 10px minmax(0,1fr) auto}.row.static:hover{background:none}
.row>input{width:17px;height:17px;margin:0;accent-color:var(--accent);cursor:pointer}
.rowbtn{display:grid;grid-template-columns:minmax(0,1fr) auto 14px;gap:16px;align-items:center;border:0;background:none;text-align:left;padding:15px 20px 15px 0;cursor:pointer;min-width:0;width:100%}
.rmain{display:block;min-width:0}.rt{display:block;font-weight:560;font-size:15px;line-height:1.35}.rs{display:block;color:var(--muted);font-size:13px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc{color:var(--muted);font-size:13.5px;font-variant-numeric:tabular-nums;white-space:nowrap}.chev{color:var(--faint);font-size:18px;line-height:1;transition:transform .2s}.row.open .chev{transform:rotate(90deg)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--faint);flex:none;vertical-align:middle}
.d-critical{background:var(--accent)}.d-high{background:transparent;box-shadow:inset 0 0 0 2.5px var(--accent)}.d-medium{background:var(--brand)}.d-low{background:var(--brand-3)}.d-info{background:var(--line-2)}.d-ok{background:var(--brand)}
.detail{padding:6px 24px 22px 62px}
.kv{display:grid;grid-template-columns:130px minmax(0,1fr);gap:8px 20px;margin:0;max-width:820px}.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 0}
.tag{display:inline-block;font-size:12px;line-height:1.5;padding:1px 9px;border-radius:999px;background:var(--sunken);color:var(--muted);border:1px solid var(--line);white-space:nowrap}
.tag.sev-critical,.tag.sev-high,.tag.review-confirmed{background:var(--accent-soft);color:var(--accent);border-color:transparent}
.tag.sev-medium,.tag.sev-low,.tag.brand,.tag.prio,.tag.review-rejected,.tag.review-fixed{background:var(--brand-soft);color:var(--brand);border-color:transparent}
.more{margin-top:14px;font-size:14px}.more>summary{cursor:pointer;color:var(--brand);width:max-content}.more>summary:hover{color:var(--accent)}.more.block{margin-top:12px}.more.block>summary{font-weight:600}
.evbox{margin-top:8px}.group{border-top:1px solid var(--line);padding:8px 0}.group:first-of-type{border-top:0}.grow{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px}.grow>input{margin-top:5px;accent-color:var(--accent)}
.group summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.gkind{font-size:12.5px;color:var(--muted)}
.ev{font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;margin:6px 0;padding:8px 12px;background:var(--sunken);border-radius:8px;color:var(--muted)}.ev a{color:var(--text)}.ref{color:var(--faint)}
.review{background:var(--sunken);border-radius:10px;padding:8px 12px}.sources ul{margin:4px 0}
/* areas */
.areas{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
.area{border:0;border-left:1px solid var(--line);background:none;text-align:left;padding:18px;cursor:pointer;min-width:0;transition:background .15s}.area:first-child{border-left:0}.area:hover{background:var(--sunken)}
.area span{display:block;font-size:13px;color:var(--muted);line-height:1.3;min-height:2.6em}.area b{display:block;font-size:23px;font-weight:650;letter-spacing:-.02em;margin:2px 0 10px}
.meter{height:4px;border-radius:2px;background:var(--sunken);overflow:hidden}.meter i{display:block;height:100%;border-radius:2px;background:var(--brand)}.meter i.mid{background:var(--brand-2)}.meter i.poor{background:var(--accent)}
/* charts */
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.chart{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 20px;box-shadow:var(--shadow)}.chart .h2{margin:0 0 14px}.chart h2{font-size:15px}
.bar{display:grid;grid-template-columns:minmax(80px,40%) 1fr 60px;align-items:center;gap:10px;margin:7px 0;font-size:13px}.bar span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar b{font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
.track{background:var(--sunken);border-radius:3px;height:6px;overflow:hidden}.fill{height:100%;background:var(--brand);border-radius:3px}
.stack{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--sunken);gap:2px}.stack .fill{border-radius:0}
.fill.critical,.key.critical,.fill.poor{background:var(--accent)}.fill.high,.key.high{background:var(--accent);opacity:.6}.fill.medium,.key.medium,.fill.brand,.key.brand{background:var(--brand)}.fill.low,.key.low,.fill.brand-3,.key.brand-3{background:var(--brand-3)}.fill.brand-2,.key.brand-2,.fill.mid{background:var(--brand-2)}.fill.faint,.key.faint,.fill.info{background:var(--line-2)}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:13px;color:var(--muted)}.legend b{color:var(--text)}.key{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:var(--brand)}
/* issues tools */
.tools{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px}
.search{flex:1 1 260px;display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:0 12px;height:42px}
.search input{border:0;background:none;outline:none;flex:1;min-width:0;font-size:14.5px}.search input:focus-visible{box-shadow:none}.search:focus-within{border-color:var(--accent);box-shadow:var(--ring)}.glass{color:var(--faint)}
.tools select,.dialog select,.fpanel select{height:42px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:0 12px;font-size:14px;max-width:100%;cursor:pointer}
.filters{position:relative}.filters>summary{list-style:none}.filters>summary::-webkit-details-marker{display:none}
.pill{display:inline-flex;align-items:center;height:42px;padding:0 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);cursor:pointer;font-size:14px}.pill:hover,.filters[open]>.pill{border-color:var(--line-2);background:var(--sunken)}
.fpanel{position:absolute;right:0;top:48px;z-index:8;width:min(420px,calc(100vw - 32px));display:flex;flex-direction:column;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 18px 40px -16px rgba(0,0,0,.3)}
.legend-rem p{margin:6px 0;color:var(--muted)}.check{display:inline-flex;gap:8px;align-items:center;font-size:14px}.check input{accent-color:var(--accent)}
.chipset{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.chipset button{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:5px 13px;font-size:13.5px;color:var(--muted);cursor:pointer}
.chipset button:hover{color:var(--text);border-color:var(--line-2)}.chipset button .n{color:var(--faint)}
.chipset button[aria-pressed=true]{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}.chipset button[aria-pressed=true] .n{color:inherit;opacity:.7}.chipset button[aria-pressed=true] .dot{box-shadow:0 0 0 2px var(--brand-ink)}
.toolbar{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:0 0 10px}
/* tables */
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:14px;margin:8px 0}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);overflow-wrap:break-word;vertical-align:top}tbody tr:last-child td{border-bottom:0}td code{white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12.5px;background:var(--sunken)}.ok{color:var(--brand)}.bad{color:var(--accent);font-weight:600}
.delta-up{color:var(--accent);font-weight:600}.delta-down{color:var(--brand);font-weight:600}
/* geo */
.botgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;align-items:start}.botgrid .list+.list{margin-top:0}
.bot{display:flex;align-items:center;gap:10px;padding:10px 20px;font-size:13.5px;border-top:1px solid var(--line)}.listhead+.bot{border-top:0}
/* selection dock + dialog */
#actionbar{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:20;display:flex;gap:10px;align-items:center;background:var(--dock);color:var(--dock-ink);border-radius:999px;padding:8px 8px 8px 22px;box-shadow:0 14px 36px -10px rgba(0,0,0,.4);max-width:calc(100vw - 32px)}
#actionbar:empty{display:none}.abinfo{display:flex;flex-direction:column;line-height:1.25;margin-right:6px;font-size:14px}.abinfo span{font-size:12px;opacity:.7}
.btn{border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:999px;padding:9px 18px;font-size:14px;font-weight:550;cursor:pointer;min-height:40px;transition:background .15s,border-color .15s;white-space:nowrap}.btn:hover{border-color:var(--line-2);background:var(--sunken)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}.btn.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.ghost{background:transparent;border-color:transparent}#actionbar .btn.ghost{color:var(--dock-ink);opacity:.75}#actionbar .btn.ghost:hover{opacity:1;background:transparent}
#modal{display:none}#modal.on{display:flex;position:fixed;inset:0;z-index:30;background:rgba(8,14,13,.5);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);align-items:center;justify-content:center;padding:24px}
.dialog{background:var(--surface);border:1px solid var(--line);border-radius:20px;width:min(820px,100%);max-height:100%;display:flex;flex-direction:column;padding:22px 24px;gap:10px;box-shadow:0 30px 80px -20px rgba(0,0,0,.5)}
.dhead,.dfoot{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dialog p{margin:0}.dialog h2{font-size:19px}.dnote{color:var(--muted);border-left:2px solid var(--brand);padding-left:10px}
.dialog textarea{width:100%;min-height:46vh;flex:1;resize:vertical;background:var(--sunken);border:1px solid var(--line);border-radius:12px;padding:14px 16px;font:12.5px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:4px}
footer{max-width:1080px;margin:0 auto;padding:8px 24px 32px;color:var(--muted);font-size:12.5px}
@media (max-width:720px){.wrap{padding:0 16px}h1{font-size:26px}.head{padding-top:22px}.hero{grid-template-columns:1fr;gap:18px;padding:22px}.stats{gap:14px 28px}.stat b{font-size:22px}
.areas{grid-template-columns:repeat(2,1fr)}.area{border-left:0;border-top:1px solid var(--line)}.area:nth-child(-n+2){border-top:0}.area:nth-child(even){border-left:1px solid var(--line)}
.row{padding-left:14px;gap:12px}.rowbtn{padding:13px 14px 13px 0;gap:10px}.detail{padding:4px 16px 18px}.kv{grid-template-columns:1fr;gap:2px 0}.kv dd{margin-bottom:10px}
.tabs .wrap{gap:20px}#actionbar{left:12px;right:12px;transform:none;bottom:12px;max-width:none}#actionbar .btn.ghost{display:none}.abinfo{flex:1}
#modal.on{padding:0}.dialog{border-radius:0;height:100%;padding:18px 16px}.dialog textarea{min-height:0}.bar{grid-template-columns:minmax(70px,42%) 1fr 48px}.fpanel{position:static;width:auto;margin-top:8px}footer{padding:8px 16px 32px}}
@media print{.tabs,#actionbar,.controls,.tools,.chipset,.toolbar{display:none}.panel{display:block}body{padding:0}.surface,.list,.chart{box-shadow:none}}
`;



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
<link rel="icon" type="image/svg+xml" href="${FAVICON_URI}">
<title>${t}</title>
<script>${THEME_BOOT}</script>
<style>
${BASE_CSS}</style>
</head>
<body>
<header class="top"><div class="wrap topbar">${LOGO_SVG}<div class="controls" id="controls"></div></div><div class="wrap head"><div class="kicker" id="kicker"></div><h1 id="t"></h1><div class="meta" id="meta"></div></div></header>
<nav class="tabs" aria-label="Sections"><div class="wrap" role="tablist" id="tabs"></div></nav>
<main id="main" class="wrap"></main>
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
      // Community pack rules are labelled with their pack (they have no Turkish text).
      title: `${rule?.title ?? f.title}${f.pack ? ` [${f.pack} pack]` : ''}`,
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
