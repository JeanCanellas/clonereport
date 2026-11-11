'use strict';
// clonereport.com: a public directory of reported game clones.
// Zero dependencies: Node 22.13+ built-ins only (http, crypto, sqlite).
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');
const scanner = require('./scanner');
const steam = require('./steam');
const api = require('./api');
const mailer = require('./mailer');
const { layout, home, searchPage, reportPage, gamePage, originalsPage, adminOriginalsPage, submitPage, thanksPage, adminPage, extensionPage, adminEditPage, adminDisputesPage, disputePage, disputeThanksPage, historyPage, apiDocsPage, followPage, developerPage, developersPage, treePage, notFound, privacyPage, termsPage, contactPage, contactThanksPage, adminRequestsPage, TERMS_VERSION, REQUEST_KINDS, esc } = require('./views');
const { familyTree } = require('./tree');
const classic = require('./classic');
const stores = require('./stores');
const extension = require('./extension');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MIN_FILL_MS = Number(process.env.MIN_FILL_MS ?? 4000);   // humans take a few seconds to fill the form
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');      // e.g. https://clonereport.com
const MAX_PER_HOUR = Number(process.env.MAX_PER_HOUR ?? 5);    // per IP
const MAX_VOTES_PER_HOUR = Number(process.env.MAX_VOTES_PER_HOUR ?? 100); // per IP
const STEAM_ENRICH = process.env.STEAM_ENRICH !== '0';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';               // gets an email for each contact or takedown request

if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set: the /admin page is disabled.');

// Load the list of verified original games (seed/originals.json) into the database.
// Idempotent: existing rows are updated, nothing is duplicated. Set SEED_ORIGINALS=0 to skip.
if (process.env.SEED_ORIGINALS !== '0') {
  try {
    const { games } = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'originals.json'), 'utf8'));
    console.log(`Loaded ${store.seedOriginals(games)} original games from seed/originals.json`);
  } catch (err) { console.error('Could not load seed/originals.json:', err.message); }
}
// Load publicly documented clone cases (seed/clone-reports.json) as approved reports.
// Each entry is added once, so admin edits and deletions stick. Set SEED_REPORTS=0 to skip.
// Skipped under `node --test` (so tests start from an empty reports table) unless SEED_REPORTS=1.
if (process.env.SEED_REPORTS === '1' || (process.env.SEED_REPORTS !== '0' && !process.env.NODE_TEST_CONTEXT)) {
  try {
    const { added, moved } = require('./seed-reports').loadSeedReports(store);
    if (added || moved) console.log(`Seeded ${added} clone reports from seed/clone-reports.json` + (moved ? ` (${moved} moved sources to evidence)` : ''));
  } catch (err) { console.error('Could not load seed/clone-reports.json:', err.message); }
}

const CSS = fs.readFileSync(path.join(__dirname, 'public', 'style.css'));
const EXT_SHOT = fs.readFileSync(path.join(__dirname, 'public', 'extension-screenshot.png'));
// Chrome extension download, built from chrome-extension/ at start. Once the extension
// is on the Chrome Web Store, set CHROME_STORE_URL and the site links there instead.
const EXT_ZIP = extension.buildZip();
const EXT_INFO = { version: extension.version(), storeUrl: process.env.CHROME_STORE_URL || '', zipUrl: '/extension/clone-report-extension.zip' };

// ---------- helpers ----------
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data: https:; form-action 'self'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(body);
}
const redirect = (res, to) => { res.writeHead(303, { Location: to }); res.end(); };

function readBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

// Form token = timestamp signed with the server secret. Proves the form was
// loaded from this site and lets us reject submissions that are too fast.
// `purpose` keeps a token for one form from being replayed on another.
const makeFormToken = (purpose = 'form') => { const t = Date.now().toString(); return `${t}.${hmac(purpose + ':' + t)}`; };
function checkFormToken(tok, purpose = 'form', minMs = MIN_FILL_MS, maxMs = 2 * 3600 * 1000) {
  const [t, sig] = String(tok || '').split('.');
  if (!t || !sig || sig.length !== 64) return 'expired';
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(purpose + ':' + t)))) return 'expired';
  const age = Date.now() - Number(t);
  if (age < minMs) return 'too-fast';
  if (age > maxMs) return 'expired';
  return null;
}

