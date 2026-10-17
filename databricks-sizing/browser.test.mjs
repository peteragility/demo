import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withBrowser} from '../scripts/browser-kit.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rates=JSON.parse(fs.readFileSync(path.join(root,'databricks-sizing/pricing-snapshot.json'),'utf8')).rates;
const setup=`
Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage disabled')}});
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}});
const nativeFetch=window.fetch.bind(window);window.__feed=${JSON.stringify(rates)};
window.__feed.premium.AWS.jobs_serverless['AP (Singapore)']='1.25';
window.fetch=async(input,options)=>String(input).includes('en-pricing-assets/data/pricing/cards.json')
  ?new Response(JSON.stringify(window.__feed),{headers:{'Content-Type':'application/json'}}):nativeFetch(input,options);
`;

await withBrowser(root,async b=>{
  const open=async(hash='')=>{await b.navigate('/databricks-sizing/'+hash,setup);await b.waitFor('!!window.sizingDesk');};
  const click=selector=>b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change=(selector,value)=>b.evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(selector)});f.value=${JSON.stringify(value)};f.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const input=(selector,value)=>b.evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(selector)});f.value=${JSON.stringify(value)};f.dispatchEvent(new Event('input',{bubbles:true}));f.dispatchEvent(new Event('change',{bubbles:true}));})()`);

  await open();
  await change('#tier','enterprise');await click('[data-cloud="Azure"]');await click('[data-cloud="AWS"]');
  assert.equal(await b.evaluate('sizingDesk.getState().tier'),'enterprise');
  assert.equal(await b.evaluate('document.querySelector("#tier").value'),'enterprise');
  await change('#tier','premium');
  assert.ok(await b.evaluate('document.getElementById("comparison").textContent.includes("Tier differs")'));
  await click('[data-cloud="Azure"]');
  assert.equal(await b.evaluate('sizingDesk.getState().platformTier'),'premium');
  await click('[data-cloud="AWS"]');assert.equal(await b.evaluate('sizingDesk.getState().tier'),'premium');

  await click('[data-scenario="bi"]');
  assert.equal(await b.evaluate('document.querySelectorAll("#requirements .field").length'),3);
  assert.equal(await b.evaluate('!!document.querySelector("#requirements #field-gb")'),false);
  const small=await b.evaluate('sizingDesk.getEstimate().total');await input('#field-storedTB',1000);
  assert.ok(await b.evaluate('sizingDesk.getEstimate().total')>small);
  await click('[data-scenario="batch"]');assert.equal(await b.evaluate('document.querySelectorAll("#requirements .field").length'),3);
  await click('[data-scenario="ai"]');assert.equal(await b.evaluate('document.querySelectorAll("#requirements .field").length'),3);
  await change('#field-answerProfile','long');assert.equal(await b.evaluate('sizingDesk.getState().inputTokens'),8000);
  await input('#field-inputTokens',1234);assert.equal(await b.evaluate('sizingDesk.getState().answerProfile'),'custom');

  await click('[data-scenario="lakebase"]');await click('[data-cloud="GCP"]');
  assert.equal(await b.evaluate('sizingDesk.getEstimate().complete'),false);
  assert.match(await b.evaluate('document.getElementById("summary-notes").textContent'),/not listed as available/);
  assert.ok(await b.evaluate('[...document.querySelectorAll("#comparison tbody tr")].find(r=>r.textContent.includes("Google Cloud")).querySelector("button").disabled'));
  await change('#region','US (Iowa)');assert.equal(await b.evaluate('sizingDesk.getEstimate().complete'),true);
  assert.match(await b.evaluate('document.getElementById("summary-notes").textContent'),/Lakebase: beta/);
  await input('#field-workingGB',200);assert.equal(await b.evaluate('sizingDesk.getEstimate().lakeCU'),120);
  assert.equal(await b.evaluate('sizingDesk.getEstimate().complete'),false);
  await input('#field-workingGB',180);await change('#field-schedule','business');
  assert.equal(await b.evaluate('sizingDesk.getEstimate().lakeHours'),730);
  assert.match(await b.evaluate('document.getElementById("sizing-notes").textContent'),/prevents scale to zero/);

  await open();const bundled=await b.evaluate('sizingDesk.getEstimate().total');
  await click('#refresh');await b.waitFor('!document.getElementById("refresh").disabled');
  const refreshed=await b.evaluate('sizingDesk.getEstimate().total');assert.ok(refreshed>bundled);
  await change('#compare-geo','us');await click('#share');await b.waitFor('!!window.__copied');
  const hash=new URL(await b.evaluate('window.__copied')).hash;
  assert.ok(hash.length<100000);
  await open(hash);assert.equal(await b.evaluate('sizingDesk.getEstimate().total'),refreshed);
  assert.equal(await b.evaluate('document.getElementById("compare-geo").value'),'us');
  assert.equal(await b.evaluate('document.getElementById("feed-label").textContent'),'SAVED ESTIMATE RATES');
  await b.evaluate('window.__goodFeed=window.__feed;window.__feed={}');
  await click('#refresh');await b.waitFor('!document.getElementById("refresh").disabled');
  assert.equal(await b.evaluate('sizingDesk.getEstimate().total'),refreshed);
  assert.equal(await b.evaluate('document.getElementById("feed-label").textContent'),'SAVED ESTIMATE RATES');
  await b.evaluate('window.__feed=window.__goodFeed');
  await b.evaluate(`window.__feed.premium.AWS.jobs_serverless['AP (Singapore)']='0.39'`);
  await click('#refresh');await b.waitFor('!document.getElementById("refresh").disabled');
  assert.equal(await b.evaluate('sizingDesk.getEstimate().total'),bundled);
  await b.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('Denied'))}})`);
  await click('#share');await b.waitFor('location.hash.startsWith("#estimate=")');
  assert.equal(await b.evaluate('JSON.parse(decodeURIComponent(location.hash.slice(10))).version'),1);

  const legacy={cloud:'AWS',region:'US East (N. Virginia)',workloads:['etl'],gb:100};
  await open('#estimate='+encodeURIComponent(JSON.stringify(legacy)));
  assert.equal(await b.evaluate('document.getElementById("compare-geo").value'),'us');
  const unsafe={region:'<img src=x onerror=window.__injected=true>',gb:-1,workloads:['etl','<svg onload=alert(1)>'],overrides:{'__proto__':1}};
  await open('#estimate='+encodeURIComponent(JSON.stringify(unsafe)));
  assert.equal(await b.evaluate('window.__injected===true'),false);assert.equal(await b.evaluate('sizingDesk.getState().gb'),0);
  assert.equal(await b.evaluate('document.querySelectorAll("img[onerror],svg[onload]").length'),0);

  await open();
  for(const width of [1440,390,320]){
    await b.viewport(width,1000);
    assert.ok(await b.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Page overflows at '+width);
    if(width===390){
      assert.equal(await b.evaluate('getComputedStyle(document.getElementById("comparison-hint")).display'),'block');
      await b.evaluate('document.getElementById("comparison").scrollLeft=200');
      const sticky=await b.evaluate(`(()=>{const c=document.getElementById('comparison'),h=c.querySelector('tbody th');return {left:h.getBoundingClientRect().left,container:c.getBoundingClientRect().left,position:getComputedStyle(h).position}})()`);
      assert.equal(sticky.position,'sticky');assert.ok(Math.abs(sticky.left-sticky.container)<2);
      await b.screenshot('/tmp/databricks-fixed-mobile.png',390,1000);
    }
  }
  await b.screenshot('/tmp/databricks-fixed-desktop.png',1440,1000);
  assert.equal(b.errors.length,0,JSON.stringify(b.errors));
});
console.log('PASS: availability/capacity, cloud tiers, scenario inputs, saved/live prices, shared geography, hostile inputs, blocked storage, denied clipboard, and mobile comparison.');
