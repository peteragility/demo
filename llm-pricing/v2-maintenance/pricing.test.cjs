const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../v2-math.js');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../v2-data.json'), 'utf8'));
const offer = (key, platform = 'databricks') => data.models[key].platforms[platform];
const date = {asOf: '2026-10-02'};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `Expected ${b}, got ${a}`);
const selected = (cell, label) => cell.variants.find(v => v.label === label).id;
// A tier by endpoint and service tier, independent of its display label.
const tier = (cell, endpoint, service) => cell.variants.find(v => v.endpoint === endpoint && v.service_tier === service).id;

test('monthly cache writes replace uncached input instead of being double-counted', () => {
  const c = offer('moonshot/kimi-k3', 'bedrock');
  const ordinary = M.calculate(c, {...date, inputM: 3, outputM: 1});
  close(ordinary.total, 24);
  const cached = M.calculate(c, {...date, inputM: 3, outputM: 1, cacheHit: 80, writeM: 0.5});
  // 0.1M regular × $3 + 2.4M hits × $0.30 + 0.5M writes × $3.75 + 1M out × $15.
  close(cached.total, 17.895);
  assert.equal(cached.complete, true);
});

test('Kimi K3 Priority stays consistently global or US geo, including cache hits', () => {
  const c = offer('moonshot/kimi-k3', 'bedrock');
  const global = M.calculate(c, {...date, cacheHit: 80, variantId: tier(c, 'Global CRIS', 'priority')});
  const regional = M.calculate(c, {...date, cacheHit: 80, variantId: tier(c, 'US CRIS', 'priority')});
  close(global.total, 30.66);
  close(regional.total, 33.726);
  close(regional.offer.cache_read, 0.5775);
  // Same service tier in a different scope is still like for like: US geo costs 10% more.
  close(M.delta(regional.offer, global.offer).value, 0.1);
});

test('1-hour Anthropic cache writes use their own charge', () => {
  const c = offer('anthropic/claude-sonnet-5.5', 'official');
  const result = M.calculate(c, {...date, cacheHit: 80, writeM: 0.5, writeTTL: '1h'});
  close(result.total, 12.68);
});

test('Gemini cache storage uses million token-hours as an additional cost', () => {
  const c = offer('google/gemini-3.5-flash-lite', 'official');
  const result = M.calculate(c, {...date, cacheHit: 80, storedM: 0.5, storageHours: 48});
  close(result.total, 26.752);
  close(result.parts.find(p => p.label === 'Cache storage').cost, 24);
});

test('unverified cache-write prices produce an incomplete estimate, never a free write', () => {
  const c = offer('moonshot/kimi-k3');
  const result = M.calculate(c, {...date, cacheHit: 80, writeM: 0.5});
  assert.equal(result.complete, false);
  assert.equal(result.total, null);
  assert.ok(result.unknown.some(x => /Cache writes/.test(x)));
});

test('a variant does not inherit a Standard cache-write rate', () => {
  // A synthetic offer: published data now lists the Databricks Priority cache-write rate.
  const c = {status: 'priced', in: 1, out: 2, cache_write: 0.5, model_match: 'confirmed', service_tier: 'standard', comparison_scope: 'global',
    variants: [{id: 'v', label: 'Priority', in: 2, out: 4, service_tier: 'priority', comparison_scope: 'global', model_match: 'confirmed'}]};
  const result = M.calculate(c, {...date, inputM: 1, outputM: 1, writeM: 0.5, variantId: 'v'});
  assert.equal(result.complete, false);
  assert.equal(result.offer.cache_write, undefined);
});

test('context threshold applies to the entire GPT request, including cached input', () => {
  const c = offer('openai/gpt-6.1-sol', 'official');
  close(M.calculate(c, {...date, promptTokens: 272000}).total, 16);
  close(M.calculate(c, {...date, promptTokens: 272001}).total, 27);
  close(M.calculate(c, {...date, promptTokens: 272001, cacheHit: 80, writeM: 0.5}).total, 18.38);
  close(M.calculate(c, {...date, promptTokens: 272001, variantId: tier(c, 'Global (api.openai.com)', 'priority')}).total, 54);
});

