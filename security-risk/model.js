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
  // Attention: each independent report loses half its weight every 3 days without fresh reporting.
  function heatOf(r,today) {
    let score=0,latest='',reports=0;
    for(const rep of r.heat?.reports||[]){
      if(!safeURL(rep.url))continue;
      const day=dayOf(rep.at);
      if(!day||day>today)continue;
      const age=Math.round((Date.parse(today)-Date.parse(day))/86400000);
      score+=Math.pow(0.5,Math.max(0,age)/3);reports++;
      if(day>latest)latest=day;
    }
    return {score:Math.min(1,score),reports,latest};
  }
  // Default "Hot · latest high impact" score. Transparent weights, not a harm measurement.
  function hotRank(r,today) {
    const tier=priority(r),emergency=tier.tier<2;
    const day=event(r,today).date;
    const age=day?Math.round((Date.parse(today)-Date.parse(day))/86400000):30;
    const recency=Math.pow(0.5,Math.max(0,age)/7); // half-life: one week
    const severity=(Number.isFinite(r.cvss?.score)?r.cvss.score:0)/10;
    const exploit=(r.exploit?.refs||[]).some(u=>safeURL(u));
    const attack=r.kev?1:exploit?0.7:Math.min(0.5,(Number.isFinite(r.epss?.score)?r.epss.score:0)*25);
    const heat=heatOf(r,today).score;
    return {emergency,tier:tier.tier,label:tier.label,reason:tier.reason,
            score:Math.round(35*attack+25*severity+25*recency+15*heat),attack,severity,recency,heat};
  }
  function hotOrder(a,b,today) {
    const x=hotRank(a,today),y=hotRank(b,today);
    // Emergencies keep their rule order above every scored entry; social heat cannot create one.
    const tx=x.emergency?x.tier:9,ty=y.emergency?y.tier:9;
    return tx-ty||y.score-x.score;
  }
  function select(records,prefs={},now=Date.now()) {
    const w=windows(now),q=(prefs.q||'').toLowerCase();
    return records.filter(r=>{
      if(!highRisk(r))return false;
      const date=event(r,w.today).date;
      const inWindow=prefs.view==='archive'?date>=w.archive&&date<w.current:date>=w.current&&date<=w.today;
      return inWindow&&(!prefs.layer||prefs.layer==='all'||prefs.layer===r.layer)&&(!q||[r.id,r.product,r.title,r.description,r.action,layers[r.layer],...(r.affected||[]),...(r.fixed||[])].join(' ').toLowerCase().includes(q));
    }).sort((a,b)=>{
      let order=0;
      if(prefs.sort==='hot')order=hotOrder(a,b,w.today);
      else if(prefs.sort!=='cvss')order=priority(a).tier-priority(b).tier;
      if(order)return order;
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
      if(r.heat){const h=r.heat;if(!Array.isArray(h.reports)||h.reports.length>16)throw new Error('Invalid attention reports');
        for(const rep of h.reports){if(!['hn','reddit','news','poc'].includes(rep.k)||!safeURL(rep.url)||!rep.at)throw new Error('Invalid attention report');}}
      if(r.exploit){const x=r.exploit;if(!Array.isArray(x.refs)||!x.refs.length||x.refs.length>8||!x.refs.every(safeURL))throw new Error('Invalid exploit evidence');}
    }
    return data;
  }
  const api={layers,safeURL,windows,event,highRisk,systemicSignal,remoteUnauthenticated,priority,heatOf,hotRank,hotOrder,select,validate};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SecurityRisks=api;
})(typeof globalThis!=='undefined'?globalThis:this);
