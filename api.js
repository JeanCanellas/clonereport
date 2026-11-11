'use strict';
// Public JSON API (v1) and RSS feeds. Read-only, CORS open, rate limited per IP.
const store = require('./db');
const { tally, verdict } = require('./scoring');
const { familyTree } = require('./tree');

const PER_MINUTE = Number(process.env.API_PER_MINUTE ?? 120);
const hits = new Map(); // ip -> { start, n }
function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > 60_000) {
    if (hits.size > 50_000) hits.clear(); // keep memory bounded
    hits.set(ip, { start: now, n: 1 });
    return false;
  }
  return ++h.n > PER_MINUTE;
}

const steamUrl = (id) => (id ? `https://store.steampowered.com/app/${id}` : null);
const lines = (s) => String(s || '').split('\n').filter(Boolean);
const ROLES = { 'clone-developer': 'clone developer', 'original-developer': 'original developer', other: 'other' };

function reportJson(r, base, { full = false } = {}) {
  const t = tally(r);
  const side = (k) => ({
    name: r[k + '_name'], developer: r[k + '_developer'] || null, url: r[k + '_url'] || null,
    steamAppid: r[k + '_steam_appid'] ?? null, steamUrl: steamUrl(r[k + '_steam_appid']),
    released: r[k + '_released'] || null, image: r[k + '_image'] || null,
  });
  const out = {
    id: r.id, url: `${base}/report/${r.id}`,
    clone: side('clone'), original: side('original'),
    platform: r.platform || null, mechanics: lines(r.mechanics), evidence: lines(r.evidence),
    votes: { clone: t.clone, inspired: t.inspired, original: t.original, total: t.total },
    cloneScore: t.score, verdict: verdict(t),
    reportedAt: r.created_at, approvedAt: r.reviewed_at || null,
  };
  if (full) {
    out.notes = r.notes || null;
    out.developerResponses = store.disputesFor(r.id, 'published').map((d) => ({ name: d.name, role: ROLES[d.role] || d.role, message: d.message, links: lines(d.links), date: d.created_at }));
    out.historyUrl = `${base}/report/${r.id}/history`;
  }
  return out;
}

function json(res, status, body, maxAge = 300) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': status === 200 ? `public, max-age=${maxAge}` : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

