'use strict';
(() => {
  const E=window.Sizing,$=id=>document.getElementById(id);
  let data,state=E.normalise(),current,editUsage=false,geo='singapore',toastTimer,liveKeys=new Set();
  const number=(n,d=0)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:d}).format(n);
  const money=(n,d=0)=>n===null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:d,minimumFractionDigits:d}).format(n);
  const rateText=n=>n===null?'—':'$'+number(n,n<0.01?5:3);
  function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function button(text,fn,cls='text-button'){const b=node('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;}
  function toast(text){$('toast').textContent=text;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4000);}
  const icons={lakehouse:'▱',batch:'⇥',streaming:'≋',ai:'✧',science:'⌘',lakebase:'▤'};
  const subs={lakehouse:'Ingest · transform · query',batch:'Scheduled ETL pipelines',streaming:'Always-on data pipelines',ai:'Inference · retrieval',science:'Notebooks · experiments',lakebase:'Operational Postgres'};
  function tab(name){if(!['estimate','rates','method'].includes(name))return;for(const view of document.querySelectorAll('.view'))view.hidden=view.id!==name+'-view';for(const b of document.querySelectorAll('[data-tab]')){const on=b.dataset.tab===name;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));}if(name!=='estimate')window.scrollTo({top:140,behavior:'smooth'});}
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
      const text=node('span');text.append(node('strong',p.name),node('small',subs[id]));b.append(node('span',icons[id],'preset-icon'),text,node('span','↗','arrow'));return b;
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
    render();
  }
  function numeric(key,label,unit,help,advanced=false){
    const box=node('div',undefined,'field');const l=node('label',label);l.htmlFor='field-'+key;
    const wrap=node('div',undefined,'input-wrap'),input=node('input');input.type='number';input.id='field-'+key;input.value=state[key];input.inputMode='decimal';input.min=E.BOUNDS[key][0];input.max=E.BOUNDS[key][1];input.step=['vectors','workingGB','etlFactor','layers','dsHours','streamDBU','dsDBU'].includes(key)?'any':'1';
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
    const dataWork=w.some(x=>['etl','stream','sql','ds'].includes(x));
    if(dataWork)fields.push(numeric('gb','Daily data volume','GB / day','New or changed data to process each day.'));
    if(w.includes('sql'))fields.push(numeric('concurrency','Concurrent analytics users','users','Peak active users, not total licensed seats.'));
    if(w.includes('ai'))fields.push(numeric('requests','AI requests per day','req / day','One model call per request by default.'),numeric('vectors','Search index size','M vectors','768 dimensions; enter 0 for inference only.'));
    if(w.includes('ds'))fields.push(numeric('scientists','Data science team','people','CPU notebook users.'));
    if(w.includes('lakebase'))fields.push(numeric('databaseGB','Database size','GB','Average stored database size.'),numeric('workingGB','Active working set','GB RAM','Frequently accessed data held in memory.'));
    if(dataWork)fields.push(select('complexity','Transformation complexity',[['simple','Simple · filtering & light joins'],['standard','Standard · joins & aggregates'],['complex','Complex · UDFs & heavy shuffles']],'Sets an editable DBU/GB starting point.'));
    if(w.some(x=>['sql','ds','lakebase'].includes(x)))fields.push(select('schedule','Operating schedule',[['business','Business hours · 8 h × 22 days'],['extended','Extended hours · 12 h × 30 days'],['always','Always on · 730 h / month']],'Streaming and AI Search remain always on.'));
    if(dataWork&&!w.includes('sql')&&!w.includes('ds'))fields.push(numeric('retention','Data retention','days','Steady-state retention across the lakehouse.'));
    if(w.includes('ai')&&!dataWork)fields.push(select('model','Foundation model',Object.keys(data.models.AWS).map(x=>[x,x]),'PAYG input and output token pricing.'));
    $('requirements').replaceChildren(...fields);$('input-count').textContent=fields.length+' inputs';
    const p=E.PRESETS[state.scenario];$('scenario-description').textContent=w.join(',')===p.workloads.join(',')?p.description:'A combined estimate for your selected workloads.';
  }
  function renderAdvanced(){
    const w=state.workloads,fields=[numeric('headroom','Compute headroom','%','Capacity cushion on sized compute.',true),numeric('uncertainty','Budget sensitivity','± %','Range around the full estimate.',true),numeric('discount','Compute discount','%','Only eligible compute; default 0%.',true)];
    if(w.some(x=>['etl','stream'].includes(x)))fields.push(numeric('etlFactor','Processing intensity','DBU/GB','Heuristic: 0.08 / 0.20 / 0.50.',true));
    if(w.includes('stream'))fields.push(numeric('streamDBU','Streaming baseline','DBU/h','Minimum estimated continuous usage.',true));
    if(w.includes('sql'))fields.push(numeric('sqlUtil','SQL active time','%','Fraction of scheduled hours billed.',true));
    if(w.some(x=>['etl','stream','sql','ds'].includes(x)))fields.push(numeric('retention','Lakehouse retention','days','Steady-state, not first-month growth.',true),numeric('layers','Retained-size factor','×','Combined layers after compression.',true));
    if(w.includes('ds'))fields.push(numeric('dsHours','Notebook time per person','h/day','Active hours; CPU compute only.',true),numeric('dsDBU','Notebook usage per person','DBU/h','Replace after measuring a sample.',true));
    if(w.includes('ai')){fields.push(numeric('inputTokens','Input tokens / request','tokens','Includes prompt and retrieved context.',true),numeric('outputTokens','Output tokens / request','tokens','Generated response length.',true));if(w.some(x=>['etl','stream','sql','ds'].includes(x)))fields.push(select('model','Foundation model',Object.keys(data.models.AWS).map(x=>[x,x])));}
    if(w.includes('lakebase')){const f=node('div',undefined,'field');const lab=node('label','Lakebase high availability');lab.htmlFor='lakebase-ha';const checkbox=node('input');checkbox.type='checkbox';checkbox.id='lakebase-ha';checkbox.checked=state.lakebaseHA;checkbox.addEventListener('change',()=>update('lakebaseHA',checkbox.checked));f.append(lab,checkbox,node('p','Primary + 1 equal secondary, 24/7.','field-help'));fields.push(f);}
    fields.push(numeric('extra','Other monthly costs','$ / mo','Networking, support or other services.',true));
    // Retention is visible in either the main form or advanced controls, never both.
    if($('requirements').querySelector('#field-retention')){const i=fields.findIndex(f=>f.querySelector('#field-retention'));if(i>=0)fields.splice(i,1);}
    $('advanced-fields').replaceChildren(...fields);
  }
  function badge(row){const cls=row.status==='exact'?'exact':row.status==='override'||row.status==='allowance'?'override':row.status==='missing'?'missing':'fallback';return node('span',row.status==='exact'?'Regional rate':row.status,'tag '+cls);}
  function rowFreshness(r){
    const path=r.id.startsWith('ai_')?`models/${r.sourceCloud}/${r.sku}/${r.sourceRegion}`:`${r.sourceTier}/${r.sourceCloud}/${r.sku}/${r.sourceRegion}`;
    return liveKeys.has(path)?'Live refresh':'Snapshot '+data.retrievedAt;
  }
  function renderCostRows(){
    $('toggle-usage').textContent=editUsage?'Done adjusting ✓':'Adjust usage & rates ↗';
    $('cost-rows').replaceChildren(...current.rows.map(r=>{
      const tr=node('tr'),name=node('td');name.append(node('b',r.name));const isCustom=Object.hasOwn(state.quantities,r.id)||Object.hasOwn(state.overrides,r.id);
      const sub=node('small',isCustom?'Manual override':r.status==='exact'?'Regional PAYG · '+r.unit:r.status+' · '+r.sourceCloud+' / '+r.sourceRegion);name.append(sub);name.title=r.formula+' · '+rowFreshness(r);
      const usage=node('td'),rate=node('td'),cost=node('td',r.cost===null?'Missing rate':money(r.cost,2));
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
    $('monthly').textContent=current.complete?money(current.total):'Incomplete';$('monthly').style.fontSize=current.complete?'':'29px';
    $('annual').textContent=current.complete?money(current.total*12)+' / year · annualized run rate':'Known costs: '+money(current.subtotal)+' / month';
    $('range').textContent=current.complete?money(current.low)+' – '+money(current.high):'Missing unit rates';
    $('range-caption').textContent='±'+state.uncertainty+'% planning sensitivity · not a quote';
    const groups={compute:{name:'Compute',color:'#8db6a3',cost:0},ai:{name:'AI & retrieval',color:'#efab80',cost:0},storage:{name:'Storage',color:'#d1d6af',cost:0},other:{name:'Other costs',color:'#9cacc5',cost:0}};
    for(const r of current.rows)groups[r.group].cost+=r.cost??0;
    const active=Object.values(groups).filter(g=>g.cost>0);
    $('cost-bars').replaceChildren(...active.map(g=>{const n=node('span');n.style.backgroundColor=g.color;n.style.width=(g.cost/current.subtotal*100)+'%';n.title=g.name+': '+money(g.cost,2);return n;}));
    $('cost-legend').replaceChildren(...active.map(g=>{const line=node('div',undefined,'legend-line'),label=node('span',undefined,'legend-name'),i=node('i');i.style.backgroundColor=g.color;label.append(i,node('span',g.name));line.append(label,node('b',money(g.cost,2)));return line;}));
    $('metric-dbu').textContent=number(current.dbus)+' DBU / mo';$('metric-storage').textContent=current.storageGB>=1000?number(current.storageGB/1000,1)+' TB':number(current.storageGB,1)+' GB';
    $('summary-location').textContent=state.cloud+' · '+state.region;$('summary-tier').textContent=state.tier.charAt(0).toUpperCase()+state.tier.slice(1);
    const notes=[];
    if(current.fallback.length)notes.push(node('div',current.fallback.length+' line(s) use fallback or missing prices. Treat the total as provisional.','summary-note warning'));
    const overrideCount=current.rows.filter(r=>r.status==='override'||Object.hasOwn(state.quantities,r.id)).length;
    if(overrideCount)notes.push(node('div',overrideCount+' line(s) have manual usage or price overrides.','summary-note'));
    if(current.savings>0)notes.push(node('div',money(current.savings,2)+' / mo compute discount applied. Tokens and storage remain at list rates.','summary-note'));
    if(!notes.length)notes.push(node('div','All active lines use exact regional prices. Usage remains assumption-based.','summary-note'));
    if(state.cloud==='Azure')notes.push(node('div','Azure Premium is the comparable platform tier to AWS/GCP Enterprise. Microsoft sets Azure rates.','summary-note'));
    $('summary-notes').replaceChildren(...notes);
    $('coverage-icon').style.backgroundColor=current.fallback.length?'#d5a34d':'#53a99b';
    $('coverage-text').textContent=current.fallback.length?current.fallback.length+' fallback / missing rate(s) · review before quoting':current.rows.filter(r=>r.status==='exact').length+' exact regional rate(s) · compute infrastructure included';
  }
  function renderComparison(){
    $('comparison').replaceChildren(...['AWS','Azure','GCP'].map(cloud=>{
      const region=E.GEOS[geo][cloud];const comparisonState={...state,cloud,region,tier:cloud==='Azure'?'premium':state.tier,overrides:{}};
      const est=E.estimate(comparisonState,data),card=node('article',undefined,'compare-card'+(state.cloud===cloud?' active-cloud':''));
      card.append(node('b',cloud==='GCP'?'Google Cloud':cloud),node('span',est.complete?money(est.total):'Incomplete','compare-price'),node('small',region+' · '+(est.fallback.length?est.fallback.length+' fallback(s)':'regional rates')));
      card.append(button('Use this region ↗',()=>{state=E.normalise(comparisonState);regionOptions();render();toast('Deployment changed to '+cloud+' · '+region);}));return card;
    }));
  }
  function renderRates(){
    $('rates-location').textContent=state.cloud+' / '+state.region+' / '+state.tier;
    $('rates-provenance').textContent=liveKeys.size?'Live refreshed rates with snapshot fallback; snapshot dated '+data.retrievedAt:'Official Databricks snapshot retrieved '+data.retrievedAt;
    $('region-count').textContent=Object.values(data.regions).reduce((n,r)=>n+r.length,0)+' CLOUD / REGION OPTIONS';
    $('rates-rows').replaceChildren(...current.rows.map(r=>{const tr=node('tr');const status=node('td');status.append(badge(r));tr.append(node('td',r.name),node('td',rateText(r.rate)),node('td',r.unit),status,node('td',r.sourceCloud+' · '+r.sourceRegion));return tr;}));
  }
  function render(){
    current=E.estimate(state,data);renderCostRows();renderSummary();renderComparison();renderRates();
    $('snapshot-date').textContent='Snapshot retrieved '+data.retrievedAt+' · USD';
    $('feed-label').textContent=liveKeys.size?'LIVE REFRESH + SNAPSHOT FALLBACK':'OFFICIAL SNAPSHOT · '+data.retrievedAt;
    $('source-mode').textContent=liveKeys.size?'Live refresh + snapshot fallback':'Official pricing snapshot';
  }
  function csvCell(v){let s=String(v??'');if(/^[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
  function exportEstimate(){
    const rows=[['Databricks Sizing Desk — directional estimate'],['Generated',new Date().toISOString()],['Cloud',state.cloud],['Region',state.region],['Plan',state.tier],['Workloads',state.workloads.join(', ')],['Pricing snapshot',data.retrievedAt],['Feed source',data.source],['Rate mode',liveKeys.size?'Live refresh with snapshot fallback':'Bundled official snapshot'],['Currency','USD'],['Estimate complete',current.complete],[],['Product','Quantity','Unit','USD / unit','Gross monthly USD','Net monthly USD','Rate status','Rate source cloud','Rate source region','Pricing date / mode','Usage formula'],...current.rows.map(r=>[r.name,r.qty,r.unit,r.rate,r.gross,r.cost,r.status,r.sourceCloud,r.sourceRegion,rowFreshness(r),Object.hasOwn(state.quantities,r.id)?'Manual quantity override':r.formula]),[],['Monthly total',current.total],['Annualized total',current.complete?current.total*12:null],['Planning low',current.complete?current.low:null],['Planning high',current.complete?current.high:null],['Sensitivity %',state.uncertainty],['Compute discount %',state.discount],[],['INPUT ASSUMPTIONS'],...Object.entries(state).filter(([k])=>!['overrides','quantities','workloads'].includes(k)),[],['SIZING NOTES'],...current.notes.map(n=>[n]),['Exclusions','Taxes, egress/networking, private connectivity, support, implementation, GPU training, embeddings, RAG sync, PITR/snapshots, cross-region DR; add allowances.'],['Terms','Usage is heuristic. Price coverage does not guarantee service availability. This is not a contractual quote.']];
    const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download='databricks-estimate-'+state.cloud.toLowerCase()+'-'+new Date().toISOString().slice(0,10)+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Estimate exported with pricing sources and assumptions.');
  }
  async function share(){
    const url=new URL(location.href);url.hash='estimate='+encodeURIComponent(JSON.stringify(state));
    try{await navigator.clipboard.writeText(url.href);toast('Estimate link copied. It includes your inputs and overrides.');}catch{history.replaceState(null,'',url);toast('Estimate saved in this page URL. Copy the address to share.');}
  }
  async function refresh(){
    const b=$('refresh');b.disabled=true;b.textContent='↻ Checking official feed…';$('refresh-status').textContent='Current prices stay active while checking.';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch(data.source,{signal:controller.signal,credentials:'omit',cache:'no-store'});if(!response.ok)throw new Error('feed unavailable');
      const raw=await response.json();if(!raw||typeof raw!=='object'||!raw.premium?.AWS?.jobs_serverless)throw new Error('unexpected pricing format');
      const next=JSON.parse(JSON.stringify(data)),updated=new Set(liveKeys);let count=0;
      for(const tier of ['premium','enterprise'])for(const cloud of ['AWS','Azure','GCP'])for(const sku of Object.keys(next.rates[tier]?.[cloud]??{}))for(const region of next.regions[cloud]){
        const value=raw[tier]?.[cloud]?.[sku]?.[region];if(E.parseRate(value)!==null&&(!sku.startsWith('vector_search')||E.parseRate(value,1)!==null)){next.rates[tier][cloud][sku][region]=String(value);updated.add(`${tier}/${cloud}/${sku}/${region}`);count++;}
      }
      for(const cloud of ['AWS','Azure','GCP'])for(const model of Object.keys(next.models[cloud]))for(const region of next.regions[cloud]){
        const v=raw.regionModels?.[cloud]?.on_demand?.[model]?.[region];if(E.parseRate(v?.inputPrice)!==null&&E.parseRate(v?.outputPrice)!==null){next.models[cloud][model][region]={inputPrice:String(v.inputPrice),outputPrice:String(v.outputPrice)};updated.add(`models/${cloud}/${model}/${region}`);count++;}
      }
      if(!count)throw new Error('no valid rates');data=next;liveKeys=updated;render();$('refresh-status').textContent=count+' regional entries refreshed at '+new Date().toLocaleTimeString()+'. Unchanged entries retain snapshot prices.';toast('Official regional prices refreshed.');
    }catch{ $('refresh-status').textContent='Live feed unavailable or browser access blocked. The current dataset remains active; bundled snapshot: '+data.retrievedAt+'.';toast('Refresh unavailable. Your estimate is still using the current prices.'); }
    finally{clearTimeout(timer);b.disabled=false;b.textContent='↻ Refresh official rates';}
  }
  function quickScale(scale){
    const values={small:{gb:20,concurrency:5,scientists:2,requests:1000,vectors:0.2,databaseGB:20,workingGB:1},medium:{gb:100,concurrency:10,scientists:5,requests:10000,vectors:1,databaseGB:100,workingGB:4},large:{gb:1000,concurrency:100,scientists:20,requests:100000,vectors:10,databaseGB:1000,workingGB:16}};
    state=E.normalise({...state,...values[scale],quantities:{}});renderRequirements();renderAdvanced();render();document.querySelectorAll('[data-scale]').forEach(b=>b.classList.toggle('selected',b.dataset.scale===scale));
  }
  function changeCloud(cloud){
    const found=Object.keys(E.GEOS).find(g=>E.GEOS[g][state.cloud]===state.region);if(found)geo=found;
    state=E.normalise({...state,cloud,region:E.GEOS[geo][cloud],overrides:{}});$('compare-geo').value=geo;regionOptions();render();
  }
  function loadSharedEstimate(){
    if(!location.hash.startsWith('#estimate='))return false;
    try{if(location.hash.length>20000)throw new Error('too long');state=E.normalise(JSON.parse(decodeURIComponent(location.hash.slice(10))));return true;}
    catch{toast('Could not load the shared estimate. Current inputs kept.');return false;}
  }
  async function init(){
    try{
      const r=await fetch('pricing-snapshot.json');if(!r.ok)throw new Error('pricing snapshot missing');data=await r.json();
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
      $('reset').addEventListener('click',()=>{state=E.normalise();geo='singapore';editUsage=false;history.replaceState(null,'',location.pathname+location.search);$('compare-geo').value=geo;regionOptions();renderSidebar();renderRequirements();renderAdvanced();render();toast('Default estimate restored.');});
      // Expose a read-only snapshot for local QA; no customer data is transmitted.
      window.sizingDesk={getState:()=>JSON.parse(JSON.stringify(state)),getEstimate:()=>JSON.parse(JSON.stringify(current))};
    }catch(error){$('loading').textContent='Could not load the bundled pricing snapshot. Reload this page to retry.';console.error(error);}
  }
  init();
})();
