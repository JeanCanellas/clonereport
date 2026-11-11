'use strict';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'pw';
process.env.MIN_FILL_MS = '0';
process.env.MAX_PER_HOUR = '3';
process.env.STEAM_ENRICH = '0';
process.env.MAX_VOTES_PER_HOUR = '5';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../server');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

const auth = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
async function token() {
  const html = await (await fetch(base + '/submit')).text();
  return html.match(/name="token" value="([^"]+)"/)[1];
}
async function submit(fields) {
  const body = new URLSearchParams({ token: await token(), ...fields });
  return fetch(base + '/submit', { method: 'POST', body, redirect: 'manual' });
}

test('report flow: submit, hidden until approved, then searchable', async () => {
  const res = await submit({ clone_name: 'Flappy Pigeon <script>', original_name: 'Flappy Bird', original_url: 'https://example.com/flappy', notes: 'same pipes' });
  assert.equal(res.status, 303);
  let s = await (await fetch(base + '/search?q=flappy')).text();
  assert.match(s, /No reports/);

  const admin = await (await fetch(base + '/admin', { headers: auth })).text();
  const id = admin.match(/\/admin\/(\d+)\/approve/)[1];
  assert.ok(!admin.includes('<script>'), 'admin escapes HTML');
  const ap = await fetch(`${base}/admin/${id}/approve`, { method: 'POST', headers: auth, redirect: 'manual' });
  assert.equal(ap.status, 303);

  s = await (await fetch(base + '/search?q=flappy BIRD')).text();
  assert.match(s, /Flappy Pigeon &lt;script&gt;/);
  const page = await (await fetch(`${base}/report/${id}`)).text();
  assert.match(page, /href="https:\/\/example.com\/flappy"/);
});

test('validation and spam protection', async () => {
  let r = await submit({ clone_name: 'X', original_name: 'Y', original_url: 'javascript:alert(1)' });
  assert.equal(r.status, 400);
  r = await submit({ clone_name: '', original_name: 'Y', original_url: 'https://a.b' });
  assert.equal(r.status, 400);
  r = await fetch(base + '/submit', { method: 'POST', body: new URLSearchParams({ token: '1.abc', clone_name: 'a', original_name: 'b', original_url: 'https://a.b' }) });
  assert.equal(r.status, 400, 'forged token rejected');
  // honeypot silently dropped
  r = await submit({ clone_name: 'Bot', original_name: 'Spam', original_url: 'https://a.b', website: 'http://spam' });
  assert.equal(r.status, 303);
  const admin = await (await fetch(base + '/admin', { headers: auth })).text();
  assert.ok(!admin.includes('Spam'));
  // rate limit: 1 accepted earlier, allow up to 3 per hour
  assert.equal((await submit({ clone_name: 'a', original_name: 'b', original_url: 'https://a.b' })).status, 303);
  assert.equal((await submit({ clone_name: 'c', original_name: 'd', original_url: 'https://a.b' })).status, 303);
  assert.equal((await submit({ clone_name: 'e', original_name: 'f', original_url: 'https://a.b' })).status, 429);
});

