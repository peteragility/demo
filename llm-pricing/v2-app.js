(() => {
  'use strict';
  const M = window.LLMPricingMath;
  const PL = ['databricks','official','fireworks','azure_foundry','bedrock','gcloud','alicloud'];
  const LONG = {databricks:'Databricks',official:'原廠 API',bedrock:'AWS Bedrock',azure_foundry:'Azure Foundry',gcloud:'Google Vertex',fireworks:'Fireworks',alicloud:'Alibaba'};
  const SHORT = {databricks:'DBX',official:'原廠',bedrock:'AWS',azure_foundry:'Azure',gcloud:'GCP',fireworks:'FW',alicloud:'Ali'};
  const ORDER = ['oss','anthropic','openai','google','xai','other'];
  // [hash id, label, phone label]
  const TABS = [['all','All','All'],['oss','OSS','OSS'],['anthropic','Anthropic','Claude'],['openai','OpenAI','GPT'],['google','Google','Gemini'],['xai','xAI','Grok'],['other','Other','Other']];
  const HASH_ALIAS = new Map([['claude','anthropic'],['gpt','openai'],['gemini','google'],['grok','xai']]);
  const PREF_KEY = 'llm-pricing-v2-preferences';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const slug = k => k.replace(/[^a-z0-9]+/gi, '-');
  const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  // Promotions and retirements switch on the viewer's local calendar date, rechecked while the tab stays open.
  const shift = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const localDate = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  let AS_OF = localDate();

  const saved = store.get(PREF_KEY, {});
  const prefs = isObject(saved) ? saved : {};
  const S = { group: 'all', q: '', sort: ['default','price','edge'].includes(prefs.sort) ? prefs.sort : 'default', blend: [1,3,10].includes(+prefs.blend) ? +prefs.blend : 3,
    talk: typeof prefs.talk === 'boolean' ? prefs.talk : null, open: new Set() };
  let RAW = null, RESOLVED = null, DATA = null, PICK = null, SUMMARY = null, SUMMARY_KEY = '', WATCH = null, RANKING = null, CHECKS = null;
  // The page is read-only: drop personal prices saved by its earlier editable version.
  store.del('llm-pricing-v2-overrides');
  if (prefs.theme === 'light' || prefs.theme === 'dark') document.documentElement.dataset.theme = prefs.theme;
  const savePrefs = () => { prefs.sort = S.sort; prefs.blend = S.blend; if (S.talk != null) prefs.talk = S.talk; store.set(PREF_KEY, prefs); };
  // Assign markup only when it changed, so unchanged regions keep focus and screen readers stay quiet.
  const paint = (el, html) => { if (el._html !== html) { el.innerHTML = html; el._html = html; } };

  const groupOf = (k, m) => m.group || (m.oss ? 'oss' : ({anthropic:'anthropic',openai:'openai',google:'google'}[k.split('/')[0]] || 'oss'));
  const kind = c => !c ? 'unk' : c.status === 'dedicated' ? 'gpu' : ['unavailable','retired'].includes(c.status) ? 'na' : c.status === 'priced' && M.validRate(c.in) && M.validRate(c.out) && !(c.problems || []).length ? 'ok' : 'unk';
  // The offer a cell shows and compares: the platform's cheapest standard price.
  const shown = (mk, pl) => PICK[mk][pl] || DATA.models[mk].platforms[pl];
  const blendOf = c => kind(c) !== 'ok' ? null : (S.blend * c.in + c.out) / (S.blend + 1);
  const deltaOf = (mk, pl) => { const a = PICK[mk][pl], b = PICK[mk].databricks; return pl === 'databricks' || !a || !b ? null : M.delta(a, b, S.blend).value; };
  const dirOf = d => d == null ? null : d > M.PARITY ? 'up' : d < -M.PARITY ? 'down' : 'par';
  const pct = d => Math.round(Math.abs(d) * 100) + '%';
  const dLabel = (d, dir) => dir === 'par' ? '=' : (dir === 'up' ? '▲' : '▼') + pct(d);
  function fmt(v) {
    if (v == null || v === '' || !isFinite(+v)) return '—';
    v = +v;
    if (v >= 1) return v.toFixed(2);
    let s = String(+v.toPrecision(3));
    if (s.indexOf('e') >= 0) s = v.toFixed(4);
    return (s.split('.')[1] || '').length < 2 ? v.toFixed(2) : s;
  }
  const precise = v => M.validRate(v) ? v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:6}) : '—';
  const srcUrl = (c, pl) => { if (c && c.url) return c.url; const id = (c && c.src) || (DATA.platform_meta && DATA.platform_meta[pl] && DATA.platform_meta[pl].src); return id && DATA.source_meta && DATA.source_meta[id] ? DATA.source_meta[id].url : null; };
  const shortAlt = a => a.short || String(a.name).replace(/^(DeepSeek|Kimi|Claude)\s+/i, '');
  // Dated notices and talk-track lines: plain strings always apply; {text, from, until} apply within their
  // dates, and lines naming models only while one of them is listed.
  const active = list => (Array.isArray(list) ? list : list ? [list] : [])
    .filter(n => typeof n === 'string' || (isObject(n) && n.text && (!n.from || AS_OF >= n.from) && (!n.until || AS_OF <= n.until) &&
      (!Array.isArray(n.models) || n.models.some(isListed))))
    .map(n => typeof n === 'string' ? n : n.text);
  const notices = m => active(m.notices || m.warn);

  function resolveAll() {
    const models = {};
    for (const [k, m] of Object.entries(RAW.models || {})) {
      models[k] = {};
      for (const pl of PL) models[k][pl] = M.resolveOffer((m.platforms || {})[pl], {asOf: AS_OF});
    }
    return {asOf: AS_OF, models};
  }
  // Offers as of the viewer's date, then each platform's cheapest standard price.
  function prepare() {
    if (!RESOLVED || RESOLVED.asOf !== AS_OF) RESOLVED = resolveAll();
    DATA = {...RAW, models: {}};
    for (const [k, m] of Object.entries(RAW.models || {})) {
      DATA.models[k] = {...m, name: m.name || k.split('/').pop(), maker: m.maker || k.split('/')[0], platforms: {...RESOLVED.models[k]}};
    }
    pickAll();
  }
  function pickAll() {
    PICK = {};
    const options = {asOf: AS_OF, inputRatio: S.blend};
    for (const k of Object.keys(DATA.models)) {
      PICK[k] = {};
      for (const pl of PL) PICK[k][pl] = M.cheapest((RAW.models[k].platforms || {})[pl], options);
    }
  }

  // The arena.ai Best Overall ranking decides which models appear and their default order. A model is
  // listed only while a compared platform hosts it; the maker's own API alone does not count.
  const rankOf = k => RANKING && RANKING.models[k] ? RANKING.models[k].rank : null;
  const offered = c => Boolean(c) && (c.status === 'priced' || c.status === 'dedicated' || (c.status === 'unverified' && c.available));
  const hosted = k => PL.some(pl => pl !== 'official' && offered(RESOLVED.models[k][pl]));
  const isListed = k => (!RANKING || rankOf(k) != null) && hosted(k);
  const listed = () => Object.entries(DATA.models).filter(([k]) => isListed(k));
  function rows() {
    const q = S.q.trim().toLowerCase();
    let arr = listed().map(([k, m], i) => ({ k, m, i: rankOf(k) ?? i, g: groupOf(k, m) }));
    if (S.group !== 'all') arr = arr.filter(r => r.g === S.group);
    if (q) arr = arr.filter(r => [r.k, r.m.name, r.m.short, r.m.maker, r.m.about, ...Object.values(r.m.platforms).map(c => c.model_id)].join(' ').toLowerCase().includes(q));
    if (S.sort === 'price') {
      // Cheapest standard price on any platform, so models Databricks does not offer sort fairly too.
      const cost = new Map(arr.map(r => [r.k, Math.min(...PL.map(pl => blendOf(shown(r.k, pl)) ?? Infinity))]));
      arr.sort((a, b) => cost.get(a.k) - cost.get(b.k) || a.i - b.i);
    } else if (S.sort === 'edge') {
      const score = new Map(arr.map(r => [r.k, edge(r)]));
      arr.sort((a, b) => score.get(b.k) - score.get(a.k) || a.i - b.i);
    } else arr.sort((a, b) => a.i - b.i);
    return arr;
  }
  // +1 for each platform without the model or pricier than DBX, −1 for each cheaper one; summed Δ breaks ties.
  function edge(r) {
    if (!PICK[r.k].databricks) return -Infinity;
    let s = 0, sum = 0;
    for (const pl of PL) {
      if (pl === 'databricks') continue;
      if (kind(r.m.platforms[pl]) === 'na') { s += 1; continue; }
      const d = deltaOf(r.k, pl);
      if (d != null) { sum += d; s += d > M.PARITY ? 1 : d < -M.PARITY ? -1 : 0; }
    }
    return s + sum / 100;
  }

  function tip(pl, c, d, dir) {
    const bits = [LONG[pl] + ': $' + precise(c.in) + ' / $' + precise(c.out)];
    if (c.cache_read != null) bits.push('cache read $' + precise(c.cache_read));
    if (c.cache_write != null) bits.push('cache write $' + precise(c.cache_write));
    else if ((c.endpoints || {}).cache_write === 'input-rate' && c.cache_read != null) bits.push('no cache-write charge');
    if (c.tier) bits.push(c.tier + (c.variant_id ? ' (cheapest standard tier)' : ''));
    if (c.pricing_checked_at) bits.push('price checked ' + c.pricing_checked_at);
    if (c.model_id) bits.push(c.model_id);
    if (d != null && pl !== 'databricks') bits.push(dir === 'par' ? 'parity with DBX' : (dir === 'up' ? '+' : '−') + pct(d) + ' vs DBX (' + S.blend + ':1 blend)');
    return bits.join(' · ');
  }

  const io = c => `<span class="io"><span class="i">${fmt(c.in)}</span><span class="sl">/</span><span class="o">${fmt(c.out)}</span></span>`;
  function cellHtml(r, pl) {
    const c = shown(r.k, pl), k = kind(c);
    const shade = pl === 'databricks' ? ' dbx' : '';
    if (k === 'gpu') return `<td class="c na${shade}" title="${esc(LONG[pl] + ': dedicated deployment only · ' + (c.note || 'No verified per-token offer'))}"><span class="x" aria-label="dedicated deployment only">GPU</span></td>`;
    if (k === 'na') {
      const a = c.alt;
      const state = c.status === 'retired' ? 'retired on ' + c.retires_on : 'not offered';
      const t = LONG[pl] + ': ' + state + (a ? ' · closest ' + a.name + ' $' + fmt(a.in) + ' / $' + fmt(a.out) : '') + (c.note ? ' · ' + c.note : '');
      return `<td class="c na${shade}" title="${esc(t)}"><span class="x" aria-label="${esc(state)}">✕</span>${a ? `<span class="alt"><span class="an">${esc(shortAlt(a))}</span><span class="ap"> ${fmt(a.in)} / ${fmt(a.out)}</span></span>` : ''}</td>`;
    }
    if (k === 'unk') return `<td class="c unk${shade}" title="${esc(LONG[pl] + ': ' + ((c && c.note) || 'not verified'))}"><span class="q" aria-label="not verified">?</span></td>`;
    if (pl === 'databricks') return `<td class="c dbx" title="${esc(tip(pl, c))}">${io(c)}</td>`;
    const d = deltaOf(r.k, pl), dir = dirOf(d);
    const ar = dir && dir !== 'par' ? `<span class="ar ${dir}" aria-hidden="true">${dir === 'up' ? '▲' : '▼'}</span>` : '';
    return `<td class="c ${dir || ''}" title="${esc(tip(pl, c, d, dir))}"><span class="io"><span class="i">${fmt(c.in)}</span><span class="sl">/</span><span class="o">${fmt(c.out)}${ar}</span></span>${d != null ? `<span class="d ${dir}">${dLabel(d, dir)}</span>` : ''}</td>`;
  }

  function rowHtml(r) {
    const m = r.m, open = S.open.has(r.k), warn = notices(m).join(' · ');
    const badges = (m.badges || []).map(b => `<span class="bdg">${esc(b)}</span>`).join('') + (warn ? `<span class="bdg warn" title="${esc(warn)}">!</span>` : '');
    const meta = [m.maker, m.ctx && (m.ctx + ' ctx')].filter(Boolean).join(' · ');
    const rank = rankOf(r.k);
    return `<tr class="row${open ? ' open' : ''}" data-k="${esc(r.k)}"><th scope="row" class="m"><button type="button" class="mb" aria-expanded="${open}"${open ? ` aria-controls="d-${slug(r.k)}"` : ''}><span class="nm">${rank != null ? `<span class="rk" title="arena.ai Best Overall rank">${rank}</span>` : ''}<span class="f">${esc(m.name)}</span><span class="s">${esc(m.short || m.name)}</span>${badges}<span class="chev" aria-hidden="true">›</span></span><span class="mk">${esc(meta)}</span></button></th>${PL.map(pl => cellHtml(r, pl)).join('')}</tr>`;
  }

  // Why a priced cell has no Δ, or which tier its Δ uses. Plain text: the card escapes it, the copied summary uses it as is.
  function comparisonNote(mk, pl, c) {
    if (kind(c) !== 'ok') return null;
    const pick = PICK[mk][pl], base = PICK[mk].databricks;
    if (pl === 'databricks') return pick && pick.variant_id ? 'Δ baseline is the cheapest standard tier: ' + pick.tier + ' $' + precise(pick.in) + ' / $' + precise(pick.out) : null;
    if (!base) return 'Δ excluded: no verified Databricks price.';
    if (!pick) return 'Δ excluded: ' + (M.comparisonReason(c, base) || 'no standard price for the confirmed model version.');
    const why = M.delta(pick, base, S.blend).reason;
    if (why) return 'Δ excluded: ' + why;
    return pick.variant_id ? 'Δ uses the cheapest standard tier: ' + pick.tier + ' $' + precise(pick.in) + ' / $' + precise(pick.out) : null;
  }

  // Detail cards: one per platform. A price table (endpoint × tier rows; input, output and cache
  // columns), then where the platform runs the model, Hong Kong / Taiwan, notes and IDs.
  const SCOPE_LABEL = {global: 'Global', geographic: 'Geo', 'data-zone': 'Data Zone', regional: 'In-region', unverified: 'Endpoint'};
  const SCOPE_RANK = {global: 0, geographic: 1, 'data-zone': 2, regional: 3, unverified: 4};
  const TIERS = ['Standard', 'Priority', 'Fast', 'Ultrafast', 'Flex', 'Batch', 'Off-peak', 'Contributor'];
  const TIER_OF = {standard: 'Standard', priority: 'Priority', flex: 'Flex', batch: 'Batch', 'off-peak': 'Off-peak', contributor: 'Contributor'};
  // Where requests are processed: [badge class, default label].
  const LEVEL = {'in-region': ['in', 'In-region'], geo: ['geo', 'Geo'], global: ['gl', 'Global'], unknown: ['no', '? Not published'], none: ['no', 'None']};
  const STATE = {'in-region': ['in', '● In-region'], routed: ['gl', '◐ Routed'], none: ['no', '✕ None'], unknown: ['no', '? Not published']};
  const badge = (cls, text) => `<span class="lv ${cls}">${esc(text)}</span>`;
  // Cards show exact published rates: at least two decimals, never rounded.
  const fx = v => { if (!M.validRate(v)) return '—'; const [a, b = ''] = String(Math.round(v * 1e6) / 1e6).split('.'); return a + '.' + (b + '00').slice(0, Math.max(2, b.length)); };

  function offersOf(mk, pl) {
    const raw = RAW.models[mk].platforms[pl], base = DATA.models[mk].platforms[pl];
    if (!raw || base.status !== 'priced') return [];
    const out = [{offer: base, label: base.tier || 'Listed tier'}];
    for (const v of raw.variants || []) {
      if (v.context_only || v.future_only) continue;
      out.push({offer: M.resolveOffer(raw, {asOf: AS_OF, variantId: v.id}), label: v.label});
    }
    return out;
  }

  // Input, output, cache read, cache write (and 1-hour write) cells for one offer.
  function rateCells(o, policy, has1h) {
    const read = M.validRate(o.cache_read) ? fx(o.cache_read) : '—';
    const write = M.validRate(o.cache_write) ? fx(o.cache_write)
      : policy === 'input-rate' && M.validRate(o.cache_read) ? '<span class="ci" title="No cache-write charge: tokens written to the cache cost only the normal input price">0.00</span>' : '—';
    return `<td>${fx(o.in)}</td><td>${fx(o.out)}</td><td>${read}</td><td>${write}</td>${has1h ? `<td>${M.validRate(o.cache_write_1h) ? fx(o.cache_write_1h) : '—'}</td>` : ''}`;
  }

  function priceTable(mk, pl) {
    const c = DATA.models[mk].platforms[pl], pick = PICK[mk][pl], groups = new Map();
    for (const {offer, label} of offersOf(mk, pl)) {
      const name = offer.endpoint || SCOPE_LABEL[offer.comparison_scope] || 'Global', rank = SCOPE_RANK[offer.comparison_scope] ?? 5;
      if (!groups.has(name)) groups.set(name, {rank, rows: []});
      const g = groups.get(name);
      g.rank = Math.min(g.rank, rank);
      g.rows.push({offer, label, tier: offer.tier_label || TIER_OF[offer.service_tier] || 'Standard'});
    }
    // Rows that share a tier within one endpoint are told apart by their own label.
    for (const [name, g] of groups) {
      for (const r of g.rows) {
        const twin = g.rows.filter(x => x.tier === r.tier).length > 1;
        r.head = twin ? (r.label.startsWith(name + ' · ') ? r.label.slice(name.length + 3) : r.label) : r.tier;
      }
    }
    if (!groups.size) return '';
    const offers = [...groups.values()].flatMap(g => g.rows.map(r => r.offer));
    const has1h = offers.some(o => M.validRate(o.cache_write_1h));
    const policy = c.endpoints && c.endpoints.cache_write, cols = has1h ? 6 : 5;
    const isPick = o => pick && !o.problems.length && (pick.variant_id || 'base') === (o.variant_id || 'base');
    const lc = c.context_threshold ? (c.context_threshold_inclusive ? '≥' : '>') + c.context_threshold / 1000 + 'K' : '';
    const body = [...groups].sort((a, b) => a[1].rank - b[1].rank).map(([name, g]) =>
      `<tr class="eg"><th scope="rowgroup" colspan="${cols}">${esc(name)}</th></tr>` +
      g.rows.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)).map(({offer: o, label, head}) => {
        if (o.status !== 'priced' || o.problems.length) return `<tr title="${esc(label)}"><th scope="row">${esc(head)}</th><td class="none" colspan="${cols - 1}">not verified</td></tr>`;
        const p = isPick(o);
        const row = `<tr${p ? ' class="pick"' : ''} title="${esc(label + (p ? ' · the price the table compares' : ''))}"><th scope="row">${esc(head)}</th>${rateCells(o, policy, has1h)}</tr>`;
        const long = o.long_context && M.validRate(o.long_context.in) ? `<tr class="lc" title="${esc('Rates for the whole request when its input is ' + lc + ' tokens')}"><th scope="row">↳ ${esc(lc)}</th>${rateCells(o.long_context, policy, has1h)}</tr>` : '';
        return row + long;
      }).join('')).join('');
    return `<div class="ptw"><table class="pt"><thead><tr><th scope="col"><span class="sr">Endpoint and tier</span></th><th scope="col">Input</th><th scope="col">Output</th><th scope="col"><span class="lg">Cache read</span><span class="sh">Cache rd</span></th><th scope="col"><span class="lg">Cache write</span><span class="sh">Cache wr</span></th>${has1h ? '<th scope="col"><span class="lg">1h write</span><span class="sh">1h wr</span></th>' : ''}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  // Where the platform runs the model: one line per geography and processing level, then HK and Taiwan.
  function whereHtml(c) {
    const e = c.endpoints;
    if (!e) return `<div class="wh"><span class="gk">Regions</span><span class="lvs">${badge('no', '?')}</span><span class="gw">${esc(c.regions || 'Not yet reviewed')}</span></div>`;
    const rows = [];
    let last = null;
    for (const [geo, level, label, text] of e.regions) {
      // One line may name several endpoint types that share the same regions.
      const levels = [].concat(level), labels = [].concat(label == null ? [] : label);
      const badges = Array.from({length: Math.max(levels.length, labels.length)}, (_, i) => {
        const [cls, word] = LEVEL[levels[Math.min(i, levels.length - 1)]] || LEVEL.none;
        return badge(cls, labels[i] || word);
      }).join(' ');
      rows.push(`<span class="gk">${geo === last ? '' : esc(geo)}</span><span class="lvs">${badges}</span><span class="gw">${esc(text)}</span>`);
      last = geo;
    }
    const [hs, ht] = e.hk, [ts, tt] = e.tw;
    if (!e.regions.length && hs === 'unknown' && ts === 'unknown') {
      rows.push(`<span class="gk">Regions</span><span class="lvs">${badge('no', '? Not published')}</span><span class="gw">${esc(ht === tt ? ht : ht + '; ' + tt)}, including Hong Kong and Taiwan</span>`);
    } else {
      if (!e.regions.length) rows.push(`<span class="gk">Regions</span><span class="lvs">${badge('no', '? Not published')}</span><span class="gw"></span>`);
      for (const [key, [state, text]] of [['HK', e.hk], ['Taiwan', e.tw]]) {
        const [cls, word] = STATE[state];
        rows.push(`<span class="gk hk">${key}</span><span class="lvs">${badge(cls, word)}</span><span class="gw">${esc(text)}</span>`);
      }
    }
    return `<div class="wh">${rows.join('')}</div>`;
  }

  const idHtml = s => { const m = /^(\S+)(?: \((.+)\))?$/.exec(s); return `<span class="id">${m ? `<code>${esc(m[1])}</code>${m[2] ? ' ' + esc(m[2]) : ''}` : esc(s)}</span>`; };

  // The newest of the reviewed dates and the daily source check; a changed source says so instead.
  function checkedText(mk, pl, c) {
    const chk = CHECKS && CHECKS.cells && CHECKS.cells[mk + '|' + pl];
    if (chk && chk.changed_at) return `<span class="chg" title="${esc('Official source changed: ' + (chk.sources || []).join(', ') + '. Prices shown are the last reviewed ones.')}">source changed ${esc(chk.changed_at)} · re-check</span>`;
    const day = [c.pricing_checked_at, c.endpoints && c.endpoints.checked_at, chk && chk.verified].filter(Boolean).sort().pop();
    return day ? 'verified ' + esc(day) : '';
  }

  function cardHtml(mk, pl) {
    const c = DATA.models[mk].platforms[pl], e = c.endpoints, d = deltaOf(mk, pl), dir = dirOf(d);
    const src = srcUrl(c, pl), when = checkedText(mk, pl, c);
    const chip = pl === 'databricks' ? '<span class="cdv base">baseline</span>' : d == null ? '' : `<span class="cdv ${dir}">${dir === 'par' ? '= DBX' : dLabel(d, dir) + ' vs DBX'}</span>`;
    // One link per label: the offer's price source first, then the other sources the card cites.
    const seen = new Set(['prices']), links = [src && `<a href="${esc(src)}" target="_blank" rel="noopener">prices ↗</a>`];
    for (const id of (e && e.src) || []) {
      const sm = DATA.source_meta[id], text = sm && (sm.short || sm.label);
      if (!sm || sm.url === src || seen.has(text)) continue;
      seen.add(text);
      links.push(`<a href="${esc(sm.url)}" target="_blank" rel="noopener" title="${esc(sm.label)}">${esc(text)} ↗</a>`);
    }
    links.splice(0, links.length, ...links.filter(Boolean));
    const extra = [];
    if (c.promotion && !c.promotion_expired) extra.push(`From ${esc(shift(c.promotion.ends_on, 1))}: <b>${fx(c.promotion.after.in)} / ${fx(c.promotion.after.out)}</b>${M.validRate(c.promotion.after.cache_read) ? ' · cache read ' + fx(c.promotion.after.cache_read) : ''}`);
    if (M.validRate(c.cache_storage) && c.cache_storage > 0) extra.push(`Cache storage $${fx(c.cache_storage)} per 1M tokens per hour`);
    if (c.retires_on) extra.push(`${AS_OF >= c.retires_on ? 'Retired' : 'Retires'} ${esc(c.retires_on)} · use ${esc((c.replacement || []).join(' / '))}`);
    const note = comparisonNote(mk, pl, c);
    if (note && note.startsWith('Δ excluded')) extra.push(esc(note));
    const notes = e && e.notes.length ? `<ul class="cnotes">${e.notes.map(([kind, t]) => `<li><b>${esc(kind)}</b> ${esc(t)}</li>`).join('')}</ul>` : (c.note ? `<ul class="cnotes"><li>${esc(c.note)}</li></ul>` : '');
    const ids = e && e.ids.length ? e.ids : c.model_id ? [c.model_id] : [];
    return `<section class="pcard${pl === 'databricks' ? ' dbx' : ''}"><h3><b>${esc(LONG[pl])}</b>${chip}<span class="chk">${when}${links.length ? (when ? ' · ' : '') + links.join(' · ') : ''}</span></h3>` +
      priceTable(mk, pl) + (extra.length ? `<div class="cextra">${extra.join('<br>')}</div>` : '') + whereHtml(c) + notes +
      (ids.length ? `<div class="cids">${ids.map(idHtml).join('')}</div>` : '') + '</section>';
  }

  function cardsHtml(r) {
    const m = r.m, warn = notices(m).join(' · ');
    const meta = [m.maker, m.about, m.ctx && ('context ' + m.ctx)].filter(Boolean).join(' · ');
    const live = PL.filter(pl => kind(m.platforms[pl]) === 'ok');
    const rest = PL.filter(pl => !live.includes(pl)).map(pl => {
      const c = m.platforms[pl], k = kind(c);
      const st = k === 'gpu' ? 'dedicated GPU deployment only' : c.status === 'retired' ? 'retired' : k === 'na' ? 'not offered' : c.available ? 'price pending verification' : 'not verified';
      const alt = c.alt ? ` · closest ${esc(c.alt.name)} ${fmt(c.alt.in)} / ${fmt(c.alt.out)}${M.validRate(c.alt.cache_read) ? ' · cache read ' + fmt(c.alt.cache_read) : ''}` : '';
      return `<span><b>${esc(LONG[pl])}</b> ${st}${alt}</span>`;
    });
    return `<tr class="detail" id="d-${slug(r.k)}"><td colspan="8"><div class="dw"><div class="dh"><b>${esc(m.name)}</b><span class="meta">${esc(meta)}</span>${warn ? `<span class="warn">${esc(warn)}</span>` : ''}<button type="button" class="copy" data-copy="${esc(r.k)}">Copy summary</button>${m.note ? `<span class="note">${esc(m.note)}</span>` : ''}</div>` +
      `<p class="clegend">USD per 1M tokens · <span class="sw">shaded</span> = the price the table compares (cheapest standard) · <b>—</b> = not published · ${badge('in', 'In-region')} processed in the region you call ${badge('geo', 'Geo')} stays in one geography (e.g. US, EU) ${badge('gl', 'Global')} may run anywhere</p>` +
      `<div class="pcards">${live.map(pl => cardHtml(r.k, pl)).join('')}</div>${rest.length ? `<div class="coff">${rest.join('')}</div>` : ''}</div></td></tr>`;
  }

  function footHtml(list) {
    const n = list.length;
    const cells = PL.map(pl => {
      let off = 0, up = 0, dn = 0;
      for (const r of list) {
        if (kind(shown(r.k, pl)) !== 'ok') continue;
        off++;
        const d = deltaOf(r.k, pl);
        if (d != null) { if (d > M.PARITY) up++; else if (d < -M.PARITY) dn++; }
      }
      const cd = pl === 'databricks' ? '' : `<span class="cd">${up ? `<i class="up">▲${up}</i>` : ''}${dn ? `<i class="down">▼${dn}</i>` : ''}</span>`;
      return `<td><span class="cv">${off}/${n}</span>${cd}</td>`;
    }).join('');
    return `<tfoot><tr><th scope="row" class="m"><span class="nm">Has model</span><span class="mk mk2">priced cells · ▲ ▼ vs DBX</span></th>${cells}</tr></tfoot>`;
  }

  // The cheaper-than-Databricks cells among the shown models, from published prices.
  function watchouts(list) {
    const found = [];
    for (const r of list) {
      for (const pl of PL) {
        const d = deltaOf(r.k, pl);
        if (d != null && d < -M.PARITY) found.push({d, text: (r.m.short || r.m.name) + ' on ' + LONG[pl] + ' (−' + pct(d) + ')'});
      }
    }
    if (!found.length) return null;
    found.sort((a, b) => a.d - b.d);
    return 'Priced below Databricks at ' + S.blend + ':1: ' + found.slice(0, 6).map(x => x.text).join(', ') +
      (found.length > 6 ? ' and ' + (found.length - 6) + ' more ▼ cells' : '') + '. Check these before quoting.';
  }

  const kpi = (cls, value, long, short) => `<div class="kpi${cls ? ' ' + cls : ''}"><b>${value}</b><span class="kl">${long}</span><span class="ks">${short}</span></div>`;
  function renderSummary(list) {
    const key = [AS_OF, S.blend, list.map(r => r.k).join(',')].join('|');
    if (key !== SUMMARY_KEY) { SUMMARY_KEY = key; SUMMARY = M.summarize(list.map(r => RAW.models[r.k]), {asOf: AS_OF, inputRatio: S.blend}); WATCH = watchouts(list); }
    const p = SUMMARY, gaps = p.gaps;
    const g = S.group === 'all' ? null : S.group;
    const tips = [WATCH, ...(g ? active(DATA.insights && DATA.insights[g]) : ORDER.flatMap(x => active(DATA.insights && DATA.insights[x]).slice(0, 1)))].filter(Boolean);
    const open = S.talk ?? window.matchMedia('(min-width: 1061px) and (min-height: 700px)').matches;
    const onDbx = list.filter(r => offered(RESOLVED.models[r.k].databricks)).length;
    paint($('#summary'),
      kpi('', `${onDbx}<small>/${list.length}</small>`, 'listed models offered on Databricks', 'on Databricks') +
      kpi('good', `${p.noCheaperModels}<small>/${p.comparedModels}</small>`, 'models where no hyperscaler beats DBX (Azure · AWS · GCP)', 'no hyperscaler cheaper') +
      kpi('', `${gaps.azure_foundry}<small> · </small>${gaps.bedrock}<small> · </small>${gaps.gcloud}`, 'models not offered on Azure · AWS · GCP (✕)', 'not on Azure · AWS · GCP') +
      kpi('warn', String(p.cheaperCells), 'cells cheaper than DBX on any platform (▼): check first', 'cheaper cells ▼') +
      (tips.length ? `<button type="button" class="talkbtn" id="talkBtn" aria-expanded="${open}" aria-controls="talk">Talk track</button><ul class="talk" id="talk"${open ? '' : ' hidden'}>${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''));
  }

  function focusKey(el) {
    if (!el || el === document.body || !el.closest) return null;
    const q = v => CSS.escape(v), row = el.closest('tr.row');
    if (el.dataset.copy) return `[data-copy="${q(el.dataset.copy)}"]`;
    if (el.classList.contains('mb') && row) return `tr.row[data-k="${q(row.dataset.k)}"] .mb`;
    if (el.classList.contains('tab')) return `.tab[data-g="${q(el.dataset.g)}"]`;
    if (el.id === 'talkBtn') return '#talkBtn';
    return null;
  }

  function render() {
    const focus = focusKey(document.activeElement);
    const list = rows();
    const counts = { all: 0 };
    for (const [k, m] of listed()) { const g = groupOf(k, m); counts[g] = (counts[g] || 0) + 1; counts.all++; }
    const tabs = $('#tabs');
    paint(tabs, TABS.filter(([id]) => id === 'all' || counts[id]).map(([id, label, short]) => `<button type="button" class="tab" data-g="${id}" aria-pressed="${S.group === id}" aria-label="${esc(label + ', ' + (counts[id] || 0) + ' models')}"><span class="tl">${label}</span><span class="ts">${short}</span><span class="n">${counts[id] || 0}</span></button>`).join(''));
    const current = tabs.querySelector('[aria-pressed="true"]');
    if (current) {
      const bounds = tabs.getBoundingClientRect(), selected = current.getBoundingClientRect();
      if (selected.right > bounds.right) tabs.scrollLeft += selected.right - bounds.right;
      else if (selected.left < bounds.left) tabs.scrollLeft -= bounds.left - selected.left;
    }
    renderSummary(list);
    const head = `<colgroup><col class="cm">${PL.map(() => '<col>').join('')}</colgroup><thead><tr><th scope="col" class="m">${RANKING ? '<span class="rk" title="arena.ai Best Overall rank">#</span>' : ''}Model<span class="u">$ / 1M · in / out</span></th>${PL.map(pl => `<th scope="col"${pl === 'databricks' ? ' class="dbx"' : ''} title="${esc(LONG[pl])}"><span class="lg">${esc(LONG[pl])}</span><span class="sh">${esc(SHORT[pl])}</span></th>`).join('')}</tr></thead>`;
    let body = '';
    for (const r of list) {
      body += rowHtml(r);
      if (S.open.has(r.k)) body += cardsHtml(r);
    }
    if (!list.length) body = `<tr class="empty"><td colspan="8">No models match “${esc(S.q)}”.</td></tr>`;
    const cap = '<caption class="sr">LLM price per 1M tokens by platform</caption>';
    paint($('#mx'), cap + head + `<tbody>${body}</tbody>` + (list.length ? footHtml(list) : ''));
    if (focus) { const el = document.querySelector(focus); if (el && el !== document.activeElement) el.focus({ preventScroll: true }); }
  }

  function copySummary(mk) {
    const m = DATA.models[mk];
    const rank = rankOf(mk);
    const lines = [`${m.name} (${m.maker})${rank != null ? `, arena.ai Best Overall #${rank}` : ''}: USD per 1M text tokens, input / output, reviewed ${DATA.reviewed_at}; prices as of ${AS_OF}. Δ compares each platform's cheapest standard price with Databricks' at ${S.blend}:1 input:output.`];
    for (const pl of PL) {
      const c = shown(mk, pl), k = kind(c);
      if (k === 'gpu') lines.push(`• ${LONG[pl]}: dedicated deployment only · ${c.note || 'No verified per-token price.'}`);
      else if (k === 'na') lines.push(`• ${LONG[pl]}: ${c.status === 'retired' ? 'retired on ' + c.retires_on : 'not offered'}${c.alt ? ` (closest ${c.alt.name} ${fmt(c.alt.in)} / ${fmt(c.alt.out)})` : ''}`);
      else if (k === 'unk') lines.push(`• ${LONG[pl]}: ${c.available ? 'price pending verification' : 'not verified'}${c.note ? ' · ' + c.note : ''}`);
      else {
        const d = deltaOf(mk, pl), dir = dirOf(d);
        const note = d == null ? comparisonNote(mk, pl, m.platforms[pl]) : null;
        lines.push(`• ${LONG[pl]}: ${precise(c.in)} / ${precise(c.out)}${c.cache_read != null ? ` · cache read ${precise(c.cache_read)}` : ''}${c.cache_write != null ? ` · cache write ${precise(c.cache_write)}` : (m.platforms[pl].endpoints || {}).cache_write === 'input-rate' && c.cache_read != null ? ' · no cache-write charge' : ''}${c.tier ? ' · ' + c.tier : ''}${d != null ? ` (${dir === 'par' ? 'parity' : (dir === 'up' ? '+' : '−') + pct(d)} vs DBX)` : note ? ' · ' + note : ''}${c.pricing_checked_at ? ' · Price checked ' + c.pricing_checked_at : ''}${c.model_id ? ' · ID ' + c.model_id : ''}`);
      }
    }
    lines.push('Internal reference only: public list prices from official sources, compiled by Peter Chan. Not an official Databricks price list or quote.');
    const text = lines.join('\n');
    const done = () => toast('Copied summary');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text));
    else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove(); toast(ok ? 'Copied summary' : 'Copy failed: select the text manually');
  }
  let toastT = 0;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 1600); }

  function setGroup(g, push) {
    S.group = g;
    if (push) { try { history.replaceState(null, '', '#' + g); } catch (e) {} }
    render();
  }
  function fromHash() {
    const h = (location.hash || '').slice(1).toLowerCase();
    return HASH_ALIAS.get(h) || (TABS.some(([id]) => id === h) ? h : null);
  }

  function bind() {
    $('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setGroup(b.dataset.g, true); });
    $('#q').addEventListener('input', e => { S.q = e.target.value; if (S.q && S.group !== 'all') S.group = 'all'; render(); });
    $('#sort').addEventListener('change', e => { S.sort = e.target.value; savePrefs(); render(); });
    $('#blend').addEventListener('change', e => { S.blend = +e.target.value; savePrefs(); pickAll(); render(); });
    $('#summary').addEventListener('click', e => {
      const b = e.target.closest('#talkBtn'); if (!b) return;
      S.talk = b.getAttribute('aria-expanded') !== 'true'; savePrefs();
      b.setAttribute('aria-expanded', String(S.talk)); $('#talk').hidden = !S.talk;
      $('#summary')._html = null;
    });
    $('#mx').addEventListener('click', e => {
      const cp = e.target.closest('.copy'); if (cp) { copySummary(cp.dataset.copy); return; }
      if (e.target.closest('tr.detail') || e.target.closest('a')) return;
      const tr = e.target.closest('tr.row'); if (!tr) return;
      // One row open at a time: opening a row closes the one before it.
      const k = tr.dataset.k, top = tr.getBoundingClientRect().top;
      S.open = S.open.has(k) ? new Set() : new Set([k]);
      render();
      // Keep the tapped row where it was on screen, even when a panel above it just closed.
      const row = document.querySelector(`tr.row[data-k="${CSS.escape(k)}"]`);
      if (row) window.scrollBy(0, row.getBoundingClientRect().top - top);
    });
    window.addEventListener('hashchange', () => { const g = fromHash(); if (g && g !== S.group) setGroup(g, false); });
    const refreshDate = () => { const d = localDate(); if (d !== AS_OF) { AS_OF = d; prepare(); render(); } };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDate(); });
    setInterval(refreshDate, 60000);
    // Column headers stick under the family tabs (and the tools, on wide screens where they share the row).
    const bar = $('#bar'), tools = $('#tools');
    const setH = () => {
      const stuck = getComputedStyle(tools).position === 'sticky';
      const h = Math.max(bar.offsetHeight, stuck ? tools.offsetHeight : 0) + (parseFloat(getComputedStyle(bar).top) || 0);
      document.documentElement.style.setProperty('--bar-h', h + 'px');
    };
    setH();
    window.addEventListener('resize', setH);
    if (window.ResizeObserver) { const ro = new ResizeObserver(setH); ro.observe(bar); ro.observe(tools); }
  }

  async function load() {
    const inline = document.getElementById('inline-data');
    const optional = name => fetch(name, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
    const ranking = optional('v2-ranking.json'), checks = optional('v2-checks.json');
    if (inline) return [JSON.parse(inline.textContent), await ranking, await checks];
    const r = await fetch('v2-data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return [await r.json(), await ranking, await checks];
  }

  load().then(([d, ranking, checks]) => {
    RAW = d;
    CHECKS = isObject(checks) && isObject(checks.cells) ? checks : null;
    RANKING = isObject(ranking) && isObject(ranking.models) && Object.keys(ranking.models).some(k => d.models[k]) ? ranking : null;
    prepare();
    if (RANKING) {
      const when = new Date(RANKING.ranked_at + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const [title, sub] = String(RANKING.board).split(/ (?=\()/);
      const board = `<a href="${esc(RANKING.board_url)}" target="_blank" rel="noopener">arena.ai ${esc(title)}<span class="bsub">${sub ? ' ' + esc(sub) : ''}</span></a>`;
      $('#rankSrc').innerHTML = ` · ranked by ${board}, ${esc(when)}`;
      $('#rankNote').innerHTML = `Models and default order follow the ${board} leaderboard (# = arena rank): its top ${esc(RANKING.top || 50)}, listed when Databricks, Fireworks, Azure, AWS, Google or Alibaba hosts the model. Checked daily; order last changed ${esc(when)}.`;
    }
    const long = day => day ? new Date(day + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    // The daily source check moves the verified date forward while the official sources are unchanged.
    const day = [d.reviewed_at, CHECKS && CHECKS.checked_at].filter(Boolean).sort().pop();
    $('#verified').textContent = long(day); $('#srcDate').textContent = '· checked ' + long(day);
    if (CHECKS && Array.isArray(CHECKS.review) && CHECKS.review.length) {
      const n = CHECKS.review.length, link = CHECKS.issue_url ? ` href="${esc(CHECKS.issue_url)}" target="_blank" rel="noopener"` : '';
      $('#verified').insertAdjacentHTML('afterend', ` · <a class="rev"${link} title="${esc(CHECKS.review.join(' · '))}">${n} under review</a>`);
    }
    if (d.usd_per_dbu) $('#dbu').textContent = '$' + d.usd_per_dbu;
    const srcList = d.source_meta ? Object.values(d.source_meta) : (d.sources || []).map(u => { const url = String(u).split(' ')[0]; let label = url; try { label = new URL(url).hostname; } catch (e) {} return { url, label }; });
    $('#srcs').innerHTML = srcList.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join('');
    // Each card links its own sources; the full list stays folded so the footer (and disclaimer) stay close.
    $('#srcCount').textContent = '· ' + srcList.length + ' official pages, tap to list';
    $('#sort').value = S.sort; $('#blend').value = String(S.blend);
    S.group = fromHash() || 'all';
    bind(); render();
    document.body.dataset.ready = 'true';
  }).catch(err => {
    $('#mx').innerHTML = `<tbody><tr class="empty"><td>Could not load v2-data.json (${esc(err.message)}). Serve this folder over HTTP rather than opening the file directly.</td></tr></tbody>`;
  });
})();
