(() => {
  'use strict';
  const M=SecurityRisks,$=id=>document.getElementById(id),state={view:location.hash==='#archive'?'archive':'current',q:'',open:new Set()};
  let data;
  const node=(tag,text,attrs={})=>{const e=document.createElement(tag);if(text!=null)e.textContent=String(text);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
  const date=value=>value?new Date(value).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'Asia/Hong_Kong'}):'Not available';
  const time=value=>value?new Date(value).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Hong_Kong'})+' HKT':'No complete successful run';
  const sourceLink=s=>{const url=M.safeURL(s.url);return url?node('a',s.label+' ↗',{href:url,target:'_blank',rel:'noopener noreferrer'}):node('span',s.label+' (invalid source URL)');};
  function score(r){
    const value=r.cvss?.score,has=Number.isFinite(value),e=node('span',has?value.toFixed(1)+'/10':'—',{class:'score '+(!has?'unknown':value>=9?'critical':value>=7?'high':'other'),title:has?'CVSS v'+r.cvss.version:'CVSS unpublished or not applicable'});return e;
  }
  function bullets(values,fallback){const list=node('ul');for(const value of values.length?values:[fallback])list.append(node('li',value));return list;}
  function details(r){
    const tr=node('tr',null,{class:'detail',id:'detail-'+r.id}),td=node('td',null,{colspan:6});tr.append(td);
    td.append(node('h2',r.title),node('p',r.description));
    const cards=node('div',null,{class:'cards'}),fix=node('section',null,{class:'card'}),scope=node('section',null,{class:'card'});
    fix.append(node('h3','Recommended action'),node('p',r.action),node('h3','Fixed / unaffected versions'),bullets(r.fixed,'See the official vendor advisory for the supported fixed build and distribution backports.'));
    scope.append(node('h3','Affected versions / configurations'),bullets(r.affected,'Version scope is not normalized; consult the official advisory.'));
    if(r.conditions?.length)scope.append(node('h3','Prerequisites'),bullets(r.conditions,''));
    cards.append(fix,scope);td.append(cards);
    const meta=[r.published?'CVE / source published '+date(r.published):'',r.advisory_published_at?'Advisory published '+date(r.advisory_published_at):'',r.kev?'KEV added '+date(r.kev_added):'',r.material_updated_at?'Material update '+date(r.material_updated_at):'',r.cvss?'CVSS v'+r.cvss.version+' · '+(r.cvss.vector||''):'CVSS not published / not applicable',r.epss?'EPSS '+(r.epss.score*100).toFixed(2)+'% · '+r.epss.date:'',r.cve_status||'',r.checked_at?'Source checked '+time(r.checked_at):''].filter(Boolean);
    td.append(node('p',meta.join(' · '),{class:'fine'}));
    if(r.source_changed)td.append(node('p','The source has changed since its action summary was reviewed; consult the current official notice.',{class:'warning'}));
    const links=node('div',null,{class:'links'});for(const s of r.sources)links.append(sourceLink(s));td.append(links);return tr;
  }
  function render(){
    const w=M.windows(),records=M.select(data.records,state),current=M.select(data.records,{view:'current'}),archive=M.select(data.records,{view:'archive'});
    for(const id of ['current','archive'])$(id).setAttribute('aria-pressed',String(state.view===id));
    $('currentCount').textContent=current.length;$('archiveCount').textContent=archive.length;
    $('period').textContent=state.view==='archive'?'Archive · '+date(w.archive)+' – '+date(new Date(Date.parse(w.current)-86400000).toISOString()):'Last 30 days · '+date(w.current)+' – '+date(w.today);
    $('count').textContent=records.length+' high-risk '+(records.length===1?'entry':'entries')+' · CVSS highest first';
    const stats=[[records.length,'high-risk entries'],[records.filter(r=>r.kev).length,'known exploited'],[records.filter(r=>r.cvss?.score>=9).length,'critical · 9.0+'],[records.filter(r=>!r.cvss).length,'unscored urgent / exploited']];
    $('summary').replaceChildren(...stats.map(([n,label])=>{const e=node('div',null,{class:'kpi'});e.append(node('b',n),node('span',label));return e;}));
    const rows=[];
    for(const r of records){
      const event=M.event(r,w.today),tr=node('tr',null,{class:'row','data-id':r.id}),cvss=node('td',null,{class:'rank'});cvss.append(score(r));
      const when=node('td',null,{class:'when'});when.append(node('time',date(event.date),{datetime:event.date}),node('small',event.label));
      if(r.kev)when.append(node('small','Known exploited',{class:'known'}));
      const issue=node('th',null,{scope:'row',class:'issue'}),button=node('button',null,{type:'button','aria-expanded':String(state.open.has(r.id)),'aria-controls':'detail-'+r.id,class:'issuebtn'});
      button.append(node('b',r.product+' ›'),node('span',r.title));button.addEventListener('click',()=>{state.open.has(r.id)?state.open.delete(r.id):state.open.add(r.id);render();});
      issue.append(button,node('small',(/^CVE-/.test(r.id)?r.id+' · ':'')+M.layers[r.layer]));
      const about=node('td',null,{class:'about'});about.append(node('p',r.description,{title:r.description}));
      const evidence=node('td',r.kev?'KEV · exploited':'Not in KEV',{class:'evidence'+(r.kev?' known':'')});
      const briefAction=/BOD|ensuring compliance/.test(r.action)?'Apply vendor security updates or mitigations. If no remedy is available, discontinue use.':r.action;
      const action=node('td',null,{class:'action'});action.append(node('p',briefAction,{title:r.action}));
      tr.append(cvss,when,issue,about,evidence,action);rows.push(tr);if(state.open.has(r.id))rows.push(details(r));else rows.push(node('tr',null,{id:'detail-'+r.id,hidden:true}));
    }
    if(!rows.length){const tr=node('tr');tr.append(node('td','No high-risk entries match this period and search.',{colspan:6,class:'empty'}));rows.push(tr);}
    $('rows').replaceChildren(...rows);
  }
  function health(){
    const failed=data.sources.filter(s=>s.status!=='ok'),stale=!data.last_attempt||Date.now()-Date.parse(data.last_attempt)>36*3600000;
    $('freshness').textContent=(failed.length?'Partial refresh':stale?'Snapshot overdue':'Updated')+' · '+time(data.last_attempt);
    if(failed.length||stale){$('notice').hidden=false;$('notice').textContent=(failed.length?failed.length+' source checks failed. ':'')+(stale?'Snapshot is over 36 hours old. ':'')+'Previous source data is retained; see refresh health.';}
    for(const s of data.sources){const li=node('li');li.append(sourceLink(s),node('span',' · '+s.status+' · '+time(s.last_success)));if(s.error)li.append(node('span',' · '+s.error));if(s.note)li.append(node('span',' · '+s.note));$('sources').append(li);}
    $('refreshMeta').textContent='Last complete refresh: '+time(data.last_success)+'. Retained data covers the last six months from the monitored sources.';
  }
  async function start(){try{
    const response=await fetch('data.json',{cache:'no-store'});if(!response.ok)throw new Error('Snapshot request failed ('+response.status+')');data=M.validate(await response.json());
    health();
    const id=decodeURIComponent(location.hash.slice(1));if(data.records.some(r=>r.id===id)){
      state.open.add(id);state.q=id;$('q').value=id;if(M.select(data.records,{view:'archive',q:id}).length)state.view='archive';
    }
    for(const id of ['current','archive'])$(id).addEventListener('click',()=>{state.view=id;state.q='';$('q').value='';history.replaceState(null,'',id==='archive'?'#archive':location.pathname);render();});
    $('q').addEventListener('input',()=>{state.q=$('q').value;render();});render();
  }catch(error){$('freshness').textContent='Snapshot unavailable';$('notice').hidden=false;$('notice').textContent='Could not load the security snapshot. '+error.message;$('count').textContent='Unable to load risks';}}
  start();
})();
