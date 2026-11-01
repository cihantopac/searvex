/**
 * Browser-side code of the HTML reports, kept as plain ES5-style strings (the reports are offline files with a
 * strict CSP and no build step). Rules: render only through textContent/createElement (never innerHTML), never
 * template literals here (the strings are embedded in TS template literals).
 */

/** Runs in <head> before the stylesheet applies: sets the stored theme so the page never flashes. */
export const THEME_BOOT = String.raw`(function(){try{var t=localStorage.getItem('searvex.theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}})();`;

/** Shared helpers: DOM builders, i18n, theme/language switchers, tabs, tables and charts. */
export const CLIENT_LIB = String.raw`function el(t,a,c){var e=document.createElement(t);if(a)for(var k in a){if(a[k]===null||a[k]===undefined||a[k]===false)continue;if(k==='text')e.textContent=a[k];else e.setAttribute(k,a[k]===true?'':a[k]);}(c||[]).forEach(function(x){if(x!==null&&x!==undefined&&x!==false)e.appendChild(typeof x==='string'||typeof x==='number'?document.createTextNode(String(x)):x)});return e}
var NS='http://www.w3.org/2000/svg';
function svg(t,a,c){var e=document.createElementNS(NS,t);for(var k in(a||{}))e.setAttribute(k,a[k]);(c||[]).forEach(function(x){if(x)e.appendChild(x)});return e}
function safeHref(u){return /^https?:\/\//i.test(u)?u:'#'}
function store(k,v){try{if(v===undefined)return localStorage.getItem(k);if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){return null}}
var LANG=(function(){var s=store('searvex.lang');if(s==='en'||s==='tr')return s;var l=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||'en']);return l.some(function(x){return /^tr\b/i.test(x)})?'tr':'en'})();
function T(k,v){var d=D.i18n[LANG]||D.i18n.en;if(v&&String(v.n)==='1'&&d[k+'.one']!==undefined)k=k+'.one';var s=d[k];if(s===undefined)s=D.i18n.en[k];if(s===undefined)s=k;if(v)s=s.replace(/\{(\w+)\}/g,function(m,n){return v[n]===undefined?m:String(v[n])});return s}
function fmt(n){try{return Number(n).toLocaleString(LANG==='tr'?'tr-TR':'en-US')}catch(e){return String(n)}}
function pct(n){return (LANG==='tr'?'%':'')+(Math.round(n*1000)/10).toLocaleString(LANG==='tr'?'tr-TR':'en-US')+(LANG==='tr'?'':'%')}
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
function h2(t,note){return el('div',{class:'h2'},[el('h2',{text:t}),note?el('p',{class:'muted small',text:note}):null])}
function table(head,rows,cls){return el('div',{class:'tablewrap'},[el('table',{class:cls||''},[el('thead',{},[el('tr',{},head.map(function(h){return el('th',{scope:'col',text:h})}))]),el('tbody',{},rows.map(function(r){return el('tr',{},r.map(function(c){return c instanceof Node?el('td',{},[c]):el('td',{text:String(c)})}))}))])])}
function bars(title,rows,opts){opts=opts||{};var max=opts.max||Math.max.apply(null,rows.map(function(r){return r[1]}).concat([1]));return el('div',{class:'chart',role:'figure','aria-label':title},[el('h3',{text:title}),opts.note?el('p',{class:'muted small',text:opts.note}):null].concat(rows.length?rows.map(function(r){return el('div',{class:'bar'},[el('span',{text:r[0],title:r[0]}),el('div',{class:'track'},[el('div',{class:'fill '+(r[2]||''),style:'width:'+Math.max(r[1]?2:0,Math.round(r[1]/max*100))+'%'})]),el('b',{text:fmt(r[1])+(opts.suffix||'')})])}):[el('div',{class:'muted',text:'—'})]))}
function stacked(title,parts,note){var total=parts.reduce(function(n,p){return n+p[1]},0)||1;return el('div',{class:'chart',role:'figure','aria-label':title},[el('h3',{text:title}),el('div',{class:'stack'},parts.filter(function(p){return p[1]}).map(function(p){return el('div',{class:'fill '+p[2],style:'width:'+(p[1]/total*100)+'%',title:p[0]+': '+p[1]})})),el('div',{class:'legend'},parts.map(function(p){return el('span',{},[el('i',{class:'dot '+p[2]}),p[0]+' ',el('b',{text:fmt(p[1])})])})),note?el('p',{class:'muted small',text:note}):null])}
function gauge(v){var r=34,c=2*Math.PI*r,ok=typeof v==='number',cls=!ok?'info':v>=90?'good':v>=70?'medium':'critical';return svg('svg',{viewBox:'0 0 80 80',width:'80',height:'80',class:'gauge','aria-hidden':'true'},[svg('circle',{cx:'40',cy:'40',r:String(r),class:'gtrack'}),svg('circle',{cx:'40',cy:'40',r:String(r),class:'gfill '+cls,'stroke-dasharray':(ok?c*v/100:0)+' '+c,transform:'rotate(-90 40 40)'})])}
function card(label,value,sub,extra,cls){return el('div',{class:'card '+(cls||'')},[extra||null,el('div',{},[el('span',{class:'label',text:label}),el('b',{text:String(value)}),sub?el('span',{class:'sub',text:sub}):null])])}
function chip(t,cls,title){return el('span',{class:'chip '+(cls||''),text:t,title:title||null})}
function sevChip(s){return chip(T('sev.'+s),'sev-'+s)}
function deltaSpan(c){return el('span',{class:c>0?'delta-up':c<0?'delta-down':'',text:(c>0?'+':'')+c})}
function boot(){document.documentElement.setAttribute('lang',LANG);controls();render();document.getElementById('foot').textContent=T('footer',{v:D.version||''})}
`;

