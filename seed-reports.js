'use strict';
// Loads seed/clone-reports.json: publicly documented clone cases, added as
// approved reports. Each entry has a stable `key` and is inserted only once
// (tracked in the seeded_reports table), so an admin can edit, reject or
// delete a seeded report and it will not come back on the next start.
//
// Sources: when the reports table has an `evidence` column (added by the
// moderation feature), the source links go there, one per line. Otherwise
// they are appended to the notes as a "Sources:" list. If the evidence column
// appears later, untouched seeded reports are moved over to it on start.
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'seed', 'clone-reports.json');
const FIELDS = ['clone_name', 'clone_url', 'clone_developer', 'original_name', 'original_url', 'original_developer',
  'platform', 'clone_released', 'original_released', 'mechanics'];

const isHttps = (u) => /^https:\/\/[^\s]+$/i.test(u);
const withSources = (notes, sources) =>
  sources.length ? `${notes}\n\nSources:\n${sources.map((u) => '- ' + u).join('\n')}` : notes;

function seedReports(store, list) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS seeded_reports (
    key        TEXT PRIMARY KEY,
    report_id  INTEGER,
    notes      TEXT,           -- notes exactly as seeded, to tell whether an admin edited them
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const hasEvidence = db.prepare('PRAGMA table_info(reports)').all().some((c) => c.name === 'evidence');
  const seen = db.prepare('SELECT * FROM seeded_reports WHERE key = ?');
  const mark = db.prepare('INSERT INTO seeded_reports (key, report_id, notes) VALUES (?, ?, ?)');
  let added = 0, moved = 0;

  for (const e of list) {
    if (!e || typeof e.key !== 'string' || !e.clone_name || !e.original_name) continue;
    const sources = (Array.isArray(e.sources) ? e.sources : []).filter(isHttps);
    const notes = String(e.notes || '').trim();
    const prev = seen.get(e.key);

    if (prev) {
      // Seeded before the evidence column existed: move the sources over if nobody edited the report.
      if (hasEvidence && prev.report_id && sources.length) {
        const r = db.prepare('SELECT notes, evidence FROM reports WHERE id = ?').get(prev.report_id);
        if (r && !r.evidence && r.notes === prev.notes && r.notes === withSources(notes, sources)) {
          db.prepare('UPDATE reports SET notes = ?, evidence = ? WHERE id = ?').run(notes, sources.join('\n'), prev.report_id);
          db.prepare('UPDATE seeded_reports SET notes = ? WHERE key = ?').run(notes, e.key);
          moved++;
        }
      }
      continue;
    }

    const input = {};
    for (const k of FIELDS) if (e[k]) input[k] = String(e[k]);
    input.notes = hasEvidence ? notes : withSources(notes, sources);
    if (hasEvidence) input.evidence = sources.join('\n');
    const id = store.createReport(input, 'seed');
    store.setStatus(id, 'approved', 'seed');

    // Same as approving in /admin: a game confirmed as a clone comes off the originals list.
    const r = store.get(id);
    const sameName = r.clone_name.toLowerCase() === r.original_name.toLowerCase();
    const g = store.findOriginal(r.clone_steam_appid, '') || (!sameName && store.findOriginal(null, r.clone_name));
    if (g) store.excludeOriginal(g.id, `seeded clone report #${id}`);

    mark.run(e.key, id, input.notes);
    added++;
  }
  return { added, moved };
}

function loadSeedReports(store) {
  const { reports } = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return seedReports(store, reports);
}

module.exports = { seedReports, loadSeedReports, withSources };
