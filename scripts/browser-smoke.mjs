import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {withBrowser} from './browser-kit.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageCount = JSON.parse(readFileSync(path.join(root,'manifest.json'),'utf8')).pages.length;
const blockedStorage = `Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage disabled for review')}});`;
const fakeAPI = `const nativeFetch=window.fetch.bind(window);window.fetch=async(input,options)=>new URL(input,location.href).hostname.endsWith('execute-api.us-east-1.amazonaws.com')?new Response(JSON.stringify({ok:false,error:'<img src=x onerror=window.x=1>'}),{headers:{'Content-Type':'application/json'}}):nativeFetch(input,options);`;
await withBrowser(root,async b=>{
  for(const width of [1440,390,320]) {
    await b.viewport(width,900);
    for(const url of ['/','/databricks-sizing/','/aidecide-arena/','/lakehouse-quest.html','/neon-orbit.html','/sandbox-compare/']) {
      await b.navigate(url,blockedStorage+fakeAPI);
      if(url==='/') {await b.waitFor('document.querySelectorAll("a.card").length==='+pageCount);await b.waitFor('document.querySelectorAll(".freshness").length===6');}
      if(url==='/lakehouse-quest.html')await b.waitFor('document.body.dataset.ready==="true"');
      if(url==='/databricks-sizing/') {
        await b.waitFor('!!window.sizingDesk');
        assert.equal(await b.evaluate('sizingDesk.getEstimate().complete'),true);
      }
      assert.ok(await b.evaluate('document.documentElement.scrollWidth<=innerWidth'),url+' overflows at '+width);
      if(url!=='/') assert.ok(await b.evaluate('[...document.querySelectorAll("a")].some(a=>a.textContent.includes("Demo home"))'),url+' needs a home link');
    }
  }
  await b.navigate('/aidecide-arena/',fakeAPI);
  await b.evaluate("resetSnake();moveSnake(A,B,'review','logA','barsA','scoreA','aliveA','mvA','avgA')");
  await b.waitFor('document.querySelectorAll("#logA .lr").length>0');
  assert.equal(await b.evaluate('document.querySelectorAll("#logA img[onerror]").length'),0);
  assert.equal(await b.evaluate('window.x===1'),false);
  assert.ok(await b.evaluate('document.querySelector("#logA .line1").textContent.includes("<img")'));
  await b.navigate('/lakehouse-quest.html');await b.waitFor('document.body.dataset.ready==="true"');
  await b.evaluate(`document.querySelector('[data-act="data"]').click();document.getElementById('io').value=JSON.stringify({v:1,q:{},xp:'<img src=x onerror=window.questInjected=1>'});[...document.querySelectorAll('#modal-actions button')].find(b=>b.textContent==='Load pasted progress').click();`);
  assert.ok(await b.evaluate('document.getElementById("toast").textContent.includes("doesn\'t look")'));
  assert.equal(await b.evaluate('window.questInjected===1'),false);
  assert.equal(await b.evaluate('document.querySelectorAll("#modal-body img").length'),0);
  await b.navigate('/aidecide-arena/',`const originalFetch=fetch;window.fetch=async(input,options)=>String(input).includes('execute-api')?new Response(JSON.stringify({ok:true,answers:{move:{choice:'c9'}}})):originalFetch(input,options);`);
  await b.evaluate('tGameNo=1;tttReset();tttMove("A")');
  assert.equal(await b.evaluate('tBoard.length'),9);assert.equal(await b.evaluate('tBoard[0]'),'X');
  await b.navigate('/lakebase-compete-calculator/');
  await b.waitFor('!!document.getElementById("copyBtn")');
  await b.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('Denied'))}});document.getElementById('copyBtn').focus();document.getElementById('copyBtn').click();`);
  await b.waitFor('!!document.querySelector("dialog[open]")');
  assert.ok(await b.evaluate('document.querySelector("dialog textarea").value.includes("Lakebase Calculator estimate")'));
  await b.evaluate('document.querySelector("dialog button").click()');await b.pause(100);
  assert.equal(await b.evaluate('document.activeElement.id'),'copyBtn');
  await b.evaluate('document.getElementById("shareBtn").click()');await b.waitFor('!!document.querySelector("dialog[open]")');
  assert.ok(await b.evaluate('document.querySelector("dialog textarea").value.includes("#w=" )'));
  assert.equal(b.errors.length,0,JSON.stringify(b.errors));
});
console.log('PASS: responsive homepage/games, blocked storage, safe API errors, home links and denied clipboard fallback.');
