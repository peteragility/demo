(() => {
  'use strict';
  const M = SecurityChecklist, $ = id => document.getElementById(id);
  const KEY = 'demo-security-checklist-v1';
  const S = {layer: 'all', q: '', view: 'open', sort: 'risk', expanded: new Set(), limit: 30};
  let data, saved = Object.create(null), reviewedAt = '', memoryOnly = false;
  const N = (tag, text, attrs = {}) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = String(text);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
  };
  const button = (text, fn, attrs = {}) => { const el = N('button', text, {type: 'button', ...attrs}); el.addEventListener('click', fn); return el; };
  const displayDate = value => { const date = new Date(value); return Number.isFinite(+date) ? date.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Hong_Kong'}) : 'Not checked'; };
  const displayTime = value => { const date = new Date(value); return Number.isFinite(+date) ? date.toLocaleString('en-GB', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong'}) + ' HKT' : 'No complete successful run'; };
  const pct = score => (score * 100).toFixed(score >= .01 ? 1 : 2) + '%';
  const list = values => { const ul = N('ul'); for (const value of values) ul.append(N('li', value)); return ul; };
  const link = (label, url) => {
    const safe = M.safeURL(url);
    return safe ? N('a', label + ' ↗', {href: safe, target: '_blank', rel: 'noopener noreferrer'}) : N('span', label + ' (invalid source URL)');
  };
  function notify(text) { $('notice').textContent = text; $('notice').hidden = !text; }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify({schema: 1, assessments: saved, reviewedAt})); memoryOnly = false; }
    catch { memoryOnly = true; }
    $('storageNotice').hidden = !memoryOnly;
    $('storageNotice').textContent = 'Browser storage is unavailable or full. Progress is kept for this tab only; export your checklist before leaving.';
    return !memoryOnly;
  }
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw?.schema === 1) {
        saved = M.progress(raw.assessments, data.records);
        if (typeof raw.reviewedAt === 'string' && Number.isFinite(Date.parse(raw.reviewedAt))) reviewedAt = raw.reviewedAt;
      }
    } catch { memoryOnly = true; }
    // Test write access too: some browsers permit reads while rejecting writes.
    persist();
  }
  function sourceHealth() {
    const failed = data.sources.filter(s => s.status !== 'ok');
    const stale = M.ageHours(data.last_attempt) > 36;
    $('freshness').textContent = (failed.length ? 'Partial refresh' : stale ? 'Snapshot overdue' : 'Source checked') + ' · ' + displayTime(data.last_attempt);
    if (failed.length || stale) notify((failed.length ? failed.length + ' source check(s) failed. ' : '') + (stale ? 'The snapshot is more than 36 hours old. ' : '') + 'Previous data remains visible; check source dates before acting.');
    const src = $('sources');
    for (const s of data.sources) {
      const li = N('li', null, {class: s.status === 'ok' ? '' : 'failed'});
      li.append(link(s.label, s.url), N('span', ' · ' + (s.status === 'ok' ? 'checked ' : 'failed · last good ') + displayTime(s.status === 'ok' ? s.checked_at : s.last_success)));
      if (s.error) li.append(N('span', ' · ' + s.error));
      if (s.note) li.append(N('span', ' · ' + s.note));
      src.append(li);
    }
    $('refreshMeta').textContent = 'Last complete refresh: ' + displayTime(data.last_success) + '. Current snapshot: ' + data.records.length + ' tracked entries.';
    $('reviewDate').textContent = reviewedAt ? 'Changes reviewed: ' + displayTime(reviewedAt) : 'New / changed initially covers the last 24 hours. Mark changes reviewed after triage.';
  }
  function renderTabs() {
    $('tabs').replaceChildren(...Object.entries(M.layers).map(([id, name]) => {
      const count = data.records.filter(r => id === 'all' || r.layer === id).length;
      const b = button('', () => {S.layer = id; S.limit = 30; render();}, {class: 'tab', 'aria-pressed': S.layer === id, 'aria-label': name + ', ' + count + ' tracked risks'});
      b.append(N('span', name), N('span', count, {class: 'n'}));
      return b;
    }));
  }
  function renderSummary() {
    const all = data.records, open = all.filter(r => !M.closed(M.effective(r, saved[r.id])));
    const counts = [[open.filter(r => r.priority === 0).length, 'P0 to action', 'urgent'],
      [open.filter(r => r.kev).length, 'exploited · open', 'urgent'],
      [all.filter(r => M.isChanged(r, reviewedAt)).length, 'new / changed', ''],
      [all.length - open.length, 'verified / N/A', 'good']];
    $('summary').replaceChildren(...counts.map(([n, label, cls]) => {
      const el = N('div', null, {class: 'kpi ' + cls}); el.append(N('b', n), N('span', label)); return el;
    }));
    const highlights = $('highlights'); highlights.replaceChildren(N('span', 'Urgent notices:'));
    const seen = new Set();
    for (const r of all.filter(r => r.urgent)) {
      if (seen.has(r.product)) continue;
      seen.add(r.product);
      highlights.append(button(r.product + ' ↗', () => {
        S.layer = 'all'; S.view = 'all'; S.q = r.product; S.limit = 30;
        $('q').value = S.q; $('view').value = 'all'; render();
      }, {class: 'highlight'}));
    }
  }
  function statusLabel(r) { const a = saved[r.id]; return M.reassess(r, a) ? 'Reassess' : M.states[M.effective(r, a)]; }
  function row(r) {
    const tr = N('tr', null, {class: 'row' + (S.expanded.has(r.id) ? ' open' : ''), 'data-id': r.id});
    const rank = N('td', null, {class: 'rank'}); rank.append(N('span', 'P' + r.priority, {class: 'rankbadge p' + r.priority, title: M.reason(r)}));
    const issue = N('th', null, {scope: 'row', class: 'issue'});
    const expand = button('', () => toggle(r.id), {class: 'issuebtn', 'aria-expanded': S.expanded.has(r.id), 'aria-controls': 'detail-' + r.id, 'aria-label': 'Details for ' + r.product + ': ' + r.title});
    expand.append(N('span', r.product, {class: 'product'}), N('span', r.title, {class: 'issuetitle', title: r.title}), N('span', '›', {class: 'chev', 'aria-hidden': 'true'}));
    const meta = N('span', /^CVE-/.test(r.id) ? r.id : (r.kind === 'incident' ? 'CA / trust incident' : 'Vendor security release'), {class: 'issueid'});
    if (M.isChanged(r, reviewedAt)) meta.append(N('span', r.change === 'updated' ? 'UPDATED' : 'NEW', {class: 'change'}));
    issue.append(expand, meta);
    const impact = N('td', r.impact, {class: 'impact'});
    const ev = N('td', null, {class: 'evidence'});
    ev.append(N('span', r.kev ? 'KEV · exploited' : r.rejected ? 'CVE rejected' : 'Not in KEV', {class: r.kev ? 'kev' : ''}));
    ev.append(N('small', 'CVSS ' + (r.cvss ? r.cvss.score.toFixed(1) : '—') + (r.epss ? ' · EPSS ' + pct(r.epss.score) : '')));
    const version = N('td', null, {class: 'versions'});
    version.append(N('span', r.fixed.length ? r.fixed[0] : r.kind === 'incident' ? 'Update trust / replace chain' : 'Follow vendor remediation ↗', {class: 'fix', title: r.fixed.join('; ') || r.action}));
    version.append(N('span', (r.source_changed ? 'Source changed · review' : 'Checked ' + displayDate(r.checked_at)), {class: 'date'}));
    const status = N('td', null, {class: 'status'}), a = saved[r.id];
    status.append(N('span', statusLabel(r), {class: 'state ' + (M.reassess(r, a) ? 'reassess' : M.effective(r, a))}));
    if (a?.owner) status.append(N('span', a.owner, {class: 'date'}));
    tr.append(rank, issue, impact, ev, version, status);
    tr.addEventListener('click', event => {if (!event.target.closest('button,a,input,select,textarea,label')) toggle(r.id);});
    return tr;
  }
  function toggle(id) {
    if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
    renderRows();
    // Expansion stays in the document flow, with a stable deep link for handovers.
    history.replaceState(null, '', '#' + encodeURIComponent(id));
  }
  const defaultSteps = r => [
    'Identify deployed versions, exposed endpoints and the configurations described in this advisory.',
    'Record applicability, affected systems and an owner. If already exploited, investigate possible compromise.',
    'Apply the vendor fix, rebuild/redeploy affected images and restart required services. Record temporary controls separately.',
    'Verify the running build or trust bundle, service health and relevant logs; record evidence.'
  ];
  function detail(r) {
    const tr = N('tr', null, {class: 'detail', id: 'detail-' + r.id}), td = N('td', null, {colspan: 6}); tr.append(td);
    const head = N('div', null, {class: 'detailhead'}); head.append(N('h2', r.title), link('Open primary source', r.sources[0]?.url));
    td.append(head, N('p', M.reason(r), {class: 'why'}), N('p', r.description));
    if (r.source_changed) td.append(N('p', 'Source changed since its reviewed baseline. Re-read the official notice before relying on the version/action summary.', {class: 'why'}));
    if (r.catalog_missing) td.append(N('p', 'This previously tracked CVE is absent from the latest KEV catalog. Reassess its current evidence.', {class: 'why'}));
    const cards = N('div', null, {class: 'cards'}), scope = N('section', null, {class: 'card'});
    scope.append(N('h3', 'Affected → fixed'), N('h4', 'Affected versions / scope'), list(r.affected.length ? r.affected : ['See the vendor advisory. Version scope is not yet normalized.']), N('h4', 'Fixed / unaffected builds'), list(r.fixed.length ? r.fixed : ['Use the vendor’s current supported fix; no exact fixed build is confirmed in this snapshot.']));
    if (r.conditions?.length) scope.append(N('h4', 'Prerequisites / configuration'), list(r.conditions));
    scope.append(N('h4', 'Required action'), N('p', r.action));
    const stepsCard = N('section', null, {class: 'card'}); stepsCard.append(N('h3', 'Action checklist'));
    const a = saved[r.id] || M.assessment({}), stepInputs = [], steps = r.steps || defaultSteps(r);
    for (let i = 0; i < 4; i++) {
      const label = N('label', null, {class: 'check'}), input = N('input', null, {type: 'checkbox', 'aria-label': 'Step ' + (i + 1) + ': ' + steps[i]});
      input.checked = !M.reassess(r, a) && a.steps[i];
      label.append(input, N('span', steps[i])); stepsCard.append(label); stepInputs.push(input);
    }
    stepsCard.append(N('p', 'Step ticks are saved with your assessment. Mitigated items remain open until the underlying fix is verified.', {class: 'fine'}));
    const form = N('form', null, {class: 'card'}); form.append(N('h3', 'Your assessment'));
    const fields = N('div', null, {class: 'fields'});
    function field(label, key, tag = 'input', max = 600) {
      const wrapper = N('label', label), input = N(tag, null, {name: key, maxlength: max, 'aria-label': label});
      input.value = a[key] || ''; wrapper.append(input); fields.append(wrapper); return input;
    }
    const stateLabel = N('label', 'Status'), select = N('select', null, {name: 'status', 'aria-label': 'Assessment status'});
    for (const [key, value] of Object.entries(M.states)) select.append(N('option', value, {value: key}));
    select.value = M.effective(r, a); stateLabel.append(select); fields.append(stateLabel);
    const owner = field('Owner', 'owner', 'input', 120), systems = field('Affected systems / inventory reference', 'systems');
    const note = field('Assessment / N/A reason', 'note', 'textarea', 2000), evidence = field('Verification evidence / ticket reference', 'evidence', 'textarea', 2000);
    const save = N('button', 'Save assessment', {type: 'submit', class: 'save'}), message = N('p', '', {class: 'formmessage', role: 'status'});
    form.append(fields, save, message);
    if (M.reassess(r, a)) form.append(N('p', 'Advisory changed after your last assessment. Recheck the action steps and save your updated decision.', {class: 'why'}));
    if (a.saved) form.append(N('p', 'Last saved ' + displayTime(a.saved), {class: 'fine'}));
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (select.value === 'fixed' && (!stepInputs.every(i => i.checked) || !evidence.value.trim())) { message.textContent = 'Complete all four steps and record verification evidence before closing.'; return; }
      if (select.value === 'na' && !note.value.trim()) { message.textContent = 'Record why this advisory does not apply to your systems.'; return; }
      saved[r.id] = M.assessment({status: select.value, owner: owner.value, systems: systems.value, note: note.value, evidence: evidence.value,
        revision: r.revision, saved: new Date().toISOString(), steps: stepInputs.map(i => i.checked)});
      const kept = persist(); render();
      notify(kept ? 'Assessment saved in this browser.' : 'Assessment updated for this tab. Export to keep your progress.');
    });
    cards.append(scope, stepsCard, form); td.append(cards);
    const meta = [r.published ? 'Published ' + displayDate(r.published) : '', r.kev_added ? 'KEV added ' + displayDate(r.kev_added) : '',
      'Source checked ' + displayTime(r.checked_at), r.cve_checked_at ? 'CNA checked ' + displayTime(r.cve_checked_at) : '',
      r.cve_status || '',
      r.reviewed_at ? 'Action summary reviewed ' + displayDate(r.reviewed_at) : '',
      r.cvss ? 'CVSS v' + r.cvss.version + ': ' + r.cvss.score + (r.cvss.vector ? ' · ' + r.cvss.vector : '') : 'CVSS not available',
      r.epss ? 'EPSS ' + pct(r.epss.score) + ' · score date ' + r.epss.date : 'EPSS not available',
      r.ransomware ? 'CISA: known ransomware use' : ''].filter(Boolean);
    td.append(N('p', meta.join(' · '), {class: 'fine'}));
    const links = N('div', null, {class: 'source-links'}); for (const source of r.sources) links.append(link(source.label, source.url)); td.append(links);
    return tr;
  }
  function renderRows() {
    const records = M.select(data.records, S, saved, reviewedAt), rows = [];
    for (const r of records.slice(0, S.limit)) {
      rows.push(row(r));
      if (S.expanded.has(r.id)) rows.push(detail(r));
      else rows.push(N('tr', null, {id: 'detail-' + r.id, hidden: true}));
    }
    if (!records.length) { const tr = N('tr'); tr.append(N('td', 'No matching risks. Change the layer, search or view filter.', {colspan: 6, class: 'empty'})); rows.push(tr); }
    $('rows').replaceChildren(...rows);
    $('count').textContent = 'Showing ' + Math.min(S.limit, records.length) + ' / ' + records.length + ' matching · ' + data.records.length + ' tracked';
    $('more').hidden = records.length <= S.limit;
  }
  function render() { renderTabs(); renderSummary(); renderRows(); }
  function download() {
    const payload = {schema: 1, exportedAt: new Date().toISOString(), reviewedAt, assessments: saved};
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'}));
    const a = N('a', null, {href: url, download: 'security-checklist-' + new Date().toISOString().slice(0, 10) + '.json'});
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Checklist exported. It includes the owners, system references and notes you entered.');
  }
  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('File is too large (2 MB maximum).');
      const raw = JSON.parse(await file.text());
      if (raw?.schema !== 1 || !raw.assessments || typeof raw.assessments !== 'object' || Array.isArray(raw.assessments)) throw new Error('Choose an exported checklist JSON file.');
      const incoming = M.progress(raw.assessments, data.records);
      let count = 0;
      for (const [id, a] of Object.entries(incoming)) {
        if (!saved[id] || (Number.isFinite(Date.parse(a.saved)) && Date.parse(a.saved) > (Date.parse(saved[id].saved) || 0))) { saved[id] = a; count++; }
      }
      // Keep this browser's review watermark; importing cannot hide unseen advisory changes.
      const kept = persist(); render(); notify(count + ' assessments imported (newer entries win).' + (kept ? '' : ' Export before leaving this tab.'));
    } catch (error) { notify('Import failed: ' + error.message); }
    finally { $('import').value = ''; }
  }
  async function start() {
    try {
      const response = await fetch('data.json', {cache: 'no-store'});
      if (!response.ok) throw new Error('Snapshot request failed (' + response.status + ')');
      data = M.validate(await response.json()); load(); sourceHealth();
      const initial = decodeURIComponent(location.hash.slice(1));
      if (data.records.some(r => r.id === initial)) { S.expanded.add(initial); S.view = 'all'; S.q = initial; $('q').value = initial; $('view').value = 'all'; }
      $('q').addEventListener('input', () => {S.q = $('q').value; S.limit = 30; renderRows();});
      for (const key of ['view', 'sort']) $(key).addEventListener('change', () => {S[key] = $(key).value; S.limit = 30; renderRows();});
      $('more').addEventListener('click', () => {S.limit = data.records.length; renderRows();});
      $('export').addEventListener('click', download);
      $('import').addEventListener('change', () => importFile($('import').files[0]));
      $('reviewed').addEventListener('click', () => {reviewedAt = new Date().toISOString(); persist(); $('reviewDate').textContent = 'Changes reviewed: ' + displayTime(reviewedAt); render(); notify('Changes marked reviewed. Open risks remain on your action list.');});
      render();
    } catch (error) {
      $('freshness').textContent = 'Snapshot unavailable'; $('count').textContent = 'Unable to load risks';
      notify('Could not load the security snapshot. Reload the page or open the source snapshot and refresh runs below. ' + error.message);
    }
  }
  start();
})();