test('Gemini Pro uses the strict greater-than-200K context threshold', () => {
  const c = offer('google/gemini-3.1-pro');
  close(M.calculate(c, {...date, promptTokens: 200000}).total, 18);
  close(M.calculate(c, {...date, promptTokens: 200001}).total, 30);
});

test('xAI higher-context billing starts at 200K, while Vertex uses above 200K', () => {
  const direct = offer('xai/grok-4.7', 'official');
  const vertex = offer('xai/grok-4.7', 'gcloud');
  close(M.calculate(direct, {...date, promptTokens: 199999}).total, 12);
  close(M.calculate(direct, {...date, promptTokens: 200000}).total, 24);
  close(M.calculate(vertex, {...date, promptTokens: 200000}).total, 12);
  close(M.calculate(vertex, {...date, promptTokens: 200001}).total, 24);
});

test('future promotion changes apply after the last promotional day', () => {
  const c = offer('google/gemini-3.5-flash-lite');
  close(M.calculate(c, {asOf: '2027-01-31'}).total, 3.4);
  close(M.calculate(c, {asOf: '2027-02-01'}).total, 4.25);
  const flash = offer('google/gemini-3.8-flash');
  close(M.calculate(flash, {asOf: '2026-12-31'}).total, 6);
  close(M.calculate(flash, {asOf: '2027-01-01'}).total, 12);
});

test('a promotion with no verified future variant never extrapolates that tier', () => {
  const c = offer('openai/gpt-5.6-sol', 'official');
  const result = M.calculate(c, {asOf: '2026-11-22', variantId: tier(c, 'Global (api.openai.com)', 'priority')});
  assert.equal(result.complete, false);
  assert.equal(result.offer.status, 'unverified');
});

test('retirement affects Databricks only, starting on the published retirement date', () => {
  const dbx = offer('tml/inkling');
  assert.equal(M.calculate(dbx, {asOf: '2026-10-29'}).complete, true);
  assert.equal(M.calculate(dbx, {asOf: '2026-10-30'}).offer.status, 'retired');
  assert.equal(M.calculate(offer('tml/inkling', 'fireworks'), {asOf: '2026-10-30'}).complete, true);
});

test('customer DBU price scales Databricks and leaves other providers at their own rates', () => {
  close(M.calculate(offer('moonshot/kimi-k3'), {...date, dbuRate: 0.056}).total, 19.2);
  close(M.calculate(offer('moonshot/kimi-k3', 'bedrock'), {...date, dbuRate: 0.056}).total, 24);
});

test('the cheapest price in any region is compared like for like; unconfirmed snapshots are not', () => {
  const pro = M.cheapest(offer('deepseek/deepseek-v4-pro'), date);
  assert.equal(M.cheapest(offer('deepseek/deepseek-v4-pro', 'azure_foundry'), date), null);
  const azure = M.resolveOffer(offer('deepseek/deepseek-v4-pro', 'azure_foundry'), date);
  assert.match(M.delta(azure, pro).reason, /snapshot|checkpoint/);
  // Azure's only GLM 5.2 offer is Data Zone (Fireworks-hosted); Bedrock sells GPT-5.5 in-region only.
  const glm = M.cheapest(offer('zai/glm-5.2', 'azure_foundry'), date);
  close(M.delta(glm, M.cheapest(offer('zai/glm-5.2'), date)).value, (3 * 1.54 + 4.84) / (3 * 1.4 + 4.4) - 1);
  close(M.delta(M.cheapest(offer('openai/gpt-5.5', 'bedrock'), date), M.cheapest(offer('openai/gpt-5.5'), date)).value, 0.1);
  const maverick = M.cheapest(offer('meta/llama-4-maverick', 'bedrock'), date);
  close(M.delta(maverick, M.cheapest(offer('meta/llama-4-maverick'), date)).value, (3 * 0.24 + 0.97) / (3 * 0.5 + 1.5) - 1);
});

