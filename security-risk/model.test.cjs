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
