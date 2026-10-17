(function (root) {
  'use strict';
  const ANCHORS = {AWS:'US East (N. Virginia)',Azure:'US East',GCP:'US (Iowa)'};
  const GEOS = {singapore:{AWS:'AP (Singapore)',Azure:'Asia Southeast',GCP:'Asia (Singapore)'},us:{...ANCHORS},europe:{AWS:'Europe (Frankfurt)',Azure:'Germany West Central',GCP:'Europe (Frankfurt)'},sydney:{AWS:'AP (Sydney)',Azure:'Australia East',GCP:'Australia (Sydney)'},tokyo:{AWS:'AP (Tokyo)',Azure:'Japan East',GCP:'Asia (Tokyo)'}};
  const PRESETS = {
    lakehouse:{name:'Lakehouse + BI',description:'Daily ingestion, transformations and dashboards.',workloads:['etl','sql'],gb:100,concurrency:10,retention:90,schedule:'business',complexity:'standard'},
    batch:{name:'Batch data engineering',description:'Scheduled ETL and a governed data lake.',workloads:['etl'],gb:500,retention:90,schedule:'business',complexity:'standard'},
    streaming:{name:'Real-time analytics',description:'Continuous pipelines with live SQL analytics.',workloads:['stream','sql'],gb:250,concurrency:20,retention:30,schedule:'always',complexity:'standard'},
    ai:{name:'GenAI / RAG',description:'Token-based inference with an AI Search index.',workloads:['ai'],requests:10000,vectors:1,gb:0,retention:30,schedule:'always',complexity:'standard'},
    science:{name:'Data science',description:'CPU notebooks and experimentation for a team.',workloads:['ds'],scientists:5,gb:20,retention:90,schedule:'business',complexity:'standard'},
    lakebase:{name:'Lakebase application',description:'Autoscaling Postgres for an operational app.',workloads:['lakebase'],databaseGB:100,workingGB:4,gb:0,retention:30,schedule:'always',complexity:'standard'}
  };
  const WORKLOADS={etl:'Batch ETL',stream:'Streaming',sql:'BI / SQL',ds:'Data science',ai:'GenAI / RAG',lakebase:'Lakebase'};
  const DEFAULTS={scenario:'lakehouse',cloud:'AWS',region:'AP (Singapore)',tier:'premium',workloads:['etl','sql'],gb:100,retention:90,concurrency:10,schedule:'business',complexity:'standard',scientists:5,requests:10000,vectors:1,model:'GPT OSS 120B',inputTokens:2000,outputTokens:500,databaseGB:100,workingGB:4,sqlUtil:60,etlFactor:0.2,streamDBU:2,dsDBU:4,dsHours:4,layers:1.5,headroom:20,discount:0,uncertainty:35,extra:0,lakebaseHA:false,overrides:{},quantities:{}};
  const BOUNDS={gb:[0,10000000],retention:[1,3650],concurrency:[1,100000],scientists:[1,10000],requests:[0,1e9],vectors:[0,10000],inputTokens:[1,2000000],outputTokens:[1,2000000],databaseGB:[0,1e8],workingGB:[0.5,224],sqlUtil:[1,100],etlFactor:[0.001,100],streamDBU:[0.1,100000],dsDBU:[0.1,1000],dsHours:[0.1,24],layers:[0.1,10],headroom:[0,200],discount:[0,90],uncertainty:[0,90],extra:[0,1e9]};
  function normalise(raw={}) {
    const s={...DEFAULTS,workloads:[...DEFAULTS.workloads],overrides:{},quantities:{}};
    for(const [key,[min,max]] of Object.entries(BOUNDS)) {const n=Number(raw[key]);if(raw[key]!==undefined&&raw[key]!==''&&Number.isFinite(n))s[key]=Math.max(min,Math.min(max,n));}
    for(const [key,allowed] of Object.entries({scenario:Object.keys(PRESETS),cloud:['AWS','Azure','GCP'],tier:['premium','enterprise'],schedule:['business','extended','always'],complexity:['simple','standard','complex'],model:['GPT OSS 120B','GPT OSS 20B','Llama 3.3 70B','Llama 4 Maverick']}))if(allowed.includes(raw[key]))s[key]=raw[key];
    if(typeof raw.region==='string'&&raw.region.length<100)s.region=raw.region;
    if(Array.isArray(raw.workloads)){const w=[...new Set(raw.workloads.filter(w=>Object.hasOwn(WORKLOADS,w)))];if(w.length)s.workloads=w;}
    s.lakebaseHA=raw.lakebaseHA===true;
    for(const field of ['overrides','quantities'])if(raw[field]&&typeof raw[field]==='object')for(const [k,v]of Object.entries(raw[field]))if(/^[a-z][a-z0-9_]{0,50}$/.test(k)&&typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<1e12)s[field][k]=v;
    if(s.cloud==='Azure')s.tier='premium';
    return s;
  }
  function preset(state,id){if(!Object.hasOwn(PRESETS,id))return normalise(state);return normalise({...state,...PRESETS[id],scenario:id,overrides:{},quantities:{},etlFactor:{simple:0.08,standard:0.2,complex:0.5}[PRESETS[id].complexity]});}
  function parseRate(v,part=0){if(typeof v!=='string'&&typeof v!=='number')return null;const p=String(v).split('|')[part];if(p===undefined||p.trim()==='')return null;const n=Number(p);return Number.isFinite(n)&&n>=0?n:null;}
  function lookup(data,state,sku,part=0) {
    const tier=state.cloud==='Azure'?'premium':state.tier;
    const exact=data?.rates?.[tier]?.[state.cloud]?.[sku];
    const candidates=[{table:exact,region:state.region,cloud:state.cloud,tier,status:'exact'},{table:exact,region:ANCHORS[state.cloud],cloud:state.cloud,tier,status:'region fallback'}];
    const awsSku=sku.replace(/_(azure|gcp)_/,'_aws_');
    candidates.push({table:data?.rates?.[tier]?.AWS?.[awsSku],region:ANCHORS.AWS,cloud:'AWS',tier,status:'cloud benchmark'});
    for(const c of candidates){const rate=parseRate(c.table?.[c.region],part);if(rate!==null)return {rate,status:c.status,sourceRegion:c.region,sourceCloud:c.cloud,sourceTier:c.tier,sku};}
    return {rate:null,status:'missing',sourceRegion:'No price available',sourceCloud:state.cloud,sourceTier:tier,sku};
  }
  function modelRate(data,s,part){
    for(const [cloud,region,status]of [[s.cloud,s.region,'exact'],[s.cloud,ANCHORS[s.cloud],'region fallback'],['AWS',ANCHORS.AWS,'cloud benchmark']]){
      const raw=data?.models?.[cloud]?.[s.model]?.[region];const n=parseRate(raw?.[part]);if(n!==null)return{rate:n,status,sourceCloud:cloud,sourceRegion:region,sourceTier:'model PAYG',sku:s.model};
    }
    return{rate:null,status:'missing',sourceCloud:s.cloud,sourceRegion:'No model price',sku:s.model};
  }
  function estimate(raw,data){
    const s=normalise(raw),rows=[],notes=[];const month=730,days=month/24;
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
    }
    if(s.workloads.includes('stream')){
      const rate=Math.max(s.streamDBU,s.gb/24*s.etlFactor)*complex*capacity;
      add('stream','Lakeflow Pipelines · serverless',rate*month,'DBU',lookup(data,s,'dlt_serverless'),`max(${s.streamDBU} baseline DBU/h, daily GB ÷ 24 × DBU/GB) × ${complex} complexity × ${capacity.toFixed(2)} headroom × 730 h`);
      notes.push('Streaming runs 24/7; the operating schedule only changes SQL, notebooks and non-HA Lakebase.');
    }
    const sizes=[['2X-Small',4],['X-Small',6],['Small',12],['Medium',24],['Large',40],['X-Large',80],['2X-Large',144],['3X-Large',272],['4X-Large',528]];
    const sqlIndex=Math.min(sizes.length-1,Math.max(0,Math.ceil(Math.log2(Math.max(1,s.gb*complex/100)))));
    const [sqlSize,sqlDBU]=sizes[sqlIndex];const clusters=Math.max(1,Math.ceil(s.concurrency/20));
    if(s.workloads.includes('sql')){
      add('sql',`SQL warehouse · ${sqlSize}`,sqlDBU*clusters*hours*s.sqlUtil/100*capacity,'DBU',lookup(data,s,'sql_serverless'),`${sqlDBU} DBU/h × ${clusters} cluster(s) × ${hours} h × ${s.sqlUtil}% active × ${capacity.toFixed(2)} headroom`);
      notes.push(`SQL assumes ${sqlSize}, ${clusters} average cluster(s) and 20 concurrent users per cluster for initial sizing; validate with query profiles.`);
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
    const lakeCU=Math.min(112,Math.max(0.5,Math.ceil(s.workingGB/2*capacity*2)/2));
    if(s.workloads.includes('lakebase')){
      const h=s.lakebaseHA?month:hours,replicas=s.lakebaseHA?2:1;
      add('lakebase','Lakebase · autoscaling',lakeCU*h*replicas,'CU-h',lookup(data,s,`lakebase_${s.cloud.toLowerCase()}_${s.tier}`),`${lakeCU} CU × ${h} h × ${replicas} compute(s); 2 GB RAM/CU; on-demand rate`);
      add('lakebase_storage','Lakebase · database storage',s.databaseGB,'GB-mo',lookup(data,s,'lakebase_storage'),`${s.databaseGB} GB provisioned average database size`,'storage',false);
      notes.push('Lakebase memory sizing is a working-set heuristic. HA includes one equal-size secondary, with compute running 24/7. PITR history and snapshots are excluded.');
    }
    if(s.gb>0&&s.workloads.some(w=>['etl','stream','sql','ds'].includes(w))){
      const storage=s.gb*s.retention*s.layers;
      add('storage','Lakehouse · retained storage',storage,'GB-mo',lookup(data,s,'storage'),`${s.gb} GB/day × ${s.retention} days × ${s.layers} retained-size factor; steady-state`,'storage',false);
    }
    if(s.extra>0)add('extra','Other monthly costs',1,'month',{rate:s.extra,status:'allowance',sourceRegion:s.region,sourceCloud:s.cloud},'Manual allowance for networking, support or other services','other',false);
    const complete=rows.every(r=>r.cost!==null),subtotal=rows.reduce((a,r)=>a+(r.cost??0),0),gross=rows.reduce((a,r)=>a+(r.gross??0),0),dbus=rows.filter(r=>r.unit==='DBU').reduce((a,r)=>a+r.qty,0);
    const fallback=rows.filter(r=>['region fallback','cloud benchmark','missing'].includes(r.status));
    return {state:s,rows,complete,total:complete?subtotal:null,subtotal,gross,savings:gross-subtotal,low:subtotal*(1-s.uncertainty/100),high:subtotal*(1+s.uncertainty/100),dbus,fallback,notes,hours,sqlSize,clusters,lakeCU,storageGB:rows.filter(r=>r.unit==='GB-mo').reduce((a,r)=>a+r.qty,0)};
  }
  const api={DEFAULTS,PRESETS,WORKLOADS,BOUNDS,ANCHORS,GEOS,normalise,preset,parseRate,lookup,modelRate,estimate};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Sizing=api;
})(typeof window!=='undefined'?window:globalThis);
