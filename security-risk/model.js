(function (root) {
  'use strict';
  const states = {assess: 'Needs assessment', affected: 'Affected', mitigated: 'Mitigated', fixed: 'Fixed / verified', na: 'Not applicable'};
  const layers = {all: 'All layers', trust: 'Certificates / TLS', edge: 'Edge / VPN', runtime: 'Runtimes', delivery: 'GitLab / CI/CD', system: 'OS / containers', identity: 'Identity / data'};
  const closed = s => s === 'fixed' || s === 'na';
  const safeURL = value => {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; }
    catch { return null; }
  };
  function assessment(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const text = (key, max) => typeof value[key] === 'string' ? value[key].slice(0, max) : '';
    const result = {status: Object.hasOwn(states, value.status) ? value.status : 'assess', owner: text('owner', 120), systems: text('systems', 600),
      note: text('note', 2000), evidence: text('evidence', 2000), revision: text('revision', 80), saved: text('saved', 40),
      steps: [0, 1, 2, 3].map(i => value.steps?.[i] === true)};
    if (result.status === 'fixed' && (!result.evidence.trim() || !result.steps.every(Boolean))) result.status = 'assess';
    if (result.status === 'na' && !result.note.trim()) result.status = 'assess';
    return result;
  }
  function progress(raw, records) {
    const result = Object.create(null), ids = new Set(records.map(r => r.id));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
    for (const [key, value] of Object.entries(raw)) {
      if (!ids.has(key)) continue;
      const a = assessment(value); if (a) result[key] = a;
    }
    return result;
  }
  const reassess = (r, a) => Boolean(a && a.revision !== r.revision && a.status !== 'assess');
  const effective = (r, a) => reassess(r, a) ? 'assess' : (a?.status || 'assess');
  const ageHours = (value, now = Date.now()) => { const t = Date.parse(value); return Number.isFinite(t) ? Math.max(0, (now - t) / 3600000) : Infinity; };
  const isChanged = (r, since, now = Date.now()) => since ? Date.parse(r.changed_at) > Date.parse(since) : ageHours(r.changed_at, now) <= 24;
  function reason(r) {
    if (r.rejected) return 'The CVE record is rejected; review your assessment against the current source.';
    if (r.kev && r.ransomware) return 'CISA confirms exploitation and reports use in ransomware campaigns.';
    if (r.kev && ['Code execution', 'Auth bypass', 'Credential / session theft'].includes(r.impact)) return 'Known exploitation combined with a high-impact compromise path.';
    if (r.kev) return 'CISA confirms exploitation in the wild.';
    if (r.urgent) return 'Reviewed high-impact advisory; assess applicable systems promptly.';
    if (r.cvss?.score >= 9) return 'Critical vendor/CNA severity; exploitation is not confirmed by this dataset.';
    return 'Security advisory to assess against your deployed versions and configuration.';
  }
  function select(records, prefs, saved, since) {
    const q = (prefs.q || '').toLowerCase();
    const list = records.filter(r => {
      const a = saved[r.id], status = effective(r, a);
      return (prefs.layer === 'all' || r.layer === prefs.layer) &&
        (!q || [r.id, r.product, r.title, r.description, ...(r.affected || []), a?.owner, a?.systems].join(' ').toLowerCase().includes(q)) &&
        (prefs.view !== 'open' || !closed(status)) && (prefs.view !== 'changed' || isChanged(r, since)) &&
        (prefs.view !== 'exploited' || r.kev) && (prefs.view !== 'reassess' || reassess(r, a)) &&
        (prefs.view !== 'done' || closed(status));
    });
    list.sort((a, b) => {
      if (prefs.sort === 'cvss') return (Number.isFinite(b.cvss?.score) ? b.cvss.score : -1) - (Number.isFinite(a.cvss?.score) ? a.cvss.score : -1) || a.priority - b.priority || a.id.localeCompare(b.id);
      if (prefs.sort === 'new') return (b.published || b.kev_added || '').localeCompare(a.published || a.kev_added || '') || a.id.localeCompare(b.id);
      if (prefs.sort === 'epss') return (b.epss?.score ?? -1) - (a.epss?.score ?? -1) || a.priority - b.priority;
      return a.priority - b.priority || Number(closed(effective(a, saved[a.id]))) - Number(closed(effective(b, saved[b.id]))) ||
        (b.published || b.kev_added || '').localeCompare(a.published || a.kev_added || '') || a.id.localeCompare(b.id);
    });
    return list;
  }
  function validate(data) {
    if (data?.schema !== 1 || !Array.isArray(data.records) || !data.records.length || !Array.isArray(data.sources)) throw new Error('Invalid security snapshot');
    const ids = new Set();
    for (const r of data.records) {
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(r.id) || ids.has(r.id) || !Object.hasOwn(layers, r.layer) || r.layer === 'all' ||
          !Number.isInteger(r.priority) || r.priority < 0 || r.priority > 3 || typeof r.title !== 'string' || typeof r.product !== 'string' ||
          typeof r.revision !== 'string' || !Array.isArray(r.sources) || !Array.isArray(r.affected) || !Array.isArray(r.fixed)) throw new Error('Invalid security record');
      ids.add(r.id);
    }
    return data;
  }
  const api = {states, layers, closed, safeURL, assessment, progress, reassess, effective, ageHours, isChanged, reason, select, validate};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecurityChecklist = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
