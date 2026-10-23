import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export async function withBrowser(root, task) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'peter-browser-'));
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
      if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
      const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
      response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      response.end(await fs.readFile(file));
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const chrome = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  const proc = spawn(chrome, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--user-data-dir=' + profile,'about:blank'], {stdio:['ignore','ignore','pipe']});
  let log = '', launchError, socket, id = 0, initId;
  const pending = new Map(), errors = [];
  proc.stderr.on('data', chunk => log += chunk);
  proc.on('error', error => launchError = error);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let n = 0; n < 300; n++) {
      if (launchError) throw launchError;
      try { await fs.access(portFile); break; } catch {}
      if (proc.exitCode !== null) throw new Error('Chrome stopped: ' + log.slice(-1000));
      await pause(100);
    }
    let portData;
    try { portData = await fs.readFile(portFile, 'utf8'); }
    catch { throw new Error('Chrome did not expose its debugging port within 30 seconds: ' + log.slice(-2000)); }
    const [port, wsPath] = portData.trim().split('\n');
    socket = new WebSocket('ws://127.0.0.1:' + port + wsPath);
    await new Promise((resolve,reject) => {socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    });
    const rpc = (method, params = {}, sessionId) => new Promise((resolve,reject) => {
      const next = ++id;
      const timer = setTimeout(() => {pending.delete(next);reject(new Error('CDP timeout: ' + method));},15000);
      pending.set(next,{resolve,reject,timer});
      socket.send(JSON.stringify({id:next,method,params,...(sessionId ? {sessionId} : {})}));
    });
    const {targetId} = await rpc('Target.createTarget',{url:'about:blank'});
    const {sessionId} = await rpc('Target.attachToTarget',{targetId,flatten:true});
    const call = (method,params={}) => rpc(method,params,sessionId);
    await call('Page.enable'); await call('Runtime.enable');
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
      return result.result.value;
    };
    const waitFor = async expression => {
      for(let n=0;n<120;n++) {try {if(await evaluate(expression)) return;} catch {} await pause(100);}
      throw new Error('Browser condition timed out: ' + expression);
    };
    const navigate = async (url, setup='') => {
      if(initId) {await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:initId});initId=null;}
      if(setup) initId=(await call('Page.addScriptToEvaluateOnNewDocument',{source:setup})).identifier;
      await call('Page.navigate',{url:url.startsWith('http') ? url : origin + url});
      await waitFor('document.readyState !== "loading" && !!document.documentElement && (!!document.body || document.documentElement.localName === "svg")'); await pause(180);
    };
    const viewport = (width,height=900) => call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const screenshot = async (file,width=1200,height=630) => {
      await viewport(width,height);const image=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await fs.writeFile(file,Buffer.from(image.data,'base64'));
    };
    await task({origin,call,evaluate,waitFor,navigate,viewport,screenshot,pause,errors});
  } finally {
    for(const item of pending.values()) {clearTimeout(item.timer);item.reject(new Error('Browser closed'));}
    socket?.close();
    if(proc.exitCode===null && proc.pid) {const stopped=new Promise(resolve=>proc.once('exit',resolve));proc.kill('SIGTERM');await stopped;}
    await new Promise(resolve => server.close(resolve));
    await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
}