function cleanUrl(v) {
  v = String(v || '').trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().slice(0, 500);
  } catch { return null; }
}
// Release dates: 2017, 2017-02 or 2017-02-21.
function cleanDate(v) {
  v = String(v || '').trim();
  if (!v) return '';
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(v);
  if (!m || +m[1] < 1950 || +m[1] > 2100 || (m[2] && (+m[2] < 1 || +m[2] > 12)) || (m[3] && (+m[3] < 1 || +m[3] > 31))) return null;
  return v;
}
// Shared mechanics: comma or line separated, stored one per line.
const cleanMechanics = (v) => [...new Set(String(v || '').split(/[,\n]/).map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean))]
  .slice(0, 12).join('\n');
// Evidence links: one per line, http(s) only, at most 8. Returns null if any line is not a link.
function cleanLinks(v, max = 8) {
  const lines = String(v || '').split(/\s*\n\s*/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) { const u = cleanUrl(l); if (!u) return null; if (!out.includes(u)) out.push(u); }
  return out.length > max ? null : out.join('\n');
}
const httpsOnly = (u) => (u && !u.startsWith('https://') ? null : u);
const clean = (v, max) => String(v || '').replace(/\s+/g, (m) => (m.includes('\n') ? '\n' : ' ')).trim().slice(0, max);

