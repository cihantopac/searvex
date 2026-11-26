/**
 * Browser-side code of the HTML reports, kept as plain ES5-style strings (the reports are offline files with a
 * strict CSP and no build step). Rules: render only through textContent/createElement (never innerHTML), never
 * template literals here (the strings are embedded in TS template literals).
 *
 * Visual language (see html.ts): calm neutral surfaces, the brand teal for structure and data, coral only for
 * actions and critical/high severity. Short labels on screen; longer explanations behind a disclosure.
 */

/** Runs in <head> before the stylesheet applies: sets the stored theme so the page never flashes. */
export const THEME_BOOT = String.raw`(function(){try{var t=localStorage.getItem('searvex.theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}})();`;

/** Shared helpers: DOM builders, i18n, theme/language switchers, tabs, tables, meters and stats. */
export const CLIENT_LIB = String.raw`function el(t,a,c){var e=document.createElement(t);if(a)for(var k in a){if(a[k]===null||a[k]===undefined||a[k]===false)continue;if(k==='text')e.textContent=a[k];else e.setAttribute(k,a[k]===true?'':a[k]);}(c||[]).forEach(function(x){if(x!==null&&x!==undefined&&x!==false)e.appendChild(typeof x==='string'||typeof x==='number'?document.createTextNode(String(x)):x)});return e}
var NS='http://www.w3.org/2000/svg';
function svg(t,a,c){var e=document.createElementNS(NS,t);for(var k in(a||{}))e.setAttribute(k,a[k]);(c||[]).forEach(function(x){if(x)e.appendChild(x)});return e}
function safeHref(u){return /^https?:\/\//i.test(u)?u:'#'}
function artHref(p){return typeof p==='string'&&/^artefacts\/(html|screenshots)\/[\w.-]+$/.test(p)?p:'#'}
function artLinks(a){if(!a)return null;var k=[];if(a.html)k.push(el('a',{href:artHref(a.html),rel:'noopener',target:'_blank',text:T('ev.html')}));if(a.screenshot)k.push(el('a',{href:artHref(a.screenshot),rel:'noopener',target:'_blank',text:T('ev.shot')}));return k.length?el('span',{class:'art'},[' · '].concat(k.length>1?[k[0],' · ',k[1]]:k)):null}
function store(k,v){try{if(v===undefined)return localStorage.getItem(k);if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){return null}}
var LANG=(function(){var s=store('searvex.lang');if(s==='en'||s==='tr')return s;var l=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||'en']);return l.some(function(x){return /^tr\b/i.test(x)})?'tr':'en'})();
function T(k,v){var d=D.i18n[LANG]||D.i18n.en;if(v&&String(v.n)==='1'&&d[k+'.one']!==undefined)k=k+'.one';var s=d[k];if(s===undefined)s=D.i18n.en[k];if(s===undefined)s=k;if(v)s=s.replace(/\{(\w+)\}/g,function(m,n){return v[n]===undefined?m:String(v[n])});return s}
function fmt(n){try{return Number(n).toLocaleString(LANG==='tr'?'tr-TR':'en-US')}catch(e){return String(n)}}
function pct(n){return (LANG==='tr'?'%':'')+(Math.round(n*1000)/10).toLocaleString(LANG==='tr'?'tr-TR':'en-US')+(LANG==='tr'?'':'%')}
function day(iso){try{return new Date(iso).toLocaleDateString(LANG==='tr'?'tr-TR':'en-US',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'})}catch(e){return String(iso).slice(0,10)}}
function theme(){return store('searvex.theme')||'system'}
function setTheme(m){if(m==='system'){store('searvex.theme',null);document.documentElement.removeAttribute('data-theme')}else{store('searvex.theme',m);document.documentElement.setAttribute('data-theme',m)}controls()}
function setLang(l){LANG=l;store('searvex.lang',l);document.documentElement.setAttribute('lang',l);controls();render()}
function seg(label,opts,cur,on){return el('div',{class:'seg',role:'group','aria-label':label},opts.map(function(o){var b=el('button',{type:'button','aria-pressed':o[0]===cur?'true':'false',title:o[2]||o[1],text:o[1]});b.onclick=function(){on(o[0])};return b}))}
function controls(){var c=document.getElementById('controls');c.textContent='';c.appendChild(seg(T('lang.label'),[['en','EN','English'],['tr','TR','Türkçe']],LANG,setLang));c.appendChild(seg(T('theme.label'),[['light',T('theme.light')],['dark',T('theme.dark')],['system',T('theme.system')]],theme(),setTheme))}
var TAB=null;
function mkTabs(tabs){var n=document.getElementById('tabs');n.textContent='';if(!tabs.some(function(t){return t[0]===TAB}))TAB=tabs[0][0];
tabs.forEach(function(t){var b=el('button',{type:'button',role:'tab',id:'tab-'+t[0],'aria-controls':'p-'+t[0],'aria-selected':t[0]===TAB?'true':'false'},[t[1],t[2]!==undefined?el('span',{class:'count',text:String(t[2])}):null]);b.onclick=function(){showTab(t[0])};n.appendChild(b)});showTab(TAB)}
function showTab(id){TAB=id;document.querySelectorAll('#tabs button').forEach(function(x){x.setAttribute('aria-selected',x.id==='tab-'+id?'true':'false')});document.querySelectorAll('.panel').forEach(function(p){p.classList.toggle('active',p.id==='p-'+id)})}
function panel(id){var p=el('section',{class:'panel',id:'p-'+id,role:'tabpanel','aria-labelledby':'tab-'+id});document.getElementById('main').appendChild(p);return p}
function hint(note){if(!note)return null;var p=el('p',{class:'hinttext',hidden:true,text:note}),b=el('button',{type:'button',class:'hintbtn','aria-expanded':'false','aria-label':T('more'),title:T('more'),text:'i'});b.onclick=function(){var o=p.hidden;p.hidden=!o;b.setAttribute('aria-expanded',o?'true':'false')};return [b,p]}
function h2(t,note,right){var h=hint(note);return el('div',{class:'h2'},[el('h2',{text:t}),h?h[0]:null,right?el('span',{class:'spacer'}):null,right||null,h?h[1]:null])}
function table(head,rows,cls){return el('div',{class:'tablewrap'},[el('table',{class:cls||''},[el('thead',{},[el('tr',{},head.map(function(h){return el('th',{scope:'col',text:h})}))]),el('tbody',{},rows.map(function(r){return el('tr',{},r.map(function(c){return c instanceof Node?el('td',{},[c]):el('td',{text:String(c)})}))}))])])}
function bars(title,rows,opts){opts=opts||{};var max=opts.max||Math.max.apply(null,rows.map(function(r){return r[1]}).concat([1]));return el('div',{class:'chart',role:'figure','aria-label':title},[h2(title,opts.note)].concat(rows.length?rows.map(function(r){return el('div',{class:'bar'},[el('span',{text:r[0],title:r[0]}),el('div',{class:'track'},[el('div',{class:'fill '+(r[2]||''),style:'width:'+Math.max(r[1]?2:0,Math.round(r[1]/max*100))+'%'})]),el('b',{text:fmt(r[1])+(opts.suffix||'')})])}):[el('div',{class:'muted',text:'—'})]))}
function stacked(title,parts,note){var total=parts.reduce(function(n,p){return n+p[1]},0)||1;return el('div',{class:'chart',role:'figure','aria-label':title},[h2(title,note),el('div',{class:'stack'},parts.filter(function(p){return p[1]}).map(function(p){return el('div',{class:'fill '+p[2],style:'width:'+(p[1]/total*100)+'%',title:p[0]+': '+p[1]})})),el('div',{class:'legend'},parts.map(function(p){return el('span',{},[el('i',{class:'key '+p[2]}),p[0]+' ',el('b',{text:fmt(p[1])})])}))])}
function ring(v,size){var s=size||132,w=s<100?7:10,r=(s-w)/2-1,c=2*Math.PI*r,ok=typeof v==='number',cls=!ok?'na':v>=70?'ok':'low';return el('div',{class:'ring '+cls,style:'width:'+s+'px;height:'+s+'px'},[svg('svg',{viewBox:'0 0 '+s+' '+s,width:String(s),height:String(s),'aria-hidden':'true'},[svg('circle',{cx:String(s/2),cy:String(s/2),r:String(r),class:'rt'}),svg('circle',{cx:String(s/2),cy:String(s/2),r:String(r),class:'rf','stroke-dasharray':(ok?c*v/100:0)+' '+c,transform:'rotate(-90 '+s/2+' '+s/2+')'})]),el('div',{class:'val'},[el('b',{text:ok?String(v):'n/a'}),ok?el('small',{text:'/ 100'}):null])])}
function stat(label,value,cls,title){return el('div',{class:'stat '+(cls||''),title:title||null},[el('b',{text:String(value)}),el('span',{text:label})])}
function stats(items){return el('div',{class:'stats'},items.filter(Boolean))}
function statrow(items){return el('div',{class:'surface statrow'},[stats(items)])}
function meter(v,cls){return el('div',{class:'meter'},[el('i',{class:cls||'',style:'width:'+Math.max(0,Math.min(100,v))+'%'})])}
function tag(t,cls,title){return el('span',{class:'tag '+(cls||''),text:t,title:title||null})}
function chip(t,cls,title){return tag(t,cls,title)}
function dot(s){return el('i',{class:'dot d-'+s,title:T('sev.'+s),'aria-label':T('sev.'+s),role:'img'})}
function sevTag(s){return tag(T('sev.'+s),'sev sev-'+s)}
function sevChip(s){return sevTag(s)}
function deltaSpan(c){return el('span',{class:c>0?'delta-up':c<0?'delta-down':'',text:(c>0?'+':'')+c})}
function boot(){document.documentElement.setAttribute('lang',LANG);controls();render();document.getElementById('foot').textContent=T('footer',{v:D.version||''})}
`;

