#!/usr/bin/env node
/* Browser integration checks using the Chrome DevTools protocol, no packages. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const artifacts = process.env.LLM_PRICING_BROWSER_ARTIFACTS || await fsp.mkdtemp(path.join(os.tmpdir(), 'llm-pricing-v2-browser-'));
await fsp.mkdir(artifacts, {recursive: true});
const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'llm-pricing-v2-chrome-'));
const chrome = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const mime = {'.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css'};
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/v2.html' : pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
    response.setHeader('Content-Type', mime[path.extname(file)] || 'text/plain');
    response.end(await fsp.readFile(file));
  } catch {response.writeHead(404); response.end('Not found');}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const pageURL = process.env.LLM_PRICING_PAGE_URL || origin + '/v2.html';
const originalURL = process.env.LLM_PRICING_ORIGINAL_URL || (fs.existsSync(path.join(root, 'index.html')) ? origin + '/index.html#all' : null);
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
let chromeLog = '', startupError;
proc.stderr.on('data', chunk => {chromeLog += chunk.toString();});
proc.on('error', error => {startupError = error;});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, id = 0;
const pending = new Map(), exceptions = [];
try {
  const activePort = path.join(profile, 'DevToolsActivePort');
  for (let n = 0; n < 100 && !fs.existsSync(activePort); n++) {
    if (startupError) throw startupError;
    if (proc.exitCode != null) throw new Error('Chrome stopped: ' + chromeLog.slice(-1200));
    await pause(100);
  }
  if (!fs.existsSync(activePort)) throw new Error('Chrome did not start: ' + chromeLog.slice(-1200));
  const [port, wsPath] = (await fsp.readFile(activePort, 'utf8')).trim().split('\n');
  socket = new WebSocket('ws://127.0.0.1:' + port + wsPath);
  await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true});});
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const task = pending.get(message.id); pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  });
  const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => {pending.delete(next); reject(new Error('CDP timeout: ' + method));}, 12000);
    pending.set(next, {resolve, reject, timer});
    socket.send(JSON.stringify({id: next, method, params, ...(sessionId ? {sessionId} : {})}));
  });

  const viewports = [{name: 'desktop', width: 1440, height: 1050, mobile: false}, {name: 'mobile', width: 390, height: 844, mobile: true}, {name: 'narrow', width: 320, height: 740, mobile: true}, {name: 'tablet', width: 768, height: 1024, mobile: false}];
  const reports = [];
  for (const viewport of viewports) {
    const {browserContextId} = await rpc('Target.createBrowserContext');
    const {targetId} = await rpc('Target.createTarget', {url: 'about:blank', browserContextId});
    const {sessionId} = await rpc('Target.attachToTarget', {targetId, flatten: true});
    const call = (method, params) => rpc(method, params, sessionId);
    const evalJS = async expression => {
      const result = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error('Browser evaluation failed: ' + JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let n = 0; n < 100; n++) {if (await evalJS(expression)) return; await pause(75);}
      throw new Error('Browser condition timed out: ' + expression);
    };
    await call('Page.enable'); await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile});
    await call('Emulation.setTouchEmulationEnabled', {enabled: viewport.mobile, maxTouchPoints: 1});
    const clockSource = date => `(() => {const NativeDate=Date;const reference=NativeDate.parse(${JSON.stringify(date+'T12:00:00Z')});window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[reference]));}static now(){return reference;}};})();`;
    let clockId = (await call('Page.addScriptToEvaluateOnNewDocument', {source: clockSource('2026-10-02')})).identifier;
    const navigate = async date => {
      if (date) {
        await call('Page.removeScriptToEvaluateOnNewDocument', {identifier: clockId});
        clockId = (await call('Page.addScriptToEvaluateOnNewDocument', {source: clockSource(date)})).identifier;
      }
      await call('Page.navigate', {url: pageURL});
      await waitFor("document.body.dataset.ready === 'true'");
      await evalJS("document.documentElement.dataset.theme='light'");
      await evalJS('document.fonts.ready.then(()=>true)');
    };
    const saveScreenshot = async name => {
      const shot = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
      await fsp.writeFile(path.join(artifacts, name + '.png'), Buffer.from(shot.data, 'base64'));
    };
    const measure = `({rows:document.querySelectorAll('#mx tr.row').length,columns:document.querySelectorAll('#mx>thead th').length,width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,priceFont:getComputedStyle(document.querySelector('td.c')).fontSize,fontFamily:getComputedStyle(document.body).fontFamily,headingSize:getComputedStyle(document.querySelector('h1')).fontSize,wrapWidth:document.querySelector('.wrap').getBoundingClientRect().width,rowHeight:document.querySelector('tr.row').getBoundingClientRect().height,visibleRows:[...document.querySelectorAll('#mx tr.row')].filter(r=>r.getBoundingClientRect().bottom<=innerHeight&&r.getBoundingClientRect().top>=0).length,summary:document.querySelector('#summary').innerText})`;
    await navigate();
    // Expected rows come from the page's own ranking: the priced models arena ranks, in rank order.
    const expected = await evalJS(`(async () => {
      const [d, r] = await Promise.all([fetch('v2-data.json').then(x => x.json()), fetch('v2-ranking.json').then(x => x.json())]);
      const keys = Object.keys(r.models).filter(k => d.models[k]).sort((a, b) => r.models[a].rank - r.models[b].rank);
      const count = g => keys.filter(k => d.models[k].group === g).length;
      return {keys, all: keys.length, oss: count('oss'), anthropic: count('anthropic'), openai: count('openai'), google: count('google'), xai: count('xai')};
    })()`);
    const listed = key => expected.keys.includes(key);
    const toggle = key => evalJS(`document.querySelector('tr[data-k="${key}"] .mb').click()`);
    const rowCount = () => evalJS("document.querySelectorAll('#mx tr.row').length");
    const initial = await evalJS(measure);
    assert.equal(initial.rows, expected.all, viewport.name + ': All is the default view');
    assert.deepEqual(await evalJS("[...document.querySelectorAll('#mx tr.row')].map(r=>r.dataset.k)"), expected.keys, viewport.name + ': arena rank order');
    assert.deepEqual(await evalJS("[...document.querySelectorAll('#tabs .tab')].map(t=>t.dataset.g+(t.getAttribute('aria-pressed')==='true'?'*':''))"), ['all*','oss','anthropic','openai','google','xai']);
    assert.equal(initial.columns, 8, viewport.name + ': all seven providers stay visible');
    assert.ok(initial.scrollWidth <= initial.width, viewport.name + ': document overflow ' + JSON.stringify(initial));
    assert.ok(initial.visibleRows >= 14, viewport.name + ': compact information density ' + initial.visibleRows);
    assert.deepEqual(await evalJS("[...document.querySelectorAll('#mx>thead th .lg')].map(x=>x.textContent)"), ['Databricks','原廠 API','AWS Bedrock','Azure Foundry','Fireworks','Google Vertex','Alibaba']);
    assert.deepEqual(await evalJS("[...document.querySelectorAll('#mx>thead th .sh')].map(x=>x.textContent)"), ['DBX','原廠','AWS','Azure','FW','GCP','Ali']);
    assert.deepEqual(await evalJS("[...document.querySelector('#sort').options].map(x=>x.textContent)"), ['Arena rank','Cheapest','DBX edge']);
    assert.match(await evalJS("document.querySelector('#rankNote').textContent"), /arena\.ai Best Overall/);
    assert.equal(await evalJS("(()=>{const tab=document.querySelector('[data-g=all]').getBoundingClientRect(),tabs=document.querySelector('#tabs').getBoundingClientRect();return tab.left>=tabs.left-1&&tab.right<=tabs.right+1;})()"), true, 'Selected family tab is visible');
    await saveScreenshot(viewport.name);

    // Search and family tabs; legacy hashes still select a family.
    if (listed('openai/gpt-6.1-sol')) {
      await evalJS("document.querySelector('#q').value='databricks-gpt-6-1-sol';document.querySelector('#q').dispatchEvent(new Event('input',{bubbles:true}));");
      assert.equal(await rowCount(), 1);
      assert.match(await evalJS("document.querySelector('#mx').innerText"), /GPT-6.1 Sol/);
      assert.equal(await evalJS("document.querySelector('tr.row td.c').innerText.trim()"), '?');
    }
    await evalJS("document.querySelector('#q').value='';document.querySelector('#q').dispatchEvent(new Event('input',{bubbles:true}));location.hash='claude';");
    await waitFor("document.querySelector('[data-g=anthropic]').getAttribute('aria-pressed')==='true'");
    assert.equal(await rowCount(), expected.anthropic);
    if (listed('anthropic/claude-sonnet-5.5')) assert.match(await evalJS("document.querySelector('#mx').innerText"), /Sonnet 5.5/);
    for (const g of ['xai', 'google', 'oss', 'openai']) {
      await evalJS(`document.querySelector('[data-g=${g}]').click()`);
      assert.equal(await rowCount(), expected[g], viewport.name + ': ' + g + ' rows');
    }
    await evalJS("document.querySelector('[data-g=all]').click()");

    // Corrected offers remain in the expandable detail table.
    if (listed('deepseek/deepseek-v4-pro')) {
      await toggle('deepseek/deepseek-v4-pro');
      const detail = await evalJS(`({text:document.querySelector('#d-deepseek-deepseek-v4-pro').innerText,width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,headers:[...document.querySelectorAll('#d-deepseek-deepseek-v4-pro .dt th')].map(x=>x.textContent)})`);
      assert.match(detail.text, /Dedicated deployment only/);
      assert.match(detail.text, /accounts\/fireworks\/models\/deepseek-v4-pro-0813/);
      assert.match(detail.text, /snapshot|checkpoint/);
      assert.match(detail.text, /Price checked 2026-10-02/);
      assert.match(detail.text, /Availability checked 2026-10-02/);
      assert.deepEqual(detail.headers, ['Platform','In','Out','Cache read','Cache write','1h write','Δ vs DBX']);
      assert.ok(detail.scrollWidth <= detail.width, viewport.name + ': expanded detail overflow');
      assert.equal(await evalJS("document.querySelector('tr[data-k=\"deepseek/deepseek-v4-pro\"] td.c:nth-of-type(4) .d')===null"), true);
      await toggle('deepseek/deepseek-v4-pro');
    }
    if (listed('moonshot/kimi-k3')) {
      await toggle('moonshot/kimi-k3');
      const kimi = await evalJS("document.querySelector('#d-moonshot-kimi-k3').innerText");
      assert.match(kimi, /Global Priority/);
      assert.match(kimi, /6\.5625/);
      assert.match(kimi, /7\.21875/);
      await toggle('moonshot/kimi-k3');
    }
    if (listed('google/gemini-3.1-pro')) {
      await toggle('google/gemini-3.1-pro');
      assert.match(await evalJS("document.querySelector('#d-google-gemini-3-1-pro').innerText"), /Cache storage \$4\.50 \/ million token-hours/);
      await toggle('google/gemini-3.1-pro');
    }
    if (listed('openai/gpt-6.1-sol')) {
      await toggle('openai/gpt-6.1-sol');
      assert.match(await evalJS("document.querySelector('#d-openai-gpt-6-1-sol').innerText"), /Price pending verification/);
      assert.match(await evalJS("document.querySelector('#d-openai-gpt-6-1-sol').innerText"), />272K input/);
      await evalJS("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedSummary=text;}}});document.querySelector('[data-copy=\"openai/gpt-6.1-sol\"]').click();");
      await waitFor("typeof window.copiedSummary==='string'");
      assert.match(await evalJS('window.copiedSummary'), /price pending verification/);
      assert.match(await evalJS('window.copiedSummary'), /原廠 API/);
      assert.match(await evalJS('window.copiedSummary'), /Price checked 2026-10-02/);
      assert.match(await evalJS('window.copiedSummary'), /arena\.ai Best Overall #\d+/);
      await toggle('openai/gpt-6.1-sol');
    }

    // Sorting / blend controls still work; private edits leave published counts intact.
    await evalJS("document.querySelector('#sort').value='price';document.querySelector('#sort').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#sort').value='edge';document.querySelector('#sort').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#sort').value='default';document.querySelector('#sort').dispatchEvent(new Event('change',{bubbles:true}));");
    assert.deepEqual(await evalJS("[...document.querySelectorAll('#mx tr.row')].map(r=>r.dataset.k)"), expected.keys, viewport.name + ': arena rank order restored');
    if (viewport.name === 'desktop' && listed('moonshot/kimi-k3')) {
      const summaryBefore = await evalJS("[...document.querySelectorAll('#summary .kpi')].map(k=>k.innerText).join('|')");
      await evalJS("localStorage.setItem('llm-pricing-edits-v3','ORIGINAL');localStorage.setItem('llm-pricing-prefs-v3','ORIGINAL');document.querySelector('#editBtn').click();document.querySelector('tr[data-k=\"moonshot/kimi-k3\"] .mb').click();");
      await evalJS("(()=>{const e=document.querySelector('[data-e=\"moonshot/kimi-k3|official|in\"]');e.value='4';e.dispatchEvent(new Event('change',{bubbles:true}));})();");
      assert.equal(await evalJS("localStorage.getItem('llm-pricing-edits-v3')"), 'ORIGINAL');
      assert.equal(await evalJS("localStorage.getItem('llm-pricing-prefs-v3')"), 'ORIGINAL');
      await waitFor("/4\\.00/.test(document.querySelector('tr[data-k=\"moonshot/kimi-k3\"] td.c:nth-of-type(2)').innerText)");
      // A personal price is a what-if: its Δ appears in the table while the published figures stay put.
      assert.equal(await evalJS("document.querySelector('tr[data-k=\"moonshot/kimi-k3\"] td.c:nth-of-type(2) .d').textContent"), '▲13%');
      assert.equal(await evalJS("[...document.querySelectorAll('#summary .kpi')].map(k=>k.innerText).join('|')"), summaryBefore);
      assert.match(await evalJS("document.querySelector('#summary .enote').textContent"), /published prices/);
      await evalJS("(()=>{const e=document.querySelector('[data-e=\"moonshot/kimi-k3|official|in\"]');e.value='-1';e.dispatchEvent(new Event('change',{bubbles:true}));})();");
      assert.equal(await evalJS("document.querySelector('[data-e=\"moonshot/kimi-k3|official|in\"]').value"), '4');
      await evalJS("(()=>{const e=document.querySelector('[data-e=\"moonshot/kimi-k3|official|in\"]');e.value='';e.dispatchEvent(new Event('change',{bubbles:true}));})();");
      // Clearing a personal price restores the published one and removes the edit.
      await waitFor("document.querySelector('[data-e=\"moonshot/kimi-k3|official|in\"]').value==='3' && !document.querySelector('#editNote').textContent");
      await evalJS("document.querySelector('#resetBtn').click();document.querySelector('#resetBtn').click();document.querySelector('#editBtn').click();document.querySelector('tr[data-k=\"moonshot/kimi-k3\"] .mb').click();");
    }
    await evalJS("document.querySelector('#blend').value='1';document.querySelector('#blend').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#blend').value='3';document.querySelector('#blend').dispatchEvent(new Event('change',{bubbles:true}));document.documentElement.dataset.theme='dark';window.scrollTo(0,0);");
    await saveScreenshot(viewport.name + '-dark');
    const finalWidth = await evalJS('({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth})');
    assert.ok(finalWidth.scrollWidth <= finalWidth.width, viewport.name + ': final document overflow');

    if (viewport.name === 'desktop') {
      await navigate('2026-10-30');
      if (listed('tml/inkling')) assert.equal(await evalJS("document.querySelector('tr[data-k=\"tml/inkling\"] td.c').innerText.trim()"), '✕');
      await navigate('2027-02-01');
      if (listed('google/gemini-3.1-pro')) assert.match(await evalJS("document.querySelector('tr[data-k=\"google/gemini-3.1-pro\"] td.c').title"), /\$2\.50 \/ \$15\.00/);
      if (listed('google/gemini-3.8-flash')) assert.match(await evalJS("document.querySelector('tr[data-k=\"google/gemini-3.8-flash\"] td.c').innerText"), /1\.50/);
      if (listed('xai/grok-4.6')) assert.match(await evalJS("document.querySelector('tr[data-k=\"xai/grok-4.6\"] td.c').innerText"), /2\.50/);
      await call('Page.removeScriptToEvaluateOnNewDocument', {identifier: clockId});
      clockId = (await call('Page.addScriptToEvaluateOnNewDocument', {source: clockSource('2026-10-02')})).identifier;
    }
    if (originalURL) {
      await call('Page.navigate', {url: originalURL});
      await waitFor("document.querySelectorAll('#mx tr.row').length>0");
      await evalJS("document.documentElement.dataset.theme='light';document.querySelector('[data-g=all]').click()");
      await evalJS('document.fonts.ready.then(()=>true)');
      await evalJS("document.querySelector('[data-g=oss]').click()");
      const original = await evalJS(measure);
      // Same typeface and provider columns as the original, with at least as many rows on screen.
      assert.equal(original.fontFamily, initial.fontFamily, 'Original font family: ' + viewport.name);
      assert.equal(original.columns, initial.columns, 'Original provider columns: ' + viewport.name);
      assert.ok(initial.visibleRows >= original.visibleRows, `v2 shows fewer rows than the original at ${viewport.name}: ${initial.visibleRows} < ${original.visibleRows}`);
      await saveScreenshot('original-' + viewport.name);
      initial.originalStyle = original;
    }
    reports.push({viewport, initial, expected: expected.all, integration: 'passed'});
    console.log(`${viewport.name}: ${initial.columns - 1} providers, ${initial.visibleRows} visible rows${initial.originalStyle ? ` (original: ${initial.originalStyle.visibleRows})` : ''}, no document overflow; details, filters and pricing checks passed.`);
    await rpc('Target.disposeBrowserContext', {browserContextId});
  }
  assert.equal(exceptions.length, 0, 'Uncaught browser exceptions: ' + JSON.stringify(exceptions));
  await fsp.writeFile(path.join(artifacts, 'browser-report.json'), JSON.stringify({reports, exceptions}, null, 2) + '\n');
  console.log('Browser artifacts: ' + artifacts);
} finally {
  if (socket) socket.close();
  for (const task of pending.values()) clearTimeout(task.timer);
  server.close();
  proc.kill('SIGTERM');
  const cleanupTimer = setTimeout(() => {if (proc.exitCode == null) proc.kill('SIGKILL');}, 1000);
  cleanupTimer.unref();
}
