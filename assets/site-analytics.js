/* Shared analytics: leave the site code empty until a GoatCounter site is configured. */
(() => {
  'use strict';
  const ownScript = document.currentScript;
  const base = new URL('../',ownScript.src);
  function parseCount(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (typeof value !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) return null;
    const count = Number(value.replaceAll(',',''));
    return Number.isSafeInteger(count) ? count : null;
  }
  function pagePath(path) {
    // Match directory and index.html URLs; query strings/fragments never split counts.
    const url = new URL(path,base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Invalid analytics path');
    return url.pathname.replace(/\/index\.html$/,'/');
  }
  const ready = (async () => {
    try {
      const response = await fetch(new URL('analytics-config.json',base),{cache:'no-cache',signal:AbortSignal.timeout(5000)});
      if (!response.ok) return null;
      const config = await response.json();
      const code = config?.goatcounterSiteCode;
      if (typeof code !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(code)) return null;
      const dashboard = 'https://'+code+'.goatcounter.com';
      // Only production page loads count. Preview/localhost requests cannot pollute totals.
      if (location.hostname === 'peteragility.github.io' && base.pathname === '/demo/') {
        window.goatcounter = {no_onload:true,no_events:true,path:pagePath(location.pathname),referrer:() => {
          try {const u=new URL(document.referrer);return u.origin+u.pathname;} catch {return '';}
        }};
        const tracker = document.createElement('script');
        tracker.dataset.goatcounter=dashboard+'/count';tracker.async=true;tracker.src='https://gc.zgo.at/count.js';
        tracker.onload = () => {
          const counter = window.goatcounter;
          const getData = counter.get_data, filter = counter.filter;
          if (typeof getData !== 'function' || typeof filter !== 'function') return;
          // count.js includes location.search separately as q, even with a custom path.
          counter.get_data = vars => { const data = getData(vars); data.q = ''; return data; };
          // The vendor filter reads localStorage; unavailable storage must not break the page.
          counter.filter = () => { try { return filter(); } catch { return 'browser storage unavailable'; } };
          const count = () => counter.count();
          if (document.visibilityState !== 'hidden') count();
          else {
            const visible = () => {
              if (document.visibilityState !== 'visible') return;
              document.removeEventListener('visibilitychange',visible);
              count();
            };
            document.addEventListener('visibilitychange',visible);
          }
        };
        document.head.append(tracker);
      }
      return {dashboard, async visits(paths) {
        const values = await Promise.all(paths.map(async path => {
          try {
            const url=dashboard+'/counter/'+encodeURIComponent(pagePath(path))+'.json';
            const response=await fetch(url,{mode:'cors',credentials:'omit',signal:AbortSignal.timeout(5000)});
            // Unknown paths and network/permission errors are unavailable, never invented zeros.
            if (!response.ok) return [path,null];
            return [path,parseCount((await response.json()).count)];
          } catch {return [path,null];}
        }));
        return new Map(values);
      }};
    } catch {return null;}
  })();
  window.demoAnalytics = Object.freeze({ready});
})();
