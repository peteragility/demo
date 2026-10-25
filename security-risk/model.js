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
  function dayOf(value) {
    if(typeof value!=='string'||!value||!Number.isFinite(Date.parse(value)))return '';
    if(/^\d{4}-\d{2}-\d{2}$/.test(value))return new Date(value).toISOString().slice(0,10)===value?value:'';
    // CNA timestamps without an explicit zone are UTC; date-only source values stay dates.
    const stamp=/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(value)?value+'Z':value;
    return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(stamp));
  }
  function event(r,today) {
    const values=[{date:r.advisory_published_at||r.published,label:r.kind==='incident'?'Incident notice':'Disclosed'},
      {date:r.material_updated_at,label:'Advisory updated'}];
    if(r.kev) values.push({date:r.kev_added,label:'Added to KEV'});
    return values.map(e=>({...e,date:dayOf(e.date)})).filter(e=>e.date&&e.date<=today)
      .sort((a,b)=>b.date.localeCompare(a.date)||b.label.localeCompare(a.label))[0]||{date:'',label:'Date unavailable'};
  }
  const highRisk=r=>!r.rejected&&(r.kev||r.urgent||(r.cvss?.score??-1)>=7||Boolean(systemicSignal(r)));
  function systemicSignal(r) {
    const evidence=r.ranking_evidence;
    if(!evidence||typeof evidence.text!=='string'||!safeURL(evidence.url))return null;
    const sentences=evidence.text.split(/[.\n;]+/);
    for(const text of sentences){
      // Text classification is conservative: hypothetical, negated and remediated reports do not promote.
      if(/\b(no|not|never|without|unconfirmed|hypothetical|potential|potentially|possible|suspected|could|may|might|if|whether|prevent|avoid|prevented|previously|formerly|historical|resolved|remediated)\b/i.test(text))continue;
      const keyLoss=/(?:compromis(?:ed|e)|stolen|leaked|exposed)[^.!?;]{0,70}\bkeys?\b|\bkeys?\b[^.!?;]{0,70}(?:compromised|stolen|leaked|exposed)/i.test(text);
      const trustRole=/certificate authorit|\bCA\b|root certificate|trust store|code.signing|update.signing|package.signing|software.signing/i.test(text);
      if(keyLoss&&trustRole)return {kind:'trust',label:'Reported trust compromise',reason:'Source text reports compromised signing or certificate-authority keys that can affect downstream trust. This is an automated text inference, not a measured population impact.'};
      if(/(?:compromised|poisoned) (?:package registr(?:y|ies)|software update (?:channel|pipeline)s?)|malicious (?:software )?updates (?:were|are|have been) (?:distributed|delivered|published)/i.test(text))return {kind:'distribution',label:'Reported distribution compromise',reason:'Source text reports compromise of shared software distribution. This is an automated text inference; the affected deployment count is unknown.'};
    }
    return null;
  }
  function remoteUnauthenticated(r){
    const vector=r.cvss?.vector;
    if(typeof vector!=='string'||!/^CVSS:[34]\./.test(vector))return false;
    const metrics=Object.fromEntries(vector.split('/').slice(1).map(part=>part.split(':')));
    return metrics.AV==='N'&&metrics.AC==='L'&&metrics.PR==='N'&&metrics.UI==='N'&&(!vector.startsWith('CVSS:4.')||metrics.AT==='N');
  }
  function priority(r) {
    const systemic=systemicSignal(r);
    if(systemic)return {tier:0,...systemic};
    if(r.kev&&((r.cvss?.score??-1)>=9||r.ransomware))return {tier:1,label:'Exploited · critical',reason:'CISA confirms exploitation, with CVSS 9.0+ or known ransomware use.'};
    if((r.cvss?.score??-1)>=9&&remoteUnauthenticated(r))return {tier:2,label:'Critical · unauthenticated remote',reason:'CVSS 9.0+ with network access, low complexity, no privileges and no user interaction; CVSS v4 also requires no additional attack prerequisite.'};
    return {tier:3,label:'CVSS severity',reason:'Ordered by published CVSS. No systemic-compromise or critical-exposure promotion rule was established from the available evidence.'};
  }
  function select(records,prefs={},now=Date.now()) {
    const w=windows(now),q=(prefs.q||'').toLowerCase();
    return records.filter(r=>{
      if(!highRisk(r))return false;
      const date=event(r,w.today).date;
      const inWindow=prefs.view==='archive'?date>=w.archive&&date<w.current:date>=w.current&&date<=w.today;
      return inWindow&&(!prefs.layer||prefs.layer==='all'||prefs.layer===r.layer)&&(!q||[r.id,r.product,r.title,r.description,r.action,layers[r.layer],...(r.affected||[]),...(r.fixed||[])].join(' ').toLowerCase().includes(q));
    }).sort((a,b)=>{
      if(prefs.sort!=='cvss'){
        const x=priority(a),y=priority(b),order=x.tier-y.tier;
        if(order)return order;
      }
      return (b.cvss?.score??-1)-(a.cvss?.score??-1)||Number(Boolean(b.kev))-Number(Boolean(a.kev))||(prefs.sort!=='cvss'?(b.epss?.score??-1)-(a.epss?.score??-1):0)||event(b,w.today).date.localeCompare(event(a,w.today).date)||a.id.localeCompare(b.id);
    });
  }
  function validate(data) {
    if(data?.schema!==1||!Array.isArray(data.records)||!Array.isArray(data.sources))throw new Error('Invalid security snapshot');
    const ids=new Set();
    for(const r of data.records){
      if(!/^[A-Za-z0-9-]{1,80}$/.test(r.id)||ids.has(r.id)||!Object.hasOwn(layers,r.layer)||
        !['title','product','description','action'].every(k=>typeof r[k]==='string')||!Array.isArray(r.sources)||!r.sources.length||!Array.isArray(r.affected)||!Array.isArray(r.fixed)||
        (r.cvss&&(!Number.isFinite(r.cvss.score)||r.cvss.score<0||r.cvss.score>10)))throw new Error('Invalid security record');
      ids.add(r.id);
      if(r.ranking_evidence){const e=r.ranking_evidence;if(typeof e.text!=='string'||e.text.length>16000||!safeURL(e.url))throw new Error('Invalid ranking evidence');}
    }
    return data;
  }
  const api={layers,safeURL,windows,event,highRisk,systemicSignal,remoteUnauthenticated,priority,select,validate};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SecurityRisks=api;
})(typeof globalThis!=='undefined'?globalThis:this);
