'use strict';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'pw';
process.env.MIN_FILL_MS = '0';
process.env.STEAM_ENRICH = '0';
process.env.SEED_ORIGINALS = '0';
process.env.MAX_PER_HOUR = '50';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../server');
const store = require('../db');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());
const auth = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
const tokenFrom = async (path) => (await (await fetch(base + path)).text()).match(/name="token" value="([^"]+)"/)[1];

test('evidence links are submitted, validated and shown', async () => {
  let res = await fetch(base + '/submit', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token: await tokenFrom('/submit'), agree: 'yes',
    clone_name: 'Ev Clone', original_name: 'Ev Orig', original_url: 'https://e.com', evidence: 'not a link' }) });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Evidence must be/);
  res = await fetch(base + '/submit', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token: await tokenFrom('/submit'), agree: 'yes',
    clone_name: 'Ev Clone', original_name: 'Ev Orig', original_url: 'https://e.com', evidence: 'https://www.youtube.com/watch?v=abc\n\nhttps://news.example/article' }) });
  assert.equal(res.status, 303);
  const r = store.byStatus('pending').find((x) => x.clone_name === 'Ev Clone');
  store.setStatus(r.id, 'approved');
  const page = await (await fetch(`${base}/report/${r.id}`)).text();
  assert.match(page, /<h2>Evidence<\/h2>/);
  assert.match(page, />youtube\.com<\/a>/);
  assert.match(page, />news\.example<\/a>/);
});

test('edit history records submit, approval, edits and Steam fill-ins, without private fields', async () => {
  const id = store.createReport({ clone_name: 'Hist', original_name: 'Orig', original_url: 'https://e.com/', contact: 'secret@example.com' }, 'x');
  assert.equal((await fetch(`${base}/report/${id}/history`)).status, 404, 'pending history is private');
  await fetch(`${base}/admin/${id}/approve`, { method: 'POST', headers: auth, redirect: 'manual' });
  await fetch(`${base}/admin/${id}/edit`, { method: 'POST', headers: auth, redirect: 'manual', body: new URLSearchParams({
    clone_name: 'Hist Renamed', original_name: 'Orig', original_url: 'https://e.com', platform: 'iOS' }) });
  store.fillComparison(id, { original_released: '2001' });
  store.fillComparison(id, { original_released: '1999' }); // no change: not logged
  const h = store.history(id);
  assert.deepEqual(h.map((x) => `${x.actor}:${x.action}`), ['reporter:submitted', 'admin:approved', 'admin:edited', 'steam:filled from Steam']);
  assert.deepEqual(h[2].changes, { clone_name: ['Hist', 'Hist Renamed'], platform: [null, 'iOS'] });
  const page = await (await fetch(`${base}/report/${id}/history`)).text();
  assert.match(page, /Clone name<\/dt><dd><span class="notes">Hist<\/span> → <span class="notes">Hist Renamed<\/span>/);
  assert.match(page, /by Moderator/);
  assert.ok(!page.includes('secret@example.com'));
  assert.match(await (await fetch(`${base}/report/${id}`)).text(), /href="\/report\/\d+\/history"/);
});

test('developers can dispute a report; admins publish or dismiss', async () => {
  const id = store.createReport({ clone_name: 'Disputed Game', original_name: 'Big Hit', original_url: 'https://e.com' }, 'x');
  assert.equal((await fetch(`${base}/report/${id}/dispute`)).status, 404, 'only approved reports');
  store.setStatus(id, 'approved');
  const post = async (fields) => fetch(`${base}/report/${id}/dispute`, { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ token: await tokenFrom(`/report/${id}/dispute`), ...fields }) });

  let res = await post({ name: 'Dev', role: 'clone-developer', contact: 'nope', message: 'short' });
  assert.equal(res.status, 400);
  const err = await res.text();
  assert.match(err, /email address/);
  assert.match(err, /at least 20 characters/);
  res = await post({ name: 'Bot', role: 'other', contact: 'a@b.co', message: 'x'.repeat(30), website: 'spam' });
  assert.equal(res.status, 303);
  assert.equal(store.disputeCounts().open, 0, 'honeypot drops it');

  res = await post({ name: 'Indie Dev <b>', role: 'clone-developer', contact: 'dev@studio.example', message: 'We started this game in 2010, two years before Big Hit.', links: 'https://studio.example/devlog-2010' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /dispute\/thanks$/);
  assert.equal(store.disputeCounts().open, 1);
  let page = await (await fetch(`${base}/report/${id}`)).text();
  assert.ok(!page.includes('two years before'), 'open disputes are not public');
  assert.match(page, /Dispute this report/);

  assert.equal((await fetch(`${base}/admin/disputes`)).status, 401);
  const admin = await (await fetch(`${base}/admin/disputes`, { headers: auth })).text();
  assert.match(admin, /dev@studio\.example/);
  assert.match(admin, /Indie Dev &lt;b&gt;/);
  assert.match(await (await fetch(`${base}/admin`, { headers: auth })).text(), /Disputes \(1 open\)/);
  const did = admin.match(/\/admin\/disputes\/(\d+)\/publish/)[1];
  await fetch(`${base}/admin/disputes/${did}/publish`, { method: 'POST', headers: auth, redirect: 'manual' });

  page = await (await fetch(`${base}/report/${id}`)).text();
  assert.match(page, /Response from Indie Dev &lt;b&gt;/);
  assert.match(page, /two years before Big Hit/);
  assert.ok(!page.includes('dev@studio.example'), 'email stays private');
  assert.deepEqual(store.history(id).slice(-2).map((x) => x.action), ['dispute received', 'developer response published']);

  await fetch(`${base}/admin/disputes/${did}/dismiss`, { method: 'POST', headers: auth, redirect: 'manual' });
  assert.ok(!(await (await fetch(`${base}/report/${id}`)).text()).includes('two years before'));

  // Deleting the report removes its disputes and history.
  await fetch(`${base}/admin/${id}/delete`, { method: 'POST', headers: auth, redirect: 'manual' });
  assert.equal(store.history(id).length, 0);
  assert.equal(store.disputeCounts().dismissed, 0);
});
