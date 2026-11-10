'use strict';
// clonereport.com: a public directory of reported game clones.
// Zero dependencies: Node 22.13+ built-ins only (http, crypto, sqlite).
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');
const scanner = require('./scanner');
const stores = require('./stores');
const extension = require('./extension');
const { layout, home, searchPage, reportPage, gamePage, originalsPage, adminOriginalsPage, submitPage, thanksPage, adminPage, extensionPage, notFound, esc } = require('./views');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MIN_FILL_MS = Number(process.env.MIN_FILL_MS ?? 4000);   // humans take a few seconds to fill the form
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');      // e.g. https://clonereport.com
const MAX_PER_HOUR = Number(process.env.MAX_PER_HOUR ?? 5);    // per IP

if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set: the /admin page is disabled.');

// Load the list of verified original games (seed/originals.json) into the database.
// Idempotent: existing rows are updated, nothing is duplicated. Set SEED_ORIGINALS=0 to skip.
if (process.env.SEED_ORIGINALS !== '0') {
  try {
    const { games } = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'originals.json'), 'utf8'));
    console.log(`Loaded ${store.seedOriginals(games)} original games from seed/originals.json`);
  } catch (err) { console.error('Could not load seed/originals.json:', err.message); }
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
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'",
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
const makeFormToken = () => { const t = Date.now().toString(); return `${t}.${hmac('form:' + t)}`; };
function checkFormToken(tok) {
  const [t, sig] = String(tok || '').split('.');
  if (!t || !sig || sig.length !== 64) return 'expired';
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac('form:' + t)))) return 'expired';
  const age = Date.now() - Number(t);
  if (age < MIN_FILL_MS) return 'too-fast';
  if (age > 2 * 3600 * 1000) return 'expired';
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
const sameOrigin = (req) => {
  const o = req.headers.origin;
  if (!o) return true; // older browsers / curl; Basic auth still required
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};

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
  const base = PUBLIC_URL || `${TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
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

  if (req.method === 'GET' && p === '/api/lookup') return apiLookup(req, res, url);

  if (req.method === 'GET' && p === '/') return send(res, 200, home(store.recent(12), store.counts().approved, store.countOriginals()));
  if (req.method === 'GET' && p === '/originals') {
    const s = url.searchParams.get('store');
    const storeFilter = ['steam', 'nintendo'].includes(s) ? s : '';
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
    return send(res, 200, reportPage(r));
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
      if (errors.length) return send(res, 400, submitPage({ token: makeFormToken(), values, errors }));

      store.logSubmission(ipHash);
      store.createReport(r, ipHash);
      return redirect(res, '/submit/thanks');
    }
  }
  if (req.method === 'GET' && p === '/submit/thanks') return send(res, 200, thanksPage());

  if (p === '/admin' || p.startsWith('/admin/')) {
    if (!isAdmin(req))
      return send(res, 401, layout('Admin', '<p>Sign in required.</p>'), { 'WWW-Authenticate': 'Basic realm="clonereport admin", charset="UTF-8"' });
    if (req.method === 'GET' && p === '/admin') {
      const status = ['pending', 'approved', 'rejected'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
      return send(res, 200, adminPage(status, store.byStatus(status), store.counts()), { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && p === '/admin/originals') {
      const q = clean(url.searchParams.get('q'), 120);
      const rows = q ? store.searchOriginals(q) : store.pageOriginals('', 50, 0).rows;
      return send(res, 200, adminOriginalsPage(q, rows, store.countOriginals(), scanner.state), { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/admin\/originals\/(\d+)\/remove$/))) {
      if (!sameOrigin(req)) return send(res, 403, layout('Forbidden', '<p>Bad origin.</p>'));
      store.excludeOriginal(Number(m[1]), 'removed by admin');
      return redirect(res, '/admin/originals?q=' + encodeURIComponent(url.searchParams.get('q') || ''));
    }
    if (req.method === 'POST' && (m = p.match(/^\/admin\/(\d+)\/(approve|reject|delete)$/))) {
      if (!sameOrigin(req)) return send(res, 403, layout('Forbidden', '<p>Bad origin.</p>'));
      const id = Number(m[1]);
      const back = url.searchParams.get('back') || 'pending';
      if (m[2] === 'delete') store.remove(id);
      else store.setStatus(id, m[2] === 'approve' ? 'approved' : 'rejected');
      // A game confirmed as a clone comes off the originals list for good.
      if (m[2] === 'approve') {
        const r = store.get(id);
        // Match by Steam id, or by name unless the clone shares the original's name.
        const sameName = r && r.clone_name.toLowerCase() === r.original_name.toLowerCase();
        const g = r && (store.findOriginal(r.clone_steam_appid, '') || (!sameName && store.findOriginal(null, r.clone_name)));
        if (g) store.excludeOriginal(g.id, `approved clone report #${id}`);
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
  // Daily Steam scan that grows the originals list. Set STEAM_SCAN=0 to turn it off.
  if (process.env.STEAM_SCAN !== '0') scanner.startSchedule();
}
module.exports = { server, esc };
