'use strict';
// Public "Pending reports" page, review trail on approved reports, moderator applications and logins.
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'owner-pw';
process.env.MIN_FILL_MS = '0';
process.env.STEAM_ENRICH = '0';
process.env.SEED_ORIGINALS = '0';
process.env.MAX_PER_HOUR = '50';
process.env.FAILED_LOGIN_LIMIT = '1000';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../server');
const store = require('../db');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());
const basic = (user, pass) => ({ Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') });
const owner = basic('admin', 'owner-pw');
const tokenFrom = async (path) => (await (await fetch(base + path)).text()).match(/name="token" value="([^"]+)"/)[1];
const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });
const post = (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers, redirect: 'manual', body: new URLSearchParams(body) });

test('pending reports are listed publicly as unverified, and nowhere else', async () => {
  const id = store.createReport({ clone_name: 'Pendy Clone', original_name: 'Pendy Original', clone_developer: 'Copy Co',
    clone_url: 'https://store.steampowered.com/app/4242/Pendy/', original_url: 'https://spam.example/buy-now',
    notes: 'SECRET-NOTES-TEXT', evidence: 'https://evidence.example/x', contact: 'reporter@example.com' }, 'ip');
  const res = await get('/pending');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  const page = await res.text();
  assert.match(page, /Pendy Clone/);
  assert.match(page, /Unverified claim/);
  assert.match(page, /unverified allegation/);
  assert.match(page, /by Copy Co/);
  assert.match(page, /href="https:\/\/store\.steampowered\.com\/app\/4242\/Pendy\/"[^>]*>Steam</, 'known store pages are linked');
  assert.ok(!page.includes('spam.example'), 'other links are not shown before review');
  for (const secret of ['SECRET-NOTES-TEXT', 'evidence.example', 'reporter@example.com']) assert.ok(!page.includes(secret), secret);
  assert.ok(!page.includes(`/report/${id}`), 'no link to the private report page');

  // Not in search, /clones, the report page, the API, the feed or the extension lookup.
  assert.ok(!(await (await get('/search?q=Pendy')).text()).includes('Pendy Clone'));
  assert.ok(!(await (await get('/clones')).text()).includes('Pendy Clone'));
  assert.equal((await get(`/report/${id}`)).status, 404);
  assert.ok(!(await (await get('/api/v1/reports?q=Pendy')).text()).includes('Pendy Clone'));
  assert.ok(!(await (await get('/feed.xml')).text()).includes('Pendy Clone'));
  const lookup = await (await get('/api/lookup?appid=4242&name=Pendy%20Clone')).json();
  assert.equal(lookup.found, false);
  assert.match(await (await get('/robots.txt')).text(), /Disallow: \/pending/);

  // Approved reports leave the pending page.
  store.setStatus(id, 'approved');
  assert.ok(!(await (await get('/pending')).text()).includes('Pendy Clone'));
});

test('approved report pages show a review trail', async () => {
  const id = store.createReport({ clone_name: 'Trail Clone', original_name: 'Trail Orig', original_url: 'https://e.com' }, 'ip');
  assert.equal((await post(`/admin/${id}/approve`, {}, owner)).status, 303);
  store.vote(id, 'voter-a', 'clone');
  store.vote(id, 'voter-b', 'inspired');
  const page = await (await get(`/report/${id}`)).text();
  assert.match(page, /<h2>Review trail<\/h2>/);
  assert.match(page, /Submitted<\/strong> by a community member/);
  assert.match(page, /Reviewed by a moderator<\/strong> and approved <span class="muted">\d{4}-\d{2}-\d{2}/);
  assert.match(page, /2 community votes/);

  // Reports seeded from public sources say so instead.
  const sid = store.createReport({ clone_name: 'Seed Clone', original_name: 'Seed Orig', original_url: 'https://e.com' }, 'seed');
  store.setStatus(sid, 'approved', 'seed');
  const seeded = await (await get(`/report/${sid}`)).text();
  assert.match(seeded, /Added by Clone Report<\/strong> from public sources/);
  assert.match(seeded, /0 community votes/);
});

