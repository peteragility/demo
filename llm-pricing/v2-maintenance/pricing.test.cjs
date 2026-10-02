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

test('monthly cache writes replace uncached input instead of being double-counted', () => {
  const c = offer('moonshot/kimi-k3', 'bedrock');
  const ordinary = M.calculate(c, {...date, inputM: 3, outputM: 1});
  close(ordinary.total, 24);
  const cached = M.calculate(c, {...date, inputM: 3, outputM: 1, cacheHit: 80, writeM: 0.5});
  // 0.1M regular × $3 + 2.4M hits × $0.30 + 0.5M writes × $3.75 + 1M out × $15.
  close(cached.total, 17.895);
  assert.equal(cached.complete, true);
});

test('Kimi K3 Priority stays consistently global or regional, including cache hits', () => {
  const c = offer('moonshot/kimi-k3', 'bedrock');
  const global = M.calculate(c, {...date, cacheHit: 80, variantId: selected(c, 'Global Priority')});
  const regional = M.calculate(c, {...date, cacheHit: 80, variantId: selected(c, 'Regional Priority')});
  close(global.total, 30.66);
  close(regional.total, 33.726);
  close(regional.offer.cache_read, 0.5775);
  assert.equal(M.delta(regional.offer, global.offer).value, null);
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
  const c = offer('openai/gpt-6-sol');
  const result = M.calculate(c, {...date, inputM: 1, outputM: 1, writeM: 0.5, variantId: selected(c, 'Priority')});
  assert.equal(result.complete, false);
  assert.equal(result.offer.cache_write, undefined);
});

test('context threshold applies to the entire GPT request, including cached input', () => {
  const c = offer('openai/gpt-6.1-sol', 'official');
  close(M.calculate(c, {...date, promptTokens: 272000}).total, 16);
  close(M.calculate(c, {...date, promptTokens: 272001}).total, 27);
  close(M.calculate(c, {...date, promptTokens: 272001, cacheHit: 80, writeM: 0.5}).total, 18.38);
  close(M.calculate(c, {...date, promptTokens: 272001, variantId: selected(c, 'Fast mode')}).total, 54);
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
  const result = M.calculate(c, {asOf: '2026-11-22', variantId: selected(c, 'Fast mode (was Priority)')});
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

test('regional offers and unconfirmed snapshots have no global same-model delta', () => {
  const pro = M.resolveOffer(offer('deepseek/deepseek-v4-pro'), date);
  const azure = M.resolveOffer(offer('deepseek/deepseek-v4-pro', 'azure_foundry'), date);
  assert.equal(M.delta(azure, pro).value, null);
  assert.match(M.delta(azure, pro).reason, /snapshot|checkpoint/);
  const dbxInkling = M.resolveOffer(offer('tml/inkling'), date);
  assert.equal(M.delta(M.resolveOffer(offer('tml/inkling', 'azure_foundry'), date), dbxInkling).value, null);
  const dbx55 = M.resolveOffer(offer('openai/gpt-5.5'), date);
  assert.equal(M.delta(M.resolveOffer(offer('openai/gpt-5.5', 'bedrock'), date), dbx55).value, null);
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

test('Vertex MaaS prices with unverified scope can be estimated but do not imply global parity', () => {
  const model = data.models['openai/gpt-oss-120b'];
  const vertex = M.calculate(model.platforms.gcloud, date);
  assert.equal(vertex.complete, true);
  assert.equal(M.delta(vertex.offer, M.resolveOffer(model.platforms.databricks, date)).value, null);
  assert.match(M.delta(vertex.offer, M.resolveOffer(model.platforms.databricks, date)).reason, /processing scope/);
});

test('Grok 4.6 Bedrock geographic and service tiers use their published cache charges', () => {
  const c = offer('xai/grok-4.6', 'bedrock');
  close(M.calculate(c, {...date, cacheHit: 80, variantId: selected(c, 'Global Priority')}).total, 14.7);
  close(M.calculate(c, {...date, cacheHit: 80, variantId: selected(c, 'Global Flex')}).total, 4.2);
  close(M.calculate(c, {...date, cacheHit: 80, variantId: selected(c, 'US geographic cross-region')}).total, 9.24);
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

test('personal overrides are excluded from published parity comparisons', () => {
  const base = M.resolveOffer(offer('moonshot/kimi-k3'), date);
  const custom = {...M.resolveOffer(offer('moonshot/kimi-k3', 'bedrock'), date), user_modified: true};
  assert.equal(M.delta(custom, base).value, null);
});