/** Website / repository audit: the action center. Expects D.report, D.rules, D.groups, D.rem, D.opt, D.templates, D.ctx, optional D.diff, D.search, D.reviews. */
export const AUDIT_SCRIPT = String.raw`var R=D.report,SEL={},OPEN={},SHOWINFO=false,FILT={sev:'',cat:'',rem:'',conf:'',q:'',pillar:null};
var SEVS=['critical','high','medium','low','info'];
var PILLARS=[['index',['crawlability','indexability','canonicalization']],['technical',['links','architecture','security','mobile','international','accessibility']],['meta',['metadata','structured-data']],['geo',['geo']],['perf',['performance']],['content',['content']]];
function rt(id){var r=D.rules[id]||{};var tr=LANG==='tr'&&r.tr;return{title:tr?r.tr.title:(r.title||id),fix:tr?r.tr.fix:r.fix,verify:r.verify,sources:r.sources||[]}}
function isIssue(f){return f.severity!=='info'&&f.confidence!=='unmeasurable'&&!f.context}
function groupsOf(f){return D.groups[f.ruleId]||[]}
function selCount(f){return groupsOf(f).filter(function(g){return SEL[g.id]}).length}
function reviewOf(ruleId,ref){var L=D.reviews||[];for(var i=L.length-1;i>=0;i--){if(ref?L[i].ref===ref:(L[i].ruleId===ruleId&&!L[i].ref))return L[i]}return null}
function byPriority(a,b){return((b.priority&&b.priority.score)||0)-((a.priority&&a.priority.score)||0)||SEVS.indexOf(a.severity)-SEVS.indexOf(b.severity)}
function unitKey(){return R.mode==='website'?'iss.pages':'iss.locations'}
function pagesOf(f){var p=groupsOf(f).reduce(function(n,x){return n+x.pages},0);return Math.max(p,f.count)}
function where(f){var G=groupsOf(f);if(!G.length)return'';if(G.length>1)return T('iss.nGroups',{n:G.length});var g=G[0];return g.kind==='site'||g.kind==='layout'?T('iss.group.'+g.kind):g.key}
function TT(k,fb){var s=T(k);return s===k?fb:s}
function host(t){t=String(t);return R.mode==='website'?t.replace(/^https?:\/\//i,'').replace(/\/$/,''):(t.replace(/[\/\\]+$/,'').split(/[\/\\]/).pop()||t)}
function render(){var M=document.getElementById('main');M.textContent='';
document.getElementById('kicker').textContent=T(R.mode==='repository'?'title.repo':'title.audit');
var tt=document.getElementById('t');tt.textContent=host(R.target);tt.setAttribute('title',R.target);
header();
var issues=R.findings.filter(isIssue),tabs=[['overview',T('nav.overview')],['issues',T('nav.issues'),issues.length]];
var hasGeo=R.mode==='website'&&R.geo&&R.geo.bots&&R.geo.bots.length;if(hasGeo)tabs.push(['geo',T('nav.geo')]);
if(D.search)tabs.push(['search',T('nav.search')]);if(D.diff)tabs.push(['changes',T('nav.changes')]);tabs.push(['details',T('nav.details')]);
overview(panel('overview'),issues);issuesPanel(panel('issues'));if(hasGeo)geo(panel('geo'));if(D.search)search(panel('search'));if(D.diff)changes(panel('changes'));details(panel('details'),issues);
mkTabs(tabs);actionbar()}
function header(){var m=document.getElementById('meta');m.textContent='';var c=R.crawl||{};
var n=R.mode==='website'?T('hdr.pages',{n:fmt(c.fetched!==undefined?c.fetched:c.crawled-c.blocked)})+(c.blocked?' · '+T('kpi.blocked',{n:fmt(c.blocked)}):''):T('hdr.routes',{n:fmt(c.crawled)});
var rows=[[T('hdr.target'),R.target],c.siteUrl?[T('hdr.auditedAsShort'),T('hdr.auditedAs',{local:c.startUrl.replace(/^(https?:\/\/[^\/]+).*$/,'$1'),site:c.siteUrl})]:null,[T('hdr.time'),R.generatedAt.slice(0,16).replace('T',' ')+' UTC'],['Searvex',R.tool.version],[T('hdr.rules'),R.tool.rulesVersion],[T('hdr.run'),R.runId],R.scores.profile==='pre-launch'?[T('hdr.profile'),T('kpi.preLaunch')]:null].filter(Boolean);
m.appendChild(el('span',{text:day(R.generatedAt)+' · '+n+' · '}));
m.appendChild(el('details',{class:'runinfo'},[el('summary',{text:T('hdr.runinfo')}),el('dl',{class:'kv small'},[].concat.apply([],rows.map(function(r){return[el('dt',{text:r[0]}),el('dd',{},[el('code',{text:String(r[1])})])]})))]))}
function lims(){var lim=[];if(R.scores.notApplicable)lim.push([T('warn.notApplicable'),T('warn.notApplicable')+': '+R.scores.notApplicable]);
if(!D.search&&R.mode==='website')lim.push([T('lim.search'),T('sp.notConnected')]);R.findings.filter(function(f){return f.confidence==='unmeasurable'}).forEach(function(f){var t=rt(f.ruleId).title,o=f.evidence[0]&&f.evidence[0].observed;lim.push([TT('lim.'+f.ruleId,t),t+(o?' — '+TT('limd.'+f.ruleId,o):'')])});
if(R.mode==='website'&&!R.rendered)lim.push([T('lim.render'),T('warn.noRender')]);return lim}
function overview(P,issues){
var warn=R.crawl.interrupted?T('warn.interrupted',{n:fmt(R.crawl.queuedRemaining),run:R.runId}):R.crawl.truncated?T('warn.truncated',{n:fmt(R.crawl.queuedRemaining)}):null;
if(warn)P.appendChild(el('p',{class:'notice',role:'note',text:warn}));
var na=!!R.scores.notApplicable,score=na?null:R.scores.overall,top=issues.slice().sort(byPriority).slice(0,3);
var RD=R.readiness,notReady=!!RD&&RD.ready===false;
var verdict=na?T('ov.verdict.na'):!issues.length?T(notReady?'ov.verdict.noneNotReady':'ov.verdict.none'):score>=90?T(notReady?'ov.verdict.goodNotReady':'ov.verdict.good'):score>=70?T('ov.verdict.fair'):T('ov.verdict.poor');
if(top.length)verdict+=' '+T('ov.fixFirst',{n:top.length});
var shared=issues.filter(function(f){return groupsOf(f).some(function(g){return g.kind==='layout'||(g.kind==='template'&&g.pages>1)})}).length;
var sub=issues.length&&shared*2>=issues.length?T('ov.shared'):T('kpi.scoreNote');
var hot=issues.filter(function(f){return f.severity==='critical'||f.severity==='high'}).length;
var auto=issues.filter(function(f){return D.rem[f.ruleId]==='auto'}).length,optOnly=issues.filter(function(f){return D.rem[f.ruleId]!=='auto'&&D.opt[f.ruleId]}).length;
var lim=lims();
P.appendChild(el('div',{class:'surface hero'},[el('div',{title:T('kpi.score')+' — '+T('kpi.scoreNote')},[ring(score)]),el('div',{class:'herotext'},[el('h2',{text:verdict}),el('p',{class:'muted',text:sub}),
stats([stat(T('kpi.typesLabel'),fmt(issues.length)),stat(T(R.mode==='website'?'kpi.affectedShort':'kpi.affectedFilesShort'),fmt(R.affectedUrls!==undefined?R.affectedUrls:0)),stat(T('kpi.critical'),fmt(hot),hot?'hot':''),auto||optOnly?stat(T(auto?'kpi.auto':'kpi.autoRepoShort'),fmt(auto||optOnly),'',T('rem.auto.help')):null]),
na?null:readiness(RD),
lim.length?el('details',{class:'gaps'},[el('summary',{text:T('ov.notMeasured',{n:lim.length})}),el('ul',{},lim.map(function(l){return el('li',{text:l[1]})}))]):null])]));
var LC=R.findings.filter(function(f){return f.context==='launch-checklist'}),EV=R.findings.filter(function(f){return f.context==='environment'});
function ctxRow(f){var r=rt(f.ruleId);return el('div',{class:'row static'},[el('span'),dot(f.severity),el('div',{class:'rmain'},[el('div',{class:'rt',text:r.title}),r.fix?el('div',{class:'rs',text:r.fix}):null]),el('span',{class:'rc',text:fmt(f.count)})])}
if(LC.length||EV.length||R.scores.profile==='pre-launch'){P.appendChild(h2(T('pl.title'),T('pl.note')));P.appendChild(LC.length?el('div',{class:'list'},LC.map(ctxRow)):el('p',{class:'muted',text:T('pl.none')}));
if(EV.length)P.appendChild(el('details',{class:'more'},[el('summary',{text:T('pl.env')+' ('+EV.length+')'}),el('p',{class:'muted small',text:T('pl.envNote')}),el('div',{class:'list'},EV.map(ctxRow))]))}
var all=el('button',{type:'button',class:'link',text:T('ov.allIssues')+' ›'});all.onclick=function(){showTab('issues');window.scrollTo(0,0)};
P.appendChild(h2(T('pri.title'),T('pri.note'),issues.length?all:null));
P.appendChild(top.length?el('div',{class:'list'},top.map(function(f){return issueRow(f,true)})):el('p',{class:'empty',text:T('pri.none')}));
var areas=el('div',{class:'areas'});PILLARS.forEach(function(p){var cats=p[1],fs=issues.filter(function(f){return cats.indexOf(f.category)>=0});var sc=cats.map(function(c){return R.scores.byCategory[c]}).filter(function(x){return typeof x==='number'});var v=sc.length?Math.min.apply(null,sc):100;
if(p[0]==='geo'&&R.mode==='repository'&&!fs.length)return;
var b=el('button',{type:'button',class:'area',title:cats.map(function(c){return T('cat.'+c)}).join(', ')+' — '+(fs.length?T('pillar.issues',{n:fs.length}):T('pillar.noIssues'))},[el('span',{text:T('pillar.'+p[0])}),el('b',{text:String(v)}),meter(v,v>=90?'':v>=70?'mid':'poor')]);
b.onclick=function(){FILT.cat=cats.length===1?cats[0]:'';FILT.q='';FILT.sev='';FILT.pillar=cats;showTab('issues');issuesPanel(document.getElementById('p-issues'));window.scrollTo(0,0)};areas.appendChild(b)});
P.appendChild(h2(T('ov.pillars'),T('ov.healthNote')));P.appendChild(areas);
if(D.diff){var X=D.diff,dd=X.scoreBefore===null||X.scoreAfter===null?null:X.scoreAfter-X.scoreBefore,go=el('button',{type:'button',class:'link',text:T('nav.changes')+' ›'});go.onclick=function(){showTab('changes');window.scrollTo(0,0)};
P.appendChild(h2(T('kpi.change'),null,go));P.appendChild(statrow([stat(T('ch.score'),dd===null?'—':(dd>=0?'+':'')+dd),stat(T('ch.new'),fmt(X.newFindings.length),X.newFindings.length?'hot':''),stat(T('ch.resolved'),fmt(X.resolved.length))]))}}
function readiness(RD){if(!RD||RD.ready===null||RD.ready===undefined)return null;
var hasGeo=R.mode==='website'&&R.geo&&R.geo.bots&&R.geo.bots.length,th=RD.thresholds,box=el('div',{class:'ready'}),items=el('div',{class:'rditems'}),det=el('div',{class:'rdetail',id:'rd-detail',role:'region',hidden:true}),cur=null;
function go(label,fn){var b=el('button',{type:'button',class:'link',text:label+' ›'});b.onclick=fn;return el('p',{},[b])}
function detail(k,s){var out=[];if(s.status==='not-measured')return[el('p',{text:T('rd.na.'+k)})];
if(k==='sd'){out.push(el('p',{text:T('rd.sd.detail',{p:fmt(s.pages),n:fmt(s.of),t:th.structuredDataPercent})}));if(s.partial)out.push(el('p',{text:T('rd.partial')}));
out.push(go(T('rd.showRows'),function(){SHOWINFO=true;FILT={sev:'',cat:'structured-data',rem:'',conf:'',q:'',pillar:null};showTab('issues');issuesPanel(document.getElementById('p-issues'));window.scrollTo(0,0)}))}
if(k==='content'){out.push(el('p',{text:T('rd.content.detail',{n:fmt(s.pages),i:fmt(s.indexable),l:fmt(s.legal),t:th.contentPages})}));
var ty=Object.keys(s.byType||{});if(ty.length)out.push(el('p',{text:ty.map(function(t){return TT('ptype.'+t,t)+' '+fmt(s.byType[t])}).join(' · ')}));if(s.partial)out.push(el('p',{text:T('rd.partial')}))}
if(k==='ai'){out.push(el('p',{text:s.blocked.length?T('rd.ai.blocked',{b:s.blocked.join(', ')}):T('rd.ai.open')}));
out.push(el('p',{text:'llms.txt: '+T(s.llmsTxt==='present'?'geo.present':s.llmsTxt==='absent'?'geo.absent':'geo.notChecked')+' · '+T('rd.training',{n:fmt(s.trainingBlocked)})}));
if(hasGeo)out.push(go(T('rd.aiAccess'),function(){showTab('geo');window.scrollTo(0,0)}))}
return out}
[['sd',RD.structuredData],['content',RD.contentPages],['ai',RD.aiSearch]].forEach(function(x){var k=x[0],s=x[1],na=s.status==='not-measured';
var v=na?T('rd.notMeasured'):k==='sd'?T('rd.pct',{n:s.percent}):k==='content'?fmt(s.pages):T(s.blocked.length?'rd.blocked':'rd.open');
var st=na?T('rd.notMeasured'):T('rd.'+s.status);
var b=el('button',{type:'button',class:'rd'+(na?' na':''),'aria-expanded':'false','aria-controls':'rd-detail','aria-label':T('rd.'+k)+': '+v+(na?'':', '+st),'data-rd':k},[el('i',{class:'rd-dot '+(na?'na':s.status),'aria-hidden':'true'}),el('span',{text:T('rd.'+k)}),el('b',{text:v})]);
b.onclick=function(){var open=cur!==b;if(cur)cur.setAttribute('aria-expanded','false');det.textContent='';det.hidden=!open;cur=open?b:null;if(open){b.setAttribute('aria-expanded','true');detail(k,s).forEach(function(n){det.appendChild(n)})}};
items.appendChild(b)});
var hn=hint(T('rd.note'));box.appendChild(el('div',{class:'rdhead'},[el('span',{text:T('rd.title')}),hn[0]]));box.appendChild(hn[1]);box.appendChild(items);box.appendChild(det);return box}
function openIssue(f){OPEN[f.ruleId]=1;FILT={sev:'',cat:'',rem:'',conf:'',q:'',pillar:null};showTab('issues');issuesPanel(document.getElementById('p-issues'));var r=document.getElementById('row-'+f.ruleId);if(r&&r.scrollIntoView)r.scrollIntoView({block:'center'})}
function issueRow(f,compact){var r=rt(f.ruleId),G=groupsOf(f),rem=D.rem[f.ruleId],rv=reviewOf(f.ruleId);
var cb=el('input',{type:'checkbox','aria-label':T('iss.selectFinding')+': '+r.title});var n=selCount(f);cb.checked=G.length>0&&n===G.length;cb.indeterminate=n>0&&n<G.length;
var gcbs=[];cb.onchange=function(){G.forEach(function(g){if(cb.checked)SEL[g.id]=1;else delete SEL[g.id]});gcbs.forEach(function(x){x.checked=cb.checked});actionbar();syncRows(f)};
var open=!compact&&!!OPEN[f.ruleId];
var btn=el('button',{type:'button',class:'rowbtn','aria-expanded':compact?null:(open?'true':'false')},[el('span',{class:'rmain'},[el('span',{class:'rt',text:r.title}),el('span',{class:'rs',text:where(f)})]),el('span',{class:'rc',text:T(unitKey(),{n:fmt(pagesOf(f))})}),el('span',{class:'chev','aria-hidden':'true',text:'›'})]);
var row=el('div',{class:'row'+(open?' open':''),id:compact?null:'row-'+f.ruleId,'data-sev':f.severity,'data-rule':f.ruleId},[cb,dot(f.severity),btn]);
if(compact){btn.onclick=function(){openIssue(f)};return row}
var body=null;function build(){
var dl=el('dl',{class:'kv'},[el('dt',{text:T('iss.message')}),el('dd',{text:f.message}),r.fix?el('dt',{text:T('iss.fix')}):null,r.fix?el('dd',{text:r.fix}):null,r.verify?el('dt',{text:T('iss.verify')}):null,r.verify?el('dd',{text:r.verify}):null]);
var tags=el('div',{class:'tags'},[sevTag(f.severity),tag(T('rem.'+rem),'rem-'+rem,T('rem.'+rem+'.help')),tag(T('conf.'+f.confidence),'conf-'+f.confidence,T('ev.'+f.confidence)),f.priority?tag(f.priority.bucket,'prio',T('iss.priority')+' '+f.priority.score+' · '+T('iss.effort')+' '+f.priority.effort):null,f.priority&&f.priority.causedBy?tag(T('rc.of',{t:rt(f.priority.causedBy.ruleId).title}),'rc-of',f.priority.causedBy.why||null):null,rv?tag(T('iss.review.'+rv.status),'review-'+rv.status):null]);
var ev=el('div',{class:'evbox'},[el('h4',{text:T('iss.groups')+' ('+G.length+')'})]);
G.forEach(function(g){var gc=el('input',{type:'checkbox','aria-label':T('iss.selectGroup')+': '+g.key,'data-gid':g.id});gc.checked=!!SEL[g.id];gc.onchange=function(){if(gc.checked)SEL[g.id]=1;else delete SEL[g.id];syncRows(f);actionbar()};gcbs.push(gc);
var lines=g.evidence.slice(0,30).map(function(i){var e=f.evidence[i],rr=reviewOf(f.ruleId,e.ref);return el('div',{class:'ev'},[el('span',{class:'ref',text:e.ref}),' ',e.url&&/^https?:/i.test(e.url)?el('a',{href:safeHref(e.url),rel:'noopener noreferrer',target:'_blank',text:e.url}):(e.file||e.url||'')+(e.line?':'+e.line:''),e.file&&e.url?' ('+e.url+')':'',e.observed?' — '+e.observed:'',e.expected?' → '+e.expected:'',artLinks(e.artefact),rr?tag(T('iss.review.'+rr.status),'review-'+rr.status):null])});
var more=g.pages-Math.min(30,g.evidence.length);
ev.appendChild(el('div',{class:'group'},[el('div',{class:'grow'},[gc,el('details',{},[el('summary',{},[el('span',{class:'gkind',text:T('iss.group.'+g.kind)}),' ',g.kind==='layout'?null:el('code',{text:g.kind==='site'?(f.evidence[0]&&(f.evidence[0].url||f.evidence[0].file)||'—'):g.key}),' ',tag(T(R.mode==='website'&&g.kind!=='file'?'iss.pages':'iss.locations',{n:fmt(g.pages)})),g.kind==='template'&&g.pages>1?tag(T('iss.shared'),'brand'):g.kind==='layout'?tag(T('iss.layout'),'brand'):null,g.langs.length?tag(g.langs.join(', ')):null])].concat(lines).concat(more>0?[el('div',{class:'muted small',text:T('iss.more',{n:fmt(more)})})]:[]))])]))});
ev.appendChild(el('p',{class:'muted small'},[T('iss.rule')+' ',el('code',{text:f.ruleId}),' · '+T('iss.engines')+': '+f.engines.join(', ')+(f.priority?' · '+T('iss.priority')+' '+f.priority.bucket+' ('+f.priority.score+') · '+T('iss.effort')+' '+f.priority.effort:'')]));
if(f.priority&&f.priority.reasons&&f.priority.reasons.length)ev.appendChild(el('p',{class:'muted small',text:T('pri.why')+': '+f.priority.reasons.join('; ')}));
if(r.sources.length)ev.appendChild(el('div',{class:'sources'},[el('h4',{text:T('iss.sources')}),el('ul',{},r.sources.map(function(s){return el('li',{class:'small'},[el('a',{href:safeHref(s.url),rel:'noopener noreferrer',target:'_blank',text:s.title}),' — '+T('iss.checked',{d:s.checked})])}))]));
return el('div',{class:'detail'},[dl,tags,rem!=='auto'&&D.opt[f.ruleId]?el('p',{class:'muted small',text:T('rem.optimizerHint')}):null,
rv?el('p',{class:'review'},[el('b',{text:T('iss.review.'+rv.status)}),rv.note?' — '+rv.note:'',el('span',{class:'muted small',text:' · '+(rv.at||'').slice(0,10)+' · '+T('iss.review.note')})]):null,
el('details',{class:'more'},[el('summary',{text:T('iss.evidenceSources')}),ev])])}
function toggle(){var o=!row.classList.contains('open');if(o){OPEN[f.ruleId]=1;if(!body){body=build();wrap.appendChild(body)}}else delete OPEN[f.ruleId];row.classList.toggle('open',o);btn.setAttribute('aria-expanded',o?'true':'false')}
btn.onclick=toggle;var wrap=el('div',{class:'item'},[row]);if(open){body=build();wrap.appendChild(body)}return wrap}
function syncRows(f){document.querySelectorAll('[data-rule="'+f.ruleId+'"] > input').forEach(function(cb){var G=groupsOf(f),k=selCount(f);cb.checked=G.length>0&&k===G.length;cb.indeterminate=k>0&&k<G.length});document.querySelectorAll('input[data-gid]').forEach(function(x){x.checked=!!SEL[x.getAttribute('data-gid')]})}
function visible(){var q=FILT.q.toLowerCase();return R.findings.filter(function(f){if(!SHOWINFO&&!isIssue(f))return false;if(FILT.sev&&f.severity!==FILT.sev)return false;if(FILT.cat&&f.category!==FILT.cat)return false;if(FILT.pillar&&!FILT.cat&&FILT.pillar.indexOf(f.category)<0)return false;if(FILT.rem&&D.rem[f.ruleId]!==FILT.rem)return false;if(FILT.conf&&f.confidence!==FILT.conf)return false;
if(q){var r=rt(f.ruleId);if((r.title+' '+f.ruleId+' '+f.message+' '+JSON.stringify(f.evidence)).toLowerCase().indexOf(q)<0)return false}return true}).sort(byPriority)}
function sel(opts,val,on,label,allText){var s=el('select',{'aria-label':label},[el('option',{value:'',text:allText||label})].concat(opts.map(function(o){var x=el('option',{value:o[0],text:o[1]});if(o[0]===val)x.selected=true;return x})));s.onchange=function(){on(s.value)};return s}
function issuesPanel(P){P.textContent='';var cats={};R.findings.forEach(function(f){cats[f.category]=1});
var q=el('input',{type:'search',placeholder:T('iss.search'),'aria-label':T('iss.search'),value:FILT.q});q.oninput=function(){FILT.q=q.value;list()};
var catSel=sel(Object.keys(cats).sort().map(function(c){return[c,T('cat.'+c)]}),FILT.cat,function(v){FILT.cat=v;FILT.pillar=null;list()},T('iss.filterCat'),T('iss.allAreas'));
var inf=el('label',{class:'check'},[el('input',{type:'checkbox'}),T('iss.showInfo')]);inf.firstChild.checked=SHOWINFO;inf.firstChild.onchange=function(){SHOWINFO=inf.firstChild.checked;list()};
var more=el('details',{class:'filters'},[el('summary',{class:'pill',text:T('iss.filters')}),el('div',{class:'fpanel'},[
sel(['auto','agent','manual'].map(function(r){return[r,T('rem.'+r)]}),FILT.rem,function(v){FILT.rem=v;list()},T('iss.filterRem'),T('iss.filterRem')+': '+T('iss.filterAll')),
sel(['verified','heuristic','unmeasurable'].map(function(r){return[r,T('conf.'+r)]}),FILT.conf,function(v){FILT.conf=v;list()},T('iss.filterConf'),T('iss.filterConf')+': '+T('iss.filterAll')),inf,
el('div',{class:'legend-rem'},['auto','agent','manual'].map(function(r){return el('p',{class:'small'},[tag(T('rem.'+r),'rem-'+r),' ',T('rem.'+r+'.help')])}))])]);
P.appendChild(el('div',{class:'tools'},[el('label',{class:'search'},[el('span',{class:'glass','aria-hidden':'true',text:'⌕'}),q]),catSel,more]));
var chips=el('div',{class:'chipset',role:'group','aria-label':T('iss.filterSev')});P.appendChild(chips);
var cnt=el('span',{class:'muted small'}),sa=el('button',{type:'button',class:'link',text:T('iss.selectVisible')}),cl=el('button',{type:'button',class:'link',text:T('iss.clear')});
sa.onclick=function(){visible().forEach(function(f){groupsOf(f).forEach(function(g){SEL[g.id]=1})});list();actionbar()};cl.onclick=function(){SEL={};list();actionbar()};
P.appendChild(el('div',{class:'toolbar'},[cnt,el('span',{class:'spacer'}),sa,cl]));
var L=el('div',{class:'list',id:'list'});P.appendChild(L);
function mkChips(){chips.textContent='';var pool=R.findings.filter(function(f){return SHOWINFO||isIssue(f)});var opts=[['',T('iss.filterAll'),pool.length]].concat(SEVS.map(function(s){return[s,T('sev.'+s),pool.filter(function(f){return f.severity===s}).length]}).filter(function(o){return o[2]>0}));
opts.forEach(function(o){var b=el('button',{type:'button','aria-pressed':FILT.sev===o[0]?'true':'false'},[o[0]?dot(o[0]):null,o[1]+' ',el('span',{class:'n',text:String(o[2])})]);b.onclick=function(){FILT.sev=o[0];list()};chips.appendChild(b)})}
function list(){mkChips();L.textContent='';var v=visible(),ng=0;v.forEach(function(f){ng+=groupsOf(f).length;L.appendChild(issueRow(f,false))});cnt.textContent=T('iss.count',{n:v.length,g:ng});L.classList.toggle('isempty',!v.length);if(!v.length)L.appendChild(el('p',{class:'empty',text:T('iss.empty')}))}
list()}
function selection(){var items=[];R.findings.forEach(function(f){var gs=groupsOf(f).filter(function(g){return SEL[g.id]});if(gs.length)items.push({f:f,groups:gs})});return items}
function actionbar(){var A=document.getElementById('actionbar');A.textContent='';var s=selection(),n=0,mix={auto:0,agent:0,manual:0};s.forEach(function(x){n+=x.groups.length;mix[D.rem[x.f.ruleId]]++});
A.className=s.length?'on':'';if(!s.length)return;
var g=el('button',{type:'button',class:'btn primary',text:T('act.generate')});g.onclick=openPrompt;var c=el('button',{type:'button',class:'btn ghost',text:T('act.clear')});c.onclick=function(){SEL={};render()};
A.appendChild(el('div',{class:'abinfo',title:T('act.mix',{a:mix.auto,g:mix.agent,m:mix.manual})},[el('b',{text:T('act.selected',{n:s.length})}),el('span',{text:T('act.groups',{n:n})})]));A.appendChild(c);A.appendChild(g)}
function promptInput(lang){return{lang:lang,target:R.target,mode:R.mode,runId:R.runId,generatedAt:R.generatedAt,version:R.tool.version,repository:D.ctx.repository||undefined,
items:selection().map(function(x){var f=x.f,r=D.rules[f.ruleId]||{},tr=lang==='tr'&&r.tr,rv=reviewOf(f.ruleId);return{ruleId:f.ruleId,title:tr?r.tr.title:(r.title||f.title),severity:f.severity,confidence:f.confidence,remediation:D.rem[f.ruleId],fix:tr?r.tr.fix:r.fix,verify:r.verify,sources:r.sources||[],review:rv?rv.status+(rv.note?': '+rv.note:''):undefined,
groups:x.groups.map(function(g){return{key:g.kind==='site'?'site':g.key,kind:g.kind,pages:g.pages,evidence:g.evidence.map(function(i){return f.evidence[i]})}})}})}}
function openPrompt(){var M=document.getElementById('modal');M.textContent='';var last=document.activeElement,plang=LANG;
var ta=el('textarea',{'aria-label':T('pr.title'),spellcheck:'false'});ta.value=buildRepairPrompt(promptInput(plang));
var st=el('span',{class:'muted small',role:'status'});
var ls=el('select',{'aria-label':T('pr.lang')},[el('option',{value:'en',text:'English'}),el('option',{value:'tr',text:'Türkçe'})]);ls.value=plang;ls.onchange=function(){plang=ls.value;ta.value=buildRepairPrompt(promptInput(plang))};
var cp=el('button',{type:'button',class:'btn primary',text:T('pr.copy')});cp.onclick=function(){var done=function(){st.textContent=T('pr.copied')},fail=function(){ta.focus();ta.select();try{if(document.execCommand('copy'))return done()}catch(e){}st.textContent=T('pr.copyFail')};
try{if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(ta.value).then(done,fail);else fail()}catch(e){fail()}};
var dl=el('button',{type:'button',class:'btn',text:T('pr.download')});dl.onclick=function(){var b=new Blob([ta.value],{type:'text/markdown;charset=utf-8'}),u=URL.createObjectURL(b),a=el('a',{href:u,download:'searvex-fix-'+R.runId+'.md'});document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(u);a.remove()},500)};
var cl=el('button',{type:'button',class:'btn ghost',text:T('pr.close')});function close(){M.className='';M.textContent='';document.removeEventListener('keydown',esc);if(last&&last.focus)last.focus()}function esc(e){if(e.key==='Escape')close()}cl.onclick=close;M.onclick=function(e){if(e.target===M)close()};document.addEventListener('keydown',esc);
M.className='on';M.appendChild(el('div',{class:'dialog',role:'dialog','aria-modal':'true','aria-labelledby':'prt'},[el('div',{class:'dhead'},[el('h2',{id:'prt',text:T('pr.title')}),el('span',{class:'spacer'}),ls]),el('p',{class:'muted small',text:T('pr.note')}),!D.ctx.repository?el('p',{class:'dnote small',text:T('pr.brief')}):null,ta,el('div',{class:'dfoot'},[st,el('span',{class:'spacer'}),cl,dl,cp])]));ta.focus();ta.setSelectionRange(0,0);ta.scrollTop=0}
function geo(P){var G=R.geo,by={};G.bots.forEach(function(b){(by[b.purpose]=by[b.purpose]||[]).push(b)});
var allowed=G.bots.filter(function(b){return b.allowed}).length;
P.appendChild(statrow([stat(T('geo.allowedN'),fmt(allowed)),stat(T('geo.blockedN'),fmt(G.bots.length-allowed),G.bots.length-allowed?'hot':''),stat(T('geo.clarityShort'),G.answerability.average+'/100','',T('geo.clarity',{n:G.answerability.average}))]));
P.appendChild(h2(T('geo.access'),T('geo.accessNote')));var grid=el('div',{class:'botgrid'});Object.keys(by).forEach(function(p){grid.appendChild(el('div',{class:'list'},[el('div',{class:'listhead',text:T('purpose.'+p)===('purpose.'+p)?p:T('purpose.'+p)})].concat(by[p].map(function(b){return el('div',{class:'bot'},[el('i',{class:'dot '+(b.allowed?'d-ok':'d-critical'),role:'img','aria-label':T(b.allowed?'geo.allowed':'geo.blocked')}),el('code',{text:b.token}),el('span',{class:'muted small',text:b.operator}),el('span',{class:'spacer'}),el('span',{class:b.allowed?'ok':'bad',text:T(b.allowed?'geo.allowed':'geo.blocked')+(b.explicit?'':' '+T('geo.inherits'))})])}))))});P.appendChild(grid);
P.appendChild(h2(T('geo.signals')));P.appendChild(el('div',{class:'surface pad'},[el('dl',{class:'kv'},[el('dt',{text:'llms.txt'}),el('dd',{text:(G.llmsTxt?T(G.llmsTxt.present?'geo.present':'geo.absent'):T('geo.notChecked'))+' — '+T('geo.llmsNote')}),el('dt',{text:T('geo.clarityShort')}),el('dd',{text:T('geo.clarity',{n:G.answerability.average})}),el('dt',{text:T('geo.citationsShort')}),el('dd',{text:T('geo.citations',{r:G.citations.reason||''})}),el('dt',{text:T('geo.entities')}),el('dd',{text:Object.keys(G.entityNames).map(function(n){return n+' ('+G.entityNames[n]+')'}).join(', ')||'—'})])]));
if(G.answerability.pages.length){P.appendChild(h2(T('geo.lowest')));P.appendChild(table([T('tbl.url'),T('tbl.score'),T('tbl.missing')],G.answerability.pages.slice(0,30).map(function(p){return[p.url,p.score,Object.keys(p.signals).filter(function(k){return!p.signals[k]}).join(', ')]})))}}
function search(P){var S=D.search,t=S.totals;P.appendChild(h2(T('sp.title'),T('sp.source',{s:S.source+(S.property?' · '+S.property:''),d:S.period.days})+' · '+T('sp.inferred')));
P.appendChild(statrow([stat(T('sp.clicks'),fmt(t.clicks)),stat(T('sp.impressions'),fmt(t.impressions)),stat(T('sp.ctr'),pct(t.ctr)),stat(T('sp.queries'),fmt(t.queries))]));
P.appendChild(h2(T('sp.queries')));P.appendChild(table([T('sp.query'),T('sp.clicks'),T('sp.impressions'),T('sp.ctr'),T('sp.position')],S.topQueries.slice(0,15).map(function(q){return[q.query,fmt(q.clicks),fmt(q.impressions),pct(q.ctr),q.position.toFixed(1)]})));
if(S.strikingDistance.length){P.appendChild(h2(T('sp.striking'),T('sp.strikingNote')));P.appendChild(table([T('sp.query'),T('tbl.url'),T('sp.position'),T('sp.impressions')],S.strikingDistance.slice(0,15).map(function(q){return[q.query,q.page||'—',q.position.toFixed(1),fmt(q.impressions)]})))}
if(S.lowCtr.length){P.appendChild(h2(T('sp.lowCtr')));P.appendChild(table([T('sp.query'),T('tbl.url'),T('sp.position'),T('sp.ctr')],S.lowCtr.slice(0,15).map(function(q){return[q.query,q.page||'—',q.position.toFixed(1),pct(q.ctr)+' / '+pct(q.siteMedianCtr)]})))}
if(S.topPages.length){P.appendChild(h2(T('sp.pages')));P.appendChild(table([T('tbl.url'),T('sp.clicks'),T('sp.impressions'),T('sp.position')],S.topPages.slice(0,15).map(function(q){return[q.page,fmt(q.clicks),fmt(q.impressions),q.position.toFixed(1)]})))}}
function changes(P){diffView(P,D.diff)}
function details(P,issues){var byId={};R.findings.forEach(function(f){byId[f.ruleId]=f});var unit=unitKey();
var roots=issues.filter(function(f){return f.priority&&f.priority.effects&&f.priority.effects.length});
P.appendChild(h2(T('rc.title'),T('rc.note')));
if(!roots.length)P.appendChild(el('p',{class:'empty',text:T('rc.none')}));
roots.forEach(function(c){var eff=c.priority.effects.map(function(id){return byId[id]}).filter(Boolean),why=eff[0]&&eff[0].priority&&eff[0].priority.causedBy?eff[0].priority.causedBy.why:'';
P.appendChild(el('div',{class:'list rc'},[el('div',{class:'listhead'},[dot(c.severity),' ',el('b',{text:rt(c.ruleId).title}),' ',el('code',{class:'muted',text:c.ruleId})]),why?el('p',{class:'muted small pad-x',text:T('rc.why')+': '+why}):null].concat(eff.map(function(f){return el('div',{class:'row static'},[el('span'),dot(f.severity),el('div',{class:'rmain'},[el('div',{class:'rt',text:rt(f.ruleId).title})]),el('span',{class:'rc',text:T(unit,{n:fmt(f.count)})})])}))))});
var areas={};issues.forEach(function(f){(D.groups[f.ruleId]||[]).forEach(function(g){if(g.kind!=='template'&&g.kind!=='file')return;var k=g.kind+':'+g.key,a=areas[k]||(areas[k]={kind:g.kind,key:g.key,rules:[],pages:0});a.rules.push({id:f.ruleId,sev:f.severity,pages:g.pages});if(g.pages>a.pages)a.pages=g.pages})});
var al=Object.keys(areas).map(function(k){return areas[k]}).filter(function(a){return a.rules.length>=2}).sort(function(a,b){return b.rules.length-a.rules.length||b.pages-a.pages});
P.appendChild(h2(T('rc.areas'),T('rc.areasNote')));
if(!al.length)P.appendChild(el('p',{class:'empty',text:T('rc.noAreas')}));
al.slice(0,30).forEach(function(a){P.appendChild(el('div',{class:'list rc'},[el('div',{class:'listhead'},[el('span',{class:'gkind',text:T('iss.group.'+a.kind)}),' ',el('code',{text:a.key}),' · ',T('rc.rules',{n:a.rules.length})])].concat(a.rules.map(function(r){return el('div',{class:'row static'},[el('span'),dot(r.sev),el('div',{class:'rmain'},[el('div',{class:'rt',text:rt(r.id).title})]),el('span',{class:'rc',text:T(unit,{n:fmt(r.pages)})})])}))))});
var c=el('div',{class:'charts'});
c.appendChild(stacked(T('ov.severity'),SEVS.slice(0,4).map(function(s){return[T('sev.'+s),issues.filter(function(f){return f.severity===s}).length,s]})));
c.appendChild(stacked(T('ov.remediation'),[['auto','brand'],['agent','brand-2'],['manual','brand-3']].map(function(r){return[T('rem.'+r[0]),issues.filter(function(f){return D.rem[f.ruleId]===r[0]}).length,r[1]]}),T('rem.auto.help')));
c.appendChild(stacked(T('ov.measurement'),[[T('conf.verified'),R.measurement.verified,'brand'],[T('conf.heuristic'),R.measurement.heuristic,'brand-2'],[T('conf.unmeasurable'),R.measurement.unmeasurable,'faint']],[T('ev.verified'),T('ev.heuristic'),T('ev.unmeasurable')].join(' ')));
c.appendChild(bars(T('ov.health'),Object.keys(R.scores.byCategory).sort(function(a,b){return R.scores.byCategory[a]-R.scores.byCategory[b]}).map(function(k){var v=R.scores.byCategory[k];return[T('cat.'+k),v,v>=90?'':v>=70?'mid':'poor']}),{max:100,note:T('ov.healthNote')}));
var tops=D.templates.filter(function(t){return t.pages>1||t.issues.length>1}).slice(0,6);
c.appendChild(bars(T('ov.rootCauses'),tops.map(function(t){return[t.pattern+' · '+t.issues.length+'×',t.pages,'']}),{note:T('ov.rootCausesNote'),suffix:' '+(R.mode==='website'?T('iss.pages',{n:''}).trim():'')}));
P.appendChild(h2(T('ev.overview')));P.appendChild(c);
P.appendChild(h2(T('ev.method')));P.appendChild(el('p',{class:'small prose',text:T('ev.methodText')}));
P.appendChild(h2(T('ev.limits')));P.appendChild(el('ul',{class:'small prose'},R.limitations.concat(R.geo.notes||[]).map(function(l){return el('li',{text:l})})));
if((D.reviews||[]).length){P.appendChild(h2(T('ev.reviews'),T('iss.review.note')));P.appendChild(table([T('iss.rule'),T('iss.ref'),T('ch.issue'),'',''],D.reviews.map(function(x){return[x.ruleId,x.ref||'—',T('iss.review.'+x.status),x.note||'',(x.at||'').slice(0,10)]})))}
P.appendChild(h2(T('ev.rules')));var ids={};R.findings.forEach(function(f){ids[f.ruleId]=f});P.appendChild(table([T('iss.rule'),T('ev.title'),T('iss.filterConf'),T('iss.sources')],Object.keys(ids).sort().map(function(id){var r=rt(id);return[el('code',{text:id}),r.title,T('conf.'+ids[id].confidence),el('span',{},r.sources.map(function(s,i){return el('span',{},[i?' · ':'',el('a',{href:safeHref(s.url),rel:'noopener noreferrer',target:'_blank',text:s.title}),' ('+s.checked+')'])}))]})));
if(R.inventory.pages.length){P.appendChild(el('details',{class:'more block'},[el('summary',{text:T('ev.inventory')+' ('+fmt(R.inventory.pages.length)+')'}),table([T('tbl.url'),T('tbl.type'),T('tbl.lang'),T('tbl.indexable'),T('tbl.depth'),T('tbl.inlinks'),T('tbl.words')],R.inventory.pages.slice(0,500).map(function(p){return[p.url,p.type,p.lang||'',T(p.indexable?'yes':'no'),p.depth,p.inlinks,p.words]}))]))}
if(R.content&&R.content.clusters.length){P.appendChild(el('details',{class:'more block'},[el('summary',{text:T('ev.content')}),table([T('ev.section'),T('ch.pages'),T('ev.terms')],R.content.clusters.slice(0,30).map(function(c){return['/'+c.key,c.pages.length,c.terms.join(', ')]}))]))}
P.appendChild(el('p',{class:'muted small prose',text:T('ev.promise')}))}
`;