/** Website / repository audit: the action center. Expects D.report, D.rules, D.groups, D.rem, D.opt, D.templates, D.ctx, optional D.diff, D.search, D.reviews. */
export const AUDIT_SCRIPT = String.raw`var R=D.report,SEL={},SHOWINFO=false,FILT={sev:'',cat:'',rem:'',conf:'',q:''};
var SEVS=['critical','high','medium','low','info'];
function rt(id){var r=D.rules[id]||{};var tr=LANG==='tr'&&r.tr;return{title:tr?r.tr.title:(r.title||id),fix:tr?r.tr.fix:r.fix,verify:r.verify,sources:r.sources||[]}}
function isIssue(f){return f.severity!=='info'&&f.confidence!=='unmeasurable'}
function groupsOf(f){return D.groups[f.ruleId]||[]}
function selCount(f){return groupsOf(f).filter(function(g){return SEL[g.id]}).length}
function reviewOf(ruleId,ref){var L=D.reviews||[];for(var i=L.length-1;i>=0;i--){if(ref?L[i].ref===ref:(L[i].ruleId===ruleId&&!L[i].ref))return L[i]}return null}
function reviewsFor(ruleId){return(D.reviews||[]).filter(function(x){return x.ruleId===ruleId})}
var PILLARS=[['index',['crawlability','indexability','canonicalization']],['technical',['links','architecture','security','mobile','international','accessibility']],['meta',['metadata','structured-data']],['geo',['geo']],['perf',['performance']],['content',['content']]];
function render(){var M=document.getElementById('main');M.textContent='';
document.getElementById('kicker').textContent=T(R.mode==='repository'?'title.repo':'title.audit');
document.getElementById('t').textContent=R.target;
document.getElementById('meta').textContent=R.generatedAt.slice(0,16).replace('T',' ')+' UTC · Searvex '+R.tool.version+' · rules '+R.tool.rulesVersion+' · '+R.runId;
var issues=R.findings.filter(isIssue),tabs=[['overview',T('nav.overview')],['priorities',T('nav.priorities')],['issues',T('nav.issues'),issues.length]];
var hasGeo=R.mode==='website'&&R.geo&&R.geo.bots&&R.geo.bots.length;if(hasGeo)tabs.push(['geo',T('nav.geo')]);
if(D.search)tabs.push(['search',T('nav.search')]);if(D.diff)tabs.push(['changes',T('nav.changes')]);tabs.push(['evidence',T('nav.evidence')]);
overview(panel('overview'),issues);priorities(panel('priorities'),issues);issuesPanel(panel('issues'));if(hasGeo)geo(panel('geo'));if(D.search)search(panel('search'));if(D.diff)changes(panel('changes'));evidence(panel('evidence'));
mkTabs(tabs);actionbar()}
function overview(P,issues){
function TT(k,fb){var s=T(k);return s===k?fb:s}
var lim=[];if(R.crawl.truncated)lim.push([T('lim.truncated'),T('warn.truncated',{n:fmt(R.crawl.queuedRemaining)})]);if(R.scores.notApplicable)lim.push([T('warn.notApplicable'),T('warn.notApplicable')+': '+R.scores.notApplicable]);
if(!D.search&&R.mode==='website')lim.push([T('lim.search'),T('sp.notConnected')]);R.findings.filter(function(f){return f.confidence==='unmeasurable'}).forEach(function(f){var t=rt(f.ruleId).title,o=f.evidence[0]&&f.evidence[0].observed;lim.push([TT('lim.'+f.ruleId,t),t+(o?' — '+TT('limd.'+f.ruleId,o):'')])});
if(R.mode==='website'&&!R.rendered)lim.push([T('lim.render'),T('warn.noRender')]);
var groups=0;issues.forEach(function(f){groups+=groupsOf(f).length});
var auto=issues.filter(function(f){return D.rem[f.ruleId]==='auto'}),optOnly=issues.filter(function(f){return D.rem[f.ruleId]!=='auto'&&D.opt[f.ruleId]});
var ch=null;if(D.diff){var dd=D.diff.scoreBefore===null?null:D.diff.scoreAfter-D.diff.scoreBefore;ch=card(T('kpi.change'),dd===null?'—':(dd>=0?'+':'')+dd,'+'+D.diff.newFindings.length+' / −'+D.diff.resolved.length)}
var score=R.scores.notApplicable?'n/a':R.scores.overall;
P.appendChild(el('div',{class:'cards kpis'},[card(T('kpi.score'),score+(R.scores.notApplicable?'':'/100'),T('kpi.scoreNote'),gauge(R.scores.notApplicable?null:R.scores.overall),'score'),
card(T('kpi.groups'),fmt(groups),T('kpi.types',{n:fmt(issues.length)})),
card(T(R.mode==='website'?'kpi.affected':'kpi.affectedFiles'),fmt(R.affectedUrls!==undefined?R.affectedUrls:0),(R.mode==='website'?T('kpi.pages'):T('kpi.routes'))+': '+fmt(R.crawl.crawled)),
card(T('kpi.critical'),fmt(issues.filter(function(f){return f.severity==='critical'||f.severity==='high'}).length),null,null,issues.some(function(f){return f.severity==='critical'})?'alert':''),
card(T('kpi.auto'),fmt(auto.length),auto.length?null:optOnly.length?T('kpi.autoRepo')+' ('+optOnly.length+')':T('kpi.autoNone')),ch||card(T('kpi.change'),'—',T('kpi.noBaseline'))]));
if(lim.length)P.appendChild(el('div',{class:'limits',role:'note'},[el('b',{text:T('ov.limits')}),el('span',{class:'lim',text:lim.map(function(l){return l[0]}).join(' · ')}),el('details',{},[el('summary',{text:T('ov.limitsMore')}),el('ul',{},lim.map(function(l){return el('li',{text:l[1]})}))])]));
var top=issues.slice().sort(function(a,b){return((b.priority&&b.priority.score)||0)-((a.priority&&a.priority.score)||0)}).slice(0,3);
P.appendChild(h2(T('pri.title'),T('pri.note')));P.appendChild(top.length?el('div',{class:'prio'},top.map(prioCard)):el('p',{class:'muted',text:T('pri.none')}));
var pil=el('div',{class:'pillars'});PILLARS.forEach(function(p){var cats=p[1],fs=issues.filter(function(f){return cats.indexOf(f.category)>=0});var sc=cats.map(function(c){return R.scores.byCategory[c]}).filter(function(x){return typeof x==='number'});var v=sc.length?Math.min.apply(null,sc):100;
if(p[0]==='geo'&&R.mode==='repository'&&!fs.length)return;var cls=v>=90?'good':v>=70?'medium':'critical';
pil.appendChild(el('button',{type:'button',class:'pillar '+cls,title:cats.map(function(c){return T('cat.'+c)}).join(', ')},[el('span',{class:'label',text:T('pillar.'+p[0])}),el('b',{text:String(v)}),el('span',{class:'sub',text:fs.length?T('pillar.issues',{n:fs.length}):T('pillar.noIssues')})]));pil.lastChild.onclick=function(){FILT.cat=cats.length===1?cats[0]:'';FILT.q='';FILT.pillar=cats;showTab('issues');issuesPanel(document.getElementById('p-issues'))}});
P.appendChild(h2(T('ov.pillars')));P.appendChild(pil);
var c=el('div',{class:'charts'});
c.appendChild(stacked(T('ov.severity'),SEVS.slice(0,4).map(function(s){return[T('sev.'+s),issues.filter(function(f){return f.severity===s}).length,s]})));
c.appendChild(stacked(T('ov.remediation'),[['auto','good'],['agent','low'],['manual','medium']].map(function(r){return[T('rem.'+r[0]),issues.filter(function(f){return D.rem[f.ruleId]===r[0]}).length,r[1]]}),T('rem.auto.help')));
c.appendChild(bars(T('ov.health'),Object.keys(R.scores.byCategory).sort(function(a,b){return R.scores.byCategory[a]-R.scores.byCategory[b]}).map(function(k){var v=R.scores.byCategory[k];return[T('cat.'+k),v,v>=90?'good':v>=70?'medium':'critical']}),{max:100,note:T('ov.healthNote')}));
var roots=D.templates.filter(function(t){return t.pages>1||t.issues.length>1}).slice(0,6);
c.appendChild(bars(T('ov.rootCauses'),roots.map(function(t){return[t.pattern+' · '+t.issues.length+'×',t.pages,'accent']}),{note:T('ov.rootCausesNote'),suffix:' '+(R.mode==='website'?T('iss.pages',{n:''}).trim():'')}));
c.appendChild(stacked(T('ov.measurement'),[[T('conf.verified'),R.measurement.verified,'good'],[T('conf.heuristic'),R.measurement.heuristic,'medium'],[T('conf.unmeasurable'),R.measurement.unmeasurable,'info']]));
P.appendChild(c)}
function prioCard(f){var r=rt(f.ruleId),g=groupsOf(f),pages=g.reduce(function(n,x){return n+x.pages},0),cb=el('input',{type:'checkbox','aria-label':T('iss.selectFinding')+': '+r.title});
cb.checked=g.length&&selCount(f)===g.length;cb.onchange=function(){g.forEach(function(x){if(cb.checked)SEL[x.id]=1;else delete SEL[x.id]});actionbar()};
return el('div',{class:'pcard','data-sev':f.severity},[el('div',{class:'prow'},[cb,el('span',{class:'pscore',title:T('iss.priority'),text:f.priority?f.priority.bucket:''}),sevChip(f.severity),chip(T('rem.'+D.rem[f.ruleId]),'rem-'+D.rem[f.ruleId])]),el('h3',{text:r.title}),
el('p',{class:'muted small',text:(g.length>1?g.length+' × ':'')+(g[0]?(g[0].kind==='site'||g[0].kind==='layout'?T('iss.group.'+g[0].kind):g[0].key):'')+' · '+T(R.mode==='website'?'iss.pages':'iss.locations',{n:fmt(Math.max(pages,f.count))})}),r.fix?el('p',{class:'small',text:r.fix}):null])}
function priorities(P,issues){P.appendChild(h2(T('pri.title'),T('pri.note')));var top=issues.slice().sort(function(a,b){return((b.priority&&b.priority.score)||0)-((a.priority&&a.priority.score)||0)}).slice(0,10);
if(!top.length)return P.appendChild(el('p',{class:'muted',text:T('pri.none')}));
P.appendChild(el('ol',{class:'plist'},top.map(function(f){var r=rt(f.ruleId);return el('li',{},[prioCard(f),f.priority?el('p',{class:'muted small',text:T('pri.why')+': '+f.priority.reasons.join('; ')+' · '+T('iss.effort')+' '+f.priority.effort+' · '+T('iss.priority')+' '+f.priority.score}):null])})))}
function visible(){var q=FILT.q.toLowerCase();return R.findings.filter(function(f){if(!SHOWINFO&&!isIssue(f))return false;if(FILT.sev&&f.severity!==FILT.sev)return false;if(FILT.cat&&f.category!==FILT.cat)return false;if(FILT.pillar&&!FILT.cat&&FILT.pillar.indexOf(f.category)<0)return false;if(FILT.rem&&D.rem[f.ruleId]!==FILT.rem)return false;if(FILT.conf&&f.confidence!==FILT.conf)return false;
if(q){var r=rt(f.ruleId);if((r.title+' '+f.ruleId+' '+f.message+' '+JSON.stringify(f.evidence)).toLowerCase().indexOf(q)<0)return false}return true}).sort(function(a,b){return((b.priority&&b.priority.score)||0)-((a.priority&&a.priority.score)||0)||SEVS.indexOf(a.severity)-SEVS.indexOf(b.severity)})}
function sel(id,opts,val,on,label){var s=el('select',{'aria-label':label},[el('option',{value:'',text:label+': '+T('iss.filterAll')})].concat(opts.map(function(o){var x=el('option',{value:o[0],text:o[1]});if(o[0]===val)x.selected=true;return x})));s.onchange=function(){on(s.value)};return s}
function issuesPanel(P){P.textContent='';var cats={};R.findings.forEach(function(f){cats[f.category]=1});
var bar=el('div',{class:'filters'},[sel('fs',SEVS.map(function(s){return[s,T('sev.'+s)]}),FILT.sev,function(v){FILT.sev=v;list()},T('iss.filterSev')),
sel('fc',Object.keys(cats).sort().map(function(c){return[c,T('cat.'+c)]}),FILT.cat,function(v){FILT.cat=v;FILT.pillar=null;list()},T('iss.filterCat')),
sel('fr',['auto','agent','manual'].map(function(r){return[r,T('rem.'+r)]}),FILT.rem,function(v){FILT.rem=v;list()},T('iss.filterRem')),
sel('fk',['verified','heuristic','unmeasurable'].map(function(r){return[r,T('conf.'+r)]}),FILT.conf,function(v){FILT.conf=v;list()},T('iss.filterConf'))]);
var q=el('input',{type:'search',placeholder:T('iss.search'),'aria-label':T('iss.search'),value:FILT.q});q.oninput=function(){FILT.q=q.value;list()};bar.appendChild(q);
var inf=el('label',{class:'check'},[el('input',{type:'checkbox'}),T('iss.showInfo')]);inf.firstChild.checked=SHOWINFO;inf.firstChild.onchange=function(){SHOWINFO=inf.firstChild.checked;list()};bar.appendChild(inf);
P.appendChild(bar);var tb=el('div',{class:'toolbar'}),cnt=el('span',{class:'muted small'});var sa=el('button',{type:'button',class:'btn',text:T('iss.selectVisible')}),cl=el('button',{type:'button',class:'btn ghost',text:T('iss.clear')});
sa.onclick=function(){visible().forEach(function(f){groupsOf(f).forEach(function(g){SEL[g.id]=1})});list();actionbar()};cl.onclick=function(){SEL={};list();actionbar()};
tb.appendChild(cnt);tb.appendChild(el('span',{class:'spacer'}));tb.appendChild(sa);tb.appendChild(cl);P.appendChild(tb);
P.appendChild(el('details',{class:'remlegend'},[el('summary',{class:'small'},[T('iss.howFixed')+' ',chip(T('rem.auto'),'rem-auto'),' ',chip(T('rem.agent'),'rem-agent'),' ',chip(T('rem.manual'),'rem-manual')])].concat(['auto','agent','manual'].map(function(r){return el('p',{class:'small'},[chip(T('rem.'+r),'rem-'+r),' ',T('rem.'+r+'.help')])}))));
var L=el('div',{id:'list'});P.appendChild(L);
function list(){L.textContent='';var v=visible(),ng=0;v.forEach(function(f){ng+=groupsOf(f).length;L.appendChild(findingCard(f))});cnt.textContent=T('iss.count',{n:v.length,g:ng});if(!v.length)L.appendChild(el('p',{class:'muted',text:T('iss.empty')}))}
list()}
function findingCard(f){var r=rt(f.ruleId),G=groupsOf(f),rem=D.rem[f.ruleId],rv=reviewOf(f.ruleId);
var cb=el('input',{type:'checkbox','aria-label':T('iss.selectFinding')+': '+r.title});var n=selCount(f);cb.checked=G.length>0&&n===G.length;cb.indeterminate=n>0&&n<G.length;
var gcbs=[];cb.onchange=function(){G.forEach(function(g){if(cb.checked)SEL[g.id]=1;else delete SEL[g.id]});gcbs.forEach(function(x){x.checked=cb.checked});actionbar()};
function sync(){var k=selCount(f);cb.checked=k===G.length;cb.indeterminate=k>0&&k<G.length;actionbar()}
var pages=G.reduce(function(s,g){return s+g.pages},0);
var body=el('div',{class:'fbody'},[el('p',{},[el('b',{text:T('iss.message')+': '}),f.message]),
r.fix?el('p',{},[el('b',{text:T('iss.fix')+': '}),r.fix]):null,
rem!=='auto'&&D.opt[f.ruleId]?el('p',{class:'muted small',text:T('rem.optimizerHint')}):null,
r.verify?el('p',{class:'small'},[el('b',{text:T('iss.verify')+': '}),r.verify]):null,
rv?el('p',{class:'review '+rv.status},[el('b',{text:T('iss.review.'+rv.status)}),rv.note?' — '+rv.note:'',el('span',{class:'muted small',text:' · '+(rv.at||'').slice(0,10)+' · '+T('iss.review.note')})]):null,
el('h4',{text:T('iss.groups')+' ('+G.length+')'})]);
G.forEach(function(g){var gc=el('input',{type:'checkbox','aria-label':T('iss.selectGroup')+': '+g.key});gc.checked=!!SEL[g.id];gc.onchange=function(){if(gc.checked)SEL[g.id]=1;else delete SEL[g.id];sync()};gcbs.push(gc);
var ev=g.evidence.slice(0,30).map(function(i){var e=f.evidence[i],rr=reviewOf(f.ruleId,e.ref);return el('div',{class:'ev'},[el('span',{class:'ref',text:e.ref}),' ',e.url&&/^https?:/i.test(e.url)?el('a',{href:safeHref(e.url),rel:'noopener noreferrer',target:'_blank',text:e.url}):(e.file||e.url||'')+(e.line?':'+e.line:''),e.file&&e.url?' ('+e.url+')':'',e.observed?' — '+e.observed:'',e.expected?' → '+e.expected:'',rr?el('span',{class:'chip review-'+rr.status,text:T('iss.review.'+rr.status)}):null])});
var more=g.pages-Math.min(30,g.evidence.length);
body.appendChild(el('div',{class:'group'},[el('div',{class:'grow'},[gc,el('details',{},[el('summary',{},[el('span',{class:'gkind',text:T('iss.group.'+g.kind)}),' ',g.kind==='layout'?null:el('code',{text:g.kind==='site'?(f.evidence[0]&&(f.evidence[0].url||f.evidence[0].file)||'—'):g.key}),' ',chip(T(R.mode==='website'&&g.kind!=='file'?'iss.pages':'iss.locations',{n:fmt(g.pages)})),g.kind==='template'&&g.pages>1?chip(T('iss.shared'),'accent'):g.kind==='layout'?chip(T('iss.layout'),'accent'):null,g.langs.length?chip(g.langs.join(', ')):null])].concat(ev).concat(more>0?[el('div',{class:'muted small',text:T('iss.more',{n:fmt(more)})})]:[]))])]))});
body.appendChild(el('p',{class:'muted small'},[T('iss.rule')+' ',el('code',{text:f.ruleId}),' · '+T('iss.engines')+': '+f.engines.join(', ')+(f.priority?' · '+T('iss.priority')+' '+f.priority.bucket+' ('+f.priority.score+') · '+T('iss.effort')+' '+f.priority.effort:'')]));
body.appendChild(el('div',{class:'sources'},[el('b',{class:'small',text:T('iss.sources')}),el('ul',{},r.sources.map(function(s){return el('li',{class:'small'},[el('a',{href:safeHref(s.url),rel:'noopener noreferrer',target:'_blank',text:s.title}),' — '+T('iss.checked',{d:s.checked})])}))]));
var det=el('details',{class:'fdet'},[el('summary',{},[el('span',{class:'ftitle',text:r.title}),el('span',{class:'chips'},[sevChip(f.severity),chip(T('rem.'+rem),'rem-'+rem,T('rem.'+rem+'.help')),chip(T('conf.'+f.confidence),'conf-'+f.confidence),chip(T(R.mode==='website'?'iss.pages':'iss.locations',{n:fmt(Math.max(pages,f.count))})),G.length>1?chip(T('act.groups',{n:G.length})):null,rv?chip(T('iss.review.'+rv.status),'review-'+rv.status):null])]),body]);
return el('article',{class:'finding','data-sev':f.severity},[cb,det])}
function selection(){var items=[];R.findings.forEach(function(f){var gs=groupsOf(f).filter(function(g){return SEL[g.id]});if(gs.length)items.push({f:f,groups:gs})});return items}
function actionbar(){var A=document.getElementById('actionbar');A.textContent='';var s=selection(),n=0,mix={auto:0,agent:0,manual:0};s.forEach(function(x){n+=x.groups.length;mix[D.rem[x.f.ruleId]]++});
A.className=s.length?'on':'';if(!s.length){A.appendChild(el('span',{class:'muted small',text:T('act.none')}));return}
var g=el('button',{type:'button',class:'btn primary',text:T('act.generate')});g.onclick=openPrompt;var c=el('button',{type:'button',class:'btn ghost',text:T('act.clear')});c.onclick=function(){SEL={};render()};
A.appendChild(el('div',{class:'abinfo'},[el('b',{text:T('act.selected',{n:s.length})}),el('span',{class:'muted small',text:T('act.groups',{n:n})+' · '+T('act.mix',{a:mix.auto,g:mix.agent,m:mix.manual})})]));A.appendChild(el('span',{class:'spacer'}));A.appendChild(c);A.appendChild(g)}
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
var cl=el('button',{type:'button',class:'btn ghost',text:T('pr.close')});function close(){M.className='';M.textContent='';document.removeEventListener('keydown',esc);if(last&&last.focus)last.focus()}function esc(e){if(e.key==='Escape')close()}cl.onclick=close;document.addEventListener('keydown',esc);
M.className='on';M.appendChild(el('div',{class:'dialog',role:'dialog','aria-modal':'true','aria-labelledby':'prt'},[el('div',{class:'dhead'},[el('h2',{id:'prt',text:T('pr.title')}),el('span',{class:'spacer'}),ls]),el('p',{class:'muted small',text:T('pr.note')}),!D.ctx.repository?el('p',{class:'notice small',text:T('pr.brief')}):null,ta,el('div',{class:'dfoot'},[st,el('span',{class:'spacer'}),cl,dl,cp])]));ta.focus();ta.setSelectionRange(0,0);ta.scrollTop=0}
function geo(P){var G=R.geo,by={};G.bots.forEach(function(b){(by[b.purpose]=by[b.purpose]||[]).push(b)});
P.appendChild(h2(T('geo.access')));var grid=el('div',{class:'botgrid'});Object.keys(by).forEach(function(p){grid.appendChild(el('div',{class:'chart'},[el('h3',{text:T('purpose.'+p)===('purpose.'+p)?p:T('purpose.'+p)})].concat(by[p].map(function(b){return el('div',{class:'bot'},[el('i',{class:'dot '+(b.allowed?'good':'critical')}),el('code',{text:b.token}),el('span',{class:'muted small',text:' '+b.operator}),el('span',{class:'spacer'}),el('span',{class:b.allowed?'ok':'bad',text:T(b.allowed?'geo.allowed':'geo.blocked')+(b.explicit?'':' '+T('geo.inherits'))})])}))))});P.appendChild(grid);
P.appendChild(h2(T('geo.signals')));P.appendChild(el('ul',{},[el('li',{text:T('geo.llms',{s:G.llmsTxt?T(G.llmsTxt.present?'geo.present':'geo.absent'):T('geo.notChecked')})}),el('li',{text:T('geo.clarity',{n:G.answerability.average})}),el('li',{text:T('geo.citations',{r:G.citations.reason||''})}),el('li',{text:T('geo.entities')+': '+(Object.keys(G.entityNames).map(function(n){return n+' ('+G.entityNames[n]+')'}).join(', ')||'—')})]));
if(G.answerability.pages.length){P.appendChild(h2(T('geo.lowest')));P.appendChild(table([T('tbl.url'),T('tbl.score'),T('tbl.missing')],G.answerability.pages.slice(0,30).map(function(p){return[p.url,p.score,Object.keys(p.signals).filter(function(k){return!p.signals[k]}).join(', ')]})))}}
function search(P){var S=D.search,t=S.totals;P.appendChild(h2(T('sp.title'),T('sp.source',{s:S.source+(S.property?' · '+S.property:''),d:S.period.days})));
P.appendChild(el('div',{class:'cards'},[card(T('sp.clicks'),fmt(t.clicks)),card(T('sp.impressions'),fmt(t.impressions)),card(T('sp.ctr'),pct(t.ctr)),card(T('sp.queries'),fmt(t.queries))]));
P.appendChild(table([T('sp.queries'),T('sp.clicks'),T('sp.impressions'),T('sp.ctr'),T('sp.position')],S.topQueries.slice(0,15).map(function(q){return[q.query,fmt(q.clicks),fmt(q.impressions),pct(q.ctr),q.position.toFixed(1)]})));
P.appendChild(el('p',{class:'notice small',text:T('sp.inferred')}));
if(S.strikingDistance.length){P.appendChild(h2(T('sp.striking')));P.appendChild(table([T('sp.queries'),T('tbl.url'),T('sp.position'),T('sp.impressions')],S.strikingDistance.slice(0,15).map(function(q){return[q.query,q.page||'—',q.position.toFixed(1),fmt(q.impressions)]})))}
if(S.lowCtr.length){P.appendChild(h2(T('sp.lowCtr')));P.appendChild(table([T('sp.queries'),T('tbl.url'),T('sp.position'),T('sp.ctr')],S.lowCtr.slice(0,15).map(function(q){return[q.query,q.page||'—',q.position.toFixed(1),pct(q.ctr)+' / '+pct(q.siteMedianCtr)]})))}
if(S.topPages.length){P.appendChild(h2(T('sp.pages')));P.appendChild(table([T('tbl.url'),T('sp.clicks'),T('sp.impressions'),T('sp.position')],S.topPages.slice(0,15).map(function(q){return[q.page,fmt(q.clicks),fmt(q.impressions),q.position.toFixed(1)]})))}}
function changes(P){diffView(P,D.diff)}
function evidence(P){P.appendChild(h2(T('ev.confidence')));P.appendChild(el('ul',{},[el('li',{text:T('ev.verified')}),el('li',{text:T('ev.heuristic')}),el('li',{text:T('ev.unmeasurable')})]));
P.appendChild(h2(T('ev.method')));P.appendChild(el('p',{class:'small',text:T('ev.methodText')}));
P.appendChild(h2(T('ev.limits')));P.appendChild(el('ul',{},R.limitations.concat(R.geo.notes||[]).map(function(l){return el('li',{class:'small',text:l})})));
if((D.reviews||[]).length){P.appendChild(h2(T('ev.reviews'),T('iss.review.note')));P.appendChild(table([T('iss.rule'),T('iss.ref'),T('ch.issue'),'',''],D.reviews.map(function(x){return[x.ruleId,x.ref||'—',T('iss.review.'+x.status),x.note||'',(x.at||'').slice(0,10)]})))}
P.appendChild(h2(T('ev.rules')));var ids={};R.findings.forEach(function(f){ids[f.ruleId]=f});P.appendChild(table([T('iss.rule'),T('ev.title'),T('iss.filterConf'),T('iss.sources')],Object.keys(ids).sort().map(function(id){var r=rt(id);return[el('code',{text:id}),r.title,T('conf.'+ids[id].confidence),el('span',{},r.sources.map(function(s,i){return el('span',{},[i?' · ':'',el('a',{href:safeHref(s.url),rel:'noopener noreferrer',target:'_blank',text:s.title}),' ('+s.checked+')'])}))]})));
if(R.inventory.pages.length){P.appendChild(el('details',{class:'more'},[el('summary',{text:T('ev.inventory')+' ('+fmt(R.inventory.pages.length)+')'}),table([T('tbl.url'),T('tbl.type'),T('tbl.lang'),T('tbl.indexable'),T('tbl.depth'),T('tbl.inlinks'),T('tbl.words')],R.inventory.pages.slice(0,500).map(function(p){return[p.url,p.type,p.lang||'',T(p.indexable?'yes':'no'),p.depth,p.inlinks,p.words]}))]))}
if(R.content&&R.content.clusters.length){P.appendChild(el('details',{class:'more'},[el('summary',{text:T('ev.content')}),table([T('ev.section'),T('ch.pages'),T('ev.terms')],R.content.clusters.slice(0,30).map(function(c){return['/'+c.key,c.pages.length,c.terms.join(', ')]}))]))}
P.appendChild(el('p',{class:'muted small',text:T('ev.promise')}))}
`;