test('cheapest uses standard real-time prices only: not Batch, Flex, Priority or off-peak', () => {
  const peak = M.cheapest(offer('deepseek/deepseek-v4-pro', 'official'), date);
  assert.equal(peak.variant_id, undefined);
  close(peak.in, 1.32);
  const cell = offer('deepseek/deepseek-v4-pro', 'alicloud');
  const idle = cell.variants.find(v => v.service_tier === 'off-peak');
  assert.ok(idle.in < cell.in, 'idle-hour rates are listed');
  assert.notEqual(M.cheapest(cell, date).service_tier, 'off-peak');
  const kimi = M.cheapest(offer('moonshot/kimi-k3', 'bedrock'), date);
  close(kimi.in, 3);
  assert.equal(M.cheapest(offer('openai/gpt-6-sol', 'official'), date).service_tier, 'standard');
});

test('a cheaper standard variant becomes the platform price, at the selected blend', () => {
  const cell = {status: 'priced', in: 1, out: 4, model_match: 'confirmed', service_tier: 'standard', tier: 'Global',
    variants: [{id: 'v0', label: 'Input-heavy region', in: 0.5, out: 6, model_match: 'confirmed', service_tier: 'standard'}]};
  assert.equal(M.cheapest(cell, {...date, inputRatio: 10}).tier, 'Input-heavy region');
  assert.equal(M.cheapest(cell, {...date, inputRatio: 1}).tier, 'Global');
});

test('models with no comparable hyperscaler are excluded from parity claims', () => {
  const model = JSON.parse(JSON.stringify(data.models['moonshot/kimi-k3']));
  for (const pl of ['bedrock', 'azure_foundry', 'gcloud']) model.platforms[pl] = {status: 'unavailable'};
  const result = M.summarize([model], date);
  assert.equal(result.noCheaperModels, 0);
  assert.equal(result.comparedModels, 0);
  assert.equal(result.withoutComparison, 1);
  assert.deepEqual(result.gaps, {bedrock: 1, azure_foundry: 1, gcloud: 1});
});

test('a cheaper hyperscaler price in any processing scope counts against parity', () => {
  const model = data.models['openai/gpt-oss-120b'];
  const vertex = M.cheapest(model.platforms.gcloud, date);
  close(M.delta(vertex, M.cheapest(model.platforms.databricks, date)).value, (3 * 0.09 + 0.36) / (3 * 0.15 + 0.6) - 1);
  const result = M.summarize([model], date);
  assert.equal(result.comparedModels, 1);
  assert.equal(result.noCheaperModels, 0);
});

test('OSS parity counts every hyperscaler that undercuts Databricks', () => {
  const oss = Object.values(data.models).filter(m => m.group === 'oss');
  const result = M.summarize(oss, date);
  // Inkling left Azure pay-per-token on 25 Sep 2026, so it has no hyperscaler price to compare.
  assert.equal(result.comparedModels, 14);
  assert.equal(result.noCheaperModels, 7);
});

test('a cheaper price for an unconfirmed checkpoint keeps a model out of the parity claim', () => {
  const model = JSON.parse(JSON.stringify(data.models['deepseek/deepseek-v4-pro']));
  model.platforms.bedrock = {...model.platforms.azure_foundry, in: 0.5, out: 1, variants: []};
  model.platforms.gcloud = {...model.platforms.databricks, retires_on: undefined, in: 1.32, out: 3.96, dbu_rate_basis: undefined};
  const result = M.summarize([model], date);
  assert.equal(result.comparedModels, 1);
  assert.equal(result.noCheaperModels, 0);
});

test('availability gaps count only models Databricks currently prices', () => {
  const openai = Object.values(data.models).filter(m => m.group === 'openai');
  assert.equal(M.summarize(openai, date).gaps.gcloud, 8);
  const oss = Object.values(data.models).filter(m => m.group === 'oss');
  // Qwen3.8 27B, MiniMax M3 and Mistral Medium 3.5 are not on Databricks, so they add no gaps.
  // Inkling is an Azure gap until it retires on Databricks.
  assert.deepEqual(M.summarize(oss, date).gaps, {bedrock: 9, azure_foundry: 6, gcloud: 11});
  assert.deepEqual(M.summarize(oss, {asOf: '2026-10-30'}).gaps, {bedrock: 6, azure_foundry: 5, gcloud: 8});
});

