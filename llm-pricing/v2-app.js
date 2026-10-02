(() => {
  'use strict';
  const M = window.LLMPricingMath;
  const AS_OF = new Date().toISOString().slice(0, 10);
  const PL = ['databricks','official','bedrock','azure_foundry','fireworks','gcloud','alicloud'];
  const LONG = {databricks:'Databricks',official:'原廠 API',bedrock:'AWS Bedrock',azure_foundry:'Azure Foundry',gcloud:'Google Vertex',fireworks:'Fireworks',alicloud:'Alibaba'};
  const SHORT = {databricks:'DBX',official:'原廠',bedrock:'AWS',azure_foundry:'Azure',gcloud:'GCP',fireworks:'FW',alicloud:'Ali'};
  const ORDER = ['oss','anthropic','openai','google','xai'];
  const TABS = [['oss','OSS'],['anthropic','Anthropic'],['openai','OpenAI'],['google','Google'],['xai','xAI'],['all','All']];
  const HASH = {oss:'oss',anthropic:'anthropic',openai:'openai',google:'google',xai:'xai',all:'all'};
  const HASH_ALIAS = {claude:'anthropic',gpt:'openai',gemini:'google',grok:'xai'};
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

  const prefs = store.get(PREF_KEY, {});
  const S = { group: 'oss', q: '', sort: ['default','price','edge'].includes(prefs.sort) ? prefs.sort : 'default', blend: [1,3,10].includes(+prefs.blend) ? +prefs.blend : 3, edit: false, open: new Set() };
  let RAW = null, DATA = null, EDITS = store.get(EDIT_KEY, {});
  if (!EDITS || typeof EDITS !== 'object' || Array.isArray(EDITS)) EDITS = {};
  if (prefs.theme === 'light' || prefs.theme === 'dark') document.documentElement.dataset.theme = prefs.theme;

  const groupOf = (k, m) => m.group || (m.oss ? 'oss' : ({anthropic:'anthropic',openai:'openai',google:'google'}[k.split('/')[0]] || 'oss'));
  const kind = c => !c ? 'unk' : c.status === 'dedicated' ? 'gpu' : ['unavailable','retired'].includes(c.status) ? 'na' : c.status === 'priced' && M.validRate(c.in) && M.validRate(c.out) && !(c.problems || []).length ? 'ok' : 'unk';
  const blendOf = c => kind(c) !== 'ok' ? null : (S.blend * c.in + c.out) / (S.blend + 1);
  const deltaOf = (c, base) => M.delta(c, base, S.blend).value;
  const dirOf = d => d == null ? null : d > 0.01 ? 'up' : d < -0.01 ? 'down' : 'par';
  const pct = d => { const n = Math.round(Math.abs(d) * 100); return n + '%'; };
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

  function applyEdits() {
    DATA = JSON.parse(JSON.stringify(RAW));
    // older data.json files have no display fields: derive them from the model key
    for (const [k, m] of Object.entries(DATA.models || {})) {
      if (!m.name) m.name = k.split('/').pop();
      if (!m.maker) m.maker = k.split('/')[0];
      if (!m.platforms) m.platforms = {};
      for (const pl of PL) {
        const resolved = M.resolveOffer(m.platforms[pl], {asOf: AS_OF});
        if (resolved.promotion_expired && resolved.tier) resolved.tier = resolved.tier.replace(/20% promotion|Promo price|Intro promo|intro until[^·]*/gi, 'list price');
        m.platforms[pl] = resolved;
      }
    }
    for (const [key, val] of Object.entries(EDITS)) {
      const [mk, pl, f] = key.split('|');
      const c = DATA.models[mk] && DATA.models[mk].platforms[pl];
      const published = RAW.models[mk] && RAW.models[mk].platforms[pl];
      if (c && published && published.status === 'priced' && FIELDS.includes(f) && (val === null || val === '' || M.validRate(+val))) {
        c[f] = val === null || val === '' ? null : +val;
        c.user_modified = true;
      }
    }
  }
  const isEdited = (mk, pl) => Boolean(DATA.models[mk] && DATA.models[mk].platforms[pl] && DATA.models[mk].platforms[pl].user_modified);

  function rows() {
    const q = S.q.trim().toLowerCase();
    let arr = Object.entries(DATA.models).map(([k, m], i) => ({ k, m, i, g: groupOf(k, m) }));
    if (S.group !== 'all') arr = arr.filter(r => r.g === S.group);
    if (q) arr = arr.filter(r => [r.k, r.m.name, r.m.short, r.m.maker, r.m.about, ...Object.values(r.m.platforms).map(c => c.model_id)].join(' ').toLowerCase().includes(q));
    const dbx = r => r.m.platforms.databricks;
    if (S.sort === 'price') arr.sort((a, b) => (blendOf(dbx(a)) ?? 9e9) - (blendOf(dbx(b)) ?? 9e9));
    else if (S.sort === 'edge') arr.sort((a, b) => edge(b) - edge(a) || a.i - b.i);
    else if (S.group === 'all') arr.sort((a, b) => ORDER.indexOf(a.g) - ORDER.indexOf(b.g) || a.i - b.i);
    return arr;
  }
  function edge(r) {
    let s = 0, sum = 0; const base = r.m.platforms.databricks;
    for (const pl of PL) {
      if (pl === 'databricks') continue;
      const c = r.m.platforms[pl], k = kind(c);
      if (k === 'ok') { const d = deltaOf(c, base); if (d != null) { sum += d; s += d > 0.01 ? 1 : d < -0.01 ? -1 : 0; } }
    }
    return s + sum / 100;
  }

  function tip(pl, c, d, dir) {
    const bits = [LONG[pl] + ': $' + precise(c.in) + ' / $' + precise(c.out)];
    if (c.cache_read != null) bits.push('cache read $' + precise(c.cache_read));
    if (c.cache_write != null) bits.push('cache write $' + precise(c.cache_write));
    if (c.tier) bits.push(c.tier);
    if (c.pricing_checked_at) bits.push('price checked ' + c.pricing_checked_at);
    if (c.model_id) bits.push(c.model_id);
    if (c.user_modified) bits.push('personal price');
    if (d != null && pl !== 'databricks') bits.push(dir === 'par' ? 'parity with DBX' : (dir === 'up' ? '+' : '−') + pct(d) + ' vs DBX (' + S.blend + ':1 blend)');
    return bits.join(' · ');
  }

  function cellHtml(r, pl) {
    const m = r.m, c = m.platforms[pl], k = kind(c), base = m.platforms.databricks;
    const ed = isEdited(r.k, pl) ? ' edited' : '';
    const shade = pl === 'databricks' ? ' dbx' : '';
    if (k === 'gpu') return `<td class="c na${shade}" title="${esc(LONG[pl] + ': dedicated deployment only · ' + (c.note || 'No verified per-token offer'))}"><span class="x" aria-label="dedicated deployment only">GPU</span></td>`;
    if (k === 'na') {
      const a = c.alt;
      const state = c.status === 'retired' ? 'retired on Databricks ' + c.retires_on : 'not offered';
      const t = LONG[pl] + ': ' + state + (a ? ' · closest ' + a.name + ' $' + fmt(a.in) + ' / $' + fmt(a.out) : '') + (c.note ? ' · ' + c.note : '');
      return `<td class="c na${shade}" title="${esc(t)}"><span class="x" aria-label="${esc(state)}">✕</span>${a ? `<span class="alt"><span class="an">${esc(shortAlt(a))}</span><span class="ap"> ${fmt(a.in)} / ${fmt(a.out)}</span></span>` : ''}</td>`;
    }
    if (k === 'unk') return `<td class="c unk${shade}${ed}" title="${esc(LONG[pl] + ': ' + ((c && c.note) || 'not verified'))}"><span class="q" aria-label="not verified">?</span></td>`;
    if (pl === 'databricks') return `<td class="c dbx${ed}" title="${esc(tip(pl, c))}"><span class="io"><span class="i">${fmt(c.in)}</span><span class="sl">/</span><span class="o">${fmt(c.out)}</span></span></td>`;
    const d = deltaOf(c, base), dir = dirOf(d);
    const ar = dir && dir !== 'par' ? `<span class="ar ${dir}" aria-hidden="true">${dir === 'up' ? '▲' : '▼'}</span>` : '';
    return `<td class="c ${dir || ''}${ed}" title="${esc(tip(pl, c, d, dir))}"><span class="io"><span class="i">${fmt(c.in)}</span><span class="sl">/</span><span class="o">${fmt(c.out)}${ar}</span></span>${d != null ? `<span class="d ${dir}">${dLabel(d, dir)}</span>` : ''}</td>`;
  }

  function rowHtml(r) {
    const m = r.m, open = S.open.has(r.k);
    const badges = (m.badges || []).map(b => `<span class="bdg">${esc(b)}</span>`).join('') + (m.warn ? `<span class="bdg warn" title="${esc(m.warn)}">!</span>` : '');
    const meta = [m.maker, m.ctx && (m.ctx + ' ctx')].filter(Boolean).join(' · ');
    return `<tr class="row${open ? ' open' : ''}" data-k="${esc(r.k)}"><th scope="row" class="m"><button type="button" class="mb" aria-expanded="${open}" aria-controls="d-${slug(r.k)}"><span class="nm"><span class="f">${esc(m.name)}</span><span class="s">${esc(m.short || m.name)}</span>${badges}<span class="chev" aria-hidden="true">›</span></span><span class="mk">${esc(meta)}</span></button></th>${PL.map(pl => cellHtml(r, pl)).join('')}</tr>`;
  }

  function offerInfo(c, pl, base) {
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
      info.push('Retires ' + esc(c.retires_on) + ' · replacement: ' + esc((c.replacement || []).join(' / ')) + (source ? ` <a href="${esc(source.url)}" target="_blank" rel="noopener">retirement source ↗</a>` : ''));
    }
    if (c.promotion_expired) info.push('Promotion ended ' + esc(c.promotion.ends_on) + '; published post-promotion rates shown.');
    if (pl !== 'databricks' && kind(c) === 'ok') {
      const reason = M.comparisonReason(c, base);
      if (reason) info.push('Δ excluded: ' + esc(reason));
    }
    return info.join(' · ');
  }

  function rateChip(label, c) {
    const cache = [['cache_read','cr'],['cache_write','cw'],['cache_write_1h','1h write']].filter(([field]) => M.validRate(c[field])).map(([field, name]) => ' · ' + name + ' ' + precise(c[field])).join('');
    return `<span>${esc(label)} <b>${precise(c.in)} / ${precise(c.out)}</b>${cache}</span>`;
  }

  function detailHtml(r) {
    const m = r.m, base = m.platforms.databricks;
    const meta = [m.maker, m.about, m.ctx && ('context ' + m.ctx)].filter(Boolean).join(' · ');
    let body = '';
    for (const pl of PL) {
      const c = m.platforms[pl], k = kind(c), src = srcUrl(c, pl);
      const link = src ? ` <a href="${esc(src)}" target="_blank" rel="noopener">source ↗</a>` : '';
      const editable = S.edit && RAW.models[r.k].platforms[pl].status === 'priced' && c.status !== 'retired';
      if (k !== 'ok' && !editable) {
        const st = k === 'gpu' ? 'Dedicated deployment only' : c.status === 'retired' ? 'Retired on Databricks' : k === 'na' ? 'Not offered' : c.available ? 'Price pending verification' : 'Not verified';
        const alt = c && c.alt ? ` · closest <b>${esc(c.alt.name)}</b> ${fmt(c.alt.in)} / ${fmt(c.alt.out)}` : '';
        body += `<tr><td class="pl">${esc(LONG[pl])}</td><td class="st" colspan="6">${st}${alt}</td></tr>`;
        body += `<tr class="info"><td colspan="7">${offerInfo(c, pl, base)}${link}</td></tr>`;
        continue;
      }
      const d = pl === 'databricks' ? null : deltaOf(c, base), dir = dirOf(d);
      const nums = FIELDS.map(f => {
        const cls = f === 'cache_write_1h' ? ' class="w1h"' : '';
        if (S.edit) return `<td${cls}><input inputmode="decimal" name="${esc(r.k + '|' + pl + '|' + f)}" id="e-${slug(r.k + '-' + pl + '-' + f)}" data-e="${esc(r.k + '|' + pl + '|' + f)}" value="${c[f] == null ? '' : c[f]}" aria-label="${esc(LONG[pl] + ' ' + f)}"></td>`;
        return `<td${cls}>${precise(c[f])}</td>`;
      }).join('');
      const dd = pl === 'databricks' ? 'base' : d == null ? '' : dLabel(d, dir);
      body += `<tr><td class="pl${pl === 'databricks' ? ' is-dbx' : ''}">${esc(LONG[pl])}</td>${nums}<td class="dd ${dir || ''}">${dd}</td></tr>`;
      const bits = offerInfo(c, pl, base);
      let vars = (c.variants || []).filter(v => !v.context_only).map(v => {
        if (v.future_only) return rateChip(v.label, v);
        const resolved = M.resolveOffer(RAW.models[r.k].platforms[pl], {asOf: AS_OF, variantId: v.id});
        return resolved.status === 'priced' ? rateChip(v.label, resolved) : `<span>${esc(v.label)} · ${esc((resolved.problems || []).join(' ') || 'Rates not verified')}</span>`;
      }).join('');
      if (c.long_context) vars += rateChip((c.context_threshold_inclusive ? '≥' : '>') + (c.context_threshold / 1000) + 'K input', c.long_context);
      else if (c.context_threshold) vars += `<span>${c.context_threshold_inclusive ? '≥' : '&gt;'}${c.context_threshold / 1000}K input: rates for this tier not verified</span>`;
      if (c.promotion && !c.promotion_expired && !(c.variants || []).some(v => v.future_only)) {
        vars += rateChip('After ' + c.promotion.ends_on, c.promotion.after);
        if (c.promotion.after.long_context) vars += rateChip('After ' + c.promotion.ends_on + ' · >' + (c.context_threshold / 1000) + 'K input', c.promotion.after.long_context);
      }
      body += `<tr class="info"><td colspan="7">${bits}${link}${vars ? `<div class="chips">${vars}</div>` : ''}</td></tr>`;
    }
    return `<tr class="detail" id="d-${slug(r.k)}"><td colspan="8"><div class="dw"><div class="dh"><b>${esc(m.name)}</b><span class="meta">${esc(meta)}</span>${m.warn ? `<span class="warn">${esc(m.warn)}</span>` : ''}<button type="button" class="copy" data-copy="${esc(r.k)}">Copy summary</button>${m.note ? `<span class="note">${esc(m.note)}</span>` : ''}</div><div class="dtwrap"><table class="dt"><thead><tr><th class="pl">Platform</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th class="w1h">1h write</th><th>Δ vs DBX</th></tr></thead><tbody>${body}</tbody></table></div></div></td></tr>`;
  }

  function footHtml(list) {
    const n = list.length;
    const cells = PL.map(pl => {
      let off = 0, up = 0, dn = 0;
      for (const r of list) {
        const c = r.m.platforms[pl];
        if (kind(c) !== 'ok') continue;
        off++;
        if (pl === 'databricks') continue;
        const d = deltaOf(c, r.m.platforms.databricks);
        if (d != null) { if (d > 0.01) up++; else if (d < -0.01) dn++; }
      }
      const cd = pl === 'databricks' ? '' : `<span class="cd">${up ? `<i class="up">▲${up}</i>` : ''}${dn ? `<i class="down">▼${dn}</i>` : ''}</span>`;
      return `<td><span class="cv">${off}/${n}</span>${cd}</td>`;
    }).join('');
    return `<tfoot><tr><th scope="row" class="m"><span class="nm">Has model</span><span class="mk mk2">priced cells · ▲ ▼ vs DBX</span></th>${cells}</tr></tfoot>`;
  }

  function renderSummary(list) {
    const published = M.summarize(list.map(r => RAW.models[r.k]), {asOf: AS_OF, inputRatio: S.blend});
    const total = published.comparedModels, tied = published.noCheaperModels, cheaper = published.cheaperCells, gaps = published.gaps;
    const g = S.group === 'all' ? null : S.group;
    const tips = g ? (DATA.insights && DATA.insights[g]) || [] : ORDER.flatMap(x => ((DATA.insights && DATA.insights[x]) || []).slice(0, 1));
    const wide = window.matchMedia('(min-width: 721px)').matches;
    $('#summary').innerHTML =
      `<div class="kpis"><div class="kpi good"><b>${tied}<small>/${total}</small></b><span>models where no hyperscaler beats DBX (AWS · Azure · GCP)</span></div>` +
      `<div class="kpi"><b>${gaps.bedrock}<small> · </small>${gaps.azure_foundry}<small> · </small>${gaps.gcloud}</b><span>models not offered on AWS · Azure · GCP (✕)</span></div>` +
      `<div class="kpi warn"><b>${cheaper}</b><span>cells cheaper than DBX on any platform (▼): check first</span></div></div>` +
      (tips.length ? `<details class="talk"${wide ? ' open' : ''}><summary>Talk track</summary><ul>${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>` : '');
  }

  function render() {
    const list = rows();
    const counts = { all: 0 };
    for (const [k, m] of Object.entries(DATA.models)) { const g = groupOf(k, m); counts[g] = (counts[g] || 0) + 1; counts.all++; }
    $('#tabs').innerHTML = TABS.map(([id, label]) => `<button type="button" role="tab" class="tab" data-g="${id}" aria-selected="${S.group === id}">${label}<span class="n">${counts[id] || 0}</span></button>`).join('');
    const tabs = $('#tabs'), active = tabs.querySelector('[aria-selected="true"]');
    if (active) {
      const bounds = tabs.getBoundingClientRect(), selected = active.getBoundingClientRect();
      if (selected.right > bounds.right) tabs.scrollLeft += selected.right - bounds.right;
      else if (selected.left < bounds.left) tabs.scrollLeft -= bounds.left - selected.left;
    }
    renderSummary(list);
    const head = `<colgroup><col class="cm">${PL.map(() => '<col>').join('')}</colgroup><thead><tr><th scope="col" class="m">Model<span class="u">$ / 1M · in / out</span></th>${PL.map(pl => `<th scope="col"${pl === 'databricks' ? ' class="dbx"' : ''} title="${esc(LONG[pl])}"><span class="lg">${esc(LONG[pl])}</span><span class="sh">${esc(SHORT[pl])}</span></th>`).join('')}</tr></thead>`;
    let body = '', last = null;
    for (const r of list) {
      if (S.group === 'all' && S.sort === 'default' && r.g !== last) { body += `<tr class="grp"><th colspan="8" scope="rowgroup">${esc((DATA.groups && DATA.groups[r.g] && DATA.groups[r.g].title) || r.g)}</th></tr>`; last = r.g; }
      body += rowHtml(r);
      if (S.open.has(r.k)) body += detailHtml(r);
    }
    if (!list.length) body = `<tr class="empty"><td colspan="8">No models match “${esc(S.q)}”.</td></tr>`;
    const cap = $('#mx caption').outerHTML;
    $('#mx').innerHTML = cap + head + `<tbody>${body}</tbody>` + (list.length ? footHtml(list) : '');
    $('#resetBtn').hidden = !Object.keys(EDITS).length;
    $('#editNote').textContent = Object.keys(EDITS).length ? Object.keys(EDITS).length + ' edited value(s), saved in this browser only' : '';
  }

  function copySummary(mk) {
    const m = DATA.models[mk], base = m.platforms.databricks;
    const lines = [`${m.name} (${m.maker}): USD per 1M text tokens, input / output, reviewed ${DATA.reviewed_at}; prices as of ${AS_OF}`];
    for (const pl of PL) {
      const c = m.platforms[pl], k = kind(c);
      if (k === 'gpu') lines.push(`• ${LONG[pl]}: dedicated deployment only · ${c.note || 'No verified per-token price.'}`);
      else if (k === 'na') lines.push(`• ${LONG[pl]}: ${c.status === 'retired' ? 'retired on ' + c.retires_on : 'not offered'}${c.alt ? ` (closest ${c.alt.name} ${fmt(c.alt.in)} / ${fmt(c.alt.out)})` : ''}`);
      else if (k === 'unk') lines.push(`• ${LONG[pl]}: ${c.available ? 'price pending verification' : 'not verified'}${c.note ? ' · ' + c.note : ''}`);
      else {
        const d = pl === 'databricks' ? null : deltaOf(c, base), dir = dirOf(d);
        const reason = pl === 'databricks' ? null : M.comparisonReason(c, base);
        lines.push(`• ${LONG[pl]}: ${precise(c.in)} / ${precise(c.out)}${c.cache_read != null ? ` · cache read ${precise(c.cache_read)}` : ''}${c.cache_write != null ? ` · cache write ${precise(c.cache_write)}` : ''}${c.tier ? ' · ' + c.tier : ''}${c.user_modified ? ' · personal price' : ''}${d != null ? ` (${dir === 'par' ? 'parity' : (dir === 'up' ? '+' : '−') + pct(d)} vs DBX)` : reason ? ' · Δ excluded: ' + reason : ''}${c.pricing_checked_at ? ' · Price checked ' + c.pricing_checked_at : ''}${c.model_id ? ' · ID ' + c.model_id : ''}`);
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
    if (push) { try { history.replaceState(null, '', '#' + HASH[g]); } catch (e) {} }
    render();
  }
  function fromHash() { const h = (location.hash || '').slice(1).toLowerCase(); return HASH_ALIAS[h] || Object.keys(HASH).find(k => HASH[k] === h); }

  function bind() {
    $('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setGroup(b.dataset.g, true); });
    $('#q').addEventListener('input', e => { S.q = e.target.value; if (S.q && S.group !== 'all') S.group = 'all'; render(); });
    $('#sort').addEventListener('change', e => { S.sort = e.target.value; store.set(PREF_KEY, { ...prefs, sort: S.sort, blend: S.blend }); render(); });
    $('#blend').addEventListener('change', e => { S.blend = +e.target.value; store.set(PREF_KEY, { ...prefs, sort: S.sort, blend: S.blend }); render(); });
    $('#mx').addEventListener('click', e => {
      const cp = e.target.closest('.copy'); if (cp) { copySummary(cp.dataset.copy); return; }
      if (e.target.closest('tr.detail') || e.target.closest('a,input')) return;
      const tr = e.target.closest('tr.row'); if (!tr) return;
      const k = tr.dataset.k; S.open.has(k) ? S.open.delete(k) : S.open.add(k); render();
    });
    $('#mx').addEventListener('change', e => {
      const el = e.target.closest('input[data-e]'); if (!el) return;
      const value = el.value.trim();
      if (value !== '' && !M.validRate(Number(value))) { toast('Enter a nonnegative finite price'); render(); return; }
      EDITS[el.dataset.e] = value === '' ? null : Number(value); store.set(EDIT_KEY, EDITS); applyEdits(); render();
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
    const bar = $('#bar');
    const setH = () => document.documentElement.style.setProperty('--bar-h', (bar.offsetHeight + (parseFloat(getComputedStyle(bar).top) || 0)) + 'px');
    setH();
    if (window.ResizeObserver) new ResizeObserver(setH).observe(bar); else window.addEventListener('resize', setH);
  }

  async function load() {
    const inline = document.getElementById('inline-data');
    if (inline) return JSON.parse(inline.textContent);
    const r = await fetch('v2-data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  load().then(d => {
    RAW = d; applyEdits();
    const dt = d.reviewed_at;
    const pretty = dt ? new Date(dt + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    $('#verified').textContent = pretty; $('#srcDate').textContent = '· checked ' + pretty;
    if (d.usd_per_dbu) $('#dbu').textContent = '$' + d.usd_per_dbu;
    const srcList = d.source_meta ? Object.values(d.source_meta) : (d.sources || []).map(u => { const url = String(u).split(' ')[0]; let label = url; try { label = new URL(url).hostname; } catch (e) {} return { url, label }; });
    $('#srcs').innerHTML = srcList.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join('');
    $('#sort').value = S.sort; $('#blend').value = String(S.blend);
    S.group = fromHash() || 'oss';
    bind(); render();
    document.body.dataset.ready = 'true';
  }).catch(err => {
    $('#mx').innerHTML = `<tbody><tr class="empty"><td>Could not load v2-data.json (${esc(err.message)}). Serve this folder over HTTP rather than opening the file directly.</td></tr></tbody>`;
  });
})();
