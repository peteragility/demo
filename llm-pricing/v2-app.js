(() => {
  'use strict';
  const M = window.LLMPricingMath;
  const PL = ['databricks','official','bedrock','azure_foundry','fireworks','gcloud','alicloud'];
  const LONG = {databricks:'Databricks',official:'原廠 API',bedrock:'AWS Bedrock',azure_foundry:'Azure Foundry',gcloud:'Google Vertex',fireworks:'Fireworks',alicloud:'Alibaba'};
  const SHORT = {databricks:'DBX',official:'原廠',bedrock:'AWS',azure_foundry:'Azure',gcloud:'GCP',fireworks:'FW',alicloud:'Ali'};
  const ORDER = ['oss','anthropic','openai','google','xai','other'];
  // [hash id, label, phone label]
  const TABS = [['all','All','All'],['oss','OSS','OSS'],['anthropic','Anthropic','Claude'],['openai','OpenAI','GPT'],['google','Google','Gemini'],['xai','xAI','Grok'],['other','Other','Other']];
  const HASH_ALIAS = new Map([['claude','anthropic'],['gpt','openai'],['gemini','google'],['grok','xai']]);
  const FIELDS = ['in','out','cache_read','cache_write','cache_write_1h'];
  const EDIT_KEY = 'llm-pricing-v2-overrides', PREF_KEY = 'llm-pricing-v2-preferences';
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
  const localDate = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  let AS_OF = localDate();

  const saved = store.get(PREF_KEY, {});
  const prefs = isObject(saved) ? saved : {};
  const S = { group: 'all', q: '', sort: ['default','price','edge'].includes(prefs.sort) ? prefs.sort : 'default', blend: [1,3,10].includes(+prefs.blend) ? +prefs.blend : 3,
    talk: typeof prefs.talk === 'boolean' ? prefs.talk : null, edit: false, open: new Set() };
  let RAW = null, RESOLVED = null, DATA = null, PICK = null, APPLIED = 0, SUMMARY = null, SUMMARY_KEY = '', WATCH = null, RANKING = null;
  let EDITS = store.get(EDIT_KEY, {});
  if (!isObject(EDITS)) EDITS = {};
  if (prefs.theme === 'light' || prefs.theme === 'dark') document.documentElement.dataset.theme = prefs.theme;
  const savePrefs = () => { prefs.sort = S.sort; prefs.blend = S.blend; if (S.talk != null) prefs.talk = S.talk; store.set(PREF_KEY, prefs); };
  const saveEdits = () => { if (Object.keys(EDITS).length) store.set(EDIT_KEY, EDITS); else store.del(EDIT_KEY); };
  // Assign markup only when it changed, so unchanged regions keep focus and screen readers stay quiet.
  const paint = (el, html) => { if (el._html !== html) { el.innerHTML = html; el._html = html; } };

  const groupOf = (k, m) => m.group || (m.oss ? 'oss' : ({anthropic:'anthropic',openai:'openai',google:'google'}[k.split('/')[0]] || 'oss'));
  const kind = c => !c ? 'unk' : c.status === 'dedicated' ? 'gpu' : ['unavailable','retired'].includes(c.status) ? 'na' : c.status === 'priced' && M.validRate(c.in) && M.validRate(c.out) && !(c.problems || []).length ? 'ok' : 'unk';
  // The offer a cell shows and compares: the platform's cheapest standard price, or the personal price typed for it.
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
      (!Array.isArray(n.models) || !RANKING || n.models.some(k => rankOf(k) != null))))
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
  // Drop stored edits that can no longer apply, so the count and Reset match what the table shows.
  function pruneEdits() {
    let changed = false;
    for (const [key, val] of Object.entries(EDITS)) {
      const [mk, pl, f] = key.split('|');
      const c = RESOLVED.models[mk] && RESOLVED.models[mk][pl];
      if (!c || c.status !== 'priced' || !FIELDS.includes(f) || !M.validRate(val) || val === c[f]) { delete EDITS[key]; changed = true; }
    }
    if (changed) saveEdits();
  }
  function applyEdits() {
    if (!RESOLVED || RESOLVED.asOf !== AS_OF) { RESOLVED = resolveAll(); pruneEdits(); }
    DATA = {...RAW, models: {}};
    for (const [k, m] of Object.entries(RAW.models || {})) {
      // older data.json files have no display fields: derive them from the model key
      DATA.models[k] = {...m, name: m.name || k.split('/').pop(), maker: m.maker || k.split('/')[0], platforms: {...RESOLVED.models[k]}};
    }
    // A personal price replaces the listed tier on a copy of that one offer.
    APPLIED = 0;
    for (const [key, val] of Object.entries(EDITS)) {
      const [mk, pl, f] = key.split('|');
      const m = DATA.models[mk], c = m && m.platforms[pl];
      if (!c || c.status !== 'priced' || !FIELDS.includes(f) || !M.validRate(val)) continue;
      if (!c.user_modified) m.platforms[pl] = {...c, user_modified: true};
      m.platforms[pl][f] = val;
      APPLIED++;
    }
    pickAll();
  }
  function pickAll() {
    PICK = {};
    const options = {asOf: AS_OF, inputRatio: S.blend};
    for (const [k, m] of Object.entries(DATA.models)) {
      PICK[k] = {};
      for (const pl of PL) {
        const c = m.platforms[pl];
        PICK[k][pl] = c.user_modified ? (M.comparable(c) ? c : null) : M.cheapest((RAW.models[k].platforms || {})[pl], options);
      }
    }
  }

  // The arena.ai Best Overall ranking decides which models appear and their default order. A model is
  // listed only while a compared platform hosts it; the maker's own API alone does not count.
  const rankOf = k => RANKING && RANKING.models[k] ? RANKING.models[k].rank : null;
  const offered = c => Boolean(c) && (c.status === 'priced' || c.status === 'dedicated' || (c.status === 'unverified' && c.available));
  const hosted = k => PL.some(pl => pl !== 'official' && offered(RESOLVED.models[k][pl]));
  const listed = () => Object.entries(DATA.models).filter(([k]) => (!RANKING || rankOf(k) != null) && hosted(k));
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
    if (c.tier) bits.push(c.tier + (c.variant_id ? ' (cheapest standard tier)' : ''));
    if (c.pricing_checked_at) bits.push('price checked ' + c.pricing_checked_at);
    if (c.model_id) bits.push(c.model_id);
    if (c.user_modified) bits.push('personal price');
    if (d != null && pl !== 'databricks') bits.push(dir === 'par' ? 'parity with DBX' : (dir === 'up' ? '+' : '−') + pct(d) + ' vs DBX (' + S.blend + ':1 blend)');
    return bits.join(' · ');
  }

  const io = c => `<span class="io"><span class="i">${fmt(c.in)}</span><span class="sl">/</span><span class="o">${fmt(c.out)}</span></span>`;
  function cellHtml(r, pl) {
    const base = r.m.platforms[pl], c = shown(r.k, pl), k = kind(c);
    const ed = base.user_modified ? ' edited' : '';
    const shade = pl === 'databricks' ? ' dbx' : '';
    if (k === 'gpu') return `<td class="c na${shade}" title="${esc(LONG[pl] + ': dedicated deployment only · ' + (c.note || 'No verified per-token offer'))}"><span class="x" aria-label="dedicated deployment only">GPU</span></td>`;
    if (k === 'na') {
      const a = c.alt;
      const state = c.status === 'retired' ? 'retired on Databricks ' + c.retires_on : 'not offered';
      const t = LONG[pl] + ': ' + state + (a ? ' · closest ' + a.name + ' $' + fmt(a.in) + ' / $' + fmt(a.out) : '') + (c.note ? ' · ' + c.note : '');
      return `<td class="c na${shade}" title="${esc(t)}"><span class="x" aria-label="${esc(state)}">✕</span>${a ? `<span class="alt"><span class="an">${esc(shortAlt(a))}</span><span class="ap"> ${fmt(a.in)} / ${fmt(a.out)}</span></span>` : ''}</td>`;
    }
    if (k === 'unk') return `<td class="c unk${shade}${ed}" title="${esc(LONG[pl] + ': ' + ((c && c.note) || 'not verified'))}"><span class="q" aria-label="not verified">?</span></td>`;
    if (pl === 'databricks') return `<td class="c dbx${ed}" title="${esc(tip(pl, c))}">${io(c)}</td>`;
    const d = deltaOf(r.k, pl), dir = dirOf(d);
    const ar = dir && dir !== 'par' ? `<span class="ar ${dir}" aria-hidden="true">${dir === 'up' ? '▲' : '▼'}</span>` : '';
    return `<td class="c ${dir || ''}${ed}" title="${esc(tip(pl, c, d, dir))}"><span class="io"><span class="i">${fmt(c.in)}</span><span class="sl">/</span><span class="o">${fmt(c.out)}${ar}</span></span>${d != null ? `<span class="d ${dir}">${dLabel(d, dir)}</span>` : ''}</td>`;
  }

  function rowHtml(r) {
    const m = r.m, open = S.open.has(r.k), warn = notices(m).join(' · ');
    const badges = (m.badges || []).map(b => `<span class="bdg">${esc(b)}</span>`).join('') + (warn ? `<span class="bdg warn" title="${esc(warn)}">!</span>` : '');
    const meta = [m.maker, m.ctx && (m.ctx + ' ctx')].filter(Boolean).join(' · ');
    const rank = rankOf(r.k);
    return `<tr class="row${open ? ' open' : ''}" data-k="${esc(r.k)}"><th scope="row" class="m"><button type="button" class="mb" aria-expanded="${open}"${open ? ` aria-controls="d-${slug(r.k)}"` : ''}><span class="nm">${rank != null ? `<span class="rk" title="arena.ai Best Overall rank">${rank}</span>` : ''}<span class="f">${esc(m.name)}</span><span class="s">${esc(m.short || m.name)}</span>${badges}<span class="chev" aria-hidden="true">›</span></span><span class="mk">${esc(meta)}</span></button></th>${PL.map(pl => cellHtml(r, pl)).join('')}</tr>`;
  }

  // Why a priced cell has no Δ, or which tier its Δ uses.
  function comparisonNote(mk, pl, c) {
    if (kind(c) !== 'ok') return null;
    const pick = PICK[mk][pl], base = PICK[mk].databricks;
    if (pl === 'databricks') return pick && pick.variant_id ? 'Δ baseline is the cheapest standard tier: ' + esc(pick.tier) + ' $' + precise(pick.in) + ' / $' + precise(pick.out) : null;
    if (!base) return 'Δ excluded: no verified Databricks price.';
    if (!pick) return 'Δ excluded: ' + esc(M.comparisonReason(c, base) || 'no standard price for the confirmed model version.');
    const why = M.delta(pick, base, S.blend).reason;
    if (why) return 'Δ excluded: ' + esc(why);
    return pick.variant_id ? 'Δ uses the cheapest standard tier: ' + esc(pick.tier) + ' $' + precise(pick.in) + ' / $' + precise(pick.out) : null;
  }

  function offerInfo(c, pl, mk) {
    const info = [c.tier, c.regions, c.note].filter(Boolean).map(esc);
    if (c.user_modified) info.push('Personal price');
    if (c.pricing_checked_at) info.push((c.user_modified ? 'Published price checked ' : 'Price checked ') + esc(c.pricing_checked_at));
    if (c.availability_checked_at) info.push('Availability checked ' + esc(c.availability_checked_at));
    if (c.status === 'priced' || c.available || c.status === 'dedicated') info.push(c.model_id ? 'ID <code>' + esc(c.model_id) + '</code>' : 'Endpoint ID unconfirmed');
    const idSource = DATA.source_meta[c.model_id_source];
    if (idSource && idSource.url !== srcUrl(c, pl)) info.push(`<a href="${esc(idSource.url)}" target="_blank" rel="noopener">endpoint source ↗</a>`);
    if (c.billing_sku) info.push('Billing SKU: ' + esc(c.billing_sku));
    if (c.cache_storage != null) info.push('Cache storage $' + precise(c.cache_storage) + ' / million token-hours');
    if (c.retires_on) {
      const source = DATA.source_meta[c.retirement_src];
      info.push((AS_OF >= c.retires_on ? 'Retired ' : 'Retires ') + esc(c.retires_on) + ' · replacement: ' + esc((c.replacement || []).join(' / ')) + (source ? ` <a href="${esc(source.url)}" target="_blank" rel="noopener">retirement source ↗</a>` : ''));
    }
    if (c.promotion_expired) info.push('Promotion ended ' + esc(c.promotion.ends_on) + '; published post-promotion rates shown.');
    const note = comparisonNote(mk, pl, c);
    if (note) info.push(note);
    return info.join(' · ');
  }

  function rateChip(label, c, cls) {
    const cache = [['cache_read','cr'],['cache_write','cw'],['cache_write_1h','1h write']].filter(([field]) => M.validRate(c[field])).map(([field, name]) => ' · ' + name + ' ' + precise(c[field])).join('');
    return `<span${cls ? ` class="${cls}"` : ''}>${esc(label)} <b>${precise(c.in)} / ${precise(c.out)}</b>${cache}</span>`;
  }

  function detailHtml(r) {
    const m = r.m, warn = notices(m).join(' · ');
    const meta = [m.maker, m.about, m.ctx && ('context ' + m.ctx)].filter(Boolean).join(' · ');
    let body = '';
    for (const pl of PL) {
      const c = m.platforms[pl], k = kind(c), src = srcUrl(c, pl), pick = PICK[r.k][pl];
      const link = src ? ` <a href="${esc(src)}" target="_blank" rel="noopener">source ↗</a>` : '';
      const editable = S.edit && c.status === 'priced';
      if (k !== 'ok' && !editable) {
        const st = k === 'gpu' ? 'Dedicated deployment only' : c.status === 'retired' ? 'Retired on Databricks' : k === 'na' ? 'Not offered' : c.available ? 'Price pending verification' : 'Not verified';
        const alt = c && c.alt ? ` · closest <b>${esc(c.alt.name)}</b> ${fmt(c.alt.in)} / ${fmt(c.alt.out)}` : '';
        body += `<tr><td class="pl">${esc(LONG[pl])}</td><td class="st" colspan="6">${st}${alt}</td></tr>`;
        body += `<tr class="info"><td colspan="7">${offerInfo(c, pl, r.k)}${link}</td></tr>`;
        continue;
      }
      const d = deltaOf(r.k, pl), dir = dirOf(d);
      const nums = FIELDS.map(f => {
        const cls = f === 'cache_write_1h' ? ' class="w1h"' : '';
        if (S.edit) return `<td${cls}><input inputmode="decimal" name="${esc(r.k + '|' + pl + '|' + f)}" id="e-${slug(r.k + '-' + pl + '-' + f)}" data-e="${esc(r.k + '|' + pl + '|' + f)}" value="${c[f] == null ? '' : c[f]}" aria-label="${esc(LONG[pl] + ' ' + f)}"></td>`;
        return `<td${cls}>${precise(c[f])}</td>`;
      }).join('');
      const dd = pl === 'databricks' ? 'base' : d == null ? '' : dLabel(d, dir);
      body += `<tr><td class="pl${pl === 'databricks' ? ' is-dbx' : ''}">${esc(LONG[pl])}</td>${nums}<td class="dd ${dir || ''}">${dd}</td></tr>`;
      const bits = offerInfo(c, pl, r.k);
      // A promotion's scheduled rates replace the duplicate "from <date>" variant.
      let vars = (c.variants || []).filter(v => !v.context_only && !(v.future_only && (c.promotion || (v.effective_from && AS_OF >= v.effective_from)))).map(v => {
        if (v.future_only) return rateChip(v.label, v);
        const resolved = M.resolveOffer(RAW.models[r.k].platforms[pl], {asOf: AS_OF, variantId: v.id});
        const isPick = pick && pick.variant_id === v.id && !c.user_modified;
        return resolved.status === 'priced' ? rateChip((resolved.tier || v.label) + (isPick ? ' · Δ basis' : ''), resolved, isPick ? 'pick' : '') : `<span>${esc(v.label)} · ${esc((resolved.problems || []).join(' ') || 'Rates not verified')}</span>`;
      }).join('');
      if (c.long_context) vars += rateChip((c.context_threshold_inclusive ? '≥' : '>') + (c.context_threshold / 1000) + 'K input', c.long_context);
      else if (c.context_threshold) vars += `<span>${c.context_threshold_inclusive ? '≥' : '&gt;'}${c.context_threshold / 1000}K input: rates for this tier not verified</span>`;
      if (c.promotion && !c.promotion_expired) {
        vars += rateChip('After ' + c.promotion.ends_on, c.promotion.after);
        if (c.promotion.after.long_context) vars += rateChip('After ' + c.promotion.ends_on + ' · ' + (c.context_threshold_inclusive ? '≥' : '>') + (c.context_threshold / 1000) + 'K input', c.promotion.after.long_context);
      }
      body += `<tr class="info"><td colspan="7">${bits}${link}${vars ? `<div class="chips">${vars}</div>` : ''}</td></tr>`;
    }
    return `<tr class="detail" id="d-${slug(r.k)}"><td colspan="8"><div class="dw"><div class="dh"><b>${esc(m.name)}</b><span class="meta">${esc(meta)}</span>${warn ? `<span class="warn">${esc(warn)}</span>` : ''}<button type="button" class="copy" data-copy="${esc(r.k)}">Copy summary</button>${m.note ? `<span class="note">${esc(m.note)}</span>` : ''}</div><div class="dtwrap"><table class="dt"><thead><tr><th class="pl">Platform</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th class="w1h">1h write</th><th>Δ vs DBX</th></tr></thead><tbody>${body}</tbody></table></div></div></td></tr>`;
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
    const options = {asOf: AS_OF, inputRatio: S.blend}, found = [];
    for (const r of list) {
      const raw = RAW.models[r.k].platforms || {}, base = M.cheapest(raw.databricks, options);
      if (!base) continue;
      for (const pl of PL) {
        if (pl === 'databricks') continue;
        const pick = M.cheapest(raw[pl], options), d = pick ? M.delta(pick, base, S.blend).value : null;
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
    // Published figures always use published prices; personal edits only change the table.
    const key = [AS_OF, S.blend, list.map(r => r.k).join(',')].join('|');
    if (key !== SUMMARY_KEY) { SUMMARY_KEY = key; SUMMARY = M.summarize(list.map(r => RAW.models[r.k]), {asOf: AS_OF, inputRatio: S.blend}); WATCH = watchouts(list); }
    const p = SUMMARY, gaps = p.gaps;
    const g = S.group === 'all' ? null : S.group;
    const tips = [WATCH, ...(g ? active(DATA.insights && DATA.insights[g]) : ORDER.flatMap(x => active(DATA.insights && DATA.insights[x]).slice(0, 1)))].filter(Boolean);
    const open = S.talk ?? window.matchMedia('(min-width: 1061px) and (min-height: 700px)').matches;
    const onDbx = list.filter(r => offered(RESOLVED.models[r.k].databricks)).length;
    paint($('#summary'),
      kpi('', `${onDbx}<small>/${list.length}</small>`, 'listed models offered on Databricks', 'on Databricks') +
      kpi('good', `${p.noCheaperModels}<small>/${p.comparedModels}</small>`, 'models where no hyperscaler beats DBX (AWS · Azure · GCP)', 'no hyperscaler cheaper') +
      kpi('', `${gaps.bedrock}<small> · </small>${gaps.azure_foundry}<small> · </small>${gaps.gcloud}`, 'models not offered on AWS · Azure · GCP (✕)', 'not on AWS · Azure · GCP') +
      kpi('warn', String(p.cheaperCells), 'cells cheaper than DBX on any platform (▼): check first', 'cheaper cells ▼') +
      (tips.length ? `<button type="button" class="talkbtn" id="talkBtn" aria-expanded="${open}" aria-controls="talk">Talk track</button><ul class="talk" id="talk"${open ? '' : ' hidden'}>${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (APPLIED ? `<p class="enote">Figures use published prices. The table includes your ${APPLIED} personal price${APPLIED === 1 ? '' : 's'}.</p>` : ''));
  }

  function focusKey(el) {
    if (!el || el === document.body || !el.closest) return null;
    const q = v => CSS.escape(v), row = el.closest('tr.row');
    if (el.dataset.e) return `[data-e="${q(el.dataset.e)}"]`;
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
      if (S.open.has(r.k)) body += detailHtml(r);
    }
    if (!list.length) body = `<tr class="empty"><td colspan="8">No models match “${esc(S.q)}”.</td></tr>`;
    const cap = '<caption class="sr">LLM price per 1M tokens by platform</caption>';
    paint($('#mx'), cap + head + `<tbody>${body}</tbody>` + (list.length ? footHtml(list) : ''));
    $('#resetBtn').hidden = !APPLIED;
    $('#editNote').textContent = APPLIED ? APPLIED + ' edited value' + (APPLIED === 1 ? '' : 's') + ', saved in this browser only' : '';
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
        lines.push(`• ${LONG[pl]}: ${precise(c.in)} / ${precise(c.out)}${c.cache_read != null ? ` · cache read ${precise(c.cache_read)}` : ''}${c.cache_write != null ? ` · cache write ${precise(c.cache_write)}` : ''}${c.tier ? ' · ' + c.tier : ''}${c.user_modified ? ' · personal price' : ''}${d != null ? ` (${dir === 'par' ? 'parity' : (dir === 'up' ? '+' : '−') + pct(d)} vs DBX)` : note ? ' · ' + note.replace(/<[^>]+>/g, '') : ''}${c.pricing_checked_at ? ' · Price checked ' + c.pricing_checked_at : ''}${c.model_id ? ' · ID ' + c.model_id : ''}`);
      }
    }
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
      if (e.target.closest('tr.detail') || e.target.closest('a,input')) return;
      const tr = e.target.closest('tr.row'); if (!tr) return;
      const k = tr.dataset.k; S.open.has(k) ? S.open.delete(k) : S.open.add(k); render();
    });
    $('#mx').addEventListener('change', e => {
      const el = e.target.closest('input[data-e]'); if (!el) return;
      const value = el.value.trim();
      if (value !== '' && !M.validRate(Number(value))) { toast('Enter a nonnegative finite price'); el.value = el.defaultValue; return; }
      // Clearing a field, or typing the published price, removes the personal price.
      if (value === '') delete EDITS[el.dataset.e]; else EDITS[el.dataset.e] = Number(value);
      pruneEdits(); saveEdits();
      // Re-render after the browser moves focus (Tab), then return focus to the same field.
      setTimeout(() => { applyEdits(); render(); }, 0);
    });
    $('#editBtn').addEventListener('click', () => {
      S.edit = !S.edit; $('#editBtn').setAttribute('aria-pressed', S.edit);
      $('#editBtn').textContent = S.edit ? 'Done editing' : 'Edit prices';
      if (S.edit && !S.open.size) toast('Tap a row, then edit its prices');
      render();
    });
    let armed = false;
    $('#resetBtn').addEventListener('click', () => {
      if (!armed) { armed = true; $('#resetBtn').textContent = 'Tap again to reset'; setTimeout(() => { armed = false; $('#resetBtn').textContent = 'Reset edits'; }, 2500); return; }
      armed = false; EDITS = {}; store.del(EDIT_KEY); applyEdits(); $('#resetBtn').textContent = 'Reset edits'; render(); toast('Edits cleared');
    });
    window.addEventListener('hashchange', () => { const g = fromHash(); if (g && g !== S.group) setGroup(g, false); });
    const refreshDate = () => { const d = localDate(); if (d !== AS_OF) { AS_OF = d; applyEdits(); render(); } };
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
    const ranking = fetch('v2-ranking.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (inline) return [JSON.parse(inline.textContent), await ranking];
    const r = await fetch('v2-data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return [await r.json(), await ranking];
  }

  load().then(([d, ranking]) => {
    RAW = d;
    RANKING = isObject(ranking) && isObject(ranking.models) && Object.keys(ranking.models).some(k => d.models[k]) ? ranking : null;
    applyEdits();
    if (RANKING) {
      const when = new Date(RANKING.ranked_at + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const [title, sub] = String(RANKING.board).split(/ (?=\()/);
      const board = `<a href="${esc(RANKING.board_url)}" target="_blank" rel="noopener">arena.ai ${esc(title)}<span class="bsub">${sub ? ' ' + esc(sub) : ''}</span></a>`;
      $('#rankSrc').innerHTML = ` · ranked by ${board}, ${esc(when)}`;
      $('#rankNote').innerHTML = `Models and default order follow the ${board} leaderboard (# = arena rank): its top ${esc(RANKING.top || 50)}, listed when Databricks, AWS, Azure, Fireworks, Google or Alibaba hosts the model. Checked daily; order last changed ${esc(when)}.`;
    }
    const dt = d.reviewed_at;
    const pretty = dt ? new Date(dt + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    $('#verified').textContent = pretty; $('#srcDate').textContent = '· checked ' + pretty;
    if (d.usd_per_dbu) $('#dbu').textContent = '$' + d.usd_per_dbu;
    const srcList = d.source_meta ? Object.values(d.source_meta) : (d.sources || []).map(u => { const url = String(u).split(' ')[0]; let label = url; try { label = new URL(url).hostname; } catch (e) {} return { url, label }; });
    $('#srcs').innerHTML = srcList.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join('');
    $('#sort').value = S.sort; $('#blend').value = String(S.blend);
    S.group = fromHash() || 'all';
    bind(); render();
    document.body.dataset.ready = 'true';
  }).catch(err => {
    $('#mx').innerHTML = `<tbody><tr class="empty"><td>Could not load v2-data.json (${esc(err.message)}). Serve this folder over HTTP rather than opening the file directly.</td></tr></tbody>`;
  });
})();
