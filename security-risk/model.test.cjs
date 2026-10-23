const {test}=require('node:test'),assert=require('node:assert/strict'),M=require('./model.js'),data=require('./data.json');
const now=Date.parse('2026-10-23T06:00:00Z');
const base={id:'CVE-2026-1234',product:'Example',title:'Example issue',description:'Memory corruption',action:'Update runtime',layer:'runtime',published:'2026-10-21',sources:[{label:'Vendor',url:'https://vendor.test/advisory'}],cvss:{score:9.3},affected:[],fixed:[]};
test('30-day view and six-calendar-month archive have non-overlapping boundaries',()=>{
 assert.deepEqual(M.windows(now),{today:'2026-10-23',current:'2026-09-24',archive:'2026-04-23'});
 const records=['2026-10-23','2026-09-24','2026-09-23','2026-04-23','2026-04-22','2026-10-24'].map((published,i)=>({...base,id:'risk-'+i,published}));
 assert.deepEqual(M.select(records,{},now).map(r=>r.id),['risk-0','risk-1']);
 assert.deepEqual(M.select(records,{view:'archive'},now).map(r=>r.id),['risk-2','risk-3']);
 assert.equal(M.windows(Date.parse('2026-08-31T06:00:00Z')).archive,'2026-02-28');
 assert.equal(M.windows(Date.parse('2026-10-23T18:00:00Z')).today,'2026-10-24');
});
test('high risk includes 7+, KEV and urgent unscored CA incidents, excludes low and rejected',()=>{
 const records=[base,{...base,id:'low',cvss:{score:6.9}},{...base,id:'high',cvss:{score:7}},{...base,id:'kev',cvss:null,kev:true,kev_added:'2026-10-22'},{...base,id:'ca',cvss:null,urgent:true,kind:'incident'},{...base,id:'rejected',rejected:true}];
 assert.deepEqual(M.select(records,{},now).map(r=>r.id),[base.id,'high','kev','ca']);
});
test('date is latest genuine event, never check/import date; new KEV brings older CVEs into current view',()=>{
 const old={...base,published:'2020-01-01',checked_at:'2026-10-23',changed_at:'2026-10-23'};
 assert.equal(M.select([old],{},now).length,0);
 const kev={...old,kev:true,kev_added:'2026-10-20'};
 assert.equal(M.select([kev],{},now).length,1);assert.equal(M.event(kev,'2026-10-23').label,'Added to KEV');
 assert.equal(M.select([{...old,material_updated_at:'2026-10-22'}],{},now).length,1);
 assert.equal(M.event({...base,advisory_published_at:'2026-10-20'},'2026-10-23').date,'2026-10-20');
});
test('search includes summaries and actions; safe URL and snapshot validation reject unsafe inputs',()=>{
 assert.equal(M.select([base],{q:'update runtime'},now).length,1);
 assert.equal(M.select([base],{q:'not deployed'},now).length,0);
 for(const url of ['javascript:alert(1)','data:text/html,x','http://example.test','https://user:pass@example.test','https://[bad'])assert.equal(M.safeURL(url),null);
 assert.equal(M.safeURL('https://vendor.test/a'),'https://vendor.test/a');
 assert.equal(M.validate({...data,records:[]}).records.length,0);
 assert.throws(()=>M.validate({...data,records:[{...base,id:'bad"onclick="x'}]}));
});
