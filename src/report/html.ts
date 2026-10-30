import type { AuditReport } from '../analyze/audit.js';
import type { KnowledgeBase } from '../rules/engine.js';

/**
 * Self-contained interactive HTML report (no external requests).
 * Security: crawled content is untrusted. Data is embedded as JSON with `<`, `>` and `&` escaped,
 * and the client renders exclusively through textContent / createElement — never innerHTML.
 */
export function safeJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function renderHtml(r: AuditReport, kb: KnowledgeBase): string {
  const sources: Record<string, Array<{ title: string; url: string; checked: string }>> = {};
  for (const f of r.findings) sources[f.ruleId] = kb.rules.get(f.ruleId)?.sources.map((s) => ({ title: s.title, url: s.url, checked: s.checked })) ?? [];
  const payload = safeJson({ report: { ...r, inventory: { ...r.inventory, pages: r.inventory.pages.slice(0, 2000) } }, sources });
  const title = `Searvex report — ${r.target}`.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e4df;--accent:#2f5bea;--crit:#c62828;--high:#e8590c;--med:#c79100;--low:#2f6fd6;--info:#8a8a85;--chip:#f0f0ec}
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
</style>
</head>
<body>
<header><h1 id="t"></h1><div class="muted" id="meta"></div></header>
<main>
<div class="cards" id="cards"></div>
<nav role="tablist" id="tabs"></nav>
<section class="panel active" id="p-issues">
 <div class="filters"><select id="fs"><option value="">All severities</option><option>critical</option><option>high</option><option>medium</option><option>low</option><option>info</option></select>
 <select id="fc"><option value="">All categories</option></select><select id="fk"><option value="">Any evidence</option><option>verified</option><option>heuristic</option><option>unmeasurable</option></select>
 <input id="fq" type="search" placeholder="Filter by text or URL" aria-label="Filter"></div>
 <div id="list"></div>
</section>
<section class="panel" id="p-geo"></section>
<section class="panel" id="p-inventory"></section>
<section class="panel" id="p-content"></section>
<section class="panel" id="p-limits"></section>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent),R=D.report;
function el(t,a,c){var e=document.createElement(t);if(a)for(var k in a){if(k==='text')e.textContent=a[k];else e.setAttribute(k,a[k]);}(c||[]).forEach(function(x){if(x)e.appendChild(typeof x==='string'?document.createTextNode(x):x)});return e}
function safeHref(u){return /^https?:\\/\\//i.test(u)?u:'#'}
document.getElementById('t').textContent='Searvex audit — '+R.target;
document.getElementById('meta').textContent=R.generatedAt+' · Searvex '+R.tool.version+' · rules '+R.tool.rulesVersion+' · '+R.runId;
var issues=R.findings.filter(function(f){return f.severity!=='info'});
[['Health score*',R.scores.overall+'/100'],['Pages crawled',R.crawl.crawled+(R.crawl.truncated?' (limit)':'')],['Issues',issues.length],['Critical / high',R.findings.filter(function(f){return f.severity==='critical'||f.severity==='high'}).length],['Site type (heuristic)',R.inventory.businessModel.label],['Evidence','✓'+R.measurement.verified+' ~'+R.measurement.heuristic+' ?'+R.measurement.unmeasurable]].forEach(function(c){document.getElementById('cards').appendChild(el('div',{class:'card'},[el('span',{class:'muted',text:c[0]}),el('b',{text:String(c[1])})]))});
var tabs=[['issues','Issues'],['geo','GEO / AI'],['inventory','Inventory'],['content','Content'],['limits','Method & limits']];
tabs.forEach(function(t,i){var b=el('button',{role:'tab','aria-selected':i===0?'true':'false',text:t[1]});b.onclick=function(){document.querySelectorAll('nav button').forEach(function(x){x.setAttribute('aria-selected','false')});b.setAttribute('aria-selected','true');document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active')});document.getElementById('p-'+t[0]).classList.add('active')};document.getElementById('tabs').appendChild(b)});
var cats={};R.findings.forEach(function(f){cats[f.category]=1});Object.keys(cats).sort().forEach(function(c){document.getElementById('fc').appendChild(el('option',{text:c}))});
function renderList(){var s=fs.value,c=fc.value,k=fk.value,q=fq.value.toLowerCase(),L=document.getElementById('list');L.textContent='';
R.findings.filter(function(f){return(!s||f.severity===s)&&(!c||f.category===c)&&(!k||f.confidence===k)&&(!q||JSON.stringify(f).toLowerCase().indexOf(q)>=0)}).forEach(function(f){
var src=(D.sources[f.ruleId]||[]).map(function(x){return el('li',{},[el('a',{href:safeHref(x.url),rel:'noopener noreferrer',target:'_blank',text:x.title}),' (checked '+x.checked+')'])});
var ev=f.evidence.slice(0,30).map(function(e){return el('div',{class:'ev',text:(e.url||e.file||'')+(e.line?':'+e.line:'')+(e.observed?' — '+e.observed:'')})});
L.appendChild(el('details',{class:'finding','data-sev':f.severity},[el('summary',{},[f.title+' ',el('span',{class:'chip',text:f.severity}),el('span',{class:'chip',text:f.confidence}),el('span',{class:'chip',text:f.category}),el('span',{class:'chip',text:'×'+f.count})]),el('p',{text:f.message}),f.fix?el('p',{},[el('b',{text:'Fix: '}),f.fix]):null,el('div',{class:'muted',text:'Rule '+f.ruleId+' · engines: '+f.engines.join(', ')})].concat(ev).concat(f.count>30?[el('div',{class:'muted',text:'… '+(f.count-30)+' more'})]:[]).concat([el('div',{class:'muted',text:'Sources:'}),el('ul',{},src)])))})}
var fs=document.getElementById('fs'),fc=document.getElementById('fc'),fk=document.getElementById('fk'),fq=document.getElementById('fq');[fs,fc,fk].forEach(function(x){x.onchange=renderList});fq.oninput=renderList;renderList();
function table(head,rows){return el('div',{class:'tablewrap'},[el('table',{},[el('thead',{},[el('tr',{},head.map(function(h){return el('th',{text:h})}))]),el('tbody',{},rows.map(function(r){return el('tr',{},r.map(function(c){return c instanceof Node?el('td',{},[c]):el('td',{text:String(c)})}))}))])])}
var g=document.getElementById('p-geo');
g.appendChild(el('h2',{text:'Crawler access (robots.txt, homepage)'}));
g.appendChild(table(['Crawler','Operator','Purpose','Access'],R.geo.bots.map(function(b){return[b.token,b.operator,b.purpose,el('span',{class:b.allowed?'ok':'bad',text:(b.allowed?'allowed':'blocked')+(b.explicit?'':' (via *)')})]})));
g.appendChild(el('h2',{text:'Signals'}));
g.appendChild(el('ul',{},[el('li',{text:'llms.txt: '+(R.geo.llmsTxt?(R.geo.llmsTxt.present?'present':'absent'):'not checked')+' — informational; Google documents it does not use llms.txt.'}),el('li',{text:'Content clarity (heuristic, not a citation predictor): average '+R.geo.answerability.average+'/100'}),el('li',{text:'AI citations: '+(R.geo.citations.measured?'measured':'not measured — '+R.geo.citations.reason)}),el('li',{text:'Entity names: '+Object.keys(R.geo.entityNames).map(function(n){return n+' ('+R.geo.entityNames[n]+')'}).join(', ')})]));
g.appendChild(el('h2',{text:'Lowest clarity pages'}));
g.appendChild(table(['URL','Score','Missing signals'],R.geo.answerability.pages.slice(0,50).map(function(p){return[p.url,p.score,Object.keys(p.signals).filter(function(k){return!p.signals[k]}).join(', ')]})));
var inv=document.getElementById('p-inventory');
inv.appendChild(el('p',{text:'Business model (heuristic): '+R.inventory.businessModel.label+(R.inventory.businessModel.evidence.length?' — '+R.inventory.businessModel.evidence.join('; '):'')}));
inv.appendChild(table(['Type','Pages'],Object.keys(R.inventory.byType).map(function(k){return[k,R.inventory.byType[k]]})));
inv.appendChild(el('h2',{text:'Pages'}));
inv.appendChild(table(['URL','Type','Basis','Lang','Indexable','Depth','Inlinks','Words'],R.inventory.pages.slice(0,1000).map(function(p){return[p.url,p.type,p.basis,p.lang||'',p.indexable?'yes':'no',p.depth,p.inlinks,p.words]})));
var ct=document.getElementById('p-content');
ct.appendChild(el('p',{text:'Site-wide terms: '+R.content.topTerms.slice(0,30).map(function(t){return t.term}).join(', ')}));
ct.appendChild(el('h2',{text:'Sections'}));ct.appendChild(table(['Section','Pages','Dominant terms'],R.content.clusters.slice(0,30).map(function(c){return['/'+c.key,c.pages.length,c.terms.join(', ')]})));
ct.appendChild(el('h2',{text:'Cannibalisation candidates (verify with Search Console)'}));ct.appendChild(table(['Shared terms','Pages'],R.content.cannibalization.slice(0,50).map(function(c){return[c.terms.join(' '),c.pages.join('\\n')]})));
ct.appendChild(el('h2',{text:'Near-duplicates'}));ct.appendChild(table(['Page A','Page B','Similarity'],R.content.nearDuplicates.slice(0,50).map(function(d){return[d.a,d.b,Math.round(d.similarity*100)+'%']})));
var lim=document.getElementById('p-limits');
lim.appendChild(el('p',{text:'* '+R.scores.method}));
lim.appendChild(el('ul',{},R.limitations.concat(R.geo.notes).map(function(l){return el('li',{text:l})})));
lim.appendChild(el('p',{class:'muted',text:'Searvex never guarantees rankings, indexing or AI citations. Every rule cites an official source.'}));
})();
</script>
</body>
</html>`;
}
