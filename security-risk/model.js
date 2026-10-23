(function (root) {
  'use strict';
  const layers = {trust:'Certificates / TLS',edge:'Edge / VPN',runtime:'Runtimes',delivery:'GitLab / CI/CD',system:'OS / containers',identity:'Identity / data'};
  function safeURL(value) {
    try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;} catch {return null;}
  }
  function windows(now=Date.now()) {
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
    const [y,m,d]=today.split('-').map(Number), t=Date.UTC(y,m-1,d);
    const month=new Date(Date.UTC(y,m-7,1)), day=Math.min(d,new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+1,0)).getUTCDate());
    const archive=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth(),day));
    return {today,current:new Date(t-29*86400000).toISOString().slice(0,10),archive:archive.toISOString().slice(0,10)};
  }
  function event(r,today) {
    const values=[{date:r.advisory_published_at||r.published,label:r.kind==='incident'?'Incident notice':'Disclosed'},
      {date:r.material_updated_at,label:'Advisory updated'}];
    if(r.kev) values.push({date:r.kev_added,label:'Added to KEV'});
    return values.filter(e=>typeof e.date==='string'&&/^\d{4}-\d{2}-\d{2}/.test(e.date)&&Number.isFinite(Date.parse(e.date))&&e.date.slice(0,10)<=today)
      .map(e=>({...e,date:e.date.slice(0,10)})).sort((a,b)=>b.date.localeCompare(a.date)||b.label.localeCompare(a.label))[0]||{date:'',label:'Date unavailable'};
  }
  const highRisk=r=>!r.rejected&&(r.kev||r.urgent||(r.cvss?.score??-1)>=7);
  function select(records,prefs={},now=Date.now()) {
    const w=windows(now),q=(prefs.q||'').toLowerCase();
    return records.filter(r=>{
      if(!highRisk(r))return false;
      const date=event(r,w.today).date;
      const inWindow=prefs.view==='archive'?date>=w.archive&&date<w.current:date>=w.current&&date<=w.today;
      return inWindow&&(!q||[r.id,r.product,r.title,r.description,r.action,layers[r.layer],...(r.affected||[]),...(r.fixed||[])].join(' ').toLowerCase().includes(q));
    }).sort((a,b)=>(b.cvss?.score??-1)-(a.cvss?.score??-1)||Number(Boolean(b.kev))-Number(Boolean(a.kev))||event(b,w.today).date.localeCompare(event(a,w.today).date)||a.id.localeCompare(b.id));
  }
  function validate(data) {
    if(data?.schema!==1||!Array.isArray(data.records)||!Array.isArray(data.sources))throw new Error('Invalid security snapshot');
    const ids=new Set();
    for(const r of data.records){
      if(!/^[A-Za-z0-9-]{1,80}$/.test(r.id)||ids.has(r.id)||!Object.hasOwn(layers,r.layer)||
        !['title','product','description','action'].every(k=>typeof r[k]==='string')||!Array.isArray(r.sources)||!r.sources.length||!Array.isArray(r.affected)||!Array.isArray(r.fixed)||
        (r.cvss&&(!Number.isFinite(r.cvss.score)||r.cvss.score<0||r.cvss.score>10)))throw new Error('Invalid security record');
      ids.add(r.id);
    }
    return data;
  }
  const api={layers,safeURL,windows,event,highRisk,select,validate};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SecurityRisks=api;
})(typeof globalThis!=='undefined'?globalThis:this);