/** Before/after view used by the audit "Changes" tab and the standalone monitor page. */
export const DIFF_VIEW = String.raw`function diffView(P,M){var delta=M.scoreBefore===null?null:M.scoreAfter-M.scoreBefore;
P.appendChild(el('div',{class:'cards'},[card(T('ch.score'),(M.scoreBefore===null?'':M.scoreBefore+' → ')+M.scoreAfter,delta===null?null:(delta>=0?'+':'')+delta),card(T('ch.pages'),(M.pagesBefore===null?'':fmt(M.pagesBefore)+' → ')+fmt(M.pagesAfter)),card(T('ch.new'),M.newFindings.length,null,null,M.newFindings.length?'alert':''),card(T('ch.resolved'),M.resolved.length),card(T('ch.worse')+' / '+T('ch.better'),M.worsened.length+' / '+M.improved.length),card(T('ch.regression'),T(M.regression?'ch.yes':'ch.no'),null,null,M.regression?'alert':'')]));
var changed=M.newFindings.concat(M.worsened,M.improved,M.resolved),mx=Math.max.apply(null,changed.map(function(x){return Math.max(x.before,x.after)}).concat([1]));
if(changed.length){var c=el('div',{class:'charts'});c.appendChild(bars(T('ch.before'),changed.slice(0,10).map(function(x){return[rtitle(x),x.before,x.severity]}),{max:mx}));c.appendChild(bars(T('ch.after'),changed.slice(0,10).map(function(x){return[rtitle(x),x.after,x.severity]}),{max:mx}));P.appendChild(c)}
[['ch.new',M.newFindings],['ch.worse',M.worsened],['ch.better',M.improved],['ch.resolved',M.resolved]].forEach(function(g){P.appendChild(h2(T(g[0])+' ('+g[1].length+')'));P.appendChild(g[1].length?table([T('ch.issue'),T('iss.filterSev'),T('ch.before'),T('ch.after'),T('ch.delta')],g[1].map(function(x){return[rtitle(x)+' ('+x.ruleId+')',T('sev.'+x.severity),x.before,x.after,deltaSpan(x.after-x.before)]})):el('p',{class:'muted',text:T('ch.nothing')}))});
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
ch.appendChild(bars(T('eco.scoreBySite'),E.sites.map(function(s){return[s.host,s.score,s.score>=90?'good':s.score>=70?'medium':'critical']}),{max:100,note:T('kpi.scoreNote')}));
ch.appendChild(bars(T('eco.shared'),E.sharedIssues.slice(0,10).map(function(i){return[i.title,i.sites,i.severity]}),{max:E.sites.length}));B.appendChild(ch);
B.appendChild(h2(T('eco.sites')));B.appendChild(table(['Site','Site name','Organization','Parent','Children','Model ~','Languages',T('ch.pages')],E.sites.map(function(s){return[s.host,s.siteName,s.organization,s.parent,s.children.join(', ')||'—',s.model,s.languages.join(', '),s.pages]})));
B.appendChild(h2(T('eco.links')));var H=E.sites.map(function(s){return s.host});
B.appendChild(table(['from \\ to'].concat(H),H.map(function(a){return[a].concat(H.map(function(b){if(a===b)return'·';var n=(E.links[a]||{})[b]||0;return el('span',{text:String(n),class:n?'':'bad',title:n?n+' links':'no links'})}))})));
var kinds={entity:'Entity & brand graph',linking:'Cross-linking','shared-issue':'Shared issues',overlap:'Topic overlap',coverage:'Language coverage'};
B.appendChild(h2(T('eco.obs')));if(!E.observations.length)B.appendChild(el('p',{class:'muted',text:T('eco.none')}));
Object.keys(kinds).forEach(function(k){var L=E.observations.filter(function(o){return o.kind===k});if(!L.length)return;B.appendChild(el('h3',{text:kinds[k]}));B.appendChild(el('ul',{},L.map(function(o){return el('li',{},[(o.confidence==='heuristic'?'~ ':'')+o.message,o.recommendation?el('div',{class:'muted small',text:'→ '+o.recommendation}):null])})))});
if(E.overlap.length){B.appendChild(h2(T('eco.overlap')));B.appendChild(table(['Sites','%','Terms'],E.overlap.slice(0,15).map(function(o){return[o.a+' ↔ '+o.b,Math.round(o.similarity*100)+'%',o.shared.slice(0,8).join(', ')]})))}
B.appendChild(h2(T('eco.limits')));B.appendChild(el('ul',{},E.limitations.map(function(l){return el('li',{class:'small',text:l})})));B.appendChild(el('p',{class:'muted small',text:T('eco.heuristicNote')+' '+T('kpi.scoreNote')}));
mkTabs([['overview',T('nav.overview')]])}
`;
