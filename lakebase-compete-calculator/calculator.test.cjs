const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Read real control defaults/options, then exercise the inline calculator without UI wiring.
function calculator(hash = '') {
  const elements = {};
  for (const match of html.matchAll(/<(input|select)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attrs, id] = match;
    const content = html.slice(match.index + match[0].length).split('</select>')[0];
    const attr = name => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || '';
    const e = {type: attr('type'), value: attr('value'), defaultValue: attr('value'), min: attr('min'), max: attr('max'), step: attr('step'), dataset: {def: attr('data-def')}, checked: false};
    if (tag === 'select') {
      e.options = [...content.matchAll(/<option\b([^>]*)>/g)].map(m => ({value: m[1].match(/value="([^"]*)"/)[1], selected: /\bselected\b/.test(m[1])}));
      e.value = (e.options.find(o => o.selected) || e.options[0]).value;
    }
    let value = String(e.value);
    Object.defineProperty(e, 'value', {get: () => value, set: v => { value = String(v); }});
    elements[id] = e;
  }
  const ctx = vm.createContext({document: {getElementById: id => elements[id]}, location: {hash, href: 'https://example.test/' + hash}, URLSearchParams, console});
  vm.runInContext(script.slice(0, script.indexOf("$('lbCloud').addEventListener")), ctx);
  const run = expression => vm.runInContext(expression, ctx);
  run('IDS.forEach(id => DEFAULTS[id] = getVal(id))');
  return {run, elements};
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('invalid shared values fall back safely, including prototype keys and injected strings', () => {
  for (const hash of ['#w=custom&region=bogus&pat=bogus&commit=bogus', '#w=constructor&io=__proto__&sync=%3Cimg%3E', '#w=__proto__&peak=NaN&sto=Infinity&disc=20junk&ret=', '#w=custom&peak=2.5&ret=35&rep=99&lbCloud=bad&lbTier=bad']) {
    const {run} = calculator(hash);
    assert.equal(run('readHash()'), true);
    assert.equal(run('curPreset'), 'custom');
    assert.ok(run('allRows(state()).filter(r => !r.na).every(r => Number.isFinite(r.total) && Object.values(r.c).every(Number.isFinite))'));
    assert.ok(run('state().ret <= 30'));
  }
});
test('valid shared links retain selections and discounts', () => {
  const {run} = calculator('#w=dev&region=sg&commit=3y&pat=intermittent&peak=1&sto=20&rep=1&disc=25&promo=1');
  run('readHash()');
  assert.equal(run('state().region'), 'sg');
  assert.equal(run('state().disc'), 25);
  assert.equal(run('state().promo'), true);
  assert.equal(run('state().rep'), 1);
});
test('oversized storage is excluded instead of receiving an undersized quote', () => {
  const {run, elements} = calculator();
  elements.sto.value = '64000';
  assert.ok(run('calcAzureSQL(state()).na'));
  assert.ok(run('calcClickHouse(state()).na'));
  assert.match(run('summaryText()'), /ClickHouse Postgres: n\/a/);
  elements.sto.value = '3800';
  assert.ok(run('Number.isFinite(calcClickHouse(state()).total)'));
  elements.sto.value = '3801';
  assert.ok(run('calcClickHouse(state()).na'));
  elements.sto.value = '4096';
  assert.ok(run('Number.isFinite(calcAzureSQL(state()).total)'));
  elements.sto.value = '4097';
  assert.ok(run('calcAzureSQL(state()).na'));
});
test('Azure SQL sizes compute to the storage capacity of the selected SKU', () => {
  const {run, elements} = calculator();
  elements.peak.value = '0'; elements.sto.value = '3000';
  assert.match(run('calcAzureSQL(state()).sub'), /12 vCores/);
  elements.sto.value = '1';
  close(run('calcAzureSQL(state()).c.sto'), 5 * .115);
});
test('Azure SQL dev serverless bills its minimum memory and supports its advertised SLO', () => {
  const {run, elements} = calculator();
  elements.pat.value = 'intermittent'; elements.peak.value = '1'; elements.sto.value = '20';
  close(run('calcAzureSQL(state()).c.cmp'), 2.05 / 3 * 130 * .5218);
  assert.match(run('calcAzureSQL(state()).sub'), /serverless 0.5–2 vCores/);
  elements.peak.value = '5';
  assert.equal(run('sqlServerlessProfile(state()).max'), 12);
});
test('geo-replicas prevent auto-pause and each pays its own minimum', () => {
  const {run, elements} = calculator();
  elements.pat.value = 'intermittent'; elements.peak.value = '1'; elements.sto.value = '20'; elements.rep.value = '1';
  close(run('calcAzureSQL(state()).c.cmp'), 2.05 / 3 * 730 * .5218);
  close(run('calcAzureSQL(state()).c.rep'), 2.02 / 3 * 730 * .5218 + 20 * .115);
  assert.equal(run('sqlServerlessProfile(state()).pause'), false);
});
test('Lakebase floor uses supported CU sizes and read replicas enforce 0.5 CU minimum', () => {
  const {run, elements} = calculator();
  elements.pat.value = 'spiky'; elements.peak.value = '4';
  assert.equal(run('state().floor'), 2);
  elements.pat.value = 'intermittent'; elements.peak.value = '0'; elements.rep.value = '1';
  close(run('calcLakebase(state()).c.rep'), .5 * 130 * .111);
  close(run('calcLakebase(state()).c.cmp'), .5 * 130 * .111);
});
test('retention is consistent between shared controls, calculations and copied summary', () => {
  const {run, elements} = calculator('#w=custom&ret=35');
  run('readHash()');
  assert.equal(Number(elements.ret.value), 30);
  close(run('calcLakebase(state()).c.bk'), 6 * 30 * .2);
  assert.match(run('summaryText()'), /30-day PITR/);
});
test('all regions, load patterns and peak sizes produce finite quotes with valid Lakebase floors', () => {
  const {run, elements} = calculator();
  for (const region of elements.region.options) for (const pat of elements.pat.options) for (let peak = 0; peak <= 12; peak++) for (const rep of ['0','1','3']) for (const ha of ['0','1']) {
    elements.region.value = region.value; elements.pat.value = pat.value; elements.peak.value = String(peak); elements.rep.value = rep; elements.ha.value = ha;
    assert.ok(run('allRows(state()).filter(r => !r.na).every(r => Number.isFinite(r.total) && Object.values(r.c).every(v => Number.isFinite(v) && v >= 0))'));
    assert.ok(run('state().floor === .5 || Number.isInteger(state().floor)'));
    assert.ok(run('state().peak - state().floor <= 16'));
  }
});

test('Azure SSD v2 included IOPS changes at 400 GiB on primary and HA', () => {
  const {run, elements} = calculator();
  elements.peak.value = '7'; elements.io.value = 'heavy'; elements.ha.value = '1';
  elements.sto.value = '399';
  close(run('calcAzure(state()).c.io'), (38400 - 3000) * .02);
  elements.sto.value = '400';
  close(run('calcAzure(state()).c.io'), (38400 - 12000) * .02);
  close(run('calcAzure(state()).c.ha - calcAzure(state()).c.cmp - calcAzure(state()).c.sto'), run('calcAzure(state()).c.io'));
});
test('Cloud SQL custom memory respects minimum and does not bill free PITR logs', () => {
  const {run, elements} = calculator();
  elements.peak.value = '0'; elements.sto.value = '20'; elements.ret.value = '2';
  assert.match(run('calcCloudSQL(state()).sub'), /1 vCPU \/ 3.75 GiB/);
  close(run('calcCloudSQL(state()).c.cmp'), (.0413 + 3.75 * .007) * 730);
  const backup = run('calcCloudSQL(state()).c.bk');
  elements.ret.value = '7'; elements.io.value = 'heavy';
  close(run('calcCloudSQL(state()).c.bk'), backup);
});
test('priced seven-day tiers are excluded for longer retention rather than underquoted', () => {
  const {run, elements} = calculator();
  elements.ret.value = '7';
  assert.ok(run('Number.isFinite(calcCloudSQL(state()).total) && Number.isFinite(calcClickHouse(state()).total)'));
  elements.ret.value = '8';
  assert.match(run('calcCloudSQL(state()).na'), /Enterprise PITR is limited to 7 days/);
  assert.match(run('calcClickHouse(state()).na'), /Scale tier retains backups for 7 days/);
  assert.match(run('summaryText()'), /Cloud SQL \(PG\): n\/a/);
});
test('field guide production example agrees with the shared calculator scenario', () => {
  const {run} = calculator('#w=custom&region=us&lbCloud=aws&lbTier=enterprise&commit=od&pat=peak&peak=7&sto=1000&ha=1&rep=2&io=mod&ret=7&promo=0&disc=0&sync=none');
  run('readHash()');
  close(run('calcLakebase(state()).total'), 6203.64);
});
