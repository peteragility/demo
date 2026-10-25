(function(root){
  'use strict';
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const fail=()=>{throw new Error('Invalid progress data');};
  const number=(v,max=1e12)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:fail();
  const integer=(v,max=1e12)=>Number.isSafeInteger(v)?number(v,max):fail();
  const boolean=v=>typeof v==='boolean'?v:fail();
  const date=v=>typeof v==='string'&&(v===''||/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v)?v:fail();
  const fresh=()=>({v:1,q:{},xp:0,streak:{n:0,last:'',day:'',today:0},mocks:{},mockSeen:{},cleared:{},examDate:{},daily:{},sound:true,track:null,active:null,lastMock:null,days:{}});
  function parse(text,data){
    if(typeof text!=='string'||text.length>2_000_000)fail();
    const input=JSON.parse(text,(key,value)=>['__proto__','prototype','constructor'].includes(key)?fail():value);
    if(!object(input)||input.v!==1||!object(input.q))fail();
    const tracks=data.tracks,questions=new Map(data.questions.map(q=>[q.id,q])),out=fresh();
    const track=t=>typeof t==='string'&&Object.hasOwn(tracks,t)?t:fail();
    const map=(value,read)=>{if(!object(value))fail();const result={};for(const[k,v]of Object.entries(value)){const parsed=read(k,v);if(parsed!==undefined)result[k]=parsed;}return result;};
    const list=(value,read,max)=>{if(!Array.isArray(value)||value.length>max)fail();return value.map(read);};
    const choices=(value,id)=>{const q=questions.get(id);if(!q)fail();const a=list(value,v=>integer(v,q.opts.length-1),q.opts.length);if(new Set(a).size!==a.length)fail();return a;};
    const ids=(value,t)=>{const a=list(value,id=>questions.get(id)?.t===t?id:fail(),questions.size);if(new Set(a).size!==a.length)fail();return a;};
    const orders=(value,deck)=>map(value,(id,v)=>{if(!deck.includes(id))fail();const a=choices(v,id);if(a.length!==questions.get(id).opts.length)fail();return a;});
    function entry(v,t){
      if(!object(v)||!['half','full'].includes(v.len))fail();
      const n=integer(v.n,questions.size),ok=integer(v.ok,n);
      return {ts:number(v.ts,8.64e15),len:v.len,score:number(v.score,100),ok,n,dur:number(v.dur,86400000),mins:number(v.mins,1440),secs:map(v.secs,(k,s)=>{
        if(!tracks[t].sections.some(section=>String(section.n)===k)||!object(s))fail();const n=integer(s.n,questions.size);return {n,c:integer(s.c,n)};
      })};
    }
    if(input.xp!==undefined)out.xp=integer(input.xp);
    if(input.sound!==undefined)out.sound=boolean(input.sound);
    if(input.track!=null)out.track=track(input.track);
    if(input.streak!==undefined){const s=input.streak;if(!object(s))fail();out.streak={n:integer(s.n),last:date(s.last),day:date(s.day),today:integer(s.today)};}
    out.q=map(input.q,(id,r)=>{
      if(!questions.has(id))return; // Retired questions do not invalidate otherwise valid progress.
      if(!object(r))fail();
      const n=integer(r.n),v={h:list(r.h,x=>number(x,1),5),n,c:integer(r.c,n),box:integer(r.box,6),due:number(r.due,8.64e15),last:number(r.last,8.64e15)};
      if(r.f!=null){v.f=number(r.f,1);v.ft=number(r.ft,8.64e15);}return v;
    });
    for(const field of ['mocks','mockSeen','examDate'])if(input[field]!==undefined)out[field]=map(input[field],(t,v)=>{
      if(!Object.hasOwn(tracks,t))return;
      return field==='mocks'?list(v,x=>entry(x,t),40):field==='mockSeen'?list(v,id=>typeof id==='string'?id:fail(),20000).filter(id=>questions.get(id)?.t===t):date(v);
    });
    if(input.days!==undefined)out.days=map(input.days,(k,v)=>{if(!date(k))fail();return integer(v);});
    if(input.cleared!==undefined)out.cleared=map(input.cleared,(k,v)=>{
      if(!Object.values(tracks).some(t=>t.sections.some(s=>k===t.code+'-'+s.n)))return;return boolean(v);
    });
    if(input.daily!==undefined)out.daily=map(input.daily,(k,v)=>{
      const [t,day,...extra]=k.split(':');if(extra.length||!Object.hasOwn(tracks,t)||!date(day)||!object(v))fail();const n=integer(v.n,questions.size);return {n,ok:integer(v.ok,n)};
    });
    if(input.active!=null){
      const a=input.active;if(!object(a))fail();const t=track(a.t),deck=ids(a.ids,t);if(!deck.length||!['half','full'].includes(a.len))fail();
      const o=orders(a.orders,deck);if(deck.some(id=>!Object.hasOwn(o,id)))fail();
      out.active={t,len:a.len,ids:deck,orders:o,cur:integer(a.cur,deck.length-1),start:number(a.start,8.64e15),deadline:number(a.deadline,8.64e15),mins:number(a.mins,1440)};
      if(out.active.deadline<out.active.start)fail();
      for(const field of ['ans','strikes','flags'])out.active[field]=map(a[field],(id,v)=>{if(!deck.includes(id))fail();return field==='flags'?boolean(v):choices(v,id);});
    }
    if(input.lastMock!=null){
      const a=input.lastMock;if(!object(a))fail();const t=track(a.t);
      const rows=list(a.rows,r=>{if(!object(r)||questions.get(r.id)?.t!==t)fail();return {id:r.id,a:choices(r.a,r.id),correct:boolean(r.correct),flagged:boolean(r.flagged),blank:boolean(r.blank)};},questions.size);
      const deck=rows.map(r=>r.id);if(new Set(deck).size!==deck.length)fail();
      const o=orders(a.orders,deck);if(deck.some(id=>!Object.hasOwn(o,id)))fail();
      out.lastMock={t,rows,orders:o,entry:entry(a.entry,t),timeUp:boolean(a.timeUp)};
    }
    return out;
  }
  const api={fresh,parse};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.QuestProgress=api;
})(typeof globalThis!=='undefined'?globalThis:this);
