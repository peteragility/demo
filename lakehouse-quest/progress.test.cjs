const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const P=require('./progress.js');
const html=fs.readFileSync(path.join(__dirname,'../lakehouse-quest.html'),'utf8');
const bank=html.match(/fetch\("(lakehouse-quest\/questions-v[^"/]+\.json)"/)[1];
const data=JSON.parse(fs.readFileSync(path.join(__dirname,'..',bank),'utf8'));
const parse=value=>P.parse(JSON.stringify(value),data),q=data.questions[0];
test('pasted and stored progress rejects HTML, malformed nesting and prototype keys',()=>{
  for(const patch of [{xp:'<img src=x onerror=alert(1)>'},{streak:{n:'<svg>',last:'',day:'',today:0}},{q:null},{q:{[q.id]:{h:'bad'}}},{days:{'bad-date':1}},{examDate:{[q.t]:'" onfocus=alert(1)'}},{active:{t:q.t,ids:['missing']}}])assert.throws(()=>parse({...P.fresh(),...patch}));
  assert.throws(()=>P.parse('{"v":1,"q":{},"__proto__":{"polluted":true}}',data));
  assert.equal({}.polluted,undefined);
  assert.throws(()=>P.parse(' '.repeat(2_000_001),data));
});
test('valid progress and an active mock survive an import without losing answers',()=>{
  const state=P.fresh();state.xp=42;state.track=q.t;
  state.q[q.id]={h:[0,0.6,1],n:3,c:1,box:3,due:123,last:100,f:0,ft:50};
  state.streak={n:1,last:'2026-10-25',day:'2026-10-25',today:10};
  const orders={[q.id]:q.opts.map((_,i)=>i)};
  state.active={t:q.t,len:'half',ids:[q.id],orders,ans:{[q.id]:[0]},flags:{[q.id]:true},strikes:{[q.id]:[1]},cur:0,start:100,deadline:200,mins:45};
  state.mockSeen[q.t]=[q.id];state.examDate[q.t]='2026-11-01';state.daily[q.t+':2026-10-25']={n:2,ok:1};state.days['2026-10-25']=10;state.cleared[q.t+'-'+q.s]=true;
  const entry={ts:100,len:'half',score:100,ok:1,n:1,dur:10,mins:45,secs:{[q.s]:{n:1,c:1}}};
  state.mocks[q.t]=[entry];state.lastMock={t:q.t,rows:[{id:q.id,a:q.ans,correct:true,flagged:false,blank:false}],orders,entry,timeUp:false};
  assert.deepEqual(parse(state),state);
  assert.throws(()=>parse({...state,active:{...state.active,orders:{[q.id]:[0,0]}}}));
  assert.throws(()=>parse({...state,lastMock:{...state.lastMock,entry:{...entry,score:'<img>'}}}));
});
test('versioned question bank has valid track, section, objective, answer and source references',()=>{
  assert.ok(bank.endsWith('questions-v'+data.version+'.json'));const ids=new Set();
  for(const q of data.questions){
    assert.ok(!ids.has(q.id),'duplicate '+q.id);ids.add(q.id);
    const section=data.tracks[q.t]?.sections.find(s=>s.n===q.s);
    assert.ok(section?.objectives.some(o=>o.id===q.o),q.id+' objective');
    assert.ok(Array.isArray(q.opts)&&q.opts.length>=2,q.id+' options');
    assert.ok(q.ans.length&&new Set(q.ans).size===q.ans.length&&q.ans.every(i=>Number.isInteger(i)&&i>=0&&i<q.opts.length),q.id+' answers');
    assert.ok(typeof q.q==='string'&&typeof q.why==='string',q.id+' explanation');
    for(const source of (Array.isArray(q.ref)?q.ref:q.ref?[q.ref]:[])){const ref=source.href||source.url||source;assert.ok(typeof ref==='string'&&ref.trim(),q.id+' source');if(/^https?:/.test(ref))assert.equal(new URL(ref).protocol,'https:',q.id+' source');}
  }
  for(const groups of Object.values(data.cram||{}))for(const group of groups)for(const id of group.ids)assert.ok(ids.has(id),'cram '+id);
});