const int = (v, def, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const text = (v, max = 120) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

// Returns true when it handled the request.
function handleApi(req, res, url, { base, ip }) {
  const p = url.pathname;
  if (!p.startsWith('/api/v1/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' });
    res.end();
    return true;
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Only GET is supported.' }), true;
  if (limited(ip)) return json(res, 429, { error: `Rate limit: ${PER_MINUTE} requests per minute.` }), true;
  let m;
  if (p === '/api/v1/reports') {
    const limit = int(url.searchParams.get('limit'), 50, 1, 100);
    const offset = int(url.searchParams.get('offset'), 0, 0, 1_000_000);
    const rows = store.apiReports({ q: text(url.searchParams.get('q')), dev: text(url.searchParams.get('developer'), 80),
      since: int(url.searchParams.get('since_id'), 0, 0, Number.MAX_SAFE_INTEGER), limit, offset });
    return json(res, 200, { reports: rows.map((r) => reportJson(r, base)), limit, offset }), true;
  }
  if ((m = p.match(/^\/api\/v1\/reports\/(\d+)$/))) {
    const r = store.get(Number(m[1]));
    if (!r || r.status !== 'approved') return json(res, 404, { error: 'Report not found.' }), true;
    return json(res, 200, reportJson(r, base, { full: true })), true;
  }
  if (p === '/api/v1/games') {
    // Clone status of one game, by Steam app id and/or name.
    const appidRaw = url.searchParams.get('appid');
    const appid = /^\d{1,10}$/.test(appidRaw || '') ? Number(appidRaw) : null;
    const name = text(url.searchParams.get('name'));
    if (!appid && !name) return json(res, 400, { error: 'Pass appid or name.' }), true;
    const { asClone, asOriginal } = store.lookup(appid, name);
    const orig = store.findOriginal(appid, name);
    const scores = asClone.map((r) => tally(r)).filter((t) => t.total);
    return json(res, 200, {
      query: { appid, name: name || null },
      status: asClone.length ? 'reported-clone' : orig ? 'verified-original' : asOriginal.length ? 'cloned-by-others' : 'unknown',
      verifiedOriginal: orig ? { name: orig.name, developer: orig.developer || null, steamAppid: orig.steam_appid ?? null, url: `${base}/game/${orig.id}` } : null,
      cloneOf: asClone.map((r) => reportJson(r, base)),
      clonedBy: asOriginal.map((r) => reportJson(r, base)),
      // Highest clone score among the reports that call this game a clone.
      cloneScore: scores.length ? Math.max(...scores.map((t) => t.score)) : null,
    }), true;
  }
  if ((m = p.match(/^\/api\/v1\/developers\/([a-z0-9-]{1,80})$/))) {
    const d = store.developer(m[1]);
    const name = d.cloned[0]?.clone_developer || d.wasCloned[0]?.original_developer || d.originals[0]?.developer;
    if (!name) return json(res, 404, { error: 'Developer not found.' }), true;
    return json(res, 200, { key: m[1], name, url: `${base}/dev/${m[1]}`,
      reportedAsCloner: d.cloned.map((r) => reportJson(r, base)), clonedByOthers: d.wasCloned.map((r) => reportJson(r, base)),
      originals: d.originals.map((g) => ({ name: g.name, steamAppid: g.steam_appid ?? null, url: `${base}/game/${g.id}` })) }), true;
  }
  if (p === '/api/v1/tree') {
    const game = text(url.searchParams.get('game'));
    if (!game) return json(res, 400, { error: 'Pass game.' }), true;
    const t = familyTree(store.approvedEdges(), game);
    if (!t) return json(res, 404, { error: 'No approved reports mention this game.' }), true;
    const fix = (nodes) => nodes.map((n) => ({ name: n.name, reportUrl: `${base}/report/${n.report}`, children: fix(n.children) }));
    return json(res, 200, { game: t.name, copies: fix(t.ancestors), copiedBy: fix(t.descendants) }), true;
  }
  return json(res, 404, { error: 'Unknown endpoint. See /api for the docs.' }), true;
}

// ---------- RSS ----------
const xml = (v) => String(v ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const rfc822 = (s) => new Date(String(s).replace(' ', 'T') + 'Z').toUTCString();
function feed(res, url, base) {
  const game = text(url.searchParams.get('game'));
  const dev = /^[a-z0-9-]{1,80}$/.test(url.searchParams.get('dev') || '') ? url.searchParams.get('dev') : '';
  const rows = store.feed({ game, dev });
  const title = game ? `New clone reports for ${game}` : dev ? `New clone reports about ${dev}` : 'New clone reports';
  const self = `${base}/feed.xml${url.search}`;
  const items = rows.map((r) => `<item>
  <title>${xml(`${r.clone_name} reported as a clone of ${r.original_name}`)}</title>
  <link>${xml(`${base}/report/${r.id}`)}</link>
  <guid isPermaLink="true">${xml(`${base}/report/${r.id}`)}</guid>
  <pubDate>${xml(rfc822(r.reviewed_at || r.created_at))}</pubDate>
  <description>${xml([r.clone_developer && `Clone by ${r.clone_developer}.`, r.original_developer && `Original by ${r.original_developer}.`, r.notes].filter(Boolean).join(' ').slice(0, 500))}</description>
</item>`).join('\n');
  res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=600', 'X-Content-Type-Options': 'nosniff' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(title)} · Clone Report</title>
<link>${xml(base)}</link>
<atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>
<description>${xml(title)}, as approved by Clone Report moderators.</description>
${items}
</channel>
</rss>`);
}

module.exports = { handleApi, feed, reportJson };
