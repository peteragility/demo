'use strict';
(() => {
  const E=window.Sizing,$=id=>document.getElementById(id);
  let data,bundledData,state=E.normalise(),current,editUsage=false,geo='singapore',toastTimer,liveKeys=new Set();
  const number=(n,d=0)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:d}).format(n);
  const money=(n,d=0)=>n===null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:d,minimumFractionDigits:d}).format(n);
  const rateText=n=>n===null?'—':'$'+number(n,n<0.01?5:3);
  function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function button(text,fn,cls='text-button'){const b=node('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;}
  function toast(text){$('toast').textContent=text;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4000);}
  const scenarioNames={lakehouse:'Lakehouse + BI',bi:'BI / SQL',batch:'Batch ETL',streaming:'Streaming',ai:'GenAI / RAG',science:'Data science',lakebase:'Lakebase'};
  const subs={lakehouse:'Ingest · transform · query',bi:'Existing data · dashboards',batch:'Scheduled ETL pipelines',streaming:'Always-on data pipelines',ai:'Inference · retrieval',science:'Notebooks · experiments',lakebase:'Operational Postgres'};
  function tab(name){if(!['estimate','rates','method'].includes(name))return;for(const view of document.querySelectorAll('.view'))view.hidden=view.id!==name+'-view';for(const b of document.querySelectorAll('[data-tab]')){const on=b.dataset.tab===name;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));}window.scrollTo({top:0,behavior:'smooth'});}
  function regionOptions(){
    const options=data.regions[state.cloud]??[];
    if(!options.includes(state.region))state.region=E.GEOS[geo][state.cloud]??E.ANCHORS[state.cloud];
    $('region').replaceChildren(...options.map(r=>{const o=node('option',r);o.value=r;return o;}));$('region').value=state.region;
    $('tier').value=state.tier;$('tier').disabled=state.cloud==='Azure';
    for(const b of document.querySelectorAll('[data-cloud]')){b.classList.toggle('selected',b.dataset.cloud===state.cloud);b.setAttribute('aria-pressed',String(b.dataset.cloud===state.cloud));}
  }
  function renderSidebar(){
    $('presets').replaceChildren(...Object.entries(E.PRESETS).map(([id,p])=>{
      const b=button('',()=>{state=E.preset(state,id);editUsage=false;renderSidebar();renderRequirements();renderAdvanced();render();},'preset'+(state.scenario===id?' selected':''));
      b.dataset.scenario=id;b.setAttribute('aria-pressed',String(state.scenario===id));
      b.textContent=scenarioNames[id];b.title=p.name+' · '+subs[id];return b;
    }));
    $('workloads').replaceChildren(...Object.entries(E.WORKLOADS).map(([id,name])=>{
      const label=node('label',undefined,'workload-item'),input=node('input');input.type='checkbox';input.checked=state.workloads.includes(id);input.dataset.workload=id;input.addEventListener('change',()=>{
        if(!input.checked&&state.workloads.length===1){input.checked=true;toast('Keep at least one workload selected.');return;}
        state.workloads=input.checked?[...state.workloads,id]:state.workloads.filter(w=>w!==id);state.quantities={};renderRequirements();renderAdvanced();render();
      });label.append(input,node('span',name));return label;
    }));
  }
  function update(key,value){
    const draft={...state,[key]:value};state=E.normalise(draft);
    if(key==='complexity'){state.etlFactor={simple:0.08,standard:0.2,complex:0.5}[state.complexity];const f=$('field-etlFactor');if(f)f.value=state.etlFactor;}
    if(key==='answerProfile'){const p=E.ANSWER_PROFILES[state.answerProfile];if(p.input){state.inputTokens=p.input;state.outputTokens=p.output;renderAdvanced();}}
    if(['inputTokens','outputTokens'].includes(key)){state.answerProfile='custom';const p=$('field-answerProfile');if(p)p.value='custom';}
    render();
  }
  function numeric(key,label,unit,help,advanced=false){
    const box=node('div',undefined,'field');const l=node('label',label);l.htmlFor='field-'+key;
    const wrap=node('div',undefined,'input-wrap'),input=node('input');input.type='number';input.id='field-'+key;input.value=state[key];input.inputMode='decimal';input.min=E.BOUNDS[key][0];input.max=E.BOUNDS[key][1];input.step=['storedTB','batchHours','vectors','workingGB','etlFactor','layers','dsHours','streamDBU','dsDBU'].includes(key)?'any':'1';
    input.addEventListener('input',()=>{if(input.value!==''&&Number.isFinite(input.valueAsNumber)){update(key,input.valueAsNumber);document.querySelectorAll('[data-scale]').forEach(b=>b.classList.remove('selected'));}});
    input.addEventListener('change',()=>{if(input.value==='')update(key,E.DEFAULTS[key]);input.value=state[key];});
    wrap.append(input,node('span',unit,'unit'));box.append(l,wrap);if(help){const h=node('p',help,'field-help');h.id='help-'+key;input.setAttribute('aria-describedby',h.id);box.append(h);}return box;
  }
  function select(key,label,options,help){
    const box=node('div',undefined,'field'),l=node('label',label);l.htmlFor='field-'+key;const sel=node('select');sel.id='field-'+key;
    for(const [value,text]of options){const o=node('option',text);o.value=value;sel.append(o);}sel.value=state[key];sel.addEventListener('change',()=>update(key,sel.value));box.append(l,sel);if(help)box.append(node('p',help,'field-help'));return box;
  }
  function renderRequirements(){
    const w=state.workloads,fields=[];
    const processing=w.some(x=>['etl','stream'].includes(x));
    if(processing)fields.push(numeric('gb','Daily processing volume','GB / day','New and updated data processed; stored data is sized separately.'),select('complexity','Transformation complexity',[['simple','Simple · filtering & light joins'],['standard','Standard · joins & aggregates'],['complex','Complex · UDFs & heavy shuffles']],'Sets an editable DBU/GB starting point.'));
    if(w.includes('etl')&&!w.includes('stream')&&!w.includes('sql'))fields.push(numeric('batchHours','Daily completion window','h / day','Throughput target; total estimated DBUs stay the same.'));
    if(w.includes('sql'))fields.push(numeric('storedTB','Retained analytics dataset','TB','Total retained logical data before the layer/compression factor.'),numeric('concurrency','Concurrent analytics users','users','Peak active users, not total licensed seats.'),select('queryProfile','Query profile',Object.entries(E.QUERY_PROFILES).map(([k,p])=>[k,p.name]),'Sets scan fraction and a starter concurrency allowance.'));
    if(w.includes('ai'))fields.push(numeric('requests','AI requests per day','req / day','One model call per request by default.'),select('answerProfile','Answer profile',Object.entries(E.ANSWER_PROFILES).map(([k,p])=>[k,p.name]),'Prompt + retrieved context in; generated answer out.'),numeric('vectors','Search index size','M vectors','768 dimensions; enter 0 for inference only.'));
    if(w.includes('ds'))fields.push(numeric('scientists','Data science team','people','CPU notebook users.'),numeric('dsHours','Active time per person','h/day','Scheduled CPU notebook time.'));
    if(w.includes('lakebase'))fields.push(numeric('databaseGB','Database size','GB','Average stored database size.'),numeric('workingGB','Active working set','GB RAM','Frequently accessed data held in memory.'));
    $('requirements').replaceChildren(...fields);$('input-count').textContent=fields.length+' inputs';
    const p=E.PRESETS[state.scenario];$('scenario-description').textContent=w.join(',')===p.workloads.join(',')?p.description:'A combined estimate for your selected workloads.';
  }
  function renderAdvanced(){
    const w=state.workloads,fields=[numeric('headroom','Compute headroom','%','Capacity cushion on sized compute.',true),numeric('uncertainty','Budget sensitivity','± %','Range around the full estimate.',true),numeric('discount','Compute discount','%','Only eligible compute; default 0%.',true)];
    if(w.some(x=>['etl','stream'].includes(x)))fields.push(numeric('etlFactor','Processing intensity','DBU/GB','Heuristic: 0.08 / 0.20 / 0.50.',true));
    if(w.includes('etl')&&(w.includes('sql')||w.includes('stream')))fields.push(numeric('batchHours','Batch completion window','h/day','Throughput target; total estimated DBUs stay the same.',true));
    if(w.includes('stream'))fields.push(numeric('streamDBU','Streaming baseline','DBU/h','Minimum estimated continuous usage.',true));
    if(w.some(x=>['sql','ds','lakebase'].includes(x)))fields.push(select('schedule','Operating schedule',[['business','Business hours · 8 h × 22 days'],['extended','Extended hours · 12 h × 30 days'],['always','Always on · 730 h / month']],'Lakebase above 32 CU or with HA is billed 24/7.'));
    if(w.includes('sql'))fields.push(numeric('sqlUtil','SQL active time','%','Fraction of scheduled hours billed.',true));
    if(w.some(x=>['etl','stream','sql','ds'].includes(x)))fields.push(numeric('layers','Retained-size factor','×','Combined layers after compression.',true));
    if(!w.includes('sql')&&w.some(x=>['etl','stream','ds'].includes(x)))fields.push(numeric('retention','Lakehouse retention','days','Steady-state, not first-month growth.',true),numeric('newDataPct','Net-new share of processed data','%','Updates do not necessarily grow retained storage.',true));
    if(w.includes('ds')){if(!processing&&!w.includes('sql'))fields.push(numeric('gb','Daily data volume','GB/day','Used only to estimate retained storage.',true));fields.push(numeric('dsDBU','Notebook usage per person','DBU/h','Replace after measuring a sample.',true));}
    if(w.includes('ai'))fields.push(select('model','Foundation model',Object.keys(data.models.AWS).map(x=>[x,x])),numeric('inputTokens','Input tokens / request','tokens','Includes prompt and retrieved context.',true),numeric('outputTokens','Output tokens / request','tokens','Generated response length.',true));
    if(w.includes('lakebase')){const f=node('div',undefined,'field');const lab=node('label','Lakebase high availability');lab.htmlFor='lakebase-ha';const checkbox=node('input');checkbox.type='checkbox';checkbox.id='lakebase-ha';checkbox.checked=state.lakebaseHA;checkbox.addEventListener('change',()=>update('lakebaseHA',checkbox.checked));f.append(lab,checkbox,node('p','Primary + 1 equal secondary, 24/7.','field-help'));fields.push(f);}
    fields.push(numeric('extra','Other monthly costs','$ / mo','Networking, support or other services.',true));
    $('advanced-fields').replaceChildren(...fields);
  }
  function badge(row){const cls=row.status==='exact'?'exact':row.status==='override'||row.status==='allowance'?'override':['missing','unavailable'].includes(row.status)?'missing':'fallback';return node('span',row.status==='exact'?'Regional rate':row.status,'tag '+cls);}
  function rowFreshness(r){
    if(Object.hasOwn(state.overrides,r.id))return 'Manual rate override';
    if(r.saved)return 'Saved rate supplied in shared link · snapshot '+data.savedPricing.snapshotDate;
    const path=r.id.startsWith('ai_')?`models/${r.sourceCloud}/${r.sku}/${r.sourceRegion}`:`${r.sourceTier}/${r.sourceCloud}/${r.sku}/${r.sourceRegion}`;
    return liveKeys.has(path)?'Live refresh':'Snapshot '+data.retrievedAt;
  }
  function renderCostRows(){
    $('toggle-usage').textContent=editUsage?'Done adjusting ✓':'Adjust usage & rates ↗';
    $('cost-rows').replaceChildren(...current.rows.map(r=>{
      const tr=node('tr'),name=node('td');name.append(node('b',r.name));const isCustom=Object.hasOwn(state.quantities,r.id)||Object.hasOwn(state.overrides,r.id);
      const sub=node('small',isCustom?'Manual override':r.status==='exact'?'Regional PAYG · '+r.unit:r.status+' · '+r.sourceCloud+' / '+r.sourceRegion);name.append(sub);name.title=r.formula+' · '+rowFreshness(r);
      const usage=node('td'),rate=node('td'),cost=node('td',r.cost===null?(r.status==='unavailable'?'Unavailable':'Missing rate'):money(r.cost,2));
      if(editUsage){
        const q=node('input');q.type='number';q.className='usage-input';q.min='0';q.max='100000000000';q.step='any';q.value=Number(r.qty.toFixed(4));q.setAttribute('aria-label',r.name+' monthly usage');q.dataset.qty=r.id;
        q.addEventListener('change',()=>{const n=q.valueAsNumber;if(Number.isFinite(n)&&n>=0&&n<1e12)state.quantities[r.id]=n;render();});usage.append(q,node('span',r.unit,'unit-caption'));
        const p=node('input');p.type='number';p.className='rate-input';p.min='0';p.max='1000000';p.step='any';p.value=r.rate??'';p.placeholder='Required';p.setAttribute('aria-label',r.name+' unit rate in USD');p.dataset.rate=r.id;
        p.addEventListener('change',()=>{const n=p.valueAsNumber;if(Number.isFinite(n)&&n>=0&&n<1e12)state.overrides[r.id]=n;render();});rate.append(p,node('span','USD / '+r.unit,'unit-caption'));
      }else{usage.append(node('span',number(r.qty,1)),node('span',r.unit,'unit-caption'));rate.textContent=rateText(r.rate);rate.title=rowFreshness(r)+' · '+r.sourceCloud+' · '+r.sourceRegion;}
      tr.append(name,usage,rate,cost);return tr;
    }));$('table-total').textContent=current.complete?money(current.total,2):'Incomplete';
  }
  function renderSummary(){
    $('monthly').textContent=current.complete?money(current.total):'Incomplete';
    $('annual').textContent=current.complete?money(current.total*12)+' / year':'Known costs: '+money(current.subtotal)+' / month';
    $('range').textContent=current.complete?money(current.low)+' – '+money(current.high):current.issues.length?'Resolve configuration':'Missing unit rates';
    $('range-caption').textContent='±'+state.uncertainty+'% planning sensitivity · not a quote';
    const groups={compute:{name:'Compute',color:'var(--dbx)',cost:0},ai:{name:'AI & retrieval',color:'var(--up)',cost:0},storage:{name:'Storage',color:'var(--geo)',cost:0},other:{name:'Other costs',color:'var(--par)',cost:0}};
    for(const r of current.rows)groups[r.group].cost+=r.cost??0;
    const active=Object.values(groups).filter(g=>g.cost>0);
    $('cost-bars').replaceChildren(...active.map(g=>{const n=node('span');n.style.backgroundColor=g.color;n.style.width=(g.cost/current.subtotal*100)+'%';n.title=g.name+': '+money(g.cost,2);return n;}));
    $('cost-legend').replaceChildren(...active.map(g=>{const line=node('div',undefined,'legend-line'),label=node('span',undefined,'legend-name'),i=node('i');i.style.backgroundColor=g.color;label.append(i,node('span',g.name));line.append(label,node('b',money(g.cost,2)));return line;}));
    $('metric-dbu').textContent=number(current.dbus)+' DBU';$('metric-storage').textContent=current.storageGB>=1000?number(current.storageGB/1000,1)+' TB':number(current.storageGB,1)+' GB';
    $('summary-location').textContent=state.cloud+' · '+state.region;$('summary-tier').textContent=state.tier.charAt(0).toUpperCase()+state.tier.slice(1);
    const notes=[];
    for(const issue of current.issues)notes.push(node('div',issue,'summary-note warning'));
    for(const a of current.availabilityChecks){
      const text='Lakebase: '+a.status+' · availability checked '+a.checkedAt;
      const n=node('div',text,'summary-note'+(['beta','unknown'].includes(a.status)?' warning':''));
      if(a.source){const link=node('a',' Region list ↗');link.href=a.source;link.target='_blank';link.rel='noopener noreferrer';n.append(link);}notes.push(n);
    }
    if(data.savedPricing)notes.push(node('div','Saved rates supplied in this link; new products or regions use snapshot prices. Refresh official rates to recalculate.','summary-note'));
    if(current.fallback.length)notes.push(node('div',current.fallback.length+' line(s) use fallback or missing prices. Treat the total as provisional.','summary-note warning'));
    const overrideCount=current.rows.filter(r=>r.status==='override'||Object.hasOwn(state.quantities,r.id)).length;
    if(overrideCount)notes.push(node('div',overrideCount+' line(s) have manual usage or price overrides.','summary-note'));
    if(current.savings>0)notes.push(node('div',money(current.savings,2)+' / mo compute discount applied. Tokens and storage remain at list rates.','summary-note'));
    if(!notes.length)notes.push(node('div','All active lines use exact regional prices. Usage and service availability still need validation.','summary-note'));
    if(state.cloud==='Azure')notes.push(node('div','Azure Premium is the comparable platform tier to AWS/GCP Enterprise. Microsoft sets Azure rates.','summary-note'));
    $('summary-notes').replaceChildren(...notes);
    $('coverage-icon').style.backgroundColor=current.issues.length?'var(--down)':current.fallback.length?'#d5a34d':'#53a99b';
    $('coverage-text').textContent=current.issues.length?'Configuration unavailable · review warnings':current.fallback.length?current.fallback.length+' fallback / missing rate(s) · provisional':current.rows.filter(r=>r.status==='exact').length+' exact regional rate(s) · availability is checked separately';
    $('sizing-notes').replaceChildren(...current.notes.map(n=>node('p',n)));
  }
  function renderComparison(){
    const table=node('table',undefined,'cloud-table'),head=node('thead'),header=node('tr'),body=node('tbody');
    for(const label of ['Cloud','Region / plan','Monthly','Δ vs selected','Pricing','']){const th=node('th',label);th.scope='col';header.append(th);}head.append(header);
    const baseState=E.cloudState(state,state.cloud,E.GEOS[geo][state.cloud]),base=E.estimate(baseState,data);
    for(const cloud of ['AWS','Azure','GCP']){
      const region=E.GEOS[geo][cloud],comparisonState=E.cloudState(state,cloud,region),comparable=E.platformLevel(comparisonState)===E.platformLevel(baseState);
      const est=E.estimate(comparisonState,data),tr=node('tr',undefined,cloud===state.cloud?'active-cloud':'');
      const platform=node('th',cloud==='GCP'?'Google Cloud':cloud);platform.scope='row';
      const price=node('td',undefined,'compare-price');price.append(node('b',est.complete?money(est.total):'Incomplete'),node('small',est.complete?money(est.total*12)+' / yr':''));
      const delta=node('td',undefined,'delta');
      if(!base.complete||!est.complete)delta.textContent='—';else if(!comparable)delta.textContent='Tier differs';else if(cloud===state.cloud)delta.textContent='base';else if(base.total===0)delta.textContent=est.total===0?'=':'—';else{const pct=(est.total/base.total-1)*100;delta.textContent=Math.abs(pct)<0.05?'=':(pct>0?'▲':'▼')+number(Math.abs(pct),1)+'%';if(Math.abs(pct)>=0.05)delta.classList.add(pct>0?'pricier':'cheaper');}
      const pricing=node('td'),status=est.issues.length?'Unavailable':est.fallback.length?est.fallback.length+' fallback(s)':est.availabilityChecks.some(a=>a.status==='beta')?'Lakebase beta':'Regional rates';pricing.append(node('span',status,'tag '+(est.issues.length?'missing':est.fallback.length||status==='Lakebase beta'?'fallback':'exact')));pricing.title=est.issues.join(' ');
      const action=node('td'),use=button('Use region ↗',()=>{state=comparisonState;regionOptions();render();toast('Deployment changed to '+cloud+' · '+region);});use.disabled=est.issues.length>0;action.append(use);
      tr.append(platform,node('td',region+' · '+(comparisonState.tier==='premium'?'Premium':'Enterprise')),price,delta,pricing,action);body.append(tr);
    }
    table.append(head,body);$('comparison').replaceChildren(table);
  }
  function renderRates(){
    $('rates-location').textContent=state.cloud+' / '+state.region+' / '+state.tier;
    $('rates-provenance').textContent=data.savedPricing?'Saved applied rates supplied in shared link · original snapshot '+data.savedPricing.snapshotDate:liveKeys.size?'Live refreshed rates with snapshot fallback; snapshot dated '+data.retrievedAt:'Official Databricks snapshot retrieved '+data.retrievedAt;
    $('region-count').textContent=Object.values(data.regions).reduce((n,r)=>n+r.length,0)+' CLOUD / REGION OPTIONS';
    $('rates-rows').replaceChildren(...current.rows.map(r=>{const tr=node('tr');const status=node('td');status.append(badge(r));const a=r.id.startsWith('lakebase')?current.availabilityChecks.find(a=>a.product==='lakebase'):null;tr.append(node('td',r.name),node('td',rateText(r.rate)),node('td',r.unit),status,node('td',r.sourceCloud+' · '+r.sourceRegion),node('td',a?a.status+' · '+a.checkedAt:'Not verified'));return tr;}));
  }
  function render(){
    current=E.estimate(state,data);renderCostRows();renderSummary();renderComparison();renderRates();
    $('snapshot-date').textContent='Snapshot retrieved '+data.retrievedAt+' · USD';
    $('feed-label').textContent=data.savedPricing?'SAVED ESTIMATE RATES':liveKeys.size?'LIVE REFRESH + SNAPSHOT FALLBACK':'OFFICIAL SNAPSHOT · '+data.retrievedAt;
    $('source-mode').textContent=data.savedPricing?'Saved estimate rates':liveKeys.size?'Live refresh + snapshot fallback':'Official pricing snapshot';
  }
  function csvCell(v){let s=String(v??'');if(/^[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
  function exportEstimate(){
    const rows=[['Databricks Sizing Desk — directional estimate'],['Generated',new Date().toISOString()],['Cloud',state.cloud],['Region',state.region],['Plan',state.tier],['Workloads',state.workloads.join(', ')],['Pricing snapshot',data.savedPricing?.snapshotDate??data.retrievedAt],['Feed source',data.source],['Rate mode',data.savedPricing?'Saved rates supplied in shared link':liveKeys.size?'Live refresh with snapshot fallback':'Bundled official snapshot'],['Currency','USD'],['Estimate complete',current.complete],[],['Product','Quantity','Unit','USD / unit','Gross monthly USD','Net monthly USD','Rate status','Rate source cloud','Rate source region','Pricing date / mode','Usage formula'],...current.rows.map(r=>[r.name,r.qty,r.unit,r.rate,r.gross,r.cost,r.status,r.sourceCloud,r.sourceRegion,rowFreshness(r),Object.hasOwn(state.quantities,r.id)?'Manual quantity override':r.formula]),[],['Monthly total',current.total],['Annualized total',current.complete?current.total*12:null],['Planning low',current.complete?current.low:null],['Planning high',current.complete?current.high:null],['Sensitivity %',state.uncertainty],['Compute discount %',state.discount],[],['INPUT ASSUMPTIONS'],...Object.entries(state).filter(([k])=>!['overrides','quantities','workloads'].includes(k)),[],['SIZING NOTES'],...current.notes.map(n=>[n]),['Exclusions','Taxes, egress/networking, private connectivity, support, implementation, GPU training, embeddings, RAG sync, PITR/snapshots, cross-region DR; add allowances.'],['Terms','Usage is heuristic. Price coverage does not guarantee service availability. This is not a contractual quote.']];
    rows.push([],['Sizing engine',E.VERSION],['Comparison geography',geo],['Applied rate mode',data.savedPricing?'Saved rates supplied in shared link':liveKeys.size?'Live + snapshot':'Bundled snapshot'],['Saved pricing snapshot',data.savedPricing?.snapshotDate??''],['CONFIGURATION ISSUES'],...current.issues.map(n=>[n]),['AVAILABILITY CHECKS'],...current.availabilityChecks.map(a=>[a.product,a.status,a.checkedAt,a.source]));
    const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download='databricks-estimate-'+state.cloud.toLowerCase()+'-'+new Date().toISOString().slice(0,10)+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Estimate exported with pricing sources and assumptions.');
  }
  async function share(){
    const url=new URL(location.href);url.hash='estimate='+encodeURIComponent(JSON.stringify(E.createSharedEstimate(state,data,geo)));
    try{await navigator.clipboard.writeText(url.href);toast('Estimate copied with applied rates, inputs and comparison geography.');}catch{history.replaceState(null,'',url);toast('Estimate and applied rates saved in this URL. Copy the address to share.');}
  }
  async function refresh(){
    const b=$('refresh');b.disabled=true;b.textContent='↻ Checking official feed…';$('refresh-status').textContent='Current prices stay active while checking.';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch(data.source,{signal:controller.signal,credentials:'omit',cache:'no-store'});if(!response.ok)throw new Error('feed unavailable');
      const raw=await response.json();if(!raw||typeof raw!=='object'||!raw.premium?.AWS?.jobs_serverless)throw new Error('unexpected pricing format');
      const next=JSON.parse(JSON.stringify(bundledData)),updated=new Set();let count=0;
      for(const tier of ['premium','enterprise'])for(const cloud of ['AWS','Azure','GCP'])for(const sku of Object.keys(next.rates[tier]?.[cloud]??{}))for(const region of next.regions[cloud]){
        const value=raw[tier]?.[cloud]?.[sku]?.[region];if(E.parseRate(value)!==null&&(!sku.startsWith('vector_search')||E.parseRate(value,1)!==null)){next.rates[tier][cloud][sku][region]=String(value);updated.add(`${tier}/${cloud}/${sku}/${region}`);count++;}
      }
      for(const cloud of ['AWS','Azure','GCP'])for(const model of Object.keys(next.models[cloud]))for(const region of next.regions[cloud]){
        const v=raw.regionModels?.[cloud]?.on_demand?.[model]?.[region];if(E.parseRate(v?.inputPrice)!==null&&E.parseRate(v?.outputPrice)!==null){next.models[cloud][model][region]={inputPrice:String(v.inputPrice),outputPrice:String(v.outputPrice)};updated.add(`models/${cloud}/${model}/${region}`);count++;}
      }
      if(!count)throw new Error('no valid rates');next.refreshedAt=new Date().toISOString();data=next;liveKeys=updated;render();$('refresh-status').textContent=count+' regional entries refreshed at '+new Date().toLocaleTimeString()+'. Other entries use the bundled snapshot.';toast('Official regional prices refreshed.');
    }catch{ $('refresh-status').textContent='Live feed unavailable or browser access blocked. The current dataset remains active; bundled snapshot: '+data.retrievedAt+'.';toast('Refresh unavailable. Your estimate is still using the current prices.'); }
    finally{clearTimeout(timer);b.disabled=false;b.textContent='↻ Refresh official rates';}
  }
  function quickScale(scale){
    const values={small:{gb:20,storedTB:1,concurrency:5,scientists:2,requests:1000,vectors:0.2,databaseGB:20,workingGB:1},medium:{gb:100,storedTB:9,concurrency:10,scientists:5,requests:10000,vectors:1,databaseGB:100,workingGB:4},large:{gb:1000,storedTB:90,concurrency:100,scientists:20,requests:100000,vectors:10,databaseGB:1000,workingGB:16}};
    state=E.normalise({...state,...values[scale],quantities:{}});renderRequirements();renderAdvanced();render();document.querySelectorAll('[data-scale]').forEach(b=>b.classList.toggle('selected',b.dataset.scale===scale));
  }
  function changeCloud(cloud){
    const found=Object.keys(E.GEOS).find(g=>E.GEOS[g][state.cloud]===state.region);if(found)geo=found;
    state=E.cloudState(state,cloud,E.GEOS[geo][cloud]);$('compare-geo').value=geo;regionOptions();render();
  }
  function loadSharedEstimate(){
    if(!location.hash.startsWith('#estimate='))return false;
    try{
      if(location.hash.length>100000)throw new Error('Estimate link exceeds the supported size.');
      const payload=JSON.parse(decodeURIComponent(location.hash.slice(10)));
      if(payload&&Object.hasOwn(payload,'version')){const restored=E.restoreSharedEstimate(payload,bundledData);state=restored.state;geo=restored.geo;data=restored.data;}
      else{state=E.normalise(payload);data=bundledData;geo=Object.keys(E.GEOS).find(g=>E.GEOS[g][state.cloud]===state.region)??'singapore';toast('Legacy input link loaded using current bundled rates and sizing assumptions.');}
      liveKeys=new Set();$('compare-geo').value=geo;return true;
    }catch(error){toast('Could not load saved estimate. '+error.message);return false;}
  }
  async function init(){
    try{
      const resources=await Promise.all(['pricing-snapshot.json','availability.json','../lakebase-content/facts.json'].map(async path=>{const r=await fetch(path);if(!r.ok)throw new Error('calculator data missing');return r.json();}));
      data={...resources[0],availability:resources[1],lakebaseParameters:resources[2].parameters};bundledData=data;
      loadSharedEstimate();
      regionOptions();renderSidebar();renderRequirements();renderAdvanced();render();$('loading').hidden=true;$('app').hidden=false;
      for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>tab(b.dataset.tab));
      for(const b of document.querySelectorAll('[data-open-tab]'))b.addEventListener('click',()=>tab(b.dataset.openTab));
      for(const b of document.querySelectorAll('[data-cloud]'))b.addEventListener('click',()=>changeCloud(b.dataset.cloud));
      for(const b of document.querySelectorAll('[data-scale]'))b.addEventListener('click',()=>quickScale(b.dataset.scale));
      $('region').addEventListener('change',()=>{state.region=$('region').value;state.overrides={};const g=Object.keys(E.GEOS).find(k=>E.GEOS[k][state.cloud]===state.region);if(g){geo=g;$('compare-geo').value=g;}render();});
      $('tier').addEventListener('change',()=>{state=E.normalise({...state,tier:$('tier').value,overrides:{}});render();});
      $('compare-geo').addEventListener('change',()=>{geo=$('compare-geo').value;renderComparison();});
      $('coverage-link').addEventListener('click',e=>{e.preventDefault();tab('rates');});
      $('toggle-usage').addEventListener('click',()=>{editUsage=!editUsage;renderCostRows();});
      $('clear-overrides').addEventListener('click',()=>{state.overrides={};state.quantities={};render();toast('Usage and rates reset to scenario calculations.');});
      $('refresh').addEventListener('click',refresh);$('export').addEventListener('click',exportEstimate);$('share').addEventListener('click',share);
      window.addEventListener('hashchange',()=>{if(loadSharedEstimate()){regionOptions();renderSidebar();renderRequirements();renderAdvanced();render();}});
      $('print').addEventListener('click',()=>{tab('estimate');window.print();});
      $('reset').addEventListener('click',()=>{state=E.normalise();geo='singapore';data=bundledData;liveKeys=new Set();editUsage=false;history.replaceState(null,'',location.pathname+location.search);$('compare-geo').value=geo;regionOptions();renderSidebar();renderRequirements();renderAdvanced();render();toast('Default estimate restored with bundled rates.');});
      // Expose a read-only snapshot for local QA; no customer data is transmitted.
      window.sizingDesk={getState:()=>JSON.parse(JSON.stringify(state)),getEstimate:()=>JSON.parse(JSON.stringify(current))};
    }catch(error){$('loading').textContent='Could not load the bundled pricing snapshot. Reload this page to retry.';console.error(error);}
  }
  init();
})();
