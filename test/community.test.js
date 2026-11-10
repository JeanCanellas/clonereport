'use strict';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'pw';
process.env.MIN_FILL_MS = '0';
process.env.STEAM_ENRICH = '0';
process.env.SEED_ORIGINALS = '0';
process.env.MAX_VOTES_PER_HOUR = '4';
process.env.TRUST_PROXY = '1';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../server');
const store = require('../db');
const { parseSteamDate, comparisonFor } = require('../steam');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());
const auth = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };

function approved(fields) {
  const id = store.createReport({ original_url: 'https://example.com/o', ...fields }, 'x');
  store.setStatus(id, 'approved');
  return id;
}
async function vote(id, choice, ip = '1.1.1.1') {
  const html = await (await fetch(`${base}/report/${id}`, { headers: { 'X-Forwarded-For': ip } })).text();
  const token = html.match(/name="token" value="([^"]+)"/)[1];
  const res = await fetch(`${base}/report/${id}/vote`, { method: 'POST', redirect: 'manual', headers: { 'X-Forwarded-For': ip }, body: new URLSearchParams({ token, choice }) });
  return res.headers.get('location');
}

test('community voting: one vote per visitor, changeable, verdict after 3 votes', async () => {
  const id = approved({ clone_name: 'Pipe Hopper', original_name: 'Tap Bird' });
  let page = await (await fetch(`${base}/report/${id}`)).text();
  assert.match(page, /verdict shows after 3 votes/);

  assert.match(await vote(id, 'clone', '10.0.0.1'), /voted=ok/);
  assert.match(await vote(id, 'original', '10.0.0.1'), /voted=ok/, 'same visitor changes vote');
  let r = store.get(id);
  assert.deepEqual([r.votes_clone, r.votes_original], [0, 1]);

  await vote(id, 'clone', '10.0.0.2');
  await vote(id, 'clone', '10.0.0.3');
  await vote(id, 'inspired', '10.0.0.4');
  r = store.get(id);
  assert.deepEqual([r.votes_clone, r.votes_inspired, r.votes_original], [2, 1, 1]);
  page = await (await fetch(`${base}/report/${id}`, { headers: { 'X-Forwarded-For': '10.0.0.2' } })).text();
  // (2 + 0.5) / 4 = 62.5% -> 63%, "Inspired by" band
  assert.match(page, /Community verdict: <strong>Inspired by<\/strong>, clone score 63% from 4 votes/);
  assert.match(page, /v-clone on" name="choice" value="clone" aria-pressed="true"/, 'shows my vote');
  assert.match(page, /<svg class="vbar"/);
  const home = await (await fetch(base + '/')).text();
  assert.match(home, /Inspired by · 63%/, 'score badge on cards');
});

test('votes are protected: bad token, bad choice, pending reports, rate limit, cross-origin', async () => {
  const id = approved({ clone_name: 'Gem Smash', original_name: 'Gem Match' });
  const post = (body, headers = {}) => fetch(`${base}/report/${id}/vote`, { method: 'POST', redirect: 'manual', headers: { 'X-Forwarded-For': '9.9.9.9', ...headers }, body: new URLSearchParams(body) });
  assert.match((await post({ token: '1.abc', choice: 'clone' })).headers.get('location'), /voted=expired/);
  const html = await (await fetch(`${base}/report/${id}`)).text();
  const token = html.match(/name="token" value="([^"]+)"/)[1];
  assert.match((await post({ token, choice: 'banana' })).headers.get('location'), /voted=expired/);
  assert.equal((await post({ token, choice: 'clone' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(store.get(id).votes_clone, 0);

  const pending = store.createReport({ clone_name: 'P', original_name: 'Q', original_url: 'https://e.com' }, 'x');
  assert.equal((await fetch(`${base}/report/${pending}/vote`, { method: 'POST', body: 'choice=clone' })).status, 404);

  // 4 votes per hour per IP in this test file
  const ids = [1, 2, 3, 4, 5].map((n) => approved({ clone_name: 'Rate ' + n, original_name: 'Orig ' + n }));
  for (const i of ids.slice(0, 4)) assert.match(await vote(i, 'clone', '7.7.7.7'), /voted=ok/);
  assert.match(await vote(ids[4], 'clone', '7.7.7.7'), /voted=limit/);
});

test('side-by-side comparison with dates, images and shared mechanics', async () => {
  const id = approved({ clone_name: 'Block Drop', original_name: 'Falling Blocks', original_released: '1984-06', clone_released: '2019-03-02',
    original_image: 'https://img.example/o.jpg', mechanics: 'line clears\nrotating pieces' });
  const page = await (await fetch(`${base}/report/${id}`)).text();
  assert.match(page, /aria-label="Side-by-side comparison"/);
  assert.match(page, /<img class="shot" src="https:\/\/img.example\/o.jpg"/);
  assert.match(page, /No image yet/, 'placeholder when only one side has an image');
  assert.match(page, /1984-06/);
  assert.match(page, /The original came out 35 years before the clone/);
  assert.match(page, /<li>line clears<\/li><li>rotating pieces<\/li>/);
});

test('submit form accepts comparison fields and validates them', async () => {
  const tok = async () => (await (await fetch(base + '/submit')).text()).match(/name="token" value="([^"]+)"/)[1];
  let res = await fetch(base + '/submit', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token: await tok(),
    clone_name: 'Bad Date', original_name: 'X', original_url: 'https://e.com', clone_released: 'yesterday', clone_image: 'http://insecure.example/a.png' }) });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /Release dates must look like/);
  assert.match(html, /must be full web addresses starting with https/);

  res = await fetch(base + '/submit', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ token: await tok(),
    clone_name: 'Good Clone', original_name: 'Good Orig', original_url: 'https://e.com', clone_released: '2020', mechanics: 'a, b,\n a , c' }) });
  assert.equal(res.status, 303);
  const r = store.byStatus('pending').find((x) => x.clone_name === 'Good Clone');
  assert.equal(r.clone_released, '2020');
  assert.equal(r.mechanics, 'a\nb\nc');
});