/** Before/after view used by the audit "Changes" tab and the standalone monitor page. */
export const DIFF_VIEW = String.raw`function diffView(P,M){var delta=M.scoreBefore===null||M.scoreAfter===null?null:M.scoreAfter-M.scoreBefore;
P.appendChild(statrow([stat(T('ch.score'),(M.scoreBefore===null?'':M.scoreBefore+' → ')+(M.scoreAfter===null?'n/a':M.scoreAfter)+(delta===null?'':' ('+(delta>=0?'+':'')+delta+')')),stat(T('ch.pages'),(M.pagesBefore===null?'':fmt(M.pagesBefore)+' → ')+fmt(M.pagesAfter)),stat(T('ch.new'),fmt(M.newFindings.length),M.newFindings.length?'hot':''),stat(T('ch.resolved'),fmt(M.resolved.length)),stat(T('ch.worse')+' / '+T('ch.better'),M.worsened.length+' / '+M.improved.length),stat(T('ch.regression'),T(M.regression?'ch.yes':'ch.no'),M.regression?'hot':'')]));
var changed=M.newFindings.concat(M.worsened,M.improved,M.resolved),mx=Math.max.apply(null,changed.map(function(x){return Math.max(x.before,x.after)}).concat([1]));
if(changed.length){var c=el('div',{class:'charts'});c.appendChild(bars(T('ch.before'),changed.slice(0,10).map(function(x){return[rtitle(x),x.before,x.severity]}),{max:mx}));c.appendChild(bars(T('ch.after'),changed.slice(0,10).map(function(x){return[rtitle(x),x.after,x.severity]}),{max:mx}));P.appendChild(c)}
[['ch.new',M.newFindings],['ch.worse',M.worsened],['ch.better',M.improved],['ch.resolved',M.resolved]].forEach(function(g){P.appendChild(h2(T(g[0])+' ('+g[1].length+')'));P.appendChild(g[1].length?table([T('ch.issue'),T('iss.filterSev'),T('ch.before'),T('ch.after'),T('ch.delta')],g[1].map(function(x){return[rtitle(x)+' ('+x.ruleId+')',T('sev.'+x.severity),x.before,x.after,deltaSpan(x.after-x.before)]})):el('p',{class:'empty',text:T('ch.nothing')}))});
P.appendChild(el('p',{class:'muted small',text:T('kpi.scoreNote')}))}
function rtitle(x){var r=D.rules&&D.rules[x.ruleId];return LANG==='tr'&&r&&r.tr?r.tr.title:x.title}
`;