test('admin requires password; pending reports are private', async () => {
  assert.equal((await fetch(base + '/admin')).status, 401);
  assert.equal((await fetch(base + '/admin/1/approve', { method: 'POST' })).status, 401);
  const wrong = { Authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') };
  assert.equal((await fetch(base + '/admin', { headers: wrong })).status, 401);
  assert.equal((await fetch(base + '/report/2')).status, 404);
});

test('api lookup by steam appid and by name', async () => {
  // Insert directly: the rate limit was already used up by the previous test.
  const store = require('../db');
  const id = store.createReport({ clone_name: 'Portal Copy', original_name: 'Portal 2', original_url: 'https://store.steampowered.com/app/620/Portal_2/',
    clone_url: 'https://store.steampowered.com/app/999999/', notes: 'portals' }, 'x');
  store.setStatus(id, 'approved');

  let r = await fetch(base + '/api/lookup?appid=999999');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  let j = await r.json();
  assert.equal(j.found, true);
  assert.equal(j.cloneOf[0].name, 'Portal 2');
  assert.equal(j.cloneOf[0].appid, 620);
  assert.equal(j.cloneOf[0].steamUrl, 'https://store.steampowered.com/app/620');
  assert.match(j.cloneOf[0].reportUrl, /\/report\/\d+$/);

  j = await (await fetch(base + '/api/lookup?appid=620')).json();
  assert.equal(j.clonedBy[0].name, 'Portal Copy');
  j = await (await fetch(base + '/api/lookup?name=flappy%20bird')).json();
  assert.equal(j.clonedBy[0].name, 'Flappy Pigeon <script>');
  j = await (await fetch(base + '/api/lookup?appid=1&name=nothing')).json();
  assert.deepEqual(j, { found: false, cloneOf: [], clonedBy: [], verifiedOriginal: null });
});

test('original games are seeded, searchable and exposed in the api', async () => {
  const store = require('../db');
  const seed = require('../seed/originals.json').games;
  assert.equal(store.countOriginals(), seed.length, 'every seed game loaded once');
  // Re-seeding is idempotent.
  store.seedOriginals(seed);
  assert.equal(store.countOriginals(), seed.length);

  const names = new Set();
  for (const g of seed) {
    assert.ok(g.name && !names.has(g.name.toLowerCase()), `unique name: ${g.name}`);
    names.add(g.name.toLowerCase());
    assert.ok(g.steam_appid || g.eshop_url, `${g.name} has a store link`);
    if (g.eshop_url) assert.match(g.eshop_url, /^https:\/\/www\.nintendo\.com\/us\/store\/products\/[a-z0-9-]+\/$/);
  }

  const home = await (await fetch(base + '/')).text();
  assert.match(home, new RegExp(`Browse ${seed.length} original games`));

  let s = await (await fetch(base + '/search?q=hollow knight')).text();
  assert.match(s, /Not a clone/);
  const id = s.match(/href="\/game\/(\d+)"/)[1];
  const page = await (await fetch(`${base}/game/${id}`)).text();
  assert.match(page, /Team Cherry/);
  assert.match(page, /store\.steampowered\.com\/app\/367520\//);
  assert.equal((await fetch(base + '/game/999999')).status, 404);

  const list = await (await fetch(base + '/originals?store=nintendo')).text();
  assert.match(list, /Super Mario Odyssey/);
  assert.match(list, /Hollow Knight/, 'games on both stores show in each');
  assert.ok(!list.includes('Factorio'), 'steam-only games are filtered out');

  let j = await (await fetch(base + '/api/lookup?appid=367520')).json();
  assert.equal(j.found, false);
  assert.equal(j.verifiedOriginal.name, 'Hollow Knight');
  assert.equal(j.verifiedOriginal.steamUrl, 'https://store.steampowered.com/app/367520');
  j = await (await fetch(base + '/api/lookup?name=super%20mario%20odyssey')).json();
  assert.match(j.verifiedOriginal.eshopUrl, /super-mario-odyssey-switch/);
  j = await (await fetch(base + '/api/lookup?appid=1&name=nothing')).json();
  assert.equal(j.verifiedOriginal, null);
});

test('admin can remove an original for good; approving a clone report removes it too', async () => {
  const store = require('../db');
  const g = store.findOriginal(null, 'Celeste');
  const r = await fetch(`${base}/admin/originals/${g.id}/remove`, { method: 'POST', headers: auth, redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(store.findOriginal(null, 'Celeste'), null);
  store.seedOriginals(require('../seed/originals.json').games);
  assert.equal(store.findOriginal(null, 'Celeste'), null, 'reseeding does not bring it back');

  const admin = await (await fetch(base + '/admin/originals?q=hades', { headers: auth })).text();
  assert.match(admin, /Hades II/);
  assert.equal((await fetch(base + '/admin/originals')).status, 401);

  // A report saying Bastion (app 107100) is a clone, once approved, takes it off the list.
  const id = store.createReport({ clone_name: 'Bastion', clone_url: 'https://store.steampowered.com/app/107100/', original_name: 'Something Older', original_url: 'https://example.com' }, 'x');
  await fetch(`${base}/admin/${id}/approve`, { method: 'POST', headers: auth, redirect: 'manual' });
  assert.equal(store.findOriginal(107100, ''), null);

  const list = await (await fetch(base + '/originals?page=2')).text();
  assert.match(list, /Page 2 of \d+/);
});

test('privacy policy page is linked from every page', async () => {
  const res = await fetch(base + '/privacy');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1>Privacy policy<\/h1>/);
  assert.match(html, /Limited Use/);
  assert.match(await (await fetch(base + '/')).text(), /href="\/privacy"/);
});