test('admins can edit a report', async () => {
  const id = approved({ clone_name: 'Typo Gaem', original_name: 'Orig' });
  assert.equal((await fetch(`${base}/admin/${id}/edit`)).status, 401);
  assert.match(await (await fetch(`${base}/admin/${id}/edit`, { headers: auth })).text(), /value="Typo Gaem"/);
  const res = await fetch(`${base}/admin/${id}/edit`, { method: 'POST', headers: auth, redirect: 'manual', body: new URLSearchParams({
    clone_name: 'Typo Game', original_name: 'Orig', original_url: 'https://store.steampowered.com/app/42/', mechanics: 'x' }) });
  assert.equal(res.status, 303);
  const r = store.get(id);
  assert.equal(r.clone_name, 'Typo Game');
  assert.equal(r.original_steam_appid, 42);
});

test('steam details fill empty comparison fields', async () => {
  assert.equal(parseSteamDate('21 Feb, 2017'), '2017-02-21');
  assert.equal(parseSteamDate('Feb 3, 2017'), '2017-02-03');
  assert.equal(parseSteamDate('Mar 2020'), '2020-03');
  assert.equal(parseSteamDate('Coming soon'), null);
  const fake = async (url) => {
    const appid = Number(new URL(url).searchParams.get('appids'));
    return { ok: true, json: async () => ({ [appid]: { success: true, data: { release_date: { date: '1 Jan, 2010' },
      header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`, developers: ['Dev ' + appid] } } }) };
  };
  const id = approved({ clone_name: 'C', original_name: 'O', clone_url: 'https://store.steampowered.com/app/11/', clone_released: '2015' });
  const d = await comparisonFor(store.get(id), fake);
  assert.equal(d.clone_image, 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/11/header.jpg');
  store.fillComparison(id, d);
  const r = store.get(id);
  assert.equal(r.clone_released, '2015', 'existing values are kept');
  assert.equal(r.clone_developer, 'Dev 11');
  assert.equal(r.original_image, null);
});