test('expired promotions carry their published list-tier labels', () => {
  assert.equal(M.resolveOffer(offer('google/gemini-3.8-flash'), {asOf: '2026-12-31'}).tier, 'Intro promo (−50%) until 31 Dec 2026');
  assert.equal(M.resolveOffer(offer('google/gemini-3.8-flash'), {asOf: '2027-01-01'}).tier, 'Standard pay-per-token');
  assert.equal(M.resolveOffer(offer('google/gemini-3.8-flash', 'gcloud'), {asOf: '2027-01-01'}).tier, 'Global endpoint');
  assert.equal(M.resolveOffer(offer('google/gemini-3.1-pro'), {asOf: '2027-02-01'}).tier, 'Standard pay-per-token');
  const lite = offer('google/gemini-3.5-flash-lite');
  assert.equal(M.resolveOffer(lite, {asOf: '2027-02-01', variantId: selected(lite, 'Priority (promotion)')}).tier, 'Priority');
});

test('promotional long-context rates do not outlive the promotion', () => {
  const cell = {status: 'priced', in: 1, out: 2, context_threshold: 100, long_context: {in: 2, out: 4},
    promotion: {ends_on: '2026-10-31', after: {in: 1.5, out: 3, tier: 'List'}}};
  assert.equal(M.calculate(cell, {asOf: '2026-11-01', promptTokens: 200}).complete, false);
  close(M.calculate(cell, {asOf: '2026-10-31', promptTokens: 200}).total, 3 * 2 + 4);
});

test('tier cache and long-context rates are the published ones, never inherited from Standard', () => {
  // OpenAI publishes GPT-6 Sol Batch / Flex cache and long-context rates; each tier carries its own.
  const c = offer('openai/gpt-6-sol', 'official');
  const batch = M.resolveOffer(c, {...date, variantId: tier(c, 'Global (api.openai.com)', 'batch')});
  close(batch.cache_read, 0.1);
  close(batch.long_context.in, 2);
  // A derived rate names the rule it follows.
  for (const [key, m] of Object.entries(data.models)) for (const [pl, cell] of Object.entries(m.platforms))
    for (const v of cell.variants || []) if (v.derived) assert.ok(typeof v.derived === 'string' && v.derived.length > 10, key + ' ' + pl + ' ' + v.label);
});

test('Grok 4.6 Bedrock geographic and service tiers use their published cache charges', () => {
  const c = offer('xai/grok-4.6', 'bedrock');
  close(M.calculate(c, {...date, cacheHit: 80, variantId: tier(c, 'Global CRIS', 'priority')}).total, 14.7);
  close(M.calculate(c, {...date, cacheHit: 80, variantId: tier(c, 'Global CRIS', 'flex')}).total, 4.2);
  close(M.calculate(c, {...date, cacheHit: 80, variantId: tier(c, 'US CRIS', 'standard')}).total, 9.24);
});

test('newer Databricks prices remain unverified rather than copying predecessor rates', () => {
  for (const key of ['openai/gpt-6.1-sol', 'xai/grok-4.7']) {
    const result = M.calculate(offer(key), date);
    assert.equal(result.total, null);
    assert.equal(result.offer.status, 'unverified');
    assert.equal(offer(key).in, undefined);
  }
});

test('discontinued Fireworks serverless offers carry no per-token price', () => {
  for (const key of ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'moonshot/kimi-k2.7']) {
    assert.equal(offer(key, 'fireworks').status, 'dedicated');
    assert.equal(M.calculate(offer(key, 'fireworks'), date).total, null);
  }
});

test('invalid volumes, cache percentages, dates and DBU rates are rejected', () => {
  const c = offer('moonshot/kimi-k3');
  for (const work of [{inputM: -1}, {outputM: Infinity}, {cacheHit: 101}, {inputM: 1, cacheHit: 100, writeM: 0.1}, {dbuRate: 0}, {asOf: '2026-02-30'}]) {
    const result = M.calculate(c, {...date, ...work});
    assert.equal(result.complete, false);
    assert.equal(result.total, null);
  }
});