test('moderator application: validated, stored, reviewed by the owner, then a moderator can sign in', async () => {
  // Validation
  let res = await post('/moderators/apply', { token: await tokenFrom('/moderators/apply'), name: 'Mo', email: 'bad', experience: 'short' });
  assert.equal(res.status, 400);
  const errs = await res.text();
  assert.match(errs, /email address/);
  assert.match(errs, /at least 50 characters/);
  assert.match(errs, /moderation guidelines/);

  const experience = 'I moderate a 50k-member mobile games subreddit and track clone listings on Google Play every week.';
  res = await post('/moderators/apply', { token: await tokenFrom('/moderators/apply'), name: 'Mo Derator', email: 'Mo@Example.com',
    experience, links: 'https://reddit.com/u/mo', agree: 'yes' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/moderators/apply/thanks');
  // A second application from the same email waits for the first.
  res = await post('/moderators/apply', { token: await tokenFrom('/moderators/apply'), name: 'Mo', email: 'mo@example.com', experience, agree: 'yes' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /already an application/);

  // Only the owner sees applications.
  assert.equal((await get('/admin/applications')).status, 401);
  const list = await (await get('/admin/applications', owner)).text();
  assert.match(list, /Mo Derator/);
  assert.match(list, /mo@example\.com/);
  assert.match(list, /subreddit/);
  const appId = Number(list.match(/\/admin\/applications\/(\d+)\/approve/)[1]);

  // Approve: creates the moderator and shows a one-time setup link.
  res = await post(`/admin/applications/${appId}/approve`, {}, owner);
  assert.equal(res.status, 303);
  const modsPage = await (await get(res.headers.get('location'), owner)).text();
  const setupUrl = modsPage.match(/(http:\/\/[^<\s]+\/moderator\/setup\?t=[\w-]+)/)[1];
  assert.match(modsPage, /has not set a password yet/);
  assert.equal(store.getApplication(appId).status, 'approved');

  const setupPath = new URL(setupUrl).pathname + new URL(setupUrl).search;
  assert.match(await (await get(setupPath)).text(), /mo@example\.com/);
  res = await post(setupPath, { password: 'short', password2: 'short' });
  assert.equal(res.status, 400);
  res = await post(setupPath, { password: 'a-long-moderator-pass', password2: 'a-long-moderator-pass' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /all set/);
  assert.equal((await get(setupPath)).status, 404, 'setup links work once');

  const mod = basic('mo@example.com', 'a-long-moderator-pass');
  assert.equal((await get('/admin', basic('mo@example.com', 'wrong-password'))).status, 401);
  const queue = await (await get('/admin', mod)).text();
  assert.match(queue, /Signed in as moderator Mo Derator/);
  assert.ok(!queue.includes('Moderator applications'), 'owner tabs are hidden');

  // A moderator can approve and reject, which is logged without their name.
  const id = store.createReport({ clone_name: 'Mod Review', original_name: 'Mod Orig', original_url: 'https://e.com', contact: 'private@example.com' }, 'ip');
  const pendingQueue = await (await get('/admin', mod)).text();
  assert.match(pendingQueue, /Mod Review/);
  assert.ok(!pendingQueue.includes('private@example.com'), 'moderators do not see reporter emails');
  assert.ok(!pendingQueue.includes(`/admin/${id}/delete`), 'no delete button for moderators');
  assert.equal((await get(`/report/${id}`, mod)).status, 200, 'moderators can open pending reports');
  assert.equal((await post(`/admin/${id}/approve`, {}, mod)).status, 303);
  assert.equal(store.get(id).status, 'approved');
  const h = store.history(id).at(-1);
  assert.match(h.actor, /^moderator:\d+$/);
  const hist = await (await get(`/report/${id}/history`)).text();
  assert.match(hist, /by Moderator/);
  assert.ok(!hist.includes('Mo Derator') && !hist.includes('moderator:'));
  assert.match(await (await get(`/report/${id}`)).text(), /Reviewed by a moderator/);
  assert.match(await (await get('/admin/moderators', owner)).text(), /1 report reviewed/);

  // Everything else is owner-only.
  for (const path of ['/admin/applications', '/admin/moderators', '/admin/disputes', '/admin/requests', '/admin/originals', `/admin/${id}/edit`])
    assert.equal((await get(path, mod)).status, 403, path);
  assert.equal((await post(`/admin/${id}/delete`, {}, mod)).status, 403);
  assert.ok(store.get(id), 'not deleted');

  // Disabling the account signs the moderator out at once.
  const modId = store.moderatorByEmail('mo@example.com').id;
  assert.equal((await post(`/admin/moderators/${modId}/disable`, {}, owner)).status, 303);
  assert.equal((await get('/admin', mod)).status, 401);
  await post(`/admin/moderators/${modId}/enable`, {}, owner);
  assert.equal((await get('/admin', mod)).status, 200);
});

test('owner can reject applications; the owner password still works with any username', async () => {
  const appId = store.createApplication({ name: 'Nope', email: 'nope@example.com', experience: 'x'.repeat(60) }, 'ip');
  assert.equal((await post(`/admin/applications/${appId}/reject`, {}, owner)).status, 303);
  assert.equal(store.getApplication(appId).status, 'rejected');
  assert.equal(store.moderatorByEmail('nope@example.com'), undefined);
  assert.equal((await get('/admin', basic('anything', 'owner-pw'))).status, 200);
});

test('the footer links to pending reports and the moderator application', async () => {
  const home = await (await get('/')).text();
  assert.match(home, /href="\/pending"/);
  assert.match(home, /href="\/moderators\/apply"/);
});
