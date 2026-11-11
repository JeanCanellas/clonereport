'use strict';
process.env.DB_PATH = ':memory:';
process.env.SEED_REPORTS = '1';
process.env.SEED_ORIGINALS = '1';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../server');
const store = require('../db');
const { seedReports, loadSeedReports, withSources } = require('../seed-reports');
const { reports } = require('../seed/clone-reports.json');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

test('seed file is well formed: unique keys, sources on every report, https links only', () => {
  const keys = new Set();
  for (const e of reports) {
    assert.ok(e.key && !keys.has(e.key), `unique key ${e.key}`);
    keys.add(e.key);
    assert.ok(e.clone_name && e.original_name && e.notes, e.key);
    assert.ok(e.sources.length >= 1, `${e.key} cites a source`);
    for (const u of [...e.sources, e.clone_url, e.original_url].filter(Boolean)) assert.match(u, /^https:\/\/\S+$/, `${e.key}: ${u}`);
  }
});

test('seeded reports are approved, searchable and found by the extension lookup', async () => {
  assert.equal(store.counts().approved, reports.length);
  const s = await (await fetch(base + '/search?q=Unpacking')).text();
  assert.match(s, /Unpacking Master/);
  // Fallout Shelter's Steam page shows the Westworld report.
  const api = await (await fetch(base + '/api/lookup?appid=588430')).json();
  assert.ok(JSON.stringify(api).includes('Westworld'));
  // Palworld is the clone side, matched by its Steam id.
  const pal = await (await fetch(base + '/api/lookup?appid=1623730')).json();
  assert.ok(JSON.stringify(pal).includes('Pokémon'));
  // Sources are shown with the report.
  const r = store.search('Unpacking Master')[0];
  const page = await (await fetch(`${base}/report/${r.id}`)).text();
  assert.match(page, /gamedeveloper\.com/);
});

test('seeding is idempotent and respects admin deletions', () => {
  assert.deepEqual(loadSeedReports(store), { added: 0, moved: 0 });
  const r = store.search('Dream Heights')[0];
  store.remove(r.id);
  loadSeedReports(store);
  assert.equal(store.search('Dream Heights').length, 0);
});

test('a seeded clone is taken off the originals list', () => {
  store.seedOriginals([{ name: 'Some Copy', steam_appid: 4242 }]);
  assert.ok(store.findOriginal(4242, ''));
  seedReports(store, [{ key: 't-copy', clone_name: 'Some Copy', clone_url: 'https://store.steampowered.com/app/4242/',
    original_name: 'Some Original', notes: 'n', sources: ['https://example.com/a'] }]);
  assert.equal(store.findOriginal(4242, ''), null);
  const r = store.search('Some Copy')[0];
  assert.ok(r.evidence === 'https://example.com/a' || r.notes.includes('Sources:\n- https://example.com/a'));
});

const hasEvidence = () => store.db.prepare('PRAGMA table_info(reports)').all().some((c) => c.name === 'evidence');
test('sources move to an evidence column once one exists, unless the notes were edited', { skip: hasEvidence() && 'evidence column already exists' }, () => {
  store.db.exec('ALTER TABLE reports ADD COLUMN evidence TEXT');
  const notes = (q) => store.search(q)[0];
  // Simulate an admin edit on one report.
  const edited = notes('Mafia Wars');
  store.db.prepare('UPDATE reports SET notes = ? WHERE id = ?').run('edited by admin', edited.id);
  const { moved } = loadSeedReports(store);
  assert.equal(moved, reports.length - 2); // all but the deleted and the edited one
  const u = notes('Unpacking Master');
  assert.ok(!u.notes.includes('Sources:'));
  assert.match(u.evidence, /^https:\/\/gamedeveloper\.com\S+\nhttps:/);
  assert.equal(notes('Mafia Wars').notes, 'edited by admin');
  assert.equal(withSources('a', []), 'a');
});
