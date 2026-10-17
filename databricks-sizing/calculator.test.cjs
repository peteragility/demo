'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const E=require('./engine.js'),data=require('./pricing-snapshot.json');
const approx=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('six presets across every cloud return itemized, finite estimates',()=>{
  for(const cloud of ['AWS','Azure','GCP'])for(const id of Object.keys(E.PRESETS)){
    const s={...E.preset(E.DEFAULTS,id),cloud,region:E.GEOS.singapore[cloud]},x=E.estimate(s,data);
    assert.equal(x.complete,true);assert.equal(x.fallback.length,0);assert.ok(x.total>0);approx(x.total,x.rows.reduce((n,r)=>n+r.cost,0));
  }
});
test('all 76 selectable cloud/region combinations avoid missing and NaN prices',()=>{
  for(const cloud of ['AWS','Azure','GCP'])for(const region of data.regions[cloud])for(const tier of cloud==='Azure'?['premium']:['premium','enterprise']){
    const x=E.estimate({...E.DEFAULTS,cloud,region,tier,workloads:Object.keys(E.WORKLOADS)},data);
    assert.equal(x.complete,true,`${cloud}/${region}/${tier}`);assert.ok(Number.isFinite(x.total));
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
