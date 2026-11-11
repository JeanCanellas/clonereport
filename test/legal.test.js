'use strict';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'pw';
process.env.MIN_FILL_MS = '0';
process.env.STEAM_ENRICH = '0';
process.env.SEED_ORIGINALS = '0';
process.env.MAIL_TEST = '1';
process.env.ADMIN_EMAIL = 'mod@example.com';
process.env.TRUST_PROXY = '1';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('../server');
const store = require('../db');
const mailer = require('../mailer');
const { TERMS_VERSION } = require('../views');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());
const auth = { Authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
const tokenFrom = async (path) => (await (await fetch(base + path)).text()).match(/name="token" value="([^"]+)"/)[1];
let ip = 0;
const post = async (path, fields) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'X-Forwarded-For': `7.7.7.${++ip}` },
  body: new URLSearchParams({ token: await tokenFrom(path.split('?')[0]), ...fields }) });

test('terms page exists and is linked from every page and the submit form', async () => {
  const terms = await (await fetch(base + '/terms')).text();
  assert.match(terms, /<h1>Terms of Service<\/h1>/);
  assert.match(terms, /truthful and accurate/);
  assert.match(terms, /Nothing on Clone Report is legal advice/);
  const home = await (await fetch(base + '/')).text();
  assert.match(home, /href="\/terms">Terms of Service/);
  assert.match(home, /href="\/contact">Contact and takedown requests/);
  const form = await (await fetch(base + '/submit')).text();
  assert.match(form, /<input type="checkbox" name="agree" value="yes"\s+required>/);
  assert.match(form, /href="\/terms"/);
});

test('reports need the terms checkbox, and record the terms version', async () => {
  const fields = { clone_name: 'Terms Clone', original_name: 'Terms Original', original_url: 'https://example.com/t' };
  let res = await post('/submit', fields);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /agree to the Terms of Service/);
  res = await post('/submit', { ...fields, agree: 'yes' });
  assert.equal(res.status, 303);
  const r = store.byStatus('pending').find((x) => x.clone_name === 'Terms Clone');
  assert.equal(r.terms_accepted, TERMS_VERSION);
});

test('contact and takedown requests reach the admin', async () => {
  const id = store.createReport({ clone_name: 'Takedown Clone', original_name: 'Takedown Original', original_url: 'https://example.com/o' }, 'x');
  store.setStatus(id, 'approved');
  const page = await (await fetch(`${base}/report/${id}`)).text();
  assert.match(page, new RegExp(`href="/contact\\?report=${id}">Request a correction or removal`));
  assert.match(page, /Reported clone<\/span> Takedown Clone/);

  const form = await (await fetch(`${base}/contact?report=${id}`)).text();
  assert.match(form, /value="removal" checked/);
  assert.match(form, new RegExp(`value="http://[^"]+/report/${id}"`));
  assert.match(form, /aim to reply within 7 days/);

  const good = { kind: 'removal', report: `https://clonereport.com/report/${id}`, name: 'Dana Dev', organization: 'Takedown Studio',
    email: 'dana@example.com', message: 'Our game came out first and this report has the dates the wrong way round.', sworn: 'yes' };
  let res = await post('/contact', { ...good, sworn: '' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /good faith/);
  res = await post('/contact', { ...good, report: '999999' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /could not find that report/);
  res = await post('/contact', { ...good, kind: 'nonsense', email: 'nope', message: 'short' });
  const errs = await res.text();
  assert.match(errs, /choose what your request is about/);
  assert.match(errs, /valid email|email address/);
  assert.match(errs, /at least 20 characters/);

  mailer.sent.length = 0;
  res = await post('/contact', good);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/contact/thanks');
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'mod@example.com');
  assert.match(mailer.sent[0].text, /Dana Dev \(Takedown Studio\) <dana@example.com> sent a removal request/);

  assert.equal((await fetch(base + '/admin/requests')).status, 401);
  const admin = await (await fetch(base + '/admin/requests', { headers: auth })).text();
  assert.match(admin, /Remove a report/);
  assert.match(admin, /Takedown Clone/);
  assert.match(admin, /dana@example.com/);
  const reqId = admin.match(/\/admin\/requests\/(\d+)\/done/)[1];
  res = await fetch(`${base}/admin/requests/${reqId}/done`, { method: 'POST', headers: auth, redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(store.getRequest(Number(reqId)).status, 'done');
  assert.deepEqual(store.requestCounts(), { open: 0, done: 1 });
  const moderation = await (await fetch(base + '/admin', { headers: auth })).text();
  assert.match(moderation, /Requests \(0 open\)/);

  // Requests are private: nothing shows on the public report or its history.
  const hist = await (await fetch(`${base}/report/${id}/history`)).text();
  assert.ok(!hist.includes('dana@example.com') && !page.includes('Dana Dev'));
  // Honeypot
  res = await post('/contact', { ...good, website: 'spam' });
  assert.equal(res.status, 303);
  assert.equal(store.requestCounts().done + store.requestCounts().open, 1);
});

test('the extension describes reports as claims', () => {
  const fs = require('node:fs');
  const src = ['content.js', 'popup.js', 'background.js'].map((f) => fs.readFileSync(`${__dirname}/../chrome-extension/${f}`, 'utf8')).join('\n');
  assert.ok(!/users say|has been cloned|cloned by \$/.test(src));
  assert.match(src, /reported as a clone/);
});