function validate(f) {
  const r = {
    clone_name: clean(f.get('clone_name'), 120),
    clone_url: cleanUrl(f.get('clone_url')),
    clone_developer: clean(f.get('clone_developer'), 120),
    original_name: clean(f.get('original_name'), 120),
    original_url: cleanUrl(f.get('original_url')),
    original_developer: clean(f.get('original_developer'), 120),
    platform: clean(f.get('platform'), 60),
    notes: String(f.get('notes') || '').trim().slice(0, 2000),
    contact: clean(f.get('contact'), 200),
    clone_released: cleanDate(f.get('clone_released')),
    original_released: cleanDate(f.get('original_released')),
    clone_image: httpsOnly(cleanUrl(f.get('clone_image'))),
    original_image: httpsOnly(cleanUrl(f.get('original_image'))),
    mechanics: cleanMechanics(f.get('mechanics')),
    evidence: cleanLinks(f.get('evidence')),
  };
  // Fill in the platform from the clone's store link when the reporter left it empty.
  if (!r.platform && r.clone_url) r.platform = stores.storeName(stores.parseStoreUrl(r.clone_url)?.store) || '';
  const errors = [];
  if (!r.clone_name) errors.push('Please enter the name of the clone.');
  if (!r.original_name) errors.push('Please enter the name of the original game.');
  if (r.clone_name && r.original_name && r.clone_name.toLowerCase() === r.original_name.toLowerCase() && !r.clone_developer)
    errors.push('The clone and the original have the same name. Add the clone developer so people can tell them apart.');
  if (r.clone_url === null) errors.push('The clone link must be a full web address starting with http:// or https://.');
  if (r.original_url === null) errors.push('The original game link must be a full web address starting with http:// or https://.');
  if (!r.original_url && !r.clone_url) errors.push('Please add at least one link (to the original game or the clone) so reviewers can verify the report.');
  if (r.clone_released === null || r.original_released === null) errors.push('Release dates must look like 2017, 2017-02 or 2017-02-21.');
  if (r.clone_image === null || r.original_image === null) errors.push('Screenshot links must be full web addresses starting with https://.');
  if (r.evidence === null) errors.push('Evidence must be up to 8 web addresses, one per line, each starting with http:// or https://.');
  const linkCount = (r.notes.match(/https?:\/\//g) || []).length;
  if (linkCount > 5) errors.push('Notes can contain at most 5 links.');
  return { r, errors };
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  const a = Buffer.from(hmac(pass)), b = Buffer.from(hmac(ADMIN_PASSWORD));
  return crypto.timingSafeEqual(a, b);
}
// One vote per visitor per report, keyed on a salted hash of the IP address.
const voterId = (req) => hmac('voter:' + clientIp(req));
const sameOrigin = (req) => {
  const o = req.headers.origin;
  if (!o) return true; // older browsers / curl; Basic auth still required
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};

const baseUrl = (req) => PUBLIC_URL || `${TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;

// ---------- email alerts ----------
const gameKey = (name) => clean(name, 120);
async function sendAlerts(r, base) {
  for (const f of store.followersOf(r.original_name)) {
    await mailer.send({
      to: f.email,
      subject: `New clone of ${r.original_name} reported: ${r.clone_name}`,
      text: `${r.clone_name}${r.clone_developer ? ` by ${r.clone_developer}` : ''} was reported as a clone of ${r.original_name} on Clone Report.\n\n`
        + `See the comparison and vote: ${base}/report/${r.id}\n\n`
        + `You get this email because you follow ${f.game}. Stop these emails: ${base}/follow/unsubscribe?t=${f.token}\n`,
    }).catch((err) => console.error('alert email failed:', err.message));
  }
}

// ---------- JSON API (used by the browser extension) ----------
// Query: ?appid=<steam app id> (Steam), or ?store=<key>&id=<store id> for any
// store in stores.js (playstation, xbox, nintendo, appstore, googleplay, itch),
// plus an optional &name= fallback.
function apiLookup(req, res, url) {
  const appidRaw = url.searchParams.get('appid');
  let appid = /^\d{1,10}$/.test(appidRaw || '') ? Number(appidRaw) : null;
  let key = appid ? { store: 'steam', id: String(appid) } : null;
  const storeParam = url.searchParams.get('store');
  if (!key && stores.isStore(storeParam)) {
    const id = stores.normalizeId(storeParam, url.searchParams.get('id'));
    if (id) key = { store: storeParam, id };
    if (key?.store === 'steam') appid = Number(id);
  }
  const name = clean(url.searchParams.get('name'), 120);
  const base = baseUrl(req);
  const { asClone, asOriginal } = (key || name) ? store.lookup(key, name) : { asClone: [], asOriginal: [] };
  const steamUrl = (id) => (id ? `https://store.steampowered.com/app/${id}` : null);
  const summary = (r) => (r.notes ? (r.notes.length > 160 ? r.notes.slice(0, 157).trimEnd() + '…' : r.notes) : null);
  const entry = (r, side) => ({
    name: r[side + '_name'],
    appid: r[side + '_steam_appid'] ?? null,
    steamUrl: steamUrl(r[side + '_steam_appid']),
    url: r[side + '_url'] || null,
    store: r[side + '_store'] || null,
    storeName: stores.storeName(r[side + '_store']),
    storeId: r[side + '_store_id'] || null,
    developer: r[side + '_developer'] || null,
    reportUrl: `${base}/report/${r.id}`,
    summary: summary(r),
  });
  const cloneOf = asClone.map((r) => entry(r, 'original'));
  const clonedBy = asOriginal.map((r) => entry(r, 'clone'));
  const hitOf = (r, side) => ({
    name: r[side + '_name'], appid: r[side + '_steam_appid'] ?? appid,
    store: r[side + '_store'] || key?.store || null, storeId: r[side + '_store_id'] || key?.id || null,
  });
  const hit = asClone[0] ? hitOf(asClone[0], 'clone') : asOriginal[0] ? hitOf(asOriginal[0], 'original') : null;
  const body = hit ? { found: true, game: hit, cloneOf, clonedBy } : { found: false, cloneOf: [], clonedBy: [] };
  // Extra field: the game is on the site's list of verified originals (not clones).
  const orig = (key || name) ? store.findOriginal(appid, name) : null;
  body.verifiedOriginal = orig ? {
    name: orig.name, developer: orig.developer || null, appid: orig.steam_appid ?? null,
    steamUrl: steamUrl(orig.steam_appid), eshopUrl: orig.eshop_url || null, pageUrl: `${base}/game/${orig.id}`,
  } : null;
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

// ---------- contact and takedown requests ----------
const KIND_KEYS = REQUEST_KINDS.map(([k]) => k);
// "12", "#12" or a link to /report/12 -> 12
const reportIdFrom = (v) => { const m = /(?:^#?|\/report\/)(\d{1,9})(?:[/?#]|$)/.exec(String(v || '').trim()); return m ? Number(m[1]) : null; };

async function contactRoute(req, res, url) {
  if (req.method === 'GET') {
    const values = {};
    if (KIND_KEYS.includes(url.searchParams.get('kind'))) values.kind = url.searchParams.get('kind');
    const rid = reportIdFrom(url.searchParams.get('report'));
    const r = rid && store.get(rid);
    const report = r && r.status === 'approved' ? r : null;
    if (report) { values.report = `${baseUrl(req)}/report/${report.id}`; values.kind ??= 'removal'; }
    return send(res, 200, contactPage({ token: makeFormToken('contact'), values, report }));
  }
  if (req.method !== 'POST') return send(res, 404, notFound());
  let f;
  try { f = await readBody(req); } catch { return send(res, 413, layout('Too large', '<p>That message is too large.</p>')); }
  if (f.get('website')) return redirect(res, '/contact/thanks');
  const values = Object.fromEntries(f);
  const again = (status, errors, report = null) => send(res, status, contactPage({ token: makeFormToken('contact'), values, errors, report }));
  const tokErr = checkFormToken(f.get('token'), 'contact');
  if (tokErr) return again(400, [tokErr === 'too-fast' ? 'That was very quick! Please check your request and send it again.' : 'The form expired. Please send it again.']);
  const ipHash = hmac('ip:' + clientIp(req));
  if (store.rateCheck(ipHash, 3600 * 1000) >= MAX_PER_HOUR) return again(429, ['You have sent several messages recently. Please try again in an hour.']);
  const q = {
    kind: KIND_KEYS.includes(f.get('kind')) ? f.get('kind') : '',
    report_id: null,
    name: clean(f.get('name'), 120),
    organization: clean(f.get('organization'), 120),
    email: clean(f.get('email'), 200),
    message: String(f.get('message') || '').trim().slice(0, 5000),
    links: cleanLinks(f.get('links'), 5),
    sworn: f.get('sworn') === 'yes',
  };
  const errors = [];
  const reportText = clean(f.get('report'), 200);
  let report = null;
  if (reportText) {
    const rid = reportIdFrom(reportText);
    report = rid ? store.get(rid) : null;
    if (!report) errors.push('We could not find that report. Paste the link from the report page, or leave the field empty.');
    else q.report_id = report.id;
  }
  if (!q.kind) errors.push('Please choose what your request is about.');
  if (!q.name) errors.push('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.email)) errors.push('Please enter an email address so a moderator can reply.');
  if (q.message.length < 20) errors.push('Please describe your request (at least 20 characters).');
  if (q.links === null) errors.push('Links must be up to 5 web addresses, one per line.');
  if (!q.sworn) errors.push('Please confirm that your request is accurate and made in good faith.');
  if (errors.length) return again(400, errors, report?.status === 'approved' ? report : null);
  store.logSubmission(ipHash);
  const id = store.createRequest(q, ipHash);
  if (ADMIN_EMAIL && mailer.enabled) {
    const base = baseUrl(req);
    mailer.send({ to: ADMIN_EMAIL, subject: `Clone Report request #${id}: ${q.kind}${report ? ` (${report.clone_name})` : ''}`,
      text: `${q.name}${q.organization ? ` (${q.organization})` : ''} <${q.email}> sent a ${q.kind} request.\n\n`
        + (report ? `Report: ${base}/report/${report.id}\n\n` : '') + `${q.message}\n\n${q.links ? `Links:\n${q.links}\n\n` : ''}`
        + `Review it: ${base}/admin/requests\n` }).catch((err) => console.error('request email failed:', err.message));
  }
  return redirect(res, '/contact/thanks');
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/style.css')
    return send(res, 200, CSS, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  if (req.method === 'GET' && p === '/robots.txt')
    return send(res, 200, 'User-agent: *\nDisallow: /admin\n', { 'Content-Type': 'text/plain' });
  if (req.method === 'GET' && p === '/extension') return send(res, 200, extensionPage(EXT_INFO));
  if (req.method === 'GET' && p === EXT_INFO.zipUrl)
    return send(res, 200, EXT_ZIP, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="clone-report-extension.zip"', 'Cache-Control': 'public, max-age=3600' });
  if (req.method === 'GET' && p === '/extension-screenshot.png')
    return send(res, 200, EXT_SHOT, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
  if (req.method === 'GET' && p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

  if (req.method === 'GET' && p === '/privacy') return send(res, 200, privacyPage());
  if (req.method === 'GET' && p === '/terms') return send(res, 200, termsPage());
  if (p === '/contact') return contactRoute(req, res, url);
  if (req.method === 'GET' && p === '/contact/thanks') return send(res, 200, contactThanksPage());
  if (req.method === 'GET' && p === '/api/lookup') return apiLookup(req, res, url);
  if (api.handleApi(req, res, url, { base: baseUrl(req), ip: clientIp(req) })) return;
  if (req.method === 'GET' && p === '/api') return send(res, 200, apiDocsPage(baseUrl(req)));
  if (req.method === 'GET' && p === '/feed.xml') return api.feed(res, url, baseUrl(req));

  // Follow a game: double opt-in by email, then one email per newly approved clone of it.
  if (p === '/follow') {
    const game = gameKey(url.searchParams.get('game'));
    if (!game) return send(res, 404, notFound());
    if (req.method === 'GET') return send(res, 200, followPage(game, { token: makeFormToken('follow'), emailOn: mailer.enabled }));
    if (req.method === 'POST' && mailer.enabled) {
      let f;
      try { f = await readBody(req, 2000); } catch { return send(res, 413, layout('Too large', '<p>Too large.</p>')); }
      if (f.get('website')) return send(res, 200, followPage(game, { done: 'sent', emailOn: true }));
      const again = (status, error) => send(res, status, followPage(game, { token: makeFormToken('follow'), emailOn: true, error, email: f.get('email') }));
      if (checkFormToken(f.get('token'), 'follow', Math.min(MIN_FILL_MS, 1500))) return again(400, 'The form expired. Please try again.');
      const email = clean(f.get('email'), 200);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return again(400, 'Please enter a valid email address.');
      const ipHash = hmac('ip:' + clientIp(req));
      if (store.rateCheck(ipHash, 3600 * 1000) >= MAX_PER_HOUR) return again(429, 'Too many requests. Please try again in an hour.');
      store.logSubmission(ipHash);
      const row = store.follow(email, game, crypto.randomBytes(24).toString('base64url'));
      if (!row.confirmed) {
        const base = baseUrl(req);
        await mailer.send({ to: email, subject: `Confirm: email alerts for ${game}`,
          text: `Someone (hopefully you) asked Clone Report to email this address when a clone of ${game} is reported.\n\n`
            + `Confirm: ${base}/follow/confirm?t=${row.token}\n\nIf it wasn't you, ignore this email and nothing will be sent.\n` })
          .catch((err) => console.error('confirm email failed:', err.message));
      }
      // Same answer either way, so the form does not reveal who already follows what.
      return send(res, 200, followPage(game, { done: 'sent', emailOn: true }));
    }
  }
  if (req.method === 'GET' && (p === '/follow/confirm' || p === '/follow/unsubscribe')) {
    const t = String(url.searchParams.get('t') || '').slice(0, 64);
    const row = t && store.followByToken(t);
    if (!row) return send(res, 404, layout('Link expired', '<h1>This link no longer works</h1><p>You may have already unsubscribed.</p>'));
    if (p === '/follow/confirm') { store.confirmFollow(t); return send(res, 200, followPage(row.game, { done: 'confirmed', emailOn: true }), { 'Cache-Control': 'no-store' }); }
    store.unfollow(t);
    return send(res, 200, followPage(row.game, { done: 'unsubscribed', emailOn: true }), { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'GET' && p === '/') return send(res, 200, home(store.recent(12), store.counts().approved, store.countOriginals()));
  if (req.method === 'GET' && p === '/originals') {
    const s = url.searchParams.get('store');
    const storeFilter = ['steam', 'nintendo', 'classic'].includes(s) ? s : '';
    const per = 100;
    const page = Math.max(1, Math.min(10_000, Number.parseInt(url.searchParams.get('page'), 10) || 1));
    const { rows, total } = store.pageOriginals(storeFilter, per, (page - 1) * per);
    return send(res, 200, originalsPage(rows, { storeFilter, page, pages: Math.max(1, Math.ceil(total / per)), total }));
  }

  if (req.method === 'GET' && p === '/search') {
    // A pasted store link (Steam, PlayStation, Xbox, eShop, App Store, Google Play, itch.io) finds reports about that page.
    const link = stores.parseStoreUrl(url.searchParams.get('q'));
    if (link) {
      const q = clean(url.searchParams.get('q'), 500);
      return send(res, 200, searchPage(q, store.byStoreId(link.store, link.id), [], { storeName: stores.storeName(link.store) }));
    }
    const q = clean(url.searchParams.get('q'), 120);
    return send(res, 200, searchPage(q, q ? store.search(q) : [], q ? store.searchOriginals(q) : []));
  }

  let m;
  if (req.method === 'GET' && (m = p.match(/^\/report\/(\d+)$/))) {
    const r = store.get(Number(m[1]));
    if (!r || (r.status !== 'approved' && !isAdmin(req))) return send(res, 404, notFound());
    const voted = url.searchParams.get('voted');
    return send(res, 200, reportPage(r, {
      responses: store.disputesFor(r.id, 'published'),
      myVote: store.myVote(r.id, voterId(req)), voteToken: makeFormToken('vote:' + r.id),
      voteMsg: voted === 'ok' ? 'Thanks, your vote counts.' : voted === 'limit' ? 'You have voted a lot in the last hour. Please try again later.'
        : voted === 'expired' ? 'The page was open too long. Please vote again.' : '',
    }), { 'Cache-Control': 'no-store' });
  }

  if (req.method === 'GET' && (m = p.match(/^\/report\/(\d+)\/history$/))) {
    const r = store.get(Number(m[1]));
    if (!r || (r.status !== 'approved' && !isAdmin(req))) return send(res, 404, notFound());
    return send(res, 200, historyPage(r, store.history(r.id)));
  }

  if ((m = p.match(/^\/report\/(\d+)\/dispute$/))) {
    const r = store.get(Number(m[1]));
    if (!r || r.status !== 'approved') return send(res, 404, notFound());
    if (req.method === 'GET') return send(res, 200, disputePage(r, { token: makeFormToken('dispute'), values: {} }));
    if (req.method === 'POST') {
      let f;
      try { f = await readBody(req); } catch { return send(res, 413, layout('Too large', '<p>That message is too large.</p>')); }
      if (f.get('website')) return redirect(res, `/report/${r.id}/dispute/thanks`);
      const values = Object.fromEntries(f);
      const again = (status, errors) => send(res, status, disputePage(r, { token: makeFormToken('dispute'), values, errors }));
      const tokErr = checkFormToken(f.get('token'), 'dispute');
      if (tokErr) return again(400, [tokErr === 'too-fast' ? 'That was very quick! Please check your message and send it again.' : 'The form expired. Please send it again.']);
      const ipHash = hmac('ip:' + clientIp(req));
      if (store.rateCheck(ipHash, 3600 * 1000) >= MAX_PER_HOUR) return again(429, ['You have sent several messages recently. Please try again in an hour.']);
      const d = {
        name: clean(f.get('name'), 120),
        role: ['clone-developer', 'original-developer', 'other'].includes(f.get('role')) ? f.get('role') : '',
        contact: clean(f.get('contact'), 200),
        message: String(f.get('message') || '').trim().slice(0, 4000),
        links: cleanLinks(f.get('links'), 5),
      };
      const errors = [];
      if (!d.name) errors.push('Please enter your name or studio.');
      if (!d.role) errors.push('Please say how you are connected to this report.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.contact)) errors.push('Please enter an email address so a moderator can reply.');
      if (d.message.length < 20) errors.push('Please explain why the report is wrong (at least 20 characters).');
      if (d.links === null) errors.push('Links must be up to 5 web addresses, one per line.');
      if (errors.length) return again(400, errors);
      store.logSubmission(ipHash);
      store.createDispute(r.id, d, ipHash);
      return redirect(res, `/report/${r.id}/dispute/thanks`);
    }
  }
  if (req.method === 'GET' && (m = p.match(/^\/report\/(\d+)\/dispute\/thanks$/))) return send(res, 200, disputeThanksPage(Number(m[1])));

  if (req.method === 'POST' && (m = p.match(/^\/report\/(\d+)\/vote$/))) {
    const r = store.get(Number(m[1]));
    if (!r || r.status !== 'approved') return send(res, 404, notFound());
    if (!sameOrigin(req)) return send(res, 403, layout('Forbidden', '<p>Bad origin.</p>'));
    let f;
    try { f = await readBody(req, 2000); } catch { return send(res, 413, layout('Too large', '<p>Too large.</p>')); }
    const back = (v) => redirect(res, `/report/${r.id}?voted=${v}#vote`);
    const choice = f.get('choice');
    if (!['clone', 'inspired', 'original'].includes(choice)) return back('expired');
    if (checkFormToken(f.get('token'), 'vote:' + r.id, 0, 24 * 3600 * 1000)) return back('expired');
    const voter = voterId(req);
    if (store.votesByVoter(voter, 3600 * 1000) >= MAX_VOTES_PER_HOUR) return back('limit');
    store.vote(r.id, voter, choice);
    return back('ok');
  }

  if (req.method === 'GET' && (m = p.match(/^\/dev\/([a-z0-9-]{1,80})$/))) {
    const d = store.developer(m[1]);
    const any = d.cloned[0] || d.wasCloned[0];
    const name = d.cloned[0]?.clone_developer || d.wasCloned[0]?.original_developer || d.originals[0]?.developer;
    if (!any && !d.originals.length) return send(res, 404, notFound());
    return send(res, 200, developerPage(m[1], name, d));
  }
  if (req.method === 'GET' && p === '/developers') return send(res, 200, developersPage(store.topDevelopers(50)));
  if (req.method === 'GET' && p === '/tree') {
    const q = clean(url.searchParams.get('game'), 120);
    return send(res, 200, treePage(q, q ? familyTree(store.approvedEdges(), q) : null));
  }

  if (req.method === 'GET' && (m = p.match(/^\/game\/(\d+)$/))) {
    const g = store.getOriginal(Number(m[1]));
    if (!g) return send(res, 404, notFound());
    return send(res, 200, gamePage(g, store.reportsAbout(g)));
  }

  if (p === '/submit') {
    if (req.method === 'GET') {
      const prefill = new URLSearchParams();
      for (const k of ['clone_name', 'original_name']) if (url.searchParams.get(k)) prefill.set(k, url.searchParams.get(k));
      return send(res, 200, submitPage({ token: makeFormToken(), values: Object.fromEntries(prefill) }));
    }
    if (req.method === 'POST') {
      let f;
      try { f = await readBody(req); } catch { return send(res, 413, layout('Too large', '<p>That submission is too large.</p>')); }
      const ipHash = hmac('ip:' + clientIp(req));

      // Honeypot: real visitors never see or fill the "website" field.
      if (f.get('website')) return redirect(res, '/submit/thanks');

      const values = Object.fromEntries(f);
      const tokErr = checkFormToken(f.get('token'));
      if (tokErr) {
        const msg = tokErr === 'too-fast' ? 'That was very quick! Please check your report and submit again.' : 'The form expired. Please submit again.';
        return send(res, 400, submitPage({ token: makeFormToken(), values, errors: [msg] }));
      }
      if (store.rateCheck(ipHash, 3600 * 1000) >= MAX_PER_HOUR)
        return send(res, 429, submitPage({ token: makeFormToken(), values, errors: ['You have sent several reports recently. Please try again in an hour.'] }));

      const { r, errors } = validate(f);
      if (f.get('agree') !== 'yes') errors.push('Please confirm that your report is truthful and that you agree to the Terms of Service.');
      if (errors.length) return send(res, 400, submitPage({ token: makeFormToken(), values, errors }));

      store.logSubmission(ipHash);
      store.setTermsAccepted(store.createReport(r, ipHash), TERMS_VERSION);
      return redirect(res, '/submit/thanks');
    }
  }
  if (req.method === 'GET' && p === '/submit/thanks') return send(res, 200, thanksPage());

  if (p === '/admin' || p.startsWith('/admin/')) {
    if (!isAdmin(req))
      return send(res, 401, layout('Admin', '<p>Sign in required.</p>'), { 'WWW-Authenticate': 'Basic realm="clonereport admin", charset="UTF-8"' });
    if (req.method === 'GET' && p === '/admin') {
      const status = ['pending', 'approved', 'rejected'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
      return send(res, 200, adminPage(status, store.byStatus(status), store.counts(), store.disputeCounts().open, store.requestCounts().open), { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && p === '/admin/originals') {
      const q = clean(url.searchParams.get('q'), 120);
      const rows = q ? store.searchOriginals(q) : store.pageOriginals('', 50, 0).rows;
      return send(res, 200, adminOriginalsPage(q, rows, store.countOriginals(), scanner.state, classic.state), { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && p === '/admin/disputes') {
      const status = ['open', 'published', 'dismissed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
      return send(res, 200, adminDisputesPage(status, store.disputesByStatus(status), store.disputeCounts()), { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/admin\/disputes\/(\d+)\/(publish|dismiss|reopen)$/))) {
      if (!sameOrigin(req)) return send(res, 403, layout('Forbidden', '<p>Bad origin.</p>'));
      store.setDisputeStatus(Number(m[1]), { publish: 'published', dismiss: 'dismissed', reopen: 'open' }[m[2]]);
      return redirect(res, '/admin/disputes?status=' + encodeURIComponent(url.searchParams.get('back') || 'open'));
    }
    if (req.method === 'GET' && p === '/admin/requests') {
      const status = url.searchParams.get('status') === 'done' ? 'done' : 'open';
      return send(res, 200, adminRequestsPage(status, store.requestsByStatus(status), store.requestCounts()), { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/admin\/requests\/(\d+)\/(done|reopen)$/))) {
      if (!sameOrigin(req)) return send(res, 403, layout('Forbidden', '<p>Bad origin.</p>'));
      store.setRequestStatus(Number(m[1]), m[2] === 'done' ? 'done' : 'open');
      return redirect(res, '/admin/requests?status=' + (url.searchParams.get('back') === 'done' ? 'done' : 'open'));
    }
    if (req.method === 'POST' && (m = p.match(/^\/admin\/originals\/(\d+)\/remove$/))) {
      if (!sameOrigin(req)) return send(res, 403, layout('Forbidden', '<p>Bad origin.</p>'));
      store.excludeOriginal(Number(m[1]), 'removed by admin');
      return redirect(res, '/admin/originals?q=' + encodeURIComponent(url.searchParams.get('q') || ''));
    }
    if ((m = p.match(/^\/admin\/(\d+)\/edit$/))) {
      const r = store.get(Number(m[1]));
      if (!r) return send(res, 404, notFound());
      if (req.method === 'GET') return send(res, 200, adminEditPage(r, { values: r }), { 'Cache-Control': 'no-store' });
      if (req.method === 'POST') {
        if (!sameOrigin(req)) return send(res, 403, layout('Forbidden', '<p>Bad origin.</p>'));
        let f;
        try { f = await readBody(req); } catch { return send(res, 413, layout('Too large', '<p>Too large.</p>')); }
        const { r: v, errors } = validate(f);
        if (errors.length) return send(res, 400, adminEditPage(r, { values: Object.fromEntries(f), errors }), { 'Cache-Control': 'no-store' });
        store.updateReport(r.id, v);
        return redirect(res, `/report/${r.id}`);
      }
    }
    if (req.method === 'POST' && (m = p.match(/^\/admin\/(\d+)\/(approve|reject|delete)$/))) {
      if (!sameOrigin(req)) return send(res, 403, layout('Forbidden', '<p>Bad origin.</p>'));
      const id = Number(m[1]);
      const back = url.searchParams.get('back') || 'pending';
      const wasPending = store.get(id)?.status === 'pending';
      if (m[2] === 'delete') store.remove(id);
      else store.setStatus(id, m[2] === 'approve' ? 'approved' : 'rejected');
      // A game confirmed as a clone comes off the originals list for good.
      if (m[2] === 'approve') {
        const r = store.get(id);
        // Match by Steam id, or by name unless the clone shares the original's name.
        const sameName = r && r.clone_name.toLowerCase() === r.original_name.toLowerCase();
        const g = r && (store.findOriginal(r.clone_steam_appid, '') || (!sameName && store.findOriginal(null, r.clone_name)));
        if (g) store.excludeOriginal(g.id, `approved clone report #${id}`);
        // Fill missing release dates, images and developers from Steam in the background.
        if (r && STEAM_ENRICH) steam.comparisonFor(r).then((d) => store.fillComparison(id, d)).catch(() => {});
        // Email people who follow the original game (only on the first approval).
        if (r && wasPending && mailer.enabled) sendAlerts(r, baseUrl(req)).catch(() => {});
      }
      return redirect(res, '/admin?status=' + encodeURIComponent(back));
    }
  }

  return send(res, 404, notFound());
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, layout('Error', '<p>Something went wrong. Please try again.</p>'));
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`clonereport listening on http://localhost:${PORT}`));
  // Daily scans (classic consoles, then Steam) that grow the originals list. Set STEAM_SCAN=0 to turn both off.
  if (process.env.STEAM_SCAN !== '0') scanner.startSchedule();
}
module.exports = { server, esc };
