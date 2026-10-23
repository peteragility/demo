import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {withBrowser} from '../scripts/browser-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await withBrowser(root, async b => {
  const ready = () => b.waitFor('document.querySelectorAll("#rows .row").length > 0');
  await b.navigate('/security-risk/'); await ready();
  assert.equal(await b.evaluate('document.querySelectorAll("#rows .row").length'), 30);
  assert.equal(await b.evaluate('document.querySelectorAll(".highlight").length >= 4'), true);
  assert.equal(await b.evaluate('document.querySelector("thead .rank").textContent'), 'CVSS');
  await b.evaluate('document.getElementById("sort").value="cvss";document.getElementById("sort").dispatchEvent(new Event("change"))');
  assert.equal(await b.evaluate('document.querySelector(".rankbadge").textContent'), '10.0/10');
  for (const width of [1440, 768, 390, 320]) {
    await b.viewport(width, 920);
    if (width === 320) await b.evaluate('document.querySelector(".wrap").style.fontFamily="Arial,sans-serif"');
    const overflow = await b.evaluate('[...document.body.querySelectorAll("*")].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && getComputedStyle(e).position!=="absolute").slice(0,6).map(e=>e.tagName+"."+e.className+":"+e.getBoundingClientRect().right).join(", ")');
    assert.ok(await b.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'No horizontal overflow at ' + width + ': ' + overflow);
    assert.ok(await b.evaluate('[...document.querySelectorAll(".rankbadge")].every(e=>e.getBoundingClientRect().right<=e.closest("td").getBoundingClientRect().right)'), 'Scores fit their cells at ' + width);
    if (width === 1440 || width === 390) await b.screenshot(path.join(os.tmpdir(), 'security-checklist-' + width + '.png'), width, 920);
  }
  await b.evaluate('document.querySelector(".wrap").style.fontFamily=""');
  await b.call('Emulation.setEmulatedMedia', {features: [{name:'prefers-color-scheme',value:'dark'}]});
  await b.screenshot(path.join(os.tmpdir(), 'security-checklist-dark.png'), 1440, 920);
  assert.equal(await b.evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(13, 16, 21)');
  await b.call('Emulation.setEmulatedMedia', {features: [{name:'prefers-color-scheme',value:'light'}]});
  await b.viewport(1440, 920);
  await b.evaluate('document.getElementById("more").click()');
  assert.ok(await b.evaluate('document.querySelectorAll("#rows .row").length > 30'));
  await b.evaluate('window.scrollTo(0,650)'); await b.pause(100);
  assert.ok(await b.evaluate('document.querySelector("thead th").getBoundingClientRect().top >= 0 && document.querySelector("thead th").getBoundingClientRect().top <= 60'), 'Sticky table headers');
  await b.evaluate('window.scrollTo(0,0)');

  const id = 'CVE-2026-109618';
  await b.evaluate(`document.getElementById('q').value='${id}'; document.getElementById('q').dispatchEvent(new Event('input')); document.querySelector('.issuebtn').click()`);
  assert.equal(await b.evaluate('document.querySelectorAll("#rows .row").length'), 1);
  assert.ok(await b.evaluate('document.querySelector(".detail").textContent.includes("8.5.12")'));
  await b.evaluate('document.querySelector("form select").value="fixed";document.querySelector("form").requestSubmit()');
  assert.match(await b.evaluate('document.querySelector(".formmessage").textContent'), /four steps/);
  await b.evaluate('document.querySelector("form select").value="na";document.querySelector("form").requestSubmit()');
  assert.match(await b.evaluate('document.querySelector(".formmessage").textContent'), /why/);
  await b.evaluate(`document.querySelector('form select').value='affected';document.querySelector('[name=owner]').value='<img src=x onerror=alert(1)>';document.querySelector('[name=systems]').value='web-prod';document.querySelector('form').requestSubmit()`);
  assert.equal(await b.evaluate('document.querySelectorAll("#rows img, #rows script").length'), 0);
  await b.navigate('/security-risk/?persist=1#' + id); await ready();
  assert.equal(await b.evaluate('document.querySelector(".state").textContent'), 'Affected');
  assert.equal(await b.evaluate('document.querySelector("[name=systems]").value'), 'web-prod');
  await b.evaluate('document.querySelectorAll(".check input").forEach(i=>i.checked=true);document.querySelector("form select").value="fixed";document.querySelector("[name=evidence]").value="Change SEC-42; running FPM build verified";document.querySelector("form").requestSubmit()');
  assert.equal(await b.evaluate('document.querySelector(".state").textContent'), 'Fixed / verified');
  await b.evaluate('document.getElementById("view").value="open";document.getElementById("view").dispatchEvent(new Event("change"))');
  assert.equal(await b.evaluate('document.querySelectorAll("#rows .row").length'), 0);

  const mutate = code => `const originalFetch=window.fetch;window.fetch=async (...args)=>{const response=await originalFetch(...args);if(String(args[0]).includes('data.json')){const data=await response.json();${code};return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});}return response;};`;
  await b.navigate('/security-risk/?reassess=1#' + id, mutate(`data.records.find(r=>r.id==='${id}').revision='changed-advisory';`)); await ready();
  assert.equal(await b.evaluate('document.querySelector(".state").textContent'), 'Reassess');
  assert.equal(await b.evaluate('document.querySelectorAll(".check input:checked").length'), 0);

  // Exercise export without allowing the test browser to write into the user's Downloads.
  await b.evaluate(`const originalObjectURL=URL.createObjectURL;URL.createObjectURL=blob=>{window.exported=blob.text();return originalObjectURL(blob)};HTMLAnchorElement.prototype.click=function(){window.exportName=this.download};document.getElementById('export').click()`);
  const exported = await b.evaluate('window.exported.then(JSON.parse)');
  assert.equal(exported.assessments[id].systems, 'web-prod');
  assert.match(await b.evaluate('window.exportName'), /^security-checklist-/);
  await b.evaluate(`const payload={schema:1,assessments:{'${id}':{status:'na',note:'No production PHP',saved:new Date(Date.now()+1000).toISOString(),revision:'changed-advisory',owner:'Ops'},'__proto__':{polluted:true},unknown:{status:'fixed'}}};const dt=new DataTransfer();dt.items.add(new File([JSON.stringify(payload)],'handover.json',{type:'application/json'}));document.getElementById('import').files=dt.files;document.getElementById('import').dispatchEvent(new Event('change'));`);
  await b.waitFor('document.getElementById("notice").textContent.includes("imported")');
  assert.equal(await b.evaluate('document.querySelector(".state").textContent'), 'Not applicable');
  assert.equal(await b.evaluate('({}).polluted'), undefined);

  await b.navigate('/security-risk/?score=1#emudhra-ca-2026-10'); await ready();
  assert.equal(await b.evaluate('document.querySelector(".rankbadge").textContent'), '—');

  await b.navigate('/security-risk/', `Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}});`); await ready();
  assert.equal(await b.evaluate('document.getElementById("storageNotice").hidden'), false);
  await b.navigate('/security-risk/?unsafe=1#' + id, mutate(`data.records.find(r=>r.id==='${id}').title='<img src=x onerror=alert(1)>';data.records.find(r=>r.id==='${id}').sources[0].url='javascript:alert(1)';data.last_attempt='2020-01-01T00:00:00Z';data.sources[0].status='failed';`)); await ready();
  assert.equal(await b.evaluate('document.querySelectorAll("#rows img, #rows script, #rows a[href^=javascript]").length'), 0);
  assert.match(await b.evaluate('document.getElementById("notice").textContent'), /source check.*failed/);
  await b.navigate('/security-risk/', `const originalFetch=window.fetch;window.fetch=(...args)=>String(args[0]).includes('data.json')?Promise.reject(new Error('offline')):originalFetch(...args);`);
  await b.waitFor('document.getElementById("notice").textContent.includes("Could not load")');
  assert.equal(await b.evaluate('document.getElementById("count").textContent'), 'Unable to load risks');
  assert.deepEqual(b.errors, []);
});
console.log('PASS: desktop/mobile/dark layout, sticky headers, checklist persistence, closure gates, reassessment, export/import, blocked storage, injection and source outages.');
