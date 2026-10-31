import type { AuditReport } from '../analyze/audit.js';
import type { KnowledgeBase } from '../rules/engine.js';
import { templatesOf } from '../analyze/priority.js';
import type { MonitorDiff } from '../commands/monitor.js';
import type { EcosystemReport } from '../commands/ecosystem.js';

/**
 * Self-contained interactive HTML report (no external requests).
 * Security: crawled content is untrusted. Data is embedded as JSON with `<`, `>` and `&` escaped,
 * and the client renders exclusively through textContent / createElement — never innerHTML.
 */
export function safeJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const BASE_CSS = `:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e4df;--accent:#2f5bea;--crit:#c62828;--high:#e8590c;--med:#c79100;--low:#2f6fd6;--info:#8a8a85;--chip:#f0f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--text:#ecece8;--muted:#a3a39e;--line:#33332f;--accent:#7b9bff;--chip:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:24px 16px 8px;max-width:1200px;margin:auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}
.muted{color:var(--muted)}main{max-width:1200px;margin:auto;padding:0 16px 48px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:16px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.card b{display:block;font-size:24px}
nav{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-top:16px;overflow-x:auto}nav button{background:none;border:0;padding:10px 14px;color:var(--muted);cursor:pointer;font:inherit;border-bottom:2px solid transparent}
nav button[aria-selected=true]{color:var(--text);border-color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.filters select,.filters input{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit}
.finding{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--info);border-radius:8px;margin:8px 0;padding:12px 14px}
.finding[data-sev=critical]{border-left-color:var(--crit)}.finding[data-sev=high]{border-left-color:var(--high)}.finding[data-sev=medium]{border-left-color:var(--med)}.finding[data-sev=low]{border-left-color:var(--low)}
.finding summary{cursor:pointer;font-weight:600;list-style:none}.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 8px;font-size:12px;margin-right:4px;font-weight:400;color:var(--muted)}
.ev{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;margin:4px 0;padding-left:12px;border-left:2px solid var(--line)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:13px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{color:var(--muted);font-weight:500}
.tablewrap{overflow-x:auto}a{color:var(--accent)}.ok{color:#2e7d32}.bad{color:var(--crit);font-weight:600}
.panel{display:none}.panel.active{display:block}ul{padding-left:18px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin:8px 0 4px}
.chart{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.chart h3{font-size:13px;margin:0 0 8px;color:var(--muted);font-weight:500}
.bar{display:grid;grid-template-columns:minmax(90px,38%) 1fr 48px;align-items:center;gap:8px;margin:3px 0;font-size:12px}.bar span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{background:var(--chip);border-radius:4px;height:10px;overflow:hidden}.fill{height:100%;background:var(--accent);border-radius:4px}.bar b{font-weight:500;text-align:right}
.fill.critical{background:var(--crit)}.fill.high{background:var(--high)}.fill.medium{background:var(--med)}.fill.low{background:var(--low)}.fill.info{background:var(--info)}.fill.good{background:#2e7d32}
.delta-up{color:var(--crit)}.delta-down{color:#2e7d32}
`;

