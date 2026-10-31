#!/usr/bin/env node
// Persist the default-ranking order so the page can show movement since the previous nightly run.
// Runs after refresh.py; reuses model.js so the saved order is exactly what the browser computes.
const fs = require('fs'), path = require('path'), M = require('./model.js');
const file = process.argv[2] || path.join(__dirname, 'data.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const now = Date.parse(data.last_attempt || new Date().toISOString());
const positions = {};
M.select(data.records, {view: 'current', sort: 'hot'}, now).forEach((r, i) => { positions[r.id] = i + 1; });
const prior = data.rank_history && data.rank_history.at !== data.last_attempt
  ? data.rank_history.current : (data.rank_history ? data.rank_history.previous : {});
data.rank_history = {at: data.last_attempt, current: positions, previous: prior || {}};
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
console.log(`rank snapshot: ${Object.keys(positions).length} current entries ordered (hot)`);
