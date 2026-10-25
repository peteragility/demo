const {test}=require('node:test'),assert=require('node:assert/strict'),M=require('./model.js'),data=require('./data.json');
const now=Date.parse('2026-10-23T06:00:00Z');
const base={id:'CVE-2026-1234',product:'Example',title:'Example issue',description:'Memory corruption',action:'Update runtime',layer:'runtime',published:'2026-10-21',sources:[{label:'Vendor',url:'https://vendor.test/advisory'}],cvss:{score:9.3},affected:[],fixed:[]};
test('timestamp events use Hong Kong dates at current/archive boundaries',()=>{
 for(const value of ['2026-09-23T18:00:00Z','2026-09-23T18:00:00','2026-09-24T02:00:00+08:00']){
  assert.equal(M.event({...base,published:value},'2026-10-23').date,'2026-09-24');
  assert.equal(M.select([{...base,published:value}],{},now).length,1);
 }
 assert.equal(M.select([{...base,published:'2026-09-23'}],{view:'archive'},now).length,1);
});
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
test('generic priority rules depend only on evidence, not identity or editorial flags',()=>{
 const evidence=text=>({text,url:'https://vendor.test/advisory'});
 const vector='CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
 const trust={...base,id:'a',cvss:null,urgent:true,ranking_evidence:evidence('Compromised code-signing keys allow forged software updates.')};
 const remote={...base,id:'b',cvss:{score:9.2,vector}};
 const numeric={...base,id:'c',cvss:{score:10}};
 const exploited={...base,id:'d',cvss:{score:9.8},kev:true,kev_added:'2026-10-21'};
 assert.deepEqual(M.select([numeric,remote,exploited,trust],{},now).map(r=>r.id),['a','d','b','c']);
 assert.deepEqual(M.select([numeric,remote,exploited,trust],{sort:'cvss'},now).map(r=>r.id),['c','d','b','a']);
 for(const r of [trust,remote,numeric,exploited]){
  const changed={...r,id:'unrelated-id',product:'Unrelated vendor',layer:'identity',title:'New headline',description:'Editorial replacement',urgent:!r.urgent,impact_scope:{level:'ecosystem'}};
  assert.deepEqual(M.priority(changed),M.priority(r));
 }
 assert.equal(M.priority({...numeric,urgent:true,impact_scope:{level:'ecosystem'}}).tier,3);
 assert.equal(M.priority({...trust,ranking_evidence:undefined}).tier,3);
 assert.equal(M.select([{...trust,published:'2020-01-01'}],{},now).length,0);
});
test('advisory text signal rejects hypothetical or negated compromise and ordinary leaked app keys',()=>{
 for(const sample of require('./ranking-fixtures.json')){
  const r={...base,cvss:null,ranking_evidence:{text:sample.text,url:'https://vendor.test/advisory'}};
  assert.equal(M.systemicSignal(r)?.kind??null,sample.signal,sample.text);
  assert.equal(Boolean(M.highRisk(r)),Boolean(sample.signal),'automatic eligibility without a manual urgent flag');
 }
 for(const text of ['No compromised CA keys were found.','CA keys might be compromised.','The package registry was not compromised.','Previously compromised code-signing keys were remediated.','Compromised application keys were found.']){
  assert.equal(M.systemicSignal({...base,ranking_evidence:{text,url:'https://vendor.test/advisory'}}),null,text);
 }
 for(const text of ['Compromised CA keys allow certificate forgery.','The code-signing keys were stolen.','A compromised package registry distributed tampered builds.','Malicious software updates were distributed to customers.']){
  assert.ok(M.systemicSignal({...base,ranking_evidence:{text,url:'https://vendor.test/advisory'}}),text);
 }
 assert.equal(M.systemicSignal({...base,ranking_evidence:{text:'Compromised CA keys',url:'javascript:alert(1)'}}),null);
});
test('remote attack promotion requires all vector prerequisites, not a guessed default',()=>{
 const vector='CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
 assert.equal(M.remoteUnauthenticated({...base,cvss:{score:9.3,vector}}),true);
 for(const other of [undefined,vector.replace('AV:N','AV:L'),vector.replace('AC:L','AC:H'),vector.replace('PR:N','PR:L'),vector.replace('UI:N','UI:R'),'CVSS:4.0/AV:N/AC:L/PR:N/UI:N/AT:P','CVSS:4.0/AV:N/AC:L/PR:N/UI:N']){
  assert.equal(M.remoteUnauthenticated({...base,cvss:{score:9.3,vector:other}}),false);
 }
 assert.equal(M.remoteUnauthenticated({...base,cvss:{score:9.3,vector:'CVSS:4.0/AV:N/AC:L/PR:N/UI:N/AT:N'}}),true);
});
test('category filtering composes with dates, search and ranking in both periods',()=>{
 const rows=[base,{...base,id:'ca',layer:'trust',urgent:true,cvss:null},{...base,id:'archived-ca',layer:'trust',published:'2026-08-01'}];
 assert.equal(M.select(rows,{layer:'all'},now).length,2);
 assert.deepEqual(M.select(rows,{layer:'trust'},now).map(r=>r.id),['ca']);
 assert.equal(M.select(rows,{layer:'runtime',q:'no match'},now).length,0);
 assert.deepEqual(M.select(rows,{layer:'trust',view:'archive'},now).map(r=>r.id),['archived-ca']);
 assert.equal(M.select(rows,{layer:'edge'},now).length,0);
});