/** Client helpers shared by every Searvex HTML page (DOM-only rendering, no innerHTML). */
const CLIENT_LIB = `function el(t,a,c){var e=document.createElement(t);if(a)for(var k in a){if(k==='text')e.textContent=a[k];else e.setAttribute(k,a[k]);}(c||[]).forEach(function(x){if(x)e.appendChild(typeof x==='string'?document.createTextNode(x):x)});return e}
function safeHref(u){return /^https?:\\/\\//i.test(u)?u:'#'}
function table(head,rows){return el('div',{class:'tablewrap'},[el('table',{},[el('thead',{},[el('tr',{},head.map(function(h){return el('th',{text:h})}))]),el('tbody',{},rows.map(function(r){return el('tr',{},r.map(function(c){return c instanceof Node?el('td',{},[c]):el('td',{text:String(c)})}))}))])])}
function bars(title,rows,opts){opts=opts||{};var max=opts.max||Math.max.apply(null,rows.map(function(r){return r[1]}).concat([1]));return el('div',{class:'chart',role:'figure','aria-label':title},[el('h3',{text:title})].concat(rows.length?rows.map(function(r){return el('div',{class:'bar'},[el('span',{text:r[0],title:r[0]}),el('div',{class:'track'},[el('div',{class:'fill '+(r[2]||''),style:'width:'+Math.max(r[1]?2:0,Math.round(r[1]/max*100))+'%'})]),el('b',{text:String(r[1])+(opts.suffix||'')})])}):[el('div',{class:'muted',text:'—'})]))}
function mkTabs(tabs){tabs.forEach(function(t,i){var b=el('button',{role:'tab','aria-selected':i===0?'true':'false',text:t[1]});b.onclick=function(){document.querySelectorAll('nav button').forEach(function(x){x.setAttribute('aria-selected','false')});b.setAttribute('aria-selected','true');document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active')});document.getElementById('p-'+t[0]).classList.add('active')};document.getElementById('tabs').appendChild(b)})}
`;

/** Self-contained page: strict CSP, data embedded as escaped JSON, rendering through CLIENT_LIB. */
export function htmlPage(title: string, payload: unknown, body: string, script: string): string {
  const t = title.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="robots" content="noindex">
<title>${t}</title>
<style>
${BASE_CSS}</style>
</head>
<body>
<header><h1 id="t"></h1><div class="muted" id="meta"></div></header>
<main>
${body}
</main>
<script type="application/json" id="data">${safeJson(payload)}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent);
${CLIENT_LIB}${script}
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
    const urls = f.evidence.map((e) => e.url).filter((u): u is string => !!u);
    const tpl = f.templates ?? templatesOf(urls);
    for (const t of tpl) (by.get(t.pattern) ?? by.set(t.pattern, []).get(t.pattern)!).push({ ruleId: f.ruleId, title: f.title, severity: f.severity, pages: t.pages });
  }
  return [...by].map(([pattern, issues]) => ({ pattern, issues: issues.sort((a, b) => b.pages - a.pages), pages: Math.max(...issues.map((i) => i.pages)) }))
    .sort((a, b) => b.issues.length - a.issues.length || b.pages - a.pages).slice(0, 60);
}

