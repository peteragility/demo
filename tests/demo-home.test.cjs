const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname,'..');
const home = fs.readFileSync(path.join(root,'index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const loader = fs.readFileSync(path.join(root,'assets/site-analytics.js'),'utf8');
function homepage() {
  const context = vm.createContext({URL,Intl,location:{href:'https://example.test/demo/'},document:{readyState:'loading',getElementById:() => ({addEventListener(){}}),addEventListener(){}}});
  vm.runInContext(home,context);
  return expression => vm.runInContext(expression,context);
}
function analytics(code,hostname='localhost',counts={}) {
  const requests=[],scripts=[];
  const window={};
  const origin='https://'+hostname;
  const context=vm.createContext({URL,Map,Object,AbortSignal,location:{hostname,pathname:'/demo/lakebase-field-guide/index.html'},window,
    document:{currentScript:{src:origin+'/demo/assets/site-analytics.js'},referrer:'https://example.test/a?token=private#secret',head:{append:s=>scripts.push(s)},createElement:()=>({dataset:{}})},
    fetch:async url=>{
      requests.push(String(url));
      if (String(url).endsWith('analytics-config.json')) return {ok:true,json:async()=>({goatcounterSiteCode:code})};
      const pathname=decodeURIComponent(new URL(url).pathname.replace('/counter/','').replace(/\.json$/,''));
      if (!Object.hasOwn(counts,pathname)) return {ok:false,status:404};
      return {ok:true,json:async()=>({count:counts[pathname]})};
    }});
  vm.runInContext(loader,context);
  return {window,requests,scripts};
}
test('manifest strings render as text and paths/colors cannot inject HTML or external URLs',()=>{
  const run=homepage();
  for (const path of ['javascript:alert(1)','//evil.test/','https://evil.test/a','../x.html','foo/../../x.html','foo%2fbar/','foo/"onclick="evil','foo/?q=evil','foo\\bar/']) {
    assert.equal(run(`validPage(${JSON.stringify({path,title:'Bad'})})`),null,path);
  }
  const title='<img src=x onerror=alert(1)>';
  const valid=run(`validPage(${JSON.stringify({path:'safe/',title,desc:'<script>alert(1)</script>',color:'#fff;background:url(x)',category:'Tools'})})`);
  assert.equal(valid.title,title);
  assert.equal(valid.color,'#83c5ff');
  assert.doesNotMatch(home,/innerHTML|insertAdjacentHTML|localStorage/);
});
test('popularity ranks real counts descending, preserves zero, and keeps unavailable values last',()=>{
  const run=homepage();
  const rows=[{path:'z/',title:'Z',visits:100},{path:'a/',title:'A',visits:100},{path:'n/',title:'N',visits:null},{path:'b/',title:'B',visits:0}];
  assert.deepEqual(JSON.parse(run(`JSON.stringify(ordered(${JSON.stringify(rows)},'popular').map(p=>p.path))`)),['a/','z/','b/','n/']);
});
test('renamed pages keep visits recorded under earlier paths',()=>{
  const run=homepage();
  assert.equal(run(`JSON.stringify(validPage(${JSON.stringify({path:'new/',title:'New',aliases:['old/','old/','new/','../x.html',7]})}).aliases)`),'["old/"]');
  assert.equal(run(`validPage(${JSON.stringify({path:'plain/',title:'Plain'})}).aliases.length`),0);
  const page={path:'new/',aliases:['old/']};
  assert.equal(run(`totalVisits(${JSON.stringify(page)},new Map([['new/',3],['old/',40]]))`),43);
  assert.equal(run(`totalVisits(${JSON.stringify(page)},new Map([['new/',null],['old/',40]]))`),40);
  assert.equal(run(`totalVisits(${JSON.stringify(page)},new Map([['new/',0],['old/',null]]))`),0);
  assert.equal(run(`totalVisits(${JSON.stringify(page)},new Map([['new/',null],['old/',null]]))`),null);
});
test('featured ordering is editorial and alphabetical sorting stays independent of counts',()=>{
  const run=homepage(),rows=[{path:'z/',title:'Z',featured:true,visits:0},{path:'a/',title:'A',featured:false,visits:100}];
  assert.equal(run(`ordered(${JSON.stringify(rows)},'featured')[0].path`),'z/');
  assert.equal(run(`ordered(${JSON.stringify(rows)},'az')[0].path`),'a/');
});
test('source health distinguishes review, outages and overdue dates without inventing success',()=>{
  const run=homepage(),now='new Date("2026-10-25T06:00:00Z")';
  assert.equal(run(`healthLabel({status:'ok',lastSuccess:'2026-10-25'},${now}).warning`),false);
  assert.equal(run(`healthLabel({status:'ok',lastSuccess:'2026-10-20'},${now}).label`),'Source check overdue');
  assert.equal(run(`healthLabel({status:'partial',lastSuccess:'2026-10-24',checkedAt:'2026-10-25'},${now}).label`),'Source check incomplete');
  assert.equal(run(`healthLabel({status:'review',lastSuccess:'2026-10-25',review:2},${now}).label`),'2 source reviews needed');
  assert.equal(run(`healthLabel({status:'ok',lastSuccess:'<img>'},${now}).label`),'Source check overdue');
});
test('empty or unsafe analytics codes do not load third-party tracking',async()=>{
  for (const code of ['',null,'https://evil.test','x/../evil','a" onload="evil']) {
    const a=analytics(code,'peteragility.github.io');
    assert.equal(await a.window.demoAnalytics.ready,null);
    assert.equal(a.scripts.length,0);
    assert.equal(a.requests.length,1);
  }
});
test('tracking normalizes index paths and removes query/fragment data from referrers',async()=>{
  const a=analytics('demo-test','peteragility.github.io');
  const client=await a.window.demoAnalytics.ready;
  assert.equal(client.dashboard,'https://demo-test.goatcounter.com');
  assert.equal(a.scripts.length,1);
  assert.equal(a.scripts[0].dataset.goatcounter,client.dashboard+'/count');
  assert.equal(a.window.goatcounter.path,'/demo/lakebase-field-guide/');
  assert.equal(a.window.goatcounter.referrer(),'https://example.test/a');
});
test('public counters parse formatted counts; absent and malformed counts remain unavailable',async()=>{
  const a=analytics('demo-test','localhost',{'/demo/one/':'1,234','/demo/two/':0,'/demo/bad/':'<img>','/demo/huge/':'9999999999999999999'});
  const client=await a.window.demoAnalytics.ready;
  assert.equal(a.scripts.length,0,'local previews must not track');
  const counts=await client.visits(['one/index.html?x=1#q','two/','missing/','bad/','huge/']);
  assert.equal(counts.get('one/index.html?x=1#q'),1234);
  assert.equal(counts.get('two/'),0);
  for (const p of ['missing/','bad/','huge/']) assert.equal(counts.get(p),null);
  assert.ok(a.requests.some(r=>r.endsWith('/counter/%2Fdemo%2Fone%2F.json')));
});
test('every listed page and homepage include the shared tracker at a resolving local path',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  for (const entry of [{path:'index.html'},...manifest.pages]) {
    const file=path.join(root,entry.path.endsWith('/')?entry.path+'index.html':entry.path);
    const text=fs.readFileSync(file,'utf8');
    const script=text.match(/<script src="([^"]*site-analytics\.js)" defer><\/script>/);
    assert.ok(script,entry.path);
    assert.equal(path.resolve(path.dirname(file),script[1]),path.join(root,'assets/site-analytics.js'));
  }
});
test('vendor requests omit their separate query field and guard unavailable storage',async()=>{
  const a=analytics('demo-test','peteragility.github.io');
  await a.window.demoAnalytics.ready;
  const counter=a.window.goatcounter;
  let request;
  counter.get_data=()=>({p:counter.path,q:'?private=value'});
  counter.filter=()=>false;
  counter.count=()=>{if (!counter.filter()) request=counter.get_data();};
  a.scripts[0].onload();
  assert.equal(request.q,'');
  assert.equal(request.p,'/demo/lakebase-field-guide/');
  assert.equal(counter.no_onload,true);
  assert.equal(counter.no_events,true);
  const b=analytics('demo-test','peteragility.github.io');
  await b.window.demoAnalytics.ready;
  b.window.goatcounter.get_data=()=>({});
  b.window.goatcounter.filter=()=>{throw new Error('blocked storage');};
  b.window.goatcounter.count=()=>b.window.goatcounter.filter();
  assert.doesNotThrow(()=>b.scripts[0].onload());
  assert.equal(b.window.goatcounter.filter(),'browser storage unavailable');
});
test('personal reading and travel pages are absent from the public site and registry',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  for(const personal of ['tongjian/','penang-trip/']) {
    assert.equal(manifest.pages.some(p=>p.path.startsWith(personal)),false);
    assert.equal(fs.existsSync(path.join(root,personal)),false);
  }
  assert.equal(manifest.pages.some(p=>['Travel','Reading'].includes(p.category)),false);
  assert.equal(manifest.pages.filter(p=>p.category==='Guides').length>=2,true);
});
