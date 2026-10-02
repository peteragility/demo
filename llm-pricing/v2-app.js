(() => {
  'use strict';
  const M = window.LLMPricingMath;
  const PL = ['databricks', 'official', 'bedrock', 'azure_foundry', 'fireworks', 'gcloud', 'alicloud'];
  const LABEL = {databricks: 'Databricks', official: 'Direct API', bedrock: 'AWS Bedrock', azure_foundry: 'Azure Foundry', fireworks: 'Fireworks', gcloud: 'Google Vertex', alicloud: 'Alibaba'};
  const ORDER = ['openai', 'anthropic', 'google', 'xai', 'oss'];
  const GROUP = {all: 'All', oss: 'Open models', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI'};
  const ALIASES = {claude: 'anthropic', gpt: 'openai', gemini: 'google'};
  const PREF_KEY = 'llm-pricing-v2-preferences', OVERRIDE_KEY = 'llm-pricing-v2-overrides';
  const storage = {
    get(key, fallback) {try {return JSON.parse(localStorage.getItem(key)) ?? fallback;} catch {return fallback;}},
    set(key, value) {try {localStorage.setItem(key, JSON.stringify(value));} catch {}},
    remove(key) {try {localStorage.removeItem(key);} catch {}}
  };
  const $ = selector => document.querySelector(selector);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const slug = key => key.replace(/[^a-zA-Z0-9]+/g, '-');
  const url = value => {try {const u = new URL(value); return u.protocol === 'https:' ? u.href : '';} catch {return '';}};
  const fmt = value => M.validRate(value) ? value.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 5}) : '—';
  const cost = value => M.validRate(value) ? '$' + value.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 4}) : '—';
  const number = value => value.toLocaleString('en-US', {maximumFractionDigits: 4});
  const prettyDate = value => M.validDate(value) ? new Date(value + 'T00:00:00Z').toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}) : 'Unverified';
  const today = () => {const d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');};
  const isAdded = model => (model.badges || []).includes('Added');
  const direction = d => d > 0.01 ? 'higher' : d < -0.01 ? 'lower' : 'parity';
  const deltaText = d => Math.abs(d) <= 0.01 ? '=' : (d > 0 ? '▲ ' : '▼ ') + Math.round(Math.abs(d) * 100) + '%';
  const media = matchMedia('(max-width: 760px)');
  const prefs = storage.get(PREF_KEY, {});
  const initialHash = location.hash.slice(1).toLowerCase();
  const S = {group: GROUP[initialHash] ? initialHash : ALIASES[initialHash] || 'all', query: '', sort: ['default', 'price', 'latest'].includes(prefs.sort) ? prefs.sort : 'default',
    blend: [1, 3, 10].includes(+prefs.blend) ? +prefs.blend : 3,
    mobileProvider: PL.includes(prefs.mobileProvider) && !['databricks', 'official'].includes(prefs.mobileProvider) ? prefs.mobileProvider : 'bedrock',
    newOnly: false, open: new Set(), edit: false, model: 'moonshot/kimi-k3', tiers: {}, asOf: today()};
  let RAW, DATA, lastResults = [], toastTimer;
  let overrides = storage.get(OVERRIDE_KEY, {});
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) overrides = {};
  if (prefs.theme === 'light' || prefs.theme === 'dark') document.documentElement.dataset.theme = prefs.theme;

  function savePrefs() {
    storage.set(PREF_KEY, {sort: S.sort, blend: S.blend, mobileProvider: S.mobileProvider, theme: document.documentElement.dataset.theme});
  }

  function applyOverrides() {
    DATA = JSON.parse(JSON.stringify(RAW));
    for (const [key, value] of Object.entries(overrides)) {
      const [modelKey, platform, field] = key.split('|');
      const c = DATA.models[modelKey]?.platforms?.[platform];
      if (c?.status === 'priced' && M.RATE_FIELDS.includes(field) && (value === null || M.validRate(value))) {
        c[field] = value;
        c.user_modified = true;
      }
    }
  }

  function config() {
    const asOf = $('#asOf').value, dbuRate = Number($('#dbuRate').value);
    if (!M.validDate(asOf) || !$('#asOf').checkValidity()) return {error: 'Enter a valid estimate date.'};
    if (!$('#dbuRate').checkValidity() || !Number.isFinite(dbuRate) || dbuRate <= 0) return {error: 'Enter a USD / DBU price greater than zero.'};
    S.asOf = asOf;
    return {asOf, dbuRate, promptTokens: 1000, inputRatio: S.blend};
  }

  function sourceLink(c, label = 'Pricing source ↗') {
    const href = url(c?.url || DATA.source_meta[c?.src]?.url);
    return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>` : '';
  }

  function metadataLink(sourceId, label) {
    return sourceLink({src: sourceId}, label);
  }

  function scopeText(offer, platform) {
    const scope = offer.comparison_scope;
    if (scope === 'regional') return 'Regional';
    if (scope === 'data-zone') return 'Data Zone';
    if (scope === 'geographic') return 'US geographic';
    if (scope === 'unverified') return 'Scope unconfirmed';
    return platform === 'official' ? 'Direct' : platform === 'databricks' ? 'Standard' : 'Global';
  }

  function offerLabel(offer) {
    let label = offer.tier || (offer.status === 'priced' ? scopeText(offer) : 'Unverified tier');
    if (offer.promotion_expired) label = label.replace(/\(promotion\)|20% promotion|Promo price.*|Intro promo.*|intro until.*/gi, 'list price');
    return label;
  }

  function stateLabel(offer) {
    return {dedicated: 'Dedicated deployment only', unavailable: 'Unavailable', unverified: offer.available ? 'Price pending verification' : 'Offer unverified', retired: 'Retired on Databricks'}[offer.status] || 'Price unverified';
  }

  function selectedRows(cfg) {
    const q = S.query.trim().toLowerCase();
    let rows = Object.entries(DATA.models).map(([key, model], index) => ({key, model, index}));
    if (S.group !== 'all') rows = rows.filter(r => r.model.group === S.group);
    if (S.newOnly) rows = rows.filter(r => isAdded(r.model));
    if (q) rows = rows.filter(r => [r.key, r.model.name, r.model.maker, r.model.about, ...Object.values(r.model.platforms).map(c => c.model_id)].join(' ').toLowerCase().includes(q));
    const family = r => ORDER.indexOf(r.model.group);
    if (S.sort === 'price') {
      const blended = r => {const o = M.resolveOffer(r.model.platforms.databricks, cfg); return o.status === 'priced' && !o.problems.length ? S.blend * o.in + o.out : Infinity;};
      rows.sort((a, b) => blended(a) - blended(b) || a.index - b.index);
    } else if (S.sort === 'latest') rows.sort((a, b) => Number(isAdded(b.model)) - Number(isAdded(a.model)) || family(a) - family(b) || a.index - b.index);
    else rows.sort((a, b) => family(a) - family(b) || a.index - b.index);
    return rows;
  }

  function visiblePlatforms() {return media.matches ? ['databricks', 'official', S.mobileProvider] : PL;}

  function renderTabs() {
    const counts = {all: Object.keys(DATA.models).length};
    for (const model of Object.values(DATA.models)) counts[model.group] = (counts[model.group] || 0) + 1;
    $('#tabs').innerHTML = ['all', 'oss', 'anthropic', 'openai', 'google', 'xai'].map(group => `<button type="button" class="tab" data-group="${group}" aria-pressed="${S.group === group}">${esc(GROUP[group])}<span class="count">${counts[group] || 0}</span></button>`).join('');
  }

  function renderSummary(rows, cfg) {
    const summary = M.summarize(rows.map(r => r.model), cfg);
    const tips = S.group === 'all' ? ORDER.map(group => DATA.insights[group]?.[0]).filter(Boolean) : DATA.insights[S.group] || [];
    const gaps = summary.gaps;
    const open = !media.matches;
    $('#summary').innerHTML = `<div><div class="kpis">
      <div class="kpi good"><strong>${summary.noCheaperModels}<small> / ${summary.comparedModels}</small></strong><span>compared models with no cheaper hyperscaler</span></div>
      <div class="kpi warning"><strong>${summary.cheaperCells}<small> / ${summary.comparableCells}</small></strong><span>comparable offers cheaper than DBX</span></div>
      <div class="kpi"><strong class="gap-values">${gaps.bedrock}<small> · </small>${gaps.azure_foundry}<small> · </small>${gaps.gcloud}</strong><span>availability gaps on AWS · Azure · GCP</span></div>
      </div><p class="summary-note">${summary.withoutComparison} model${summary.withoutComparison === 1 ? '' : 's'} without a comparable hyperscaler price excluded from the first count. ${summary.dedicated} dedicated-only · ${summary.unverified} unverified offer${summary.unverified === 1 ? '' : 's'}.</p></div>
      <details class="insights"${open ? ' open' : ''}><summary>What to watch</summary><ul>${tips.map(tip => `<li>${esc(tip)}</li>`).join('')}</ul></details>`;
  }

  function matrixCell(row, platform, cfg) {
    const c = row.model.platforms[platform];
    const offer = M.resolveOffer(c, cfg);
    const commonClass = platform === 'databricks' ? ' dbx' : '';
    if (offer.status !== 'priced' || offer.problems.length) {
      const label = offer.status === 'priced' ? 'Price unverified' : stateLabel(offer);
      const short = offer.status === 'dedicated' ? 'GPU' : offer.status === 'unavailable' ? '—' : offer.status === 'retired' ? 'Retired' : '?';
      const note = offer.problems.join(' ') || offer.note || label;
      return `<td class="price-cell${commonClass}" data-platform="${platform}" data-status="${offer.status}" title="${esc(note)}"><span class="state-label">${short}<small>${esc(offer.status === 'dedicated' ? 'Dedicated' : offer.status === 'unavailable' ? 'Unavailable' : offer.status === 'retired' ? prettyDate(offer.retires_on) : 'Unverified')}</small></span></td>`;
    }
    const base = M.resolveOffer(row.model.platforms.databricks, cfg);
    const d = platform === 'databricks' ? {value: null, reason: null} : M.delta(offer, base, S.blend);
    const dir = d.value == null ? '' : direction(d.value);
    let tag = scopeText(offer, platform);
    if (offer.model_match !== 'confirmed') tag += ' · version ?';
    else if (offer.promotion) tag += offer.promotion_expired ? ' · list' : ' · promo';
    const exception = offer.model_match !== 'confirmed' || ['regional', 'data-zone', 'geographic', 'unverified'].includes(offer.comparison_scope);
    const title = `${LABEL[platform]}: ${fmt(offer.in)} / ${fmt(offer.out)} · ${offerLabel(offer)} · ${offer.user_modified ? 'Personal price override' : 'Price checked ' + (offer.pricing_checked_at || 'unverified')}${d.reason ? ' · ' + d.reason : ''}`;
    return `<td class="price-cell ${dir}${commonClass}" data-platform="${platform}" data-status="priced" title="${esc(title)}"><span class="io"><span class="in">${fmt(offer.in)}</span><span class="slash">/</span><span class="out">${fmt(offer.out)}</span></span>${d.value != null ? `<span class="delta ${dir}">${esc(deltaText(d.value))}</span>` : ''}<span class="tier-tag${exception ? ' exception' : ''}">${esc(tag)}</span>${offer.user_modified ? '<span class="personal-label">Personal</span>' : ''}</td>`;
  }

  function detailOffer(key, platform, cfg) {
    const c = DATA.models[key].platforms[platform], offer = M.resolveOffer(c, cfg);
    const priced = offer.status === 'priced' && !offer.problems.length;
    const metadata = `<p>${c.user_modified ? '<span class="personal-label">Personal price override</span> · ' : ''}Price checked: <b>${esc(prettyDate(c.pricing_checked_at))}</b> · availability: ${esc(prettyDate(c.availability_checked_at))}</p>`;
    const identity = c.model_id ? `<p class="identity">${esc(c.model_id)}</p><p>${metadataLink(c.model_id_source || c.src, 'Model ID source ↗')}</p>` : '<p class="exception">Exact endpoint ID not confirmed.</p>';
    const sku = c.billing_sku ? `<p>Billing SKU: <span class="identity">${esc(c.billing_sku)}</span></p>` : '';
    const issues = M.comparisonReason(offer, M.resolveOffer(DATA.models[key].platforms.databricks, cfg));
    const compareNote = platform !== 'databricks' && priced && issues ? `<p class="exception">${esc(issues)} Δ excluded.</p>` : '';
    let body;
    if (priced) {
      const cache = [['cache_read', 'Cached input'], ['cache_write', 'Cache write'], ['cache_write_1h', '1h cache write'], ['cache_storage', 'Storage / M token-hour']];
      body = `<p class="offer-price">${fmt(offer.in)} / ${fmt(offer.out)} <small>input / output</small></p><p><b>${esc(offerLabel(offer))}</b>${offer.context_threshold ? ' · long rates ' + (offer.context_threshold_inclusive ? 'at or above ' : 'above ') + number(offer.context_threshold) + ' input tokens' : ''}</p><div class="cache-grid">${cache.map(([field, label]) => `<div class="cache-item">${label}<b>${offer[field] == null ? 'Unverified' : '$' + fmt(offer[field])}</b></div>`).join('')}</div>`;
    } else body = `<p><b>${esc(offer.status === 'priced' ? 'Rate unverified for this context' : stateLabel(offer))}</b></p>`;
    if (offer.problems.length) body += `<p class="exception">${esc(offer.problems.join(' '))}</p>`;
    if (c.regions) body += `<p>${esc(c.regions)} ${platform === 'databricks' ? metadataLink('dbx_region', 'Region catalog ↗') : ''}</p>`;
    if (c.note) body += `<p>${esc(c.note)}</p>`;
    if (c.alt) body += `<p>Closest alternative: ${esc(c.alt.name)} · ${fmt(c.alt.in)} / ${fmt(c.alt.out)}. Different model; no price delta.</p>`;
    if (c.retires_on) body += `<p class="exception">Databricks retirement: ${esc(prettyDate(c.retires_on))}. Replacement: ${esc((c.replacement || []).join(' or '))}. ${metadataLink(c.retirement_src, 'Retirement source ↗')}</p>`;
    if (c.promotion) body += `<p>${esc(c.promotion.label)} through ${esc(prettyDate(c.promotion.ends_on))}.${offer.promotion_expired ? ' The displayed rates are the verified post-promotion rates.' : ''}</p>`;
    const variants = (c.variants || []).map(v => {
      const note = v.context_only ? 'Context pricing band; chosen automatically by request size.' : v.future_only ? 'Scheduled list price; applied by estimate date.' : '';
      return `<div class="variant-item"><b>${esc(v.label)}</b> · ${fmt(v.in)} / ${fmt(v.out)}${v.cache_read != null ? ' · cache hit ' + fmt(v.cache_read) : ''}${v.cache_write != null ? ' · write ' + fmt(v.cache_write) : ''}${v.cache_write_1h != null ? ' · 1h write ' + fmt(v.cache_write_1h) : ''}<br>${esc(note || [scopeText(v, platform), v.service_tier].filter(Boolean).join(' · '))}${v.pricing_checked_at ? ' · checked ' + esc(prettyDate(v.pricing_checked_at)) : ''}${v.model_match !== 'confirmed' ? '<br>Model version unconfirmed; excluded from deltas.' : ''}</div>`;
    }).join('');
    let edit = '';
    if (S.edit && c.status === 'priced') {
      edit = `<form class="override-form" data-override-model="${esc(key)}" data-override-platform="${platform}">${M.RATE_FIELDS.map(field => `<label>${esc(({in: 'Input', out: 'Output', cache_read: 'Cached input', cache_write: 'Cache write', cache_write_1h: '1h write', cache_storage: 'Hourly storage'})[field])}<input type="number" min="0" step="any" name="${field}" value="${c[field] ?? ''}"${field === 'in' || field === 'out' ? ' required' : ''}></label>`).join('')}<button type="submit" class="button">Save personal prices</button></form>`;
    }
    return `<article class="offer${platform === 'databricks' ? ' dbx' : ''}" data-offer-platform="${platform}"><h3>${esc(LABEL[platform])}</h3>${body}${compareNote}${metadata}${identity}${sku}<p>${sourceLink(c, priced ? 'Pricing source ↗' : 'Availability / offer source ↗')}</p>${variants ? `<details><summary>Other tiers and context rates</summary><div class="variant-list">${variants}</div></details>` : ''}${edit}</article>`;
  }

  function rowDetails(row, count, cfg) {
    const model = row.model;
    return `<tr class="detail-row" id="detail-${slug(row.key)}"><td colspan="${count + 1}"><div class="detail-heading"><div><h2>${esc(model.name)}</h2><p>${esc([model.maker, model.ctx && model.ctx + ' context', model.about].filter(Boolean).join(' · '))}</p>${model.warn ? `<p class="warning">${esc(model.warn)}</p>` : ''}${model.note ? `<p>${esc(model.note)}</p>` : ''}</div><div class="detail-actions"><button type="button" class="button" data-estimate="${esc(row.key)}">Estimate this model</button><button type="button" class="button" data-copy-model="${esc(row.key)}">Copy summary</button></div></div><div class="offer-grid">${PL.map(platform => detailOffer(row.key, platform, cfg)).join('')}</div></td></tr>`;
  }

  function renderMatrix(rows, cfg) {
    const platforms = visiblePlatforms();
    const head = `<caption class="sr">Text-token prices by model and platform. Select a model to view exact offers and sources.</caption><colgroup><col class="model-col">${platforms.map(() => '<col>').join('')}</colgroup><thead><tr><th scope="col" class="model-cell">Model</th>${platforms.map(platform => `<th scope="col"${platform === 'databricks' ? ' class="dbx"' : ''}>${esc(media.matches && platform === 'databricks' ? 'DBX' : LABEL[platform])}</th>`).join('')}</tr></thead>`;
    let body = '', previous = null;
    for (const row of rows) {
      const model = row.model, open = S.open.has(row.key);
      if (S.group === 'all' && S.sort === 'default' && previous !== model.group) {
        body += `<tr class="group-row"><th scope="rowgroup" colspan="${platforms.length + 1}">${esc(DATA.groups[model.group]?.title || GROUP[model.group])}</th></tr>`;
        previous = model.group;
      }
      const badges = (model.badges || []).map(badge => `<span class="badge${badge === 'Added' ? ' added' : ''}">${esc(badge)}</span>`).join('');
      body += `<tr class="row${open ? ' open' : ''}" data-model="${esc(row.key)}"><th scope="row" class="model-cell"><button type="button" class="model-button" id="model-${slug(row.key)}" data-model-button="${esc(row.key)}" aria-expanded="${open}"${open ? ` aria-controls="detail-${slug(row.key)}"` : ''}><span class="model-name">${esc(model.name)}<span class="row-chevron" aria-hidden="true">${open ? '▾' : '›'}</span></span><span class="model-meta">${esc(model.maker)}${model.ctx ? ' · ' + esc(model.ctx) : ''}</span>${badges}${model.warn ? '<span class="badge warning">Watch date</span>' : ''}</button></th>${platforms.map(platform => matrixCell(row, platform, cfg)).join('')}</tr>`;
      if (open) body += rowDetails(row, platforms.length, cfg);
    }
    if (!rows.length) body = `<tr class="empty"><td colspan="${platforms.length + 1}">No models match these filters.</td></tr>`;
    const foot = rows.length ? `<tfoot><tr><th scope="row">Verified prices<span class="small">Comparable offers below</span></th>${platforms.map(platform => {
      let priced = 0, comparable = 0;
      for (const row of rows) {
        const resolved = M.resolveOffer(row.model.platforms[platform], cfg);
        if (resolved.status === 'priced' && !resolved.problems.length) priced++;
        if (platform !== 'databricks' && M.delta(resolved, M.resolveOffer(row.model.platforms.databricks, cfg), S.blend).value != null) comparable++;
      }
      return `<td>${priced} / ${rows.length}<span class="small">${platform === 'databricks' ? 'baseline' : comparable + ' comparable'}</span></td>`;
    }).join('')}</tr></tfoot>` : '';
    $('#prices').innerHTML = head + `<tbody>${body}</tbody>` + foot;
    $('#rowCount').textContent = rows.length + ' / ' + Object.keys(DATA.models).length + ' models';
  }

  function workload() {
    const form = $('#workload');
    const cfg = config();
    if (cfg.error) return {error: cfg.error};
    if (!form.checkValidity()) return {error: 'Complete the usage fields with nonnegative numbers; cache-hit rate must be 0–100%.'};
    const values = {};
    for (const id of ['inputM', 'outputM', 'cacheHit', 'writeM', 'storedM', 'storageHours', 'promptTokens']) values[id] = Number($('#' + id).value);
    values.writeTTL = $('#writeTTL').value;
    return {...cfg, ...values};
  }

  function renderCalculator() {
    const model = DATA.models[S.model], work = workload();
    const error = $('#calcError');
    if (work.error) {
      error.textContent = work.error; error.hidden = false;
      $('#calcResults').innerHTML = ''; lastResults = []; return;
    }
    const results = PL.map(platform => {
      const variantId = S.tiers[S.model + '|' + platform] || 'base';
      return {platform, result: M.calculate(model.platforms[platform], {...work, variantId}), variantId};
    });
    const errors = [...new Set(results.flatMap(r => r.result.errors))];
    error.textContent = errors.join(' '); error.hidden = !errors.length;
    if (errors.length) {$('#calcResults').innerHTML = ''; lastResults = []; return;}
    lastResults = results;
    const highest = Math.max(0, ...results.filter(r => r.result.complete).map(r => r.result.total));
    const baseline = results.find(r => r.platform === 'databricks').result;
    const globalDate = prettyDate(work.asOf);
    $('#calcDescription').textContent = `${model.name} · ${number(work.inputM)}M input / ${number(work.outputM)}M output · ${number(work.cacheHit)}% cache hit · ${globalDate}`;
    $('#calcResults').innerHTML = results.map(({platform, result, variantId}) => {
      const c = model.platforms[platform], o = result.offer;
      const variants = (c.variants || []).filter(v => !v.context_only && !v.future_only);
      const select = c.status === 'priced' ? `<label class="sr" for="tier-${platform}">${esc(LABEL[platform])} service tier</label><select id="tier-${platform}" data-tier="${platform}"><option value="base"${variantId === 'base' ? ' selected' : ''}>${esc(c.tier || 'Listed Standard tier')}</option>${variants.map(v => `<option value="${esc(v.id)}"${v.id === variantId ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select>` : '';
      let estimate;
      if (o.status !== 'priced') estimate = `<p class="state">${esc(stateLabel(o))}</p><p class="reason">${esc(o.note || '')}</p>`;
      else if (!result.complete) estimate = `<p class="state"><b>Estimate incomplete</b>${result.subtotal != null ? ' · known subtotal ' + cost(result.subtotal) : ''}</p><p class="reason warn">${esc(result.unknown.join(' '))}</p>`;
      else estimate = `<p class="cost">${cost(result.total)} <small>/ month</small></p><div class="cost-bar" aria-hidden="true"><span style="width:${highest ? (result.total / highest * 100).toFixed(3) : 0}%"></span></div>`;
      const breakdown = o.status === 'priced' && result.parts.length ? `<dl class="breakdown">${result.parts.filter(part => part.amount > 0 || part.label === 'Regular input' || part.label === 'Output').map(part => `<div><dt title="${esc(number(part.amount) + ' ' + part.unit + (part.rate == null ? '' : ' × $' + fmt(part.rate)))}">${esc(part.label)}</dt><dd>${part.cost == null ? 'Unverified' : cost(part.cost)}</dd></div>`).join('')}</dl>` : '';
      const compareReason = platform === 'databricks' ? null : M.comparisonReason(o, baseline.offer);
      const comparable = platform !== 'databricks' && result.complete && baseline.complete && baseline.total > 0 && !compareReason;
      const d = comparable ? result.total / baseline.total - 1 : null;
      const compare = d == null ? '' : `<p class="cost-delta ${direction(d)}">${esc(deltaText(d))} vs Databricks for this workload</p>`;
      const incompleteDelta = platform !== 'databricks' && result.complete && compareReason ? `<p class="reason">Δ excluded: ${esc(compareReason)}</p>` : '';
      return `<article class="result${platform === 'databricks' ? ' dbx' : ''}" data-result-platform="${platform}" data-complete="${result.complete}"><div class="result-header"><h3>${esc(LABEL[platform])}</h3><span class="tier-tag${['regional', 'data-zone', 'unverified'].includes(o.comparison_scope) ? ' exception' : ''}">${esc(o.status === 'priced' ? scopeText(o, platform) : '')}</span></div>${select}${estimate}${compare}${breakdown}${incompleteDelta}${c.user_modified ? '<p class="personal-label">Personal price override</p>' : ''}<p class="check">${c.pricing_checked_at ? 'Price checked ' + esc(prettyDate(c.pricing_checked_at)) : 'No verified per-token price'}${o.context_band === 'long' ? ' · long context' : ''}${o.promotion_expired ? ' · post-promotion rates' : ''}</p><p class="check">${sourceLink(c)}</p></article>`;
    }).join('');
  }

  function render() {
    const cfg = config();
    $('#validation').hidden = !cfg.error;
    if (cfg.error) {
      $('#validation').textContent = cfg.error;
      $('#summary').innerHTML = '';
      $('#prices').innerHTML = '<tbody><tr class="empty"><td>Correct the date or DBU price to show estimates.</td></tr></tbody>';
      renderCalculator(); return;
    }
    renderTabs();
    const rows = selectedRows(cfg);
    renderSummary(rows, cfg); renderMatrix(rows, cfg); renderCalculator();
    const n = Object.keys(overrides).length;
    $('#clearOverrides').hidden = !n;
    $('#overrideCount').textContent = n ? n + ' personal value' + (n === 1 ? '' : 's') : '';
    $('#basis').textContent = `Standard listed tiers · Δ ${S.blend}:1 · DBU $${number(cfg.dbuRate)}${n ? ' · personal prices active' : ''}`;
    $('#quoteSummary').textContent = prettyDate(cfg.asOf) + ' · $' + number(cfg.dbuRate);
  }

  function modelText(key) {
    const model = DATA.models[key], cfg = config();
    if (cfg.error) return cfg.error;
    const lines = [`${model.name} · USD per 1M text tokens (input / output) · estimate date ${cfg.asOf}`];
    for (const platform of PL) {
      const c = model.platforms[platform], o = M.resolveOffer(c, cfg);
      if (o.status !== 'priced' || o.problems.length) lines.push(`${LABEL[platform]}: ${o.status === 'priced' ? o.problems.join(' ') : stateLabel(o)}`);
      else {
        const d = platform === 'databricks' ? {value: null} : M.delta(o, M.resolveOffer(model.platforms.databricks, cfg), S.blend);
        lines.push(`${LABEL[platform]}: ${fmt(o.in)} / ${fmt(o.out)} · ${offerLabel(o)}${o.cache_read == null ? '' : ' · cache hit ' + fmt(o.cache_read)}${d.value == null ? (d.reason ? ' · Δ excluded: ' + d.reason : '') : ' · ' + deltaText(d.value) + ' vs DBX (' + S.blend + ':1 blend)'}${c.user_modified ? ' · PERSONAL PRICE' : ''}`);
      }
      lines.push(`  Price checked ${c.pricing_checked_at || 'unverified'}; availability checked ${c.availability_checked_at || 'unverified'}; endpoint ${c.model_id || 'unconfirmed'}`);
      if (c.url) lines.push('  ' + c.url);
    }
    if (model.warn) lines.push(model.warn);
    return lines.join('\n');
  }

  function estimateText() {
    const work = workload();
    if (work.error || !lastResults.length) return work.error || 'No valid estimate to copy.';
    const lines = [`${DATA.models[S.model].name} · monthly text-token estimate on ${work.asOf}`, `Input ${work.inputM}M (including ${work.cacheHit}% cache hits), output ${work.outputM}M, prompt ${work.promptTokens} tokens; USD/DBU ${work.dbuRate}.`, `Cache writes ${work.writeM}M (${work.writeTTL}); storage ${work.storedM}M × ${work.storageHours} hours.`];
    for (const {platform, result} of lastResults) {
      const c = DATA.models[S.model].platforms[platform];
      lines.push(`${LABEL[platform]}: ${result.complete ? cost(result.total) + '/month' : result.offer.status !== 'priced' ? stateLabel(result.offer) : 'Incomplete — ' + result.unknown.join(' ')} · ${offerLabel(result.offer)}${c.user_modified ? ' · PERSONAL PRICE' : ''}`);
      if (c.pricing_checked_at) lines.push('  Price checked ' + c.pricing_checked_at + '; ' + (c.url || ''));
    }
    return lines.join('\n');
  }

  function toast(message) {
    $('#toast').textContent = message; $('#toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => {$('#toast').hidden = true;}, 2800);
  }

  async function copy(text) {
    try {await navigator.clipboard.writeText(text); toast('Copied'); return;} catch {}
    const area = document.createElement('textarea'); area.value = text; area.className = 'copied-text'; area.setAttribute('aria-label', 'Text to copy');
    $('#calculator .calc-body').append(area); area.select();
    let copied = false;
    try {copied = document.execCommand('copy');} catch {}
    if (copied) {area.remove(); toast('Copied');}
    else toast('Select and copy the text shown in the calculator.');
  }

  function bind() {
    $('#tabs').addEventListener('click', e => {
      const button = e.target.closest('[data-group]'); if (!button) return;
      S.group = button.dataset.group;
      history.replaceState(null, '', '#' + S.group); render();
      $(`[data-group="${S.group}"]`)?.focus({preventScroll: true});
    });
    $('#search').addEventListener('input', e => {S.query = e.target.value; if (S.query) S.group = 'all'; render();});
    $('#newOnly').addEventListener('change', e => {S.newOnly = e.target.checked; render();});
    $('#sort').addEventListener('change', e => {S.sort = e.target.value; savePrefs(); render();});
    $('#blend').addEventListener('change', e => {S.blend = +e.target.value; savePrefs(); render();});
    $('#mobileProvider').addEventListener('change', e => {S.mobileProvider = e.target.value; savePrefs(); render();});
    for (const id of ['asOf', 'dbuRate']) $('#' + id).addEventListener('input', render);
    $('#workload').addEventListener('submit', e => e.preventDefault());
    $('#workload').addEventListener('input', e => {if (e.target.id !== 'calcModel') renderCalculator();});
    $('#workload').addEventListener('change', e => {
      if (e.target.id === 'calcModel') S.model = e.target.value;
      renderCalculator();
    });
    $('#calcResults').addEventListener('change', e => {
      const target = e.target.closest('[data-tier]'); if (!target) return;
      const platform = target.dataset.tier;
      S.tiers[S.model + '|' + platform] = target.value; renderCalculator();
      $('#tier-' + platform)?.focus({preventScroll: true});
    });
    $('#copyEstimate').addEventListener('click', () => copy(estimateText()));
    $('#prices').addEventListener('click', e => {
      const estimate = e.target.closest('[data-estimate]');
      if (estimate) {
        S.model = estimate.dataset.estimate; $('#calcModel').value = S.model; $('#calculator').open = true;
        renderCalculator(); $('#calculator').scrollIntoView({block: 'start', behavior: 'smooth'}); $('#calcModel').focus({preventScroll: true}); return;
      }
      const copyButton = e.target.closest('[data-copy-model]');
      if (copyButton) {copy(modelText(copyButton.dataset.copyModel)); return;}
      if (e.target.closest('.detail-row') || e.target.closest('a,input,select')) return;
      const row = e.target.closest('tr.row'); if (!row) return;
      const key = row.dataset.model;
      S.open.has(key) ? S.open.delete(key) : S.open.add(key); render();
      $('#model-' + slug(key))?.focus({preventScroll: true});
    });
    $('#prices').addEventListener('submit', e => {
      const form = e.target.closest('[data-override-model]'); if (!form) return;
      e.preventDefault(); if (!form.reportValidity()) return;
      const key = form.dataset.overrideModel, platform = form.dataset.overridePlatform;
      for (const field of M.RATE_FIELDS) {
        const input = form.elements[field], raw = input.value.trim();
        const value = raw === '' ? null : Number(raw);
        if (value !== null && !M.validRate(value)) {toast('Enter a nonnegative finite price.'); return;}
        const id = key + '|' + platform + '|' + field;
        if (value === (RAW.models[key].platforms[platform][field] ?? null)) delete overrides[id];
        else overrides[id] = value;
      }
      storage.set(OVERRIDE_KEY, overrides); applyOverrides(); render(); toast('Personal prices saved');
    });
    $('#editPrices').addEventListener('click', () => {
      S.edit = !S.edit; $('#editPrices').textContent = S.edit ? 'Done editing' : 'Edit prices'; $('#editPrices').setAttribute('aria-pressed', String(S.edit)); render();
      if (S.edit) toast('Open a model row to override its prices.');
    });
    let resetArmed = false, resetTimer;
    $('#clearOverrides').addEventListener('click', () => {
      if (!resetArmed) {resetArmed = true; $('#clearOverrides').textContent = 'Click again to reset'; clearTimeout(resetTimer); resetTimer = setTimeout(() => {resetArmed = false; $('#clearOverrides').textContent = 'Reset overrides';}, 3000); return;}
      resetArmed = false; overrides = {}; storage.remove(OVERRIDE_KEY); applyOverrides(); $('#clearOverrides').textContent = 'Reset overrides'; render(); toast('Personal overrides reset');
    });
    $('#theme').addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'light' : 'dark'; savePrefs();
    });
    media.addEventListener('change', () => {$('#quoteSettings').open = !media.matches; render();});
    window.addEventListener('hashchange', () => {const hash = location.hash.slice(1).toLowerCase(); S.group = GROUP[hash] ? hash : ALIASES[hash] || 'all'; render();});
    const updateHeight = () => document.documentElement.style.setProperty('--bar-height', ($('#bar').getBoundingClientRect().height - 1) + 'px');
    new ResizeObserver(updateHeight).observe($('#bar')); updateHeight();
  }

  async function init() {
    try {
      const response = await fetch('v2-data.json', {cache: 'no-cache'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      RAW = await response.json();
      if (RAW.schema !== 4 || !RAW.models || !RAW.source_meta) throw new Error('Unsupported v2 data format');
      applyOverrides();
      $('#reviewDate').textContent = prettyDate(DATA.reviewed_at);
      $('#asOf').value = S.asOf; $('#sort').value = S.sort; $('#blend').value = String(S.blend); $('#mobileProvider').value = S.mobileProvider;
      $('#quoteSettings').open = !media.matches;
      const models = Object.entries(DATA.models).sort((a, b) => ORDER.indexOf(a[1].group) - ORDER.indexOf(b[1].group));
      $('#calcModel').innerHTML = models.map(([key, model]) => `<option value="${esc(key)}">${esc(model.name)}</option>`).join('');
      if (!DATA.models[S.model]) S.model = models[0][0];
      $('#calcModel').value = S.model;
      $('#changes').innerHTML = DATA.changes.map(change => `<li>${esc(change)}</li>`).join('');
      $('#sources').innerHTML = Object.entries(DATA.source_meta).map(([id, source]) => `<li>${metadataLink(id, source.label)}</li>`).join('');
      bind(); render(); document.body.dataset.ready = 'true';
    } catch (error) {
      $('#validation').hidden = false; $('#validation').textContent = 'Could not load v2 pricing data (' + error.message + '). Reload the page or serve this folder over HTTP.';
    }
  }
  init();
})();
