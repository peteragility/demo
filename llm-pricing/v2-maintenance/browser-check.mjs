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
    await call('Page.navigate', {url: pageURL});
    await waitFor("document.body.dataset.ready === 'true'");
    await evalJS("document.documentElement.dataset.theme='light';document.querySelector('#asOf').value='2026-10-02';document.querySelector('#asOf').dispatchEvent(new Event('input',{bubbles:true}));");
    const initial = await evalJS(`({rows:document.querySelectorAll('#prices tr.row').length,columns:document.querySelectorAll('#prices thead th').length, width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth, priceFont:getComputedStyle(document.querySelector('.io')).fontSize,summary:document.querySelector('#summary').innerText})`);
    assert.equal(initial.rows, 38, viewport.name + ': model count');
    assert.equal(initial.columns, viewport.width <= 760 ? 4 : 8, viewport.name + ': provider columns');
    assert.ok(initial.scrollWidth <= initial.width, viewport.name + ': document overflow ' + JSON.stringify(initial));
    if (viewport.width <= 760) assert.ok(parseFloat(initial.priceFont) >= 15);
    const screenshot = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    await fsp.writeFile(path.join(artifacts, viewport.name + '.png'), Buffer.from(screenshot.data, 'base64'));

    // Filters, latest-model additions, endpoint search and legacy family hashes.
    await evalJS("document.querySelector('#newOnly').click();");
    assert.equal(await evalJS("document.querySelectorAll('#prices tr.row').length"), 6);
    await evalJS("document.querySelector('#newOnly').click();document.querySelector('#search').value='databricks-gpt-6-1-sol';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}));");
    assert.equal(await evalJS("document.querySelectorAll('#prices tr.row').length"), 1);
    assert.match(await evalJS("document.querySelector('#prices').innerText"), /GPT-6.1 Sol/);
    await evalJS("document.querySelector('#search').value='';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}));location.hash='claude';");
    await waitFor("document.querySelector('[data-group=anthropic]').getAttribute('aria-pressed')==='true'");
    assert.equal(await evalJS("document.querySelectorAll('#prices tr.row').length"), 7);
    await evalJS("document.querySelector('[data-group=all]').click();");

    // Expand a row: version exceptions, source links and provider states fit the viewport.
    await evalJS("document.querySelector('[data-model-button=\"deepseek/deepseek-v4-pro\"]').click();");
    const detail = await evalJS(`({text:document.querySelector('#detail-deepseek-deepseek-v4-pro').innerText,width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,offers:document.querySelectorAll('#detail-deepseek-deepseek-v4-pro [data-offer-platform]').length})`);
    assert.equal(detail.offers, 7);
    assert.match(detail.text, /Dedicated deployment only/);
    assert.match(detail.text, /snapshot|checkpoint/);
    assert.ok(detail.scrollWidth <= detail.width, viewport.name + ': expanded row overflow');
    await evalJS("document.querySelector('[data-model-button=\"deepseek/deepseek-v4-pro\"]').click();");

    if (viewport.width <= 760) {
      await evalJS("const provider=document.querySelector('#mobileProvider');provider.value='azure_foundry';provider.dispatchEvent(new Event('change',{bubbles:true}));");
      assert.match(await evalJS("document.querySelector('#prices thead').innerText"), /Azure Foundry/);
    }

    // Actual controls must use the same context, cache and date rules as the tested math.
    await evalJS("document.querySelector('#calculator').open=true;");
    const setField = async (selector, value, event = 'input') => evalJS(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(String(value))};document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));`);
    await setField('#calcModel', 'moonshot/kimi-k3', 'change');
    await setField('#cacheHit', 80); await setField('#writeM', 0.5);
    assert.match(await evalJS("document.querySelector('[data-result-platform=bedrock]').innerText"), /17.895/);
    assert.match(await evalJS("document.querySelector('[data-result-platform=databricks]').innerText"), /Estimate incomplete/);
    await setField('#writeM', 0);
    await evalJS("const s=document.querySelector('#tier-bedrock');s.value=[...s.options].find(o=>o.textContent==='Regional Priority').value;s.dispatchEvent(new Event('change',{bubbles:true}));");
    assert.match(await evalJS("document.querySelector('[data-result-platform=bedrock]').innerText"), /33.726/);
    assert.match(await evalJS("document.querySelector('[data-result-platform=bedrock]').innerText"), /Δ excluded/);
    await setField('#cacheHit', 101);
    assert.equal(await evalJS("document.querySelectorAll('#calcResults .result').length"), 0);
    assert.equal(await evalJS("document.querySelector('#calcError').hidden"), false);
    await setField('#cacheHit', 0);
    await setField('#calcModel', 'google/gemini-3.5-flash-lite', 'change');
    await setField('#asOf', '2027-02-01');
    assert.match(await evalJS("document.querySelector('[data-result-platform=databricks]').innerText"), /4.25/);
    await setField('#asOf', '2026-10-30');
    await setField('#calcModel', 'tml/inkling', 'change');
    assert.match(await evalJS("document.querySelector('[data-result-platform=databricks]').innerText"), /Retired/);
    await setField('#asOf', '2026-10-02');
    await setField('#calcModel', 'openai/gpt-6.1-sol', 'change');
    assert.match(await evalJS("document.querySelector('[data-result-platform=databricks]').innerText"), /pending verification/);
    await setField('#promptTokens', 272001);
    assert.match(await evalJS("document.querySelector('[data-result-platform=official]').innerText"), /27.00/);
    await setField('#promptTokens', 1000);

    // Copy text without changing the user's system clipboard.
    await evalJS("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedEstimate=text;}}});document.querySelector('#copyEstimate').click();");
    await waitFor("typeof window.copiedEstimate==='string'");
    assert.match(await evalJS('window.copiedEstimate'), /Price pending verification/);
    assert.match(await evalJS('window.copiedEstimate'), /Price checked 2026-10-02/);

    // Isolated browser-only overrides must leave the original page's keys alone.
    if (viewport.name === 'desktop') {
      await evalJS("localStorage.setItem('llm-pricing-edits-v3','ORIGINAL');localStorage.setItem('llm-pricing-prefs-v3','ORIGINAL');document.querySelector('#editPrices').click();document.querySelector('[data-model-button=\"moonshot/kimi-k3\"]').click();");
      await evalJS("const form=document.querySelector('[data-override-model=\"moonshot/kimi-k3\"][data-override-platform=official]');form.elements.in.value='4';form.requestSubmit();");
      assert.equal(await evalJS("localStorage.getItem('llm-pricing-edits-v3')"), 'ORIGINAL');
      assert.equal(await evalJS("localStorage.getItem('llm-pricing-prefs-v3')"), 'ORIGINAL');
      assert.match(await evalJS("document.querySelector('[data-model=\"moonshot/kimi-k3\"] [data-platform=official]').innerText"), /Personal/);
      assert.equal(await evalJS("document.querySelector('[data-model=\"moonshot/kimi-k3\"] [data-platform=official] .delta')===null"), true);
      await evalJS("document.querySelector('#clearOverrides').click();document.querySelector('#clearOverrides').click();document.querySelector('#editPrices').click();document.querySelector('[data-model-button=\"moonshot/kimi-k3\"]').click();");
    }
    await evalJS("document.querySelector('#calculator').open=false;document.querySelector('#theme').click();window.scrollTo(0,0);");
    await pause(100);
    const dark = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    if (viewport.name === 'desktop' || viewport.name === 'mobile') await fsp.writeFile(path.join(artifacts, viewport.name + '-dark.png'), Buffer.from(dark.data, 'base64'));
    const finalWidth = await evalJS('({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth})');
    assert.ok(finalWidth.scrollWidth <= finalWidth.width, viewport.name + ': final document overflow');
    reports.push({viewport, initial, integration: 'passed'});
    console.log(`${viewport.name}: ${initial.rows} models, ${initial.columns - 1} providers, no overflow; calculator, filters, date and tier checks passed.`);
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
