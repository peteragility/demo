import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {withBrowser} from '../scripts/browser-kit.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixed='2026-10-23T06:00:00Z',clock=`const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[${JSON.stringify(fixed)}]))}static now(){return NativeDate.parse(${JSON.stringify(fixed)})}};`;
const make=(id,published,score=9.3)=>({id,title:'Example issue '+id,product:'Example',description:'Untrusted input can allow code execution.',action:'Upgrade the runtime and restart affected services.',impact:'Code execution',layer:'runtime',published,cvss:score===null?null:{score,version:'3.1'},affected:['1.x'],fixed:['1.2'],conditions:[],sources:[{label:'Vendor',url:'https://vendor.test/advisory'}],checked_at:fixed});
const fixture={schema:1,last_attempt:fixed,last_success:fixed,sources:[],records:[make('current-a','2026-10-21',10),make('current-b','2026-09-24'),make('archive-a','2026-09-23'),make('archive-b','2026-04-23'),make('expired','2026-04-22'),make('low','2026-10-20',6.9),{...make('ca','2026-10-20',null),layer:'trust',urgent:true,kind:'incident',ranking_evidence:{text:'Compromised code-signing keys allow forged software updates.',url:'https://vendor.test/advisory'}}]};
const setup=(data,extra='')=>clock+`const originalFetch=window.fetch;window.fetch=async(...args)=>String(args[0]).includes('data.json')?new Response(JSON.stringify(${JSON.stringify(data)}),{status:200}):originalFetch(...args);`+extra;
await withBrowser(root,async b=>{
 await b.navigate('/security-risk/',setup(fixture));await b.waitFor('document.querySelectorAll(".row").length===3');
 assert.equal(await b.evaluate('document.querySelector("#current").getAttribute("aria-pressed")'),'true');
 assert.equal(await b.evaluate('document.querySelector(".row").dataset.id'),'ca');
 assert.equal(await b.evaluate('document.querySelector(".score").textContent'),'—');
 assert.equal(await b.evaluate('document.querySelectorAll("form,textarea,input[type=checkbox],#recent,#export,#import,#view").length'),0);
 assert.equal(await b.evaluate('document.getElementById("sort").value'),'impact');
 assert.equal(await b.evaluate('document.querySelectorAll("#categories button").length'),7);
 assert.equal(await b.evaluate('document.querySelector("#categories [aria-pressed=true]").dataset.layer'),'all');
 assert.equal(await b.evaluate('document.querySelectorAll("footer a[href*=llm-pricing]").length'),0);
 await b.evaluate('document.querySelector("[data-layer=trust]").click()');
 assert.equal(await b.evaluate('document.querySelectorAll(".row").length'),1);
 assert.equal(await b.evaluate('document.querySelector(".row").dataset.id'),'ca');
 await b.evaluate('document.querySelector("[data-layer=all]").click();document.getElementById("sort").value="cvss";document.getElementById("sort").dispatchEvent(new Event("change"))');
 assert.equal(await b.evaluate('document.querySelector(".score").textContent'),'10.0/10');
 await b.evaluate('document.getElementById("sort").value="impact";document.getElementById("sort").dispatchEvent(new Event("change"))');
 for(const width of [1440,768,390,320]){
  await b.viewport(width,900);if(width===320)await b.evaluate('document.body.style.fontFamily="Arial,sans-serif"');
  assert.ok(await b.evaluate('document.documentElement.scrollWidth<=innerWidth'),'No overflow at '+width);
  assert.ok(await b.evaluate('document.querySelector(".row .issue").getBoundingClientRect().width>100'),'Readable product column at '+width);
  assert.ok(await b.evaluate('document.querySelector("header .home").getBoundingClientRect().height>0'),'Demo link visible at '+width);
  assert.equal(await b.evaluate('document.querySelector("header .home").getAttribute("href")'),'../');
  assert.equal(await b.evaluate('document.querySelectorAll(".row .about,.row .action,.detail").length'),0,'Rows start collapsed without duplicate issue/action blocks');
  if(width<=720){
   assert.ok(await b.evaluate('[...document.querySelectorAll(".row")].every(r=>r.getBoundingClientRect().height<=60)'),'Compact rows at '+width);
   assert.ok(await b.evaluate('["q","sort"].every(id=>parseFloat(getComputedStyle(document.getElementById(id)).fontSize)>=16)'),'iOS controls avoid focus zoom');
  }
  if(width===1440||width===390)await b.screenshot(path.join(os.tmpdir(),'security-info-'+width+'.png'),width,900);
 }
 await b.evaluate('document.querySelector(".issuebtn").click()');assert.ok(await b.evaluate('document.querySelector(".detail").textContent.includes("Recommended action")'));
 assert.ok(await b.evaluate('document.querySelector(".impact-note").textContent.includes("Why this ranks here")'));
 await b.evaluate('document.querySelector(".row .rank").click()');assert.equal(await b.evaluate('document.querySelectorAll(".detail").length'),0,'Tap any cell to collapse');
 await b.evaluate('document.querySelector(".row .rank").click()');assert.equal(await b.evaluate('document.querySelectorAll(".detail").length'),1,'Tap any cell to expand');
 await b.evaluate('document.querySelector(".issuebtn").focus()');
 await b.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
 await b.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 assert.equal(await b.evaluate('document.activeElement.className'),'issuebtn','Disclosure preserves keyboard focus');
 assert.equal(await b.evaluate('document.activeElement.getAttribute("aria-expanded")'),'false');
 await b.evaluate('document.getElementById("archive").click()');assert.equal(await b.evaluate('document.querySelectorAll(".row").length'),2);
 assert.match(await b.evaluate('document.getElementById("period").textContent'),/Archive/);
 await b.evaluate('document.getElementById("q").value="archive-b";document.getElementById("q").dispatchEvent(new Event("input"))');assert.equal(await b.evaluate('document.querySelectorAll(".row").length'),1);
 await b.evaluate('document.getElementById("current").click()');assert.equal(await b.evaluate('document.querySelectorAll(".row").length'),3);
 // Exercise real touch events and mobile viewport sizing, beyond desktop resizing.
 await b.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
 await b.call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 await b.navigate('/security-risk/?touch=1',setup(fixture));await b.waitFor('document.querySelectorAll(".row").length===3');
 const scale=await b.evaluate('visualViewport.scale');
 const tap=async selector=>{
  await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);await b.pause(80);
  const point=await b.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await b.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
  await b.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await b.pause(150);
  assert.equal(await b.evaluate('visualViewport.scale'),scale,'No viewport zoom after '+selector);
 };
 await tap('#q');assert.equal(await b.evaluate('document.activeElement.id'),'q');await b.evaluate('document.activeElement.blur()');
 await b.evaluate('document.getElementById("sort").focus();document.getElementById("sort").value="cvss";document.getElementById("sort").dispatchEvent(new Event("change"));document.activeElement.blur()');
 assert.equal(await b.evaluate('visualViewport.scale'),scale,'No viewport zoom after ranking control focus/change');
 await tap('#archive');assert.equal(await b.evaluate('document.querySelectorAll(".row").length'),2);
 await tap('#current');assert.equal(await b.evaluate('document.querySelectorAll(".row").length'),3);
 await tap('[data-layer=trust]');await tap('[data-layer=all]');
 await tap('.row .rank');assert.equal(await b.evaluate('document.querySelectorAll(".detail").length'),1);
 await tap('.row .rank');assert.equal(await b.evaluate('document.querySelectorAll(".detail").length'),0);
 // Double taps on text, cells, expanded content and page background must not change scale.
 await tap('.row .rank');
 for(const selector of ['header h1','.kpi','.detail p','.row .when']){
  await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);await b.pause(100);
  const point=await b.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.min(380,Math.max(10,r.x+r.width/2)),y:Math.min(830,Math.max(10,r.y+r.height/2))}})()`);
  await b.call('Input.synthesizeTapGesture',{...point,tapCount:2,duration:50,gestureSourceType:'touch'});await b.pause(350);
  assert.equal(await b.evaluate('visualViewport.scale'),scale,'Double tap zoom on '+selector);
  assert.equal(await b.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).touchAction`),'manipulation');
 }
 await b.call('Emulation.setPageScaleFactor',{pageScaleFactor:1.5});const zoomed=await b.evaluate('visualViewport.scale');
 await b.call('Input.synthesizeTapGesture',{x:8,y:180,tapCount:2,duration:50,gestureSourceType:'touch'});await b.pause(350);
 assert.equal(await b.evaluate('visualViewport.scale'),zoomed,'Double tap must not zoom out an intentionally zoomed page');
 await b.call('Emulation.setPageScaleFactor',{pageScaleFactor:1});
 assert.equal(await b.evaluate('getComputedStyle(document.querySelector(".issuebtn")).touchAction'),'manipulation');
 assert.ok(await b.evaluate('!document.querySelector("meta[name=viewport]").content.includes("user-scalable=no")'),'Intentional accessibility zoom remains available');
 await b.call('Emulation.setTouchEmulationEnabled',{enabled:false});await b.viewport(390,900);
 await b.navigate('/security-risk/?blocked=1',setup(fixture,`Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}});`));await b.waitFor('document.querySelectorAll(".row").length===3');
 const unsafe=structuredClone(fixture);unsafe.records[0].title='<img src=x onerror=alert(1)>';unsafe.records[0].action='<script>alert(1)</script>';unsafe.records[0].sources[0].url='javascript:alert(1)';
 await b.navigate('/security-risk/?unsafe=1',setup(unsafe));await b.waitFor('document.querySelectorAll(".row").length===3');await b.evaluate('document.querySelector(".issuebtn").click()');assert.equal(await b.evaluate('document.querySelectorAll("#rows img,#rows script,#rows a[href^=javascript]").length'),0);
 await b.navigate('/security-risk/#%',setup(fixture));await b.waitFor('document.querySelectorAll(".row").length===3');
 await b.navigate('/security-risk/?empty=1',setup({...fixture,records:[]}));await b.waitFor('!!document.querySelector(".empty")');
 await b.navigate('/security-risk/?offline=1',clock+`window.fetch=()=>Promise.reject(new Error('offline'));`);await b.waitFor('document.getElementById("notice").textContent.includes("Could not load")');
 await b.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
 await b.navigate('/security-risk/?dark=1',setup(fixture));await b.waitFor('document.querySelectorAll(".row").length===3');assert.equal(await b.evaluate('getComputedStyle(document.body).backgroundColor'),'rgb(13, 16, 21)');
 assert.deepEqual(b.errors,[]);
});
console.log('PASS: compact rows, touch/keyboard disclosure, mobile controls and viewport scale, period/category/search/ranking, safe source rendering and empty/offline states.');
