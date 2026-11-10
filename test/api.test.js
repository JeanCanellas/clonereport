'use strict';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'pw';
process.env.MIN_FILL_MS = '0';
process.env.STEAM_ENRICH = '0';
process.env.SEED_ORIGINALS = '0';
process.env.MAIL_TEST = '1';
process.env.API_PER_MINUTE = '40';
process.env.PUBLIC_URL = 'https://clonereport.test';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../server');
const store = require('../db');
const mailer = require('../mailer');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());
const auth = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
const approved = (f) => { const id = store.createReport({ original_url: 'https://e.com/', ...f }, 'x'); store.setStatus(id, 'approved'); return id; };

test('public API: reports, games, developers, tree', async () => {
  const id = approved({ clone_name: 'Api Clone', clone_developer: 'Api Copy Co', original_name: 'Api Orig', clone_url: 'https://store.steampowered.com/app/555/',
    mechanics: 'm1\nm2', evidence: 'https://ev.example/1', notes: 'details' });
  store.createReport({ clone_name: 'Api Hidden', original_name: 'Api Orig', original_url: 'https://e.com/' }, 'x');
  store.vote(id, 'a', 'clone'); store.vote(id, 'b', 'clone'); store.vote(id, 'c', 'original');

  let res = await fetch(base + '/api/v1/reports?q=api');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  let j = await res.json();
  assert.equal(j.reports.length, 1, 'pending reports are not exposed');
  const rep = j.reports[0];
  assert.equal(rep.url, `https://clonereport.test/report/${id}`);
  assert.deepEqual(rep.votes, { clone: 2, inspired: 0, original: 1, total: 3 });
  assert.equal(rep.cloneScore, 67);
  assert.equal(rep.verdict, 'Likely a clone');
  assert.deepEqual(rep.mechanics, ['m1', 'm2']);
  assert.equal(rep.clone.steamAppid, 555);
  assert.equal(rep.notes, undefined, 'list is compact');

  j = await (await fetch(`${base}/api/v1/reports/${id}`)).json();
  assert.equal(j.notes, 'details');
  assert.deepEqual(j.evidence, ['https://ev.example/1']);
  assert.ok(Array.isArray(j.developerResponses));
  assert.ok(!JSON.stringify(j).includes('ip_hash') && !('contact' in j));
  assert.equal((await fetch(`${base}/api/v1/reports/999999`)).status, 404);

  j = await (await fetch(`${base}/api/v1/reports?developer=api-copy-co`)).json();
  assert.equal(j.reports[0].id, id);
  j = await (await fetch(`${base}/api/v1/reports?since_id=${id}`)).json();
  assert.equal(j.reports.length, 0);

  j = await (await fetch(`${base}/api/v1/games?appid=555`)).json();
  assert.equal(j.status, 'reported-clone');
  assert.equal(j.cloneScore, 67);
  j = await (await fetch(`${base}/api/v1/games?name=api%20orig`)).json();
  assert.equal(j.status, 'cloned-by-others');
  assert.equal(j.clonedBy[0].clone.name, 'Api Clone');
  assert.equal((await fetch(`${base}/api/v1/games`)).status, 400);

  j = await (await fetch(`${base}/api/v1/developers/api-copy-co`)).json();
  assert.equal(j.reportedAsCloner.length, 1);
  j = await (await fetch(`${base}/api/v1/tree?game=Api%20Orig`)).json();
  assert.equal(j.copiedBy[0].name, 'Api Clone');
  assert.equal((await fetch(`${base}/api/v1/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/reports`, { method: 'POST' })).status, 405);
  assert.match(await (await fetch(base + '/api')).text(), /Public API/);
});

test('RSS feeds', async () => {
  approved({ clone_name: 'Feed Clone <x>', original_name: 'Feed Orig' });
  approved({ clone_name: 'Other Clone', original_name: 'Other Orig' });
  let res = await fetch(base + '/feed.xml');
  assert.match(res.headers.get('content-type'), /application\/rss\+xml/);
  let x = await res.text();
  assert.match(x, /<title>Feed Clone &lt;x&gt; reported as a clone of Feed Orig<\/title>/);
  assert.match(x, /Other Clone/);
  x = await (await fetch(base + '/feed.xml?game=feed%20orig')).text();
  assert.match(x, /Feed Clone/);
  assert.ok(!x.includes('Other Clone'));
  assert.match(x, /<pubDate>[A-Z][a-z]{2}, \d\d [A-Z][a-z]{2} \d{4}/);
});

test('email alerts: double opt-in, alert on approval, unsubscribe', async () => {
  const form = async () => (await (await fetch(base + '/follow?game=Alert%20Orig')).text()).match(/name="token" value="([^"]+)"/)[1];
  const post = async (email) => fetch(base + '/follow?game=Alert%20Orig', { method: 'POST', body: new URLSearchParams({ token: await form(), email }) });
  assert.match(await (await post('bad')).text(), /valid email/);
  assert.match(await (await post('fan@example.com')).text(), /Check your inbox/);
  const confirm = mailer.sent.at(-1);
  assert.equal(confirm.to, 'fan@example.com');
  const link = confirm.text.match(/https:\/\/clonereport\.test(\/follow\/confirm\?t=\S+)/)[1];

  // Not confirmed yet: approving a clone sends nothing.
  let n = mailer.sent.length;
  const id1 = store.createReport({ clone_name: 'Early Clone', original_name: 'alert orig', original_url: 'https://e.com/' }, 'x');
  await fetch(`${base}/admin/${id1}/approve`, { method: 'POST', headers: auth, redirect: 'manual' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailer.sent.length, n);

  assert.match(await (await fetch(base + link)).text(), /all set/);
  const id2 = store.createReport({ clone_name: 'Late Clone', original_name: 'ALERT ORIG', original_url: 'https://e.com/' }, 'x');
  await fetch(`${base}/admin/${id2}/approve`, { method: 'POST', headers: auth, redirect: 'manual' });
  await new Promise((r) => setTimeout(r, 20));
  const alert = mailer.sent.at(-1);
  assert.equal(alert.to, 'fan@example.com');
  assert.match(alert.subject, /New clone of ALERT ORIG reported: Late Clone/);
  assert.match(alert.text, new RegExp(`/report/${id2}`));

  // Re-approving after a reject does not email again.
  n = mailer.sent.length;
  await fetch(`${base}/admin/${id2}/reject`, { method: 'POST', headers: auth, redirect: 'manual' });
  await fetch(`${base}/admin/${id2}/approve`, { method: 'POST', headers: auth, redirect: 'manual' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailer.sent.length, n);

  // Following again while confirmed sends no new confirmation email.
  await post('FAN@example.com');
  assert.equal(mailer.sent.length, n);

  const unsub = alert.text.match(/https:\/\/clonereport\.test(\/follow\/unsubscribe\?t=\S+)/)[1];
  assert.match(await (await fetch(base + unsub)).text(), /get any more emails about Alert Orig/);
  assert.equal((await fetch(base + unsub)).status, 404);
  assert.equal(store.followersOf('Alert Orig').length, 0);
});

test('api rate limit', async () => {
  let last;
  for (let i = 0; i < 45; i++) last = await fetch(base + '/api/v1/reports?limit=1');
  assert.equal(last.status, 429);
});