export function renderHtml(r: AuditReport, kb: KnowledgeBase): string {
  const sources: Record<string, Array<{ title: string; url: string; checked: string }>> = {};
  for (const f of r.findings) sources[f.ruleId] = kb.rules.get(f.ruleId)?.sources.map((s) => ({ title: s.title, url: s.url, checked: s.checked })) ?? [];
  const payload = { report: { ...r, inventory: { ...r.inventory, pages: r.inventory.pages.slice(0, 2000) } }, sources, templates: templateView(r) };
  const title = `Searvex report — ${r.target}`.replace(/[<>&"]/g, '');
  return htmlPage(title, payload, `<div class="cards" id="cards"></div>
<div class="charts" id="charts"></div>
<nav role="tablist" id="tabs"></nav>
<section class="panel active" id="p-issues">
 <div class="filters"><select id="fs"><option value="">All severities</option><option>critical</option><option>high</option><option>medium</option><option>low</option><option>info</option></select>
 <select id="fc"><option value="">All categories</option></select><select id="fk"><option value="">Any evidence</option><option>verified</option><option>heuristic</option><option>unmeasurable</option></select>
 <select id="fo"><option value="priority">Sort: fix first</option><option value="severity">Sort: severity</option></select>
 <input id="fq" type="search" placeholder="Filter by text or URL" aria-label="Filter"></div>
 <div id="list"></div>
</section>
<section class="panel" id="p-geo"></section>
<section class="panel" id="p-inventory"></section>
<section class="panel" id="p-content"></section>
<section class="panel" id="p-templates"></section>
<section class="panel" id="p-limits"></section>
`, `var R=D.report;
document.getElementById('t').textContent='Searvex audit — '+R.target;
document.getElementById('meta').textContent=R.generatedAt+' · Searvex '+R.tool.version+' · rules '+R.tool.rulesVersion+' · '+R.runId;
var issues=R.findings.filter(function(f){return f.severity!=='info'});
[['Health score*',R.scores.notApplicable?'n/a':R.scores.overall+'/100'],['Pages crawled',R.crawl.crawled+(R.crawl.truncated?' (limit)':'')],['Issues',issues.length],['Critical / high',R.findings.filter(function(f){return f.severity==='critical'||f.severity==='high'}).length],['Site type (heuristic)',R.inventory.businessModel.label],['Evidence','✓'+R.measurement.verified+' ~'+R.measurement.heuristic+' ?'+R.measurement.unmeasurable]].forEach(function(c){document.getElementById('cards').appendChild(el('div',{class:'card'},[el('span',{class:'muted',text:c[0]}),el('b',{text:String(c[1])})]))});
var SEV=['critical','high','medium','low'],ch=document.getElementById('charts');
ch.appendChild(bars('Issues by severity (rules)',SEV.map(function(s){return[s,issues.filter(function(f){return f.severity===s}).length,s]})));
ch.appendChild(bars('Score by category (100 = no findings)',Object.keys(R.scores.byCategory).sort(function(a,b){return R.scores.byCategory[a]-R.scores.byCategory[b]}).map(function(k){var v=R.scores.byCategory[k];return[k,v,v>=90?'good':v>=70?'medium':'critical']}),{max:100}));
ch.appendChild(bars('Fix-first buckets',['P1','P2','P3'].map(function(b){return[b,issues.filter(function(f){return f.priority&&f.priority.bucket===b}).length]})));
var tabs=[['issues','Issues'],['templates','Templates'],['geo','GEO / AI'],['inventory','Inventory'],['content','Content'],['limits','Method & limits']];
mkTabs(tabs);
var cats={};R.findings.forEach(function(f){cats[f.category]=1});Object.keys(cats).sort().forEach(function(c){document.getElementById('fc').appendChild(el('option',{text:c}))});
function renderList(){var s=fs.value,c=fc.value,k=fk.value,q=fq.value.toLowerCase(),L=document.getElementById('list');L.textContent='';
var list=R.findings.filter(function(f){return(!s||f.severity===s)&&(!c||f.category===c)&&(!k||f.confidence===k)&&(!q||JSON.stringify(f).toLowerCase().indexOf(q)>=0)});
if(fo.value==='priority')list=list.slice().sort(function(a,b){return((b.priority&&b.priority.score)||0)-((a.priority&&a.priority.score)||0)});
list.forEach(function(f){
var src=(D.sources[f.ruleId]||[]).map(function(x){return el('li',{},[el('a',{href:safeHref(x.url),rel:'noopener noreferrer',target:'_blank',text:x.title}),' (checked '+x.checked+')'])});
var ev=f.evidence.slice(0,30).map(function(e){return el('div',{class:'ev',text:(e.url||e.file||'')+(e.line?':'+e.line:'')+(e.observed?' — '+e.observed:'')})});
L.appendChild(el('details',{class:'finding','data-sev':f.severity},[el('summary',{},[f.title+' ',f.priority?el('span',{class:'chip',text:f.priority.bucket+' · '+f.priority.score}):null,el('span',{class:'chip',text:f.severity}),el('span',{class:'chip',text:f.confidence}),el('span',{class:'chip',text:f.category}),el('span',{class:'chip',text:'×'+f.count})]),el('p',{text:f.message}),f.fix?el('p',{},[el('b',{text:'Fix: '}),f.fix]):null,el('div',{class:'muted',text:'Rule '+f.ruleId+' · engines: '+f.engines.join(', ')}),f.priority?el('div',{class:'muted',text:'Priority: '+f.priority.reasons.join('; ')+' · effort '+f.priority.effort}):null,f.templates?el('div',{class:'muted',text:'Templates: '+f.templates.map(function(t){return t.pattern+' ('+t.pages+')'}).join(', ')}):null].concat(ev).concat(f.count>30?[el('div',{class:'muted',text:'… '+(f.count-30)+' more'})]:[]).concat([el('div',{class:'muted',text:'Sources:'}),el('ul',{},src)])))})}
var fs=document.getElementById('fs'),fc=document.getElementById('fc'),fk=document.getElementById('fk'),fo=document.getElementById('fo'),fq=document.getElementById('fq');[fs,fc,fk,fo].forEach(function(x){x.onchange=renderList});fq.oninput=renderList;renderList();
var g=document.getElementById('p-geo');
g.appendChild(el('h2',{text:'Crawler access (robots.txt, homepage)'}));
g.appendChild(table(['Crawler','Operator','Purpose','Access'],R.geo.bots.map(function(b){return[b.token,b.operator,b.purpose,el('span',{class:b.allowed?'ok':'bad',text:(b.allowed?'allowed':'blocked')+(b.explicit?'':' (via *)')})]})));
g.appendChild(el('h2',{text:'Signals'}));
g.appendChild(el('ul',{},[el('li',{text:'llms.txt: '+(R.geo.llmsTxt?(R.geo.llmsTxt.present?'present':'absent'):'not checked')+' — informational; Google documents it does not use llms.txt.'}),el('li',{text:'Content clarity (heuristic, not a citation predictor): average '+R.geo.answerability.average+'/100'}),el('li',{text:'AI citations: '+(R.geo.citations.measured?'measured':'not measured — '+R.geo.citations.reason)}),el('li',{text:'Entity names: '+Object.keys(R.geo.entityNames).map(function(n){return n+' ('+R.geo.entityNames[n]+')'}).join(', ')})]));
g.appendChild(el('h2',{text:'Lowest clarity pages'}));
g.appendChild(table(['URL','Score','Missing signals'],R.geo.answerability.pages.slice(0,50).map(function(p){return[p.url,p.score,Object.keys(p.signals).filter(function(k){return!p.signals[k]}).join(', ')]})));
var inv=document.getElementById('p-inventory');
inv.appendChild(el('p',{text:'Business model (heuristic): '+R.inventory.businessModel.label+(R.inventory.businessModel.evidence.length?' — '+R.inventory.businessModel.evidence.join('; '):'')}));
var ich=el('div',{class:'charts'});ich.appendChild(bars('Pages by type',Object.keys(R.inventory.byType).sort(function(a,b){return R.inventory.byType[b]-R.inventory.byType[a]}).map(function(k){return[k,R.inventory.byType[k]]})));if(R.inventory.intents)ich.appendChild(bars('Intent the pages are built for (inferred from type)',Object.keys(R.inventory.intents).sort(function(a,b){return R.inventory.intents[b]-R.inventory.intents[a]}).map(function(k){return[k,R.inventory.intents[k]]})));inv.appendChild(ich);
inv.appendChild(el('h2',{text:'Pages'}));
inv.appendChild(table(['URL','Type','Intent','Basis','Lang','Indexable','Depth','Inlinks','Words'],R.inventory.pages.slice(0,1000).map(function(p){return[p.url,p.type,p.intent||'',p.basis,p.lang||'',p.indexable?'yes':'no',p.depth,p.inlinks,p.words]})));
var ct=document.getElementById('p-content');
ct.appendChild(el('p',{text:'Site-wide terms: '+R.content.topTerms.slice(0,30).map(function(t){return t.term}).join(', ')}));
ct.appendChild(el('h2',{text:'Sections'}));ct.appendChild(table(['Section','Pages','Dominant terms'],R.content.clusters.slice(0,30).map(function(c){return['/'+c.key,c.pages.length,c.terms.join(', ')]})));
if((R.content.linkOpportunities||[]).length){ct.appendChild(el('h2',{text:'Internal-link opportunities (heuristic)'}));ct.appendChild(table(['Add a link from','To','Similarity','Shared topics'],R.content.linkOpportunities.slice(0,50).map(function(o){return[o.from,o.to+' ('+o.toInlinks+' inlinks)',Math.round(o.similarity*100)+'%',o.sharedTerms.slice(0,5).join(', ')]})));}
ct.appendChild(el('h2',{text:'Cannibalisation candidates (verify with Search Console)'}));ct.appendChild(table(['Shared terms','Pages'],R.content.cannibalization.slice(0,50).map(function(c){return[c.terms.join(' '),c.pages.join('\\n')]})));
ct.appendChild(el('h2',{text:'Near-duplicates'}));ct.appendChild(table(['Page A','Page B','Similarity'],R.content.nearDuplicates.slice(0,50).map(function(d){return[d.a,d.b,Math.round(d.similarity*100)+'%']})));
var tp=document.getElementById('p-templates');
tp.appendChild(el('p',{class:'muted',text:'Issues grouped by URL template (locale + first path segment, deeper segments generalised). A pattern with many issues usually shares one layout or component: fixing it once removes the issue from every page built on it.'}));
if(!D.templates.length)tp.appendChild(el('p',{text:'No issues with page URLs.'}));
D.templates.forEach(function(t){tp.appendChild(el('details',{class:'finding'},[el('summary',{},[t.pattern+' ',el('span',{class:'chip',text:t.issues.length+' issue types'}),el('span',{class:'chip',text:'up to '+t.pages+' pages'})]),table(['Issue','Severity','Pages in template'],t.issues.map(function(i){return[i.title+' ('+i.ruleId+')',i.severity,i.pages]}))]))});
var lim=document.getElementById('p-limits');
lim.appendChild(el('p',{text:'* '+R.scores.method}));
lim.appendChild(el('ul',{},R.limitations.concat(R.geo.notes).map(function(l){return el('li',{text:l})})));
lim.appendChild(el('p',{class:'muted',text:'Searvex never guarantees rankings, indexing or AI citations. Every rule cites an official source.'}));
`);
}

/** Before/after view of two audits of the same site (searvex monitor). */
export function renderMonitorHtml(d: MonitorDiff): string {
  return htmlPage(`Searvex monitor — ${d.target}`, { diff: d }, `<div class="cards" id="cards"></div>
<div class="charts" id="charts"></div>
<section id="tables"></section>`, `var M=D.diff;
document.getElementById('t').textContent='Searvex monitor — '+M.target;
document.getElementById('meta').textContent=(M.baselineRun?'Baseline '+M.baselineRun+' → ':'No baseline · ')+M.currentRun;
var delta=M.scoreBefore===null?null:M.scoreAfter-M.scoreBefore;
[['Health score*',(M.scoreBefore===null?'':M.scoreBefore+' → ')+M.scoreAfter+(delta===null?'':' ('+(delta>=0?'+':'')+delta+')')],['Pages',(M.pagesBefore===null?'':M.pagesBefore+' → ')+M.pagesAfter],['New issues',M.newFindings.length],['Resolved',M.resolved.length],['Worse / better',M.worsened.length+' / '+M.improved.length],['Regression',M.regression?'yes (critical/high)':'no']].forEach(function(c){document.getElementById('cards').appendChild(el('div',{class:'card'},[el('span',{class:'muted',text:c[0]}),el('b',{text:String(c[1])})]))});
var changed=M.newFindings.concat(M.worsened,M.improved,M.resolved);
var ch=document.getElementById('charts');
ch.appendChild(bars('Affected pages before',changed.slice(0,12).map(function(x){return[x.title,x.before,x.severity]}),{max:Math.max.apply(null,changed.map(function(x){return Math.max(x.before,x.after)}).concat([1]))}));
ch.appendChild(bars('Affected pages after',changed.slice(0,12).map(function(x){return[x.title,x.after,x.severity]}),{max:Math.max.apply(null,changed.map(function(x){return Math.max(x.before,x.after)}).concat([1]))}));
var T=document.getElementById('tables');
[['New issues',M.newFindings],['Worsened',M.worsened],['Improved',M.improved],['Resolved',M.resolved]].forEach(function(g){T.appendChild(el('h2',{text:g[0]+' ('+g[1].length+')'}));if(g[1].length)T.appendChild(table(['Issue','Severity','Before','After','Change'],g[1].map(function(x){var c=x.after-x.before;return[x.title+' ('+x.ruleId+')',x.severity,x.before,x.after,el('span',{class:c>0?'delta-up':'delta-down',text:(c>0?'+':'')+c})]})));else T.appendChild(el('p',{class:'muted',text:'None.'}))});
T.appendChild(el('p',{class:'muted',text:'* Searvex health score summarises Searvex findings; it is not a search engine metric. Counts are affected pages per rule.'}));`);
}

/** Multi-site (brand family) view: entities, cross-link matrix, overlap and shared issues. */
export function renderEcosystemHtml(e: EcosystemReport): string {
  return htmlPage('Searvex ecosystem', { eco: e }, `<div class="charts" id="charts"></div>
<section id="body"></section>`, `var E=D.eco,B=document.getElementById('body');
document.getElementById('t').textContent='Searvex ecosystem — '+E.sites.length+' sites';
document.getElementById('meta').textContent=E.sites.map(function(s){return s.host}).join(' · ');
var ch=document.getElementById('charts');
ch.appendChild(bars('Health score* by site',E.sites.map(function(s){return[s.host,s.score,s.score>=90?'good':s.score>=70?'medium':'critical']}),{max:100}));
ch.appendChild(bars('Issues shared across sites (sites affected)',E.sharedIssues.slice(0,10).map(function(i){return[i.title,i.sites,i.severity]}),{max:E.sites.length}));
B.appendChild(el('h2',{text:'Sites'}));
B.appendChild(table(['Site','Site name','Organization','Parent','Declares children','Model (heuristic)','Languages','Pages'],E.sites.map(function(s){return[s.host,s.siteName,s.organization,s.parent,s.children.join(', ')||'—',s.model,s.languages.join(', '),s.pages]})));
B.appendChild(el('h2',{text:'Cross-links (row links to column, crawled pages)'}));
var H=E.sites.map(function(s){return s.host}),mx=1;H.forEach(function(a){H.forEach(function(b){if(a!==b)mx=Math.max(mx,(E.links[a]||{})[b]||0)})});
B.appendChild(table(['from \\\\ to'].concat(H),H.map(function(a){return[a].concat(H.map(function(b){if(a===b)return'·';var n=(E.links[a]||{})[b]||0;var c=el('span',{text:String(n),class:n?'':'bad',title:n?n+' links':'no links'});return c}))})));
var kinds={entity:'Entity & brand graph',linking:'Cross-linking','shared-issue':'Issues shared across the family',overlap:'Topic overlap',coverage:'Language coverage'};
B.appendChild(el('h2',{text:'Observations'}));
if(!E.observations.length)B.appendChild(el('p',{class:'muted',text:'No ecosystem issues found.'}));
Object.keys(kinds).forEach(function(k){var L=E.observations.filter(function(o){return o.kind===k});if(!L.length)return;B.appendChild(el('h3',{text:kinds[k]}));B.appendChild(el('ul',{},L.map(function(o){return el('li',{},[(o.confidence==='heuristic'?'~ ':'')+o.message,o.recommendation?el('div',{class:'muted',text:'Recommendation: '+o.recommendation}):null])})))});
if(E.overlap.length){B.appendChild(el('h2',{text:'Topic similarity (same primary language)'}));B.appendChild(table(['Sites','Similarity','Shared prominent terms'],E.overlap.slice(0,15).map(function(o){return[o.a+' ↔ '+o.b,Math.round(o.similarity*100)+'%',o.shared.slice(0,8).join(', ')]})))}
B.appendChild(el('h2',{text:'Limitations'}));B.appendChild(el('ul',{},E.limitations.map(function(l){return el('li',{text:l})})));
B.appendChild(el('p',{class:'muted',text:'~ marks heuristic observations. * Searvex health score is not a search engine metric.'}));`);
}
