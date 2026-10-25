(function (root) {
  'use strict';
  const VERSION='2026-10-25.1';
  const ANCHORS = {AWS:'US East (N. Virginia)',Azure:'US East',GCP:'US (Iowa)'};
  const GEOS = {singapore:{AWS:'AP (Singapore)',Azure:'Asia Southeast',GCP:'Asia (Singapore)'},us:{...ANCHORS},europe:{AWS:'Europe (Frankfurt)',Azure:'Germany West Central',GCP:'Europe (Frankfurt)'},sydney:{AWS:'AP (Sydney)',Azure:'Australia East',GCP:'Australia (Sydney)'},tokyo:{AWS:'AP (Tokyo)',Azure:'Japan East',GCP:'Asia (Tokyo)'}};
  const PRESETS = {
    lakehouse:{name:'Lakehouse + BI',description:'Daily ingestion, transformations and dashboards.',workloads:['etl','sql'],gb:100,concurrency:10,retention:90,schedule:'business',complexity:'standard'},
    bi:{name:'BI / SQL',description:'Dashboards and analytics over an existing dataset.',workloads:['sql'],storedTB:9,concurrency:10,queryProfile:'dashboard',schedule:'business'},
    batch:{name:'Batch data engineering',description:'Scheduled ETL and a governed data lake.',workloads:['etl'],gb:500,retention:90,schedule:'business',complexity:'standard'},
    streaming:{name:'Real-time analytics',description:'Continuous pipelines with live SQL analytics.',workloads:['stream','sql'],gb:250,concurrency:20,retention:30,schedule:'always',complexity:'standard'},
    ai:{name:'GenAI / RAG',description:'Token-based inference with an AI Search index.',workloads:['ai'],requests:10000,vectors:1,gb:0,retention:30,schedule:'always',complexity:'standard'},
    science:{name:'Data science',description:'CPU notebooks and experimentation for a team.',workloads:['ds'],scientists:5,gb:20,retention:90,schedule:'business',complexity:'standard'},
    lakebase:{name:'Lakebase application',description:'Autoscaling Postgres for an operational app.',workloads:['lakebase'],databaseGB:100,workingGB:4,gb:0,retention:30,schedule:'always',complexity:'standard'}
  };
  const WORKLOADS={etl:'Batch ETL',stream:'Streaming',sql:'BI / SQL',ds:'Data science',ai:'GenAI / RAG',lakebase:'Lakebase'};
  const QUERY_PROFILES={dashboard:{name:'Dashboard · selective reads',scan:0.001,users:20,minSize:0},interactive:{name:'Interactive · joins & exploration',scan:0.01,users:10,minSize:1},heavy:{name:'Heavy · broad scans & joins',scan:0.1,users:5,minSize:2}};
  const ANSWER_PROFILES={short:{name:'Short · 1K in / 250 out',input:1000,output:250},standard:{name:'Standard · 2K in / 500 out',input:2000,output:500},long:{name:'Long · 8K in / 2K out',input:8000,output:2000},custom:{name:'Custom token assumptions'}};
  const DEFAULTS={scenario:'lakehouse',cloud:'AWS',region:'AP (Singapore)',tier:'premium',platformTier:'premium',workloads:['etl','sql'],gb:100,storedTB:9,queryProfile:'dashboard',batchHours:4,newDataPct:100,answerProfile:'standard',retention:90,concurrency:10,schedule:'business',complexity:'standard',scientists:5,requests:10000,vectors:1,model:'GPT OSS 120B',inputTokens:2000,outputTokens:500,databaseGB:100,workingGB:4,sqlUtil:60,etlFactor:0.2,streamDBU:2,dsDBU:4,dsHours:4,layers:1.5,headroom:20,discount:0,uncertainty:35,extra:0,lakebaseHA:false,lakebaseBilling:'qualified',overrides:{},quantities:{}};
  const BOUNDS={gb:[0,10000000],storedTB:[0,10000000],batchHours:[0.1,24],newDataPct:[0,100],retention:[1,3650],concurrency:[1,100000],scientists:[1,10000],requests:[0,1e9],vectors:[0,10000],inputTokens:[1,2000000],outputTokens:[1,2000000],databaseGB:[0,1e8],workingGB:[0.5,1000000],sqlUtil:[1,100],etlFactor:[0.001,100],streamDBU:[0.1,100000],dsDBU:[0.1,1000],dsHours:[0.1,24],layers:[0.1,10],headroom:[0,200],discount:[0,90],uncertainty:[0,90],extra:[0,1e9]};
  function normalise(raw={}) {
    const s={...DEFAULTS,workloads:[...DEFAULTS.workloads],overrides:{},quantities:{}};
    for(const [key,[min,max]] of Object.entries(BOUNDS)) {const n=Number(raw[key]);if(raw[key]!==undefined&&raw[key]!==''&&Number.isFinite(n))s[key]=Math.max(min,Math.min(max,n));}
    for(const [key,allowed] of Object.entries({scenario:Object.keys(PRESETS),cloud:['AWS','Azure','GCP'],tier:['premium','enterprise'],platformTier:['premium','enterprise'],queryProfile:Object.keys(QUERY_PROFILES),answerProfile:Object.keys(ANSWER_PROFILES),schedule:['business','extended','always'],lakebaseBilling:['qualified','first-month'],complexity:['simple','standard','complex'],model:['GPT OSS 120B','GPT OSS 20B','Llama 3.3 70B','Llama 4 Maverick']}))if(allowed.includes(raw[key]))s[key]=raw[key];
    if(typeof raw.region==='string'&&raw.region.length<100)s.region=raw.region;
    if(Array.isArray(raw.workloads)){const w=[...new Set(raw.workloads.filter(w=>Object.hasOwn(WORKLOADS,w)))];if(w.length)s.workloads=w;}
    s.lakebaseHA=raw.lakebaseHA===true;
    for(const field of ['overrides','quantities'])if(raw[field]&&typeof raw[field]==='object')for(const [k,v]of Object.entries(raw[field]))if(/^[a-z][a-z0-9_]{0,50}$/.test(k)&&typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<1e12)s[field][k]=v;
    if(s.cloud==='Azure'){s.tier='premium';if(!['premium','enterprise'].includes(raw.platformTier))s.platformTier='enterprise';}else s.platformTier=s.tier;
    return s;
  }
  function preset(state,id){if(!Object.hasOwn(PRESETS,id))return normalise(state);return normalise({...state,...PRESETS[id],scenario:id,overrides:{},quantities:{},etlFactor:{simple:0.08,standard:0.2,complex:0.5}[PRESETS[id].complexity??'standard']});}
  function cloudState(raw,cloud,region){const s=normalise(raw);return normalise({...s,cloud,region,tier:cloud==='Azure'?'premium':s.platformTier,overrides:{}});}
  function platformLevel(s){return s.cloud==='Azure'?'enterprise':s.tier;}
  function availability(data,s,product){
    const entry=data.availability?.[product]?.[s.cloud];
    return {product,status:entry?(entry.regions.includes(s.region)?entry.status:'unavailable'):'unknown',source:entry?.source,checkedAt:data.availability?.checkedAt};
  }
  function priceKey(s,sku,part=0){return [s.cloud==='Azure'?'premium':s.tier,s.cloud,s.region,sku,part].join('|');}
  function parseRate(v,part=0){if(typeof v!=='string'&&typeof v!=='number')return null;const p=String(v).split('|')[part];if(p===undefined||p.trim()==='')return null;const n=Number(p);return Number.isFinite(n)&&n>=0?n:null;}
  function lookup(data,state,sku,part=0) {
    const key=priceKey(state,sku,part),saved=data.savedRates?.[key];if(saved)return {...saved,priceKey:key};
    const tier=state.cloud==='Azure'?'premium':state.tier;
    const exact=data?.rates?.[tier]?.[state.cloud]?.[sku];
    const candidates=[{table:exact,region:state.region,cloud:state.cloud,tier,status:'exact'},{table:exact,region:ANCHORS[state.cloud],cloud:state.cloud,tier,status:'region fallback'}];
    const awsSku=sku.replace(/_(azure|gcp)_/,'_aws_');
    candidates.push({table:data?.rates?.[tier]?.AWS?.[awsSku],region:ANCHORS.AWS,cloud:'AWS',tier,status:'cloud benchmark'});
    for(const c of candidates){const rate=parseRate(c.table?.[c.region],part);if(rate!==null)return {rate,status:c.status,sourceRegion:c.region,sourceCloud:c.cloud,sourceTier:c.tier,sku,priceKey:key};}
    return {rate:null,status:'missing',sourceRegion:'No price available',sourceCloud:state.cloud,sourceTier:tier,sku,priceKey:key};
  }
  function modelRate(data,s,part){
    const key=priceKey(s,'model:'+s.model,part),saved=data.savedRates?.[key];if(saved)return {...saved,priceKey:key};
    for(const [cloud,region,status]of [[s.cloud,s.region,'exact'],[s.cloud,ANCHORS[s.cloud],'region fallback'],['AWS',ANCHORS.AWS,'cloud benchmark']]){
      const raw=data?.models?.[cloud]?.[s.model]?.[region];const n=parseRate(raw?.[part]);if(n!==null)return{rate:n,status,sourceCloud:cloud,sourceRegion:region,sourceTier:'model PAYG',sku:s.model,priceKey:key};
    }
    return{rate:null,status:'missing',sourceCloud:s.cloud,sourceRegion:'No model price',sourceTier:'model PAYG',sku:s.model,priceKey:key};
  }
  function estimate(raw,data){
    const s=normalise(raw),rows=[],notes=[],issues=[],availabilityChecks=[];const month=730,days=month/24;
    const hours={business:176,extended:360,always:month}[s.schedule];
    const complex={simple:0.7,standard:1,complex:1.8}[s.complexity];
    const capacity=1+s.headroom/100;
    function add(id,name,qty,unit,rate,formula,group='compute',discountable=true){
      const custom=Object.hasOwn(s.overrides,id);if(custom)rate={...rate,rate:s.overrides[id],status:'override',sourceRegion:s.region,sourceCloud:s.cloud};
      if(Object.hasOwn(s.quantities,id))qty=s.quantities[id];
      const gross=rate.rate===null?null:qty*rate.rate;
      rows.push({id,name,qty,unit,...rate,gross,cost:gross===null?null:gross*(discountable?1-s.discount/100:1),formula,group,discountable});
    }
    if(s.workloads.includes('etl')){
      const q=s.gb*days*s.etlFactor*capacity;
      add('etl','Lakeflow Jobs · serverless',q,'DBU',lookup(data,s,'jobs_serverless'),`${s.gb} GB/day × ${days.toFixed(2)} days × ${s.etlFactor} DBU/GB × ${capacity.toFixed(2)} headroom`);
      notes.push(`Batch sizing assumes ${s.etlFactor} DBU/GB; this is a planning heuristic, not a Databricks throughput guarantee.`);
      notes.push(`Batch window: ${s.batchHours} h/day; approximately ${(q/days/s.batchHours).toFixed(1)} DBU/h during that window. A shorter window changes required throughput, not total estimated DBUs.`);
    }
    if(s.workloads.includes('stream')){
      const rate=Math.max(s.streamDBU,s.gb/24*s.etlFactor)*complex*capacity;
      add('stream','Lakeflow Pipelines · serverless',rate*month,'DBU',lookup(data,s,'dlt_serverless'),`max(${s.streamDBU} baseline DBU/h, daily GB ÷ 24 × DBU/GB) × ${complex} complexity × ${capacity.toFixed(2)} headroom × 730 h`);
      notes.push('Streaming runs 24/7; the operating schedule only changes SQL, notebooks and non-HA Lakebase.');
    }
    const sizes=[['2X-Small',4],['X-Small',6],['Small',12],['Medium',24],['Large',40],['X-Large',80],['2X-Large',144],['3X-Large',272],['4X-Large',528]];
    const profile=QUERY_PROFILES[s.queryProfile],scanGB=s.storedTB*1000*profile.scan;
    const sqlIndex=Math.min(sizes.length-1,Math.max(profile.minSize,Math.ceil(Math.log2(Math.max(1,scanGB/100)))));
    const [sqlSize,sqlDBU]=sizes[sqlIndex];const clusters=Math.max(1,Math.ceil(s.concurrency/profile.users));
    if(s.workloads.includes('sql')){
      add('sql',`SQL warehouse · ${sqlSize}`,sqlDBU*clusters*hours*s.sqlUtil/100*capacity,'DBU',lookup(data,s,'sql_serverless'),`${sqlDBU} DBU/h × ${clusters} cluster(s) × ${hours} h × ${s.sqlUtil}% active × ${capacity.toFixed(2)} headroom`);
      notes.push(`SQL heuristic: ${s.storedTB} TB dataset × ${profile.scan*100}% scanned/query ≈ ${scanGB.toFixed(1)} GB; ${sqlSize}, ${clusters} cluster(s), ${profile.users} users/cluster. This is a starter configuration, not a latency or concurrency guarantee; validate query profiles.`);
    }
    if(s.workloads.includes('ds'))add('ds','Notebooks · serverless CPU',s.scientists*s.dsHours*(s.schedule==='business'?22:days)*s.dsDBU*capacity,'DBU',lookup(data,s,'interactive_serverless'),`${s.scientists} people × ${s.dsHours} active h/day × ${s.schedule==='business'?22:days.toFixed(2)} days × ${s.dsDBU} DBU/h × headroom`);
    if(s.workloads.includes('ai')){
      const requests=s.requests*days;
      add('ai_input',s.model+' · input',requests*s.inputTokens/1e6,'M tokens',modelRate(data,s,'inputPrice'),`${s.requests} requests/day × ${days.toFixed(2)} days × ${s.inputTokens} tokens ÷ 1M`,'ai',false);
      add('ai_output',s.model+' · output',requests*s.outputTokens/1e6,'M tokens',modelRate(data,s,'outputPrice'),`${s.requests} requests/day × ${days.toFixed(2)} days × ${s.outputTokens} tokens ÷ 1M`,'ai',false);
      if(s.vectors>0){
        const units=Math.ceil(s.vectors/2);
        add('vector','AI Search · standard endpoint',units*month,'unit-h',lookup(data,s,'vector_search_standard'),`${units} units × 730 h; 1 unit per 2M vectors at 768 dimensions`,'ai');
        const gb=s.vectors*1e6*768*4/1e9;
        add('vector_storage','AI Search · vector storage',gb,'GB-mo',lookup(data,s,'vector_search_standard',1),`${s.vectors}M vectors × 768 dimensions × 4 bytes; metadata excluded`,'storage',false);
      }
      notes.push('RAG excludes embedding generation, index sync jobs, document parsing, reranking and agent/tool calls; add allowances or custom usage. Token rates are USD per million tokens.');
    }
    const limits=data.lakebaseParameters;
    let lakeCU=null,lakeMode=null,lakeHours=null;
    if(s.workloads.includes('lakebase')){
      const check=availability(data,s,'lakebase');availabilityChecks.push(check);
      if(check.status==='unavailable')issues.push(`Lakebase is not listed as available in ${s.cloud} · ${s.region} (checked ${check.checkedAt}). Select a supported region.`);
      if(!limits)issues.push('Lakebase compute limits could not be loaded. Capacity cannot be validated.');
      else{
        const required=s.workingGB*capacity/limits.ramGB;
        lakeCU=required<=Number(limits.minCU)?Number(limits.minCU):Math.ceil(required);
        lakeMode=lakeCU<=limits.autoMax?'autoscaling capacity':'fixed capacity';
        if(lakeCU>limits.fixedMax)issues.push(`Lakebase requires ${lakeCU} CU (${s.workingGB*capacity} GB including headroom), above the ${limits.fixedMax} CU / ${limits.fixedMax*limits.ramGB} GB maximum. Reduce the working set or revise the architecture.`);
      }
      const canSuspend=limits&&lakeCU<=limits.suspendMax&&!s.lakebaseHA;
      const h=canSuspend?hours:month,replicas=s.lakebaseHA?2:1;lakeHours=h;
      const qualified=h===month,initialHours=qualified&&s.lakebaseBilling==='first-month'?24:0;
      const lakeRate=alwaysOn=>{
        const r=lookup(data,s,`lakebase_${alwaysOn?'alwayson_':''}${s.cloud.toLowerCase()}_${s.tier}`);
        if(check.status==='unavailable'||!limits||lakeCU>limits.fixedMax){r.rate=null;r.status='unavailable';}return r;
      };
      add('lakebase','Lakebase · '+(qualified?'Always-On minimum':lakeMode??'capacity unverified'),(lakeCU??0)*(h-initialHours)*replicas,'CU-h',lakeRate(qualified),`${lakeCU??'?'} CU × ${h-initialHours} h × ${replicas} compute(s); ${limits?.ramGB??'?'} GB RAM/CU; ${qualified?'qualified Always-On minimum':'autoscaling rate during active hours'}`);
      if(initialHours)add('lakebase_startup','Lakebase · first 24 h qualification',(lakeCU??0)*initialHours*replicas,'CU-h',lakeRate(false),`${lakeCU??'?'} CU × 24 h × ${replicas} compute(s) at the autoscaling rate before Always-On qualification`);
      if(qualified)notes.push(initialHours?'First month: 24 h at the autoscaling rate, then 706 h at the Always-On minimum rate.':'Steady state: scale to zero is disabled and the held capacity has qualified for Always-On pricing after 24 continuous hours. Select First month to include that qualification period.');
      add('lakebase_storage','Lakebase · database storage',s.databaseGB,'GB-mo',lookup(data,s,'lakebase_storage'),`${s.databaseGB} GB provisioned average database size`,'storage',false);
      notes.push('Lakebase sizes are 0.5 CU, then integers. This estimate holds the recommended capacity while active; it does not predict average autoscaling consumption. HA adds one equal secondary. PITR and snapshots are excluded.');
      if(limits)notes.push(`Autoscaling is limited to ${limits.autoMax} CU with a maximum ${limits.band} CU min/max spread; larger sizes to ${limits.fixedMax} CU are fixed. The chosen size is a capacity target, not an autoscaling range.`);
      if(canSuspend&&s.schedule!=='always')notes.push('Scheduled Lakebase usage assumes scale to zero is configured for the idle period. Consumption during the idle timeout is excluded.');
      if(!canSuspend&&s.schedule!=='always')notes.push(`Lakebase is billed for 730 h: HA or capacity above ${limits?.suspendMax??32} CU prevents scale to zero. Business-hour savings are not assumed.`);
    }
    if(s.workloads.some(w=>['etl','stream','sql','ds'].includes(w))){
      const storage=(s.workloads.includes('sql')?s.storedTB*1000:s.gb*s.newDataPct/100*s.retention)*s.layers;
      add('storage','Lakehouse · retained storage',storage,'GB-mo',lookup(data,s,'storage'),s.workloads.includes('sql')?`${s.storedTB} TB retained dataset × 1000 × ${s.layers} layer/compression factor; includes processed data, no additional ingestion storage`:`${s.gb} GB/day × ${s.newDataPct}% net-new × ${s.retention} days × ${s.layers} retained-size factor; steady-state`,'storage',false);
    }
    if(s.extra>0)add('extra','Other monthly costs',1,'month',{rate:s.extra,status:'allowance',sourceRegion:s.region,sourceCloud:s.cloud},'Manual allowance for networking, support or other services','other',false);
    const complete=issues.length===0&&rows.every(r=>r.cost!==null),subtotal=rows.reduce((a,r)=>a+(r.cost??0),0),gross=rows.reduce((a,r)=>a+(r.gross??0),0),dbus=rows.filter(r=>r.unit==='DBU').reduce((a,r)=>a+r.qty,0);
    const fallback=rows.filter(r=>['region fallback','cloud benchmark','missing'].includes(r.status));
    return {state:s,rows,complete,total:complete?subtotal:null,subtotal,gross,savings:gross-subtotal,low:subtotal*(1-s.uncertainty/100),high:subtotal*(1+s.uncertainty/100),dbus,fallback,notes,issues,availabilityChecks,hours,sqlSize,clusters,lakeCU,lakeMode,lakeHours,storageGB:rows.filter(r=>r.unit==='GB-mo').reduce((a,r)=>a+r.qty,0)};
  }
  function rulesVersion(data){return JSON.stringify([data.availability?.checkedAt,data.lakebaseParameters]);}
  function sharedStates(raw,geo){const s=normalise(raw);return [s,...['AWS','Azure','GCP'].map(cloud=>cloudState(s,cloud,GEOS[geo][cloud]))];}
  function createSharedEstimate(raw,data,geo){
    if(!Object.hasOwn(GEOS,geo))throw new Error('Unknown comparison geography.');
    const keys=new Set(sharedStates(raw,geo).flatMap(s=>estimate(s,data).rows.map(r=>r.priceKey).filter(Boolean)));
    const quotes=[...keys].map(key=>{
      const [tier,cloud,region,sku,part]=key.split('|'),s={tier,cloud,region};
      const r=sku.startsWith('model:')?modelRate(data,{...s,model:sku.slice(6)},part):lookup(data,s,sku,Number(part));
      return [key,r.rate,r.status,r.sourceCloud,r.sourceRegion,r.sourceTier];
    });
    return {version:1,engine:VERSION,rules:rulesVersion(data),state:normalise(raw),geo,pricing:{snapshotDate:data.savedPricing?.snapshotDate??data.retrievedAt,refreshedAt:data.savedPricing?.refreshedAt??data.refreshedAt??null,quotes}};
  }
  function restoreSharedEstimate(payload,baseline){
    if(!payload||payload.version!==1||payload.engine!==VERSION||payload.rules!==rulesVersion(baseline))throw new Error('This saved estimate uses a different sizing version. Start a new estimate to use the current model.');
    const state=normalise(payload.state),geo=payload.geo;
    if(!Object.hasOwn(GEOS,geo)||!baseline.regions[state.cloud]?.includes(state.region))throw new Error('Invalid saved deployment or comparison geography.');
    const pricing=payload.pricing;
    if(!pricing||!/^\d{4}-\d{2}-\d{2}$/.test(pricing.snapshotDate)||!(pricing.refreshedAt===null||typeof pricing.refreshedAt==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(pricing.refreshedAt))||!Array.isArray(pricing.quotes)||pricing.quotes.length>100)throw new Error('Invalid saved pricing snapshot.');
    const expected=new Set(createSharedEstimate(state,baseline,geo).pricing.quotes.map(q=>q[0])),savedRates=Object.create(null);
    for(const q of pricing.quotes){
      if(!Array.isArray(q)||q.length!==6)throw new Error('Invalid saved rate.');
      const [key,rate,status,sourceCloud,sourceRegion,sourceTier]=q;
      if(!expected.has(key)||Object.hasOwn(savedRates,key)||!(rate===null||typeof rate==='number'&&Number.isFinite(rate)&&rate>=0&&rate<1e12)||!['exact','region fallback','cloud benchmark','missing'].includes(status)||!['AWS','Azure','GCP'].includes(sourceCloud)||!['premium','enterprise','model PAYG'].includes(sourceTier))throw new Error('Invalid saved rate.');
      if(status==='missing'?(rate!==null||!['No price available','No model price'].includes(sourceRegion)):(rate===null||!baseline.regions[sourceCloud].includes(sourceRegion)))throw new Error('Invalid saved rate provenance.');
      const sku=key.split('|')[3];savedRates[key]={rate,status,sourceCloud,sourceRegion,sourceTier,sku:sku.startsWith('model:')?sku.slice(6):sku,saved:true};
    }
    if(Object.keys(savedRates).length!==expected.size)throw new Error('The saved estimate is missing applied rates.');
    return {state,geo,data:{...baseline,savedRates,savedPricing:{snapshotDate:pricing.snapshotDate,refreshedAt:pricing.refreshedAt}}};
  }
  const api={VERSION,DEFAULTS,PRESETS,WORKLOADS,BOUNDS,QUERY_PROFILES,ANSWER_PROFILES,ANCHORS,GEOS,normalise,preset,cloudState,platformLevel,availability,priceKey,parseRate,lookup,modelRate,estimate,createSharedEstimate,restoreSharedEstimate};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Sizing=api;
})(typeof window!=='undefined'?window:globalThis);
