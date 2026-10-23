const {test} = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model.js');
const data = require('./data.json');
const r = {id:'CVE-2026-1234', product:'Example PHP', title:'Critical fix', description:'', affected:[], layer:'runtime', priority:0, revision:'new', published:'2026-10-21', changed_at:'2026-10-23T01:00:00Z', kev:true};

test('closed assessments need evidence or a reason and all verification steps', () => {
  assert.equal(M.assessment({status:'fixed', steps:[true,true,true,true]}).status,'assess');
  assert.equal(M.assessment({status:'fixed', evidence:'ticket/42', steps:[true,true,false,true]}).status,'assess');
  assert.equal(M.assessment({status:'fixed', evidence:'ticket/42', steps:[true,true,true,true]}).status,'fixed');
  assert.equal(M.assessment({status:'na', note:'  '}).status,'assess');
  assert.equal(M.assessment({status:'na', note:'No deployed PHP'}).status,'na');
});
test('material changes reopen prior decisions, including imported N/A and mitigations', () => {
  for (const status of ['fixed','na','mitigated','affected']) {
    assert.equal(M.effective(r,{revision:'old',status}),'assess');
    assert.equal(M.reassess(r,{revision:'old',status}),true);
  }
  assert.equal(M.effective(r,{revision:'new',status:'fixed'}),'fixed');
});
test('import only accepts known IDs, enum statuses and bounded text without prototype mutation', () => {
  const raw=JSON.parse('{"__proto__":{"polluted":true},"unknown":{"status":"fixed"},"CVE-2026-1234":{"status":"<script>","owner":"'+ 'x'.repeat(180)+'","note":"<img src=x onerror=alert(1)>"}}');
  const result=M.progress(raw,[r]);
  assert.equal(Object.getPrototypeOf(result),null);
  assert.deepEqual(Object.keys(result),[r.id]);
  assert.equal(result[r.id].status,'assess');
  assert.equal(result[r.id].owner.length,120);
  assert.equal(result[r.id].note,'<img src=x onerror=alert(1)>');
  assert.equal({}.polluted,undefined);
});
test('source URLs block script, data, credentials and malformed URLs', () => {
  for(const value of ['javascript:alert(1)','data:text/html,<script>','http://example.test','//evil.test','https://user:pass@example.test','https://[bad']) assert.equal(M.safeURL(value),null);
  assert.equal(M.safeURL('https://www.php.net/archive/2026.php#x'),'https://www.php.net/archive/2026.php#x');
});
test('filtering combines layers, owners, changed view and assessment status', () => {
  const other={...r,id:'other',layer:'delivery',product:'GitLab',priority:1,kev:false};
  const saved={[r.id]:{status:'fixed',revision:'new',owner:'Ops'}};
  const pref={layer:'all',view:'open',q:'',sort:'risk'};
  assert.deepEqual(M.select([other,r],pref,saved,'').map(x=>x.id),['other']);
  assert.deepEqual(M.select([other,r],{...pref,view:'all',q:'ops'},saved,'').map(x=>x.id),[r.id]);
  assert.equal(M.select([other,r],{...pref,view:'changed'},saved,'2026-10-23T02:00:00Z').length,0);
  assert.equal(M.select([other,r],{...pref,view:'exploited'},saved,'').length,1);
  assert.equal(M.select([other,r],{...pref,view:'all',layer:'runtime'},saved,'').length,1);
});
test('snapshot validates, covers all six layers and contains the requested current issues', () => {
  assert.equal(M.validate(data),data);
  assert.equal(new Set(data.records.map(r=>r.layer)).size,6);
  for(const id of ['CVE-2026-109618','CVE-2026-111497','CVE-2026-110264','emudhra-ca-2026-10']) assert.ok(data.records.find(r=>r.id===id),id);
  const bad=structuredClone(data);bad.records[0].id='bad" onclick="x';assert.throws(()=>M.validate(bad));
});
test('change windows and freshness use real timestamps; missing data stays unknown', () => {
  const now=Date.parse('2026-10-23T12:00:00Z');
  assert.equal(M.isChanged(r,'',now),true);
  assert.equal(M.isChanged({...r,changed_at:'2026-10-21T01:00:00Z'},'',now),false);
  assert.equal(M.ageHours('',now),Infinity);
  assert.equal(M.ageHours('2026-10-21T12:00:00Z',now),48);
});
test('CVSS sort uses published severity, preserves zero and leaves unknown scores last', () => {
  const rows=[{...r,id:'unknown',cvss:null},{...r,id:'zero',cvss:{score:0}},{...r,id:'critical',cvss:{score:10},priority:1},{...r,id:'high',cvss:{score:9.3}}];
  assert.deepEqual(M.select(rows,{layer:'all',view:'all',q:'',sort:'cvss'},{},'').map(r=>r.id),['critical','high','zero','unknown']);
});
test('recent advisories group related CVEs, include unscored CA incidents and ignore check dates', () => {
  const now=Date.parse('2026-10-23T12:00:00Z');
  const base={...r, sources:[{label:'Vendor notice',url:'https://vendor.test/releases/october'}],cvss:{score:9.3},action:'Update the runtime',published:'2026-10-22',advisory_published_at:'2026-10-21',kev:false};
  const ca={...base,id:'ca',product:'CA',kind:'incident',cvss:null,urgent:true,published:'2026-10-20',advisory_published_at:'2026-10-20',sources:[{label:'CA notice',url:'https://vendor.test/ca'}]};
  const old={...base,id:'old',published:'2020-01-01',advisory_published_at:'2020-01-01',changed_at:'2026-10-23',checked_at:'2026-10-23',sources:[{label:'Vendor notice',url:'https://vendor.test/old'}]};
  const low={...base,id:'low',cvss:{score:3},sources:[{label:'Vendor notice',url:'https://vendor.test/low'}]};
  const groups=M.recent([base,{...base,id:'CVE-2026-2345',cvss:{score:10}},ca,old,low],now);
  assert.equal(groups.length,2);assert.equal(groups[0].records.length,2);assert.equal(groups[0].score,10);
  assert.equal(groups[0].event.date,'2026-10-21','official advisory date precedes CNA publication');
  assert.equal(groups[1].representative.id,'ca');assert.equal(groups[1].score,null);
  assert.equal(M.recent([{...old,material_updated_at:'2026-10-23T01:00:00Z'}],now)[0].event.label,'Advisory updated');
  assert.equal(M.recent([{...base,published:'2030-01-01',advisory_published_at:'2030-01-01'}],now).length,0);
});
test('recent KEV alerts can escalate old flaws without merging catalog records', () => {
  const now=Date.parse('2026-10-23T12:00:00Z');
  const old={...r,published:'2020-01-01',changed_at:'2026-10-23',kev_added:'2026-10-22',sources:[{label:'CISA KEV',url:'https://www.cisa.gov/known-exploited-vulnerabilities-catalog'}]};
  const groups=M.recent([old,{...old,id:'CVE-2026-2345'}],now);
  assert.equal(groups.length,2);assert.equal(groups[0].event.label,'Added to KEV');
  assert.equal(M.recent([{...old,kev:false}],now).length,0);
  assert.equal(M.recent([{...old,rejected:true}],now).length,0);
  assert.equal(M.select([old,{...old,id:'other'}],{layer:'all',view:'all',sort:'cvss',ids:[old.id]},{},'').length,1);
  const shared={label:'CNA reference · raw.githubusercontent.com',url:'https://raw.githubusercontent.com/cisagov/CSAF/develop/csaf_files/IT/white/2026/va-26-266-01.json'};
  const related=M.recent([{...old,sources:[shared]},{...old,id:'CVE-2026-2345',sources:[shared]}],now);
  assert.equal(related.length,1);assert.equal(related[0].cves,2);
  const ca={...old,id:'ca',urgent:true,kev:false,cvss:null,kind:'incident',published:'2026-10-22',sources:[{label:'Vendor',url:'https://vendor.test/ca'}]};
  assert.equal(M.recent([old,ca],now)[0].representative.id,'ca','urgent unscored incidents remain visible among equally recent alerts');
});
