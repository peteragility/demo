'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const E=require('./engine.js'),data={...require('./pricing-snapshot.json'),availability:require('./availability.json'),lakebaseParameters:require('../lakebase-content/facts.json').parameters};
const approx=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('Lakebase uses qualified Always-On rates, first-month qualification and scheduled autoscaling separately',()=>{
  const s={...E.preset(E.DEFAULTS,'lakebase'),region:'US East (N. Virginia)',headroom:0,workingGB:2,databaseGB:0,lakebaseHA:true};
  const rates=structuredClone(data);rates.rates.premium.AWS.lakebase_aws_premium[s.region]='0.092';rates.rates.premium.AWS.lakebase_alwayson_aws_premium[s.region]='0.069';
  approx(E.estimate(s,rates).total,100.74);
  const first=E.estimate({...s,lakebaseBilling:'first-month'},rates);approx(first.total,2*(706*0.069+24*0.092));
  assert.equal(first.rows.find(r=>r.id==='lakebase_startup').qty,48);
  const scheduled=E.estimate({...s,lakebaseHA:false,schedule:'business'},rates);approx(scheduled.total,176*0.092);
  const restored=E.restoreSharedEstimate(E.createSharedEstimate({...s,lakebaseBilling:'first-month'},rates,'us'),data);
  approx(E.estimate(restored.state,restored.data).total,first.total);
});
test('presets price every cloud, with unsupported Lakebase regions explicitly incomplete',()=>{
  for(const cloud of ['AWS','Azure','GCP'])for(const id of Object.keys(E.PRESETS)){
    const s={...E.preset(E.DEFAULTS,id),cloud,region:E.GEOS.singapore[cloud]},x=E.estimate(s,data);
    const available=!s.workloads.includes('lakebase')||E.availability(data,s,'lakebase').status!=='unavailable';
    assert.equal(x.complete,available);assert.equal(x.fallback.length,0);
    if(available){assert.ok(x.total>0);approx(x.total,x.rows.reduce((n,r)=>n+r.cost,0));}else{assert.equal(x.total,null);assert.ok(x.issues.length);}
  }
});
test('all 76 cloud/region options retain price coverage without claiming unsupported availability',()=>{
  for(const cloud of ['AWS','Azure','GCP'])for(const region of data.regions[cloud])for(const tier of cloud==='Azure'?['premium']:['premium','enterprise']){
    const x=E.estimate({...E.DEFAULTS,cloud,region,tier,workloads:Object.keys(E.WORKLOADS)},data);
    const available=E.availability(data,{cloud,region},'lakebase').status!=='unavailable';
    assert.equal(x.complete,available,`${cloud}/${region}/${tier}`);assert.ok(x.fallback.every(r=>r.rate!==null));assert.ok(Number.isFinite(x.subtotal));
    if(!available)assert.equal(x.total,null);
  }
});
test('regional lookup uses exact, same-cloud anchor, then same-tier AWS benchmark',()=>{
  const d=structuredClone(data),s={...E.DEFAULTS,cloud:'GCP',region:'Asia (Singapore)'};
  assert.equal(E.lookup(d,s,'jobs_serverless').status,'exact');
  delete d.rates.premium.GCP.jobs_serverless[s.region];
  const region=E.lookup(d,s,'jobs_serverless');assert.equal(region.status,'region fallback');assert.equal(region.sourceRegion,E.ANCHORS.GCP);
  delete d.rates.premium.GCP.jobs_serverless;
  const cloud=E.lookup(d,s,'jobs_serverless');assert.equal(cloud.status,'cloud benchmark');assert.equal(cloud.rate,0.35);
  delete d.rates.premium.AWS.jobs_serverless;assert.equal(E.lookup(d,s,'jobs_serverless').rate,null);
});
test('missing prices make total incomplete instead of silently charging zero',()=>{
  const d=structuredClone(data);delete d.rates.premium.AWS.jobs_serverless;
  const x=E.estimate(E.preset(E.DEFAULTS,'batch'),d);assert.equal(x.complete,false);assert.equal(x.total,null);assert.ok(x.subtotal>0);
});
test('blank, invalid and pipe-separated rates are handled without free-price substitutions',()=>{
  for(const value of [undefined,null,'',' ','X','NaN',{},'Infinity','-1'])assert.equal(E.parseRate(value),null);
  assert.equal(E.parseRate('0'),0);assert.equal(E.parseRate('0.35|0.250',1),0.25);assert.equal(E.parseRate('0.35',1),null);
});
test('zero dollar and zero usage overrides are retained exactly',()=>{
  const x=E.estimate({...E.DEFAULTS,workloads:['etl'],gb:0,overrides:{etl:0},quantities:{etl:100}},data);
  assert.equal(x.total,0);assert.equal(x.rows[0].rate,0);assert.equal(x.rows[0].qty,100);assert.equal(x.rows[0].status,'override');
});
test('compute discounts do not reduce tokens, storage, or allowance lines',()=>{
  const s={...E.DEFAULTS,workloads:['etl','ai','lakebase'],extra:100},base=E.estimate(s,data),discount=E.estimate({...s,discount:25},data);
  for(const r of discount.rows){const before=base.rows.find(x=>x.id===r.id);approx(r.cost,before.cost*(r.discountable?0.75:1));}
});
test('token inputs and outputs use separate per-million rates and scale linearly',()=>{
  const s={...E.preset(E.DEFAULTS,'ai'),vectors:0};const x=E.estimate(s,data),double=E.estimate({...s,requests:s.requests*2},data);
  const days=730/24;approx(x.rows[0].cost,s.requests*days*s.inputTokens/1e6*0.19);approx(x.rows[1].cost,s.requests*days*s.outputTokens/1e6*0.75);approx(double.total,x.total*2);
});
test('Lakebase HA runs primary and secondary 24/7 without duplicating stored data',()=>{
  const s={...E.preset(E.DEFAULTS,'lakebase'),schedule:'business'},single=E.estimate(s,data),ha=E.estimate({...s,lakebaseHA:true},data);
  approx(ha.rows[0].qty,single.lakeCU*730*2);approx(ha.rows[1].cost,single.rows[1].cost);assert.ok(ha.rows[0].qty>single.rows[0].qty*2);
});
test('streaming remains 730 hours regardless of business-hours schedule',()=>{
  const s={...E.preset(E.DEFAULTS,'streaming'),workloads:['stream']};approx(E.estimate({...s,schedule:'always'},data).total,E.estimate({...s,schedule:'business'},data).total);
});
test('untrusted shared state is clamped and unknown fields are discarded',()=>{
  const x=E.normalise(JSON.parse('{"cloud":"oops","gb":-1,"discount":150,"workloads":["etl","<script>"],"overrides":{"__proto__":1,"etl":0},"prototype":"x","scientists":"NaN"}'));
  assert.equal(x.cloud,'AWS');assert.equal(x.gb,0);assert.equal(x.discount,90);assert.deepEqual(x.workloads,['etl']);assert.equal(x.prototype,undefined);assert.equal(x.overrides.etl,0);assert.equal(Object.hasOwn(x.overrides,'__proto__'),false);
});
test('Lakebase availability is independent of exact prices and survives manual overrides',()=>{
  const s={...E.preset(E.DEFAULTS,'lakebase'),cloud:'GCP',region:'Asia (Singapore)'};
  assert.equal(E.lookup(data,s,'lakebase_gcp_premium').status,'exact');
  const x=E.estimate({...s,overrides:{lakebase:0}},data);
  assert.equal(x.complete,false);assert.equal(x.total,null);assert.equal(x.availabilityChecks[0].status,'unavailable');
  assert.match(x.issues[0],/not listed as available/);
  for(const region of ['US (Virginia)','US (Iowa)','Europe (Frankfurt)']){
    const beta=E.estimate({...s,region},data);assert.equal(beta.complete,true);assert.equal(beta.availabilityChecks[0].status,'beta');
  }
});
test('availability lists use selectable pricing region names and cite their sources',()=>{
  for(const [cloud,entry]of Object.entries(data.availability.lakebase)){
    assert.ok(entry.source.startsWith('https://'));for(const region of entry.regions)assert.ok(data.regions[cloud].includes(region),cloud+'/'+region);
  }
});
test('Lakebase uses deployable increments, shared limits, and explicit excess-capacity errors',()=>{
  const s=E.preset(E.DEFAULTS,'lakebase');
  assert.equal(E.estimate({...s,workingGB:0.5,headroom:0},data).lakeCU,0.5);
  assert.equal(E.estimate({...s,workingGB:4,headroom:20},data).lakeCU,3);
  const fixed=E.estimate({...s,workingGB:180,headroom:20},data);
  assert.equal(fixed.lakeCU,108);assert.equal(fixed.lakeMode,'fixed capacity');assert.equal(fixed.complete,true);
  const max=E.estimate({...s,workingGB:224,headroom:0},data);assert.equal(max.lakeCU,112);assert.equal(max.complete,true);
  const excess=E.estimate({...s,workingGB:200,headroom:20,overrides:{lakebase:1},quantities:{lakebase:1}},data);
  assert.equal(excess.lakeCU,120);assert.equal(excess.complete,false);assert.equal(excess.total,null);assert.match(excess.issues.join(' '),/120 CU.*112 CU/);
});
test('Lakebase above the suspend limit is billed 730 hours despite a business schedule',()=>{
  const s={...E.preset(E.DEFAULTS,'lakebase'),schedule:'business',headroom:0};
  assert.equal(E.estimate({...s,workingGB:64},data).lakeHours,176);
  const large=E.estimate({...s,workingGB:66},data);assert.equal(large.lakeHours,730);assert.match(large.notes.join(' '),/prevents scale to zero/);
  const missing={...data,lakebaseParameters:undefined};assert.equal(E.estimate(s,missing).complete,false);
});
test('cloud switches preserve the AWS/GCP plan through Azure and disclose unequal tiers',()=>{
  for(const tier of ['premium','enterprise']){
    const aws=E.normalise({...E.DEFAULTS,tier}),azure=E.cloudState(aws,'Azure',E.GEOS.singapore.Azure),back=E.cloudState(azure,'AWS',E.GEOS.singapore.AWS),gcp=E.cloudState(azure,'GCP',E.GEOS.singapore.GCP);
    assert.equal(azure.tier,'premium');assert.equal(azure.platformTier,tier);assert.equal(back.tier,tier);assert.equal(gcp.tier,tier);
    assert.equal(E.platformLevel(azure)===E.platformLevel(aws),tier==='enterprise');
    approx(E.estimate(back,data).total,E.estimate(aws,data).total);
  }
});
test('SQL size and storage respond to retained data and query profile, independently of ingestion',()=>{
  const s=E.preset(E.DEFAULTS,'bi'),base=E.estimate(s,data),moreIngest=E.estimate({...s,gb:1000000},data),large=E.estimate({...s,storedTB:1000},data),heavy=E.estimate({...s,queryProfile:'heavy'},data);
  approx(base.total,moreIngest.total);assert.ok(large.total>base.total);assert.ok(heavy.rows.find(r=>r.id==='sql').cost>base.rows.find(r=>r.id==='sql').cost);
  approx(base.rows.find(r=>r.id==='storage').qty,s.storedTB*1000*s.layers);
  const batch={...E.preset(E.DEFAULTS,'batch'),newDataPct:10};
  approx(E.estimate(batch,data).rows.find(r=>r.id==='storage').qty,batch.gb*0.1*batch.retention*batch.layers);
  approx(E.estimate({...s,gb:0},data).rows.find(r=>r.id==='storage').qty,13500);
});
test('batch completion window changes throughput guidance without inventing extra consumption',()=>{
  const s=E.preset(E.DEFAULTS,'batch'),short=E.estimate({...s,batchHours:1},data),long=E.estimate({...s,batchHours:8},data);
  approx(short.total,long.total);assert.notEqual(short.notes[1],long.notes[1]);
});
test('saved estimates preserve refreshed rates, tier preferences and comparison geography after reload',()=>{
  const live=structuredClone(data);live.rates.enterprise.AWS.jobs_serverless['US East (N. Virginia)']='1.25';live.refreshedAt='2026-10-17T01:23:45.000Z';
  const s={...E.DEFAULTS,tier:'enterprise',region:E.GEOS.us.AWS},before=E.estimate(s,live);
  const payload=JSON.parse(JSON.stringify(E.createSharedEstimate(s,live,'us'))),restored=E.restoreSharedEstimate(payload,data);
  assert.equal(restored.geo,'us');assert.equal(restored.state.tier,'enterprise');assert.equal(restored.data.savedPricing.refreshedAt,live.refreshedAt);
  approx(E.estimate(restored.state,restored.data).total,before.total);assert.notEqual(before.total,E.estimate(s,data).total);
  for(const cloud of ['AWS','Azure','GCP']){
    const c=E.cloudState(s,cloud,E.GEOS.us[cloud]);approx(E.estimate(c,restored.data).total,E.estimate(c,live).total);
  }
  const again=E.restoreSharedEstimate(E.createSharedEstimate(restored.state,restored.data,restored.geo),data);
  approx(E.estimate(again.state,again.data).total,before.total);
});
test('saved fallback and missing prices retain provenance instead of becoming exact or free',()=>{
  const d=structuredClone(data);delete d.rates.premium.AWS.jobs_serverless;
  const s=E.preset(E.DEFAULTS,'batch'),restored=E.restoreSharedEstimate(E.createSharedEstimate(s,d,'singapore'),data),x=E.estimate(restored.state,restored.data);
  assert.equal(x.complete,false);assert.equal(x.rows[0].status,'missing');assert.equal(x.rows[0].rate,null);
  const gcp={...s,cloud:'GCP',region:E.GEOS.singapore.GCP};delete d.rates.premium.GCP.jobs_serverless[gcp.region];
  const fallback=E.restoreSharedEstimate(E.createSharedEstimate(gcp,d,'singapore'),data);
  assert.equal(E.estimate(fallback.state,fallback.data).rows[0].status,'region fallback');
});
test('all workload rates and manual overrides round-trip through a saved estimate',()=>{
  const s={...E.DEFAULTS,workloads:Object.keys(E.WORKLOADS),region:E.GEOS.us.AWS,overrides:{etl:0.9},quantities:{sql:999},extra:100};
  const before=E.estimate(s,data),payload=E.createSharedEstimate(s,data,'europe');
  const restored=E.restoreSharedEstimate(JSON.parse(JSON.stringify(payload)),data),after=E.estimate(restored.state,restored.data);
  assert.ok(encodeURIComponent(JSON.stringify(payload)).length<100000);assert.equal(before.complete,true);assert.equal(after.complete,true);
  approx(after.total,before.total);
  for(const row of before.rows){const saved=after.rows.find(r=>r.id===row.id);approx(saved.cost,row.cost);assert.equal(saved.rate,row.rate);}
  assert.equal(restored.state.quantities.sql,999);assert.equal(restored.state.overrides.etl,0.9);
  const newer={...data,retrievedAt:'2026-10-18'},again=E.restoreSharedEstimate(payload,newer);
  assert.equal(E.createSharedEstimate(again.state,again.data,again.geo).pricing.snapshotDate,'2026-10-17');
});
test('saved estimate validation rejects tampered rates, unsafe fields and incompatible versions',()=>{
  const payload=E.createSharedEstimate(E.DEFAULTS,data,'singapore');
  for(const mutate of [p=>p.engine='old',p=>p.rules='old',p=>p.geo='__proto__',p=>p.pricing.quotes[0][0]='__proto__',p=>p.pricing.quotes[0][1]=-1,p=>p.pricing.quotes[0][2]='<img>',p=>p.pricing.quotes[0][4]='<svg onload=alert(1)>',p=>p.pricing.quotes.pop(),p=>p.pricing.quotes.push(p.pricing.quotes[0])]){
    const bad=structuredClone(payload);mutate(bad);assert.throws(()=>E.restoreSharedEstimate(bad,data));
  }
  const valid=E.restoreSharedEstimate(payload,data);assert.equal(Object.getPrototypeOf(valid.data.savedRates),null);assert.equal({}.polluted,undefined);
});