export const MONITOR_SCRIPT = String.raw`function render(){var M=document.getElementById('main');M.textContent='';var X=D.diff;
document.getElementById('kicker').textContent=T('title.monitor');document.getElementById('t').textContent=X.target;document.getElementById('meta').textContent=(X.baselineRun?X.baselineRun+' → ':'')+X.currentRun;
var P=panel('changes');diffView(P,X);if(!X.baselineRun)P.insertBefore(el('p',{class:'notice',text:T('ch.none')}),P.firstChild);mkTabs([['changes',T('nav.changes')]])}
`;

export const ECOSYSTEM_SCRIPT = String.raw`function render(){var M=document.getElementById('main');M.textContent='';var E=D.eco;
document.getElementById('kicker').textContent=T('title.ecosystem');document.getElementById('t').textContent=E.sites.length+' sites';document.getElementById('meta').textContent=E.sites.map(function(s){return s.host}).join(' · ');
var B=panel('overview');var ch=el('div',{class:'charts'});
ch.appendChild(bars(T('eco.scoreBySite'),E.sites.filter(function(s){return s.score!==null}).map(function(s){return[s.host,s.score,s.score>=90?'':s.score>=70?'mid':'poor']}),{max:100,note:T('kpi.scoreNote')}));
ch.appendChild(bars(T('eco.shared'),E.sharedIssues.slice(0,10).map(function(i){return[i.title,i.sites,i.severity]}),{max:E.sites.length}));B.appendChild(ch);
B.appendChild(h2(T('eco.sites')));B.appendChild(table(['Site','Site name','Organization','Parent','Children','Model ~','Languages',T('ch.pages')],E.sites.map(function(s){return[s.host,s.siteName,s.organization,s.parent,s.children.join(', ')||'—',s.model,s.languages.join(', '),s.pages]})));
B.appendChild(h2(T('eco.links')));var H=E.sites.map(function(s){return s.host});
B.appendChild(table(['from \\ to'].concat(H),H.map(function(a){return[a].concat(H.map(function(b){if(a===b)return'·';var n=(E.links[a]||{})[b]||0;return el('span',{text:String(n),class:n?'':'bad',title:n?n+' links':'no links'})}))})));
var kinds={entity:'Entity & brand graph',linking:'Cross-linking','shared-issue':'Shared issues',overlap:'Topic overlap',coverage:'Language coverage'};
B.appendChild(h2(T('eco.obs'),T('eco.heuristicNote')));if(!E.observations.length)B.appendChild(el('p',{class:'empty',text:T('eco.none')}));
Object.keys(kinds).forEach(function(k){var L=E.observations.filter(function(o){return o.kind===k});if(!L.length)return;B.appendChild(el('h3',{text:kinds[k]}));B.appendChild(el('ul',{class:'prose'},L.map(function(o){return el('li',{},[(o.confidence==='heuristic'?'~ ':'')+o.message,o.recommendation?el('div',{class:'muted small',text:'→ '+o.recommendation}):null])})))});
if(E.overlap.length){B.appendChild(h2(T('eco.overlap')));B.appendChild(table(['Sites','%','Terms'],E.overlap.slice(0,15).map(function(o){return[o.a+' ↔ '+o.b,Math.round(o.similarity*100)+'%',o.shared.slice(0,8).join(', ')]})))}
B.appendChild(h2(T('eco.limits')));B.appendChild(el('ul',{class:'small prose'},E.limitations.map(function(l){return el('li',{text:l})})));B.appendChild(el('p',{class:'muted small',text:T('kpi.scoreNote')}));
mkTabs([['overview',T('nav.overview')]])}
`;
