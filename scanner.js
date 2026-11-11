'use strict';
// Steam scanner: keeps the "original games" list growing on its own.
//
// It reads Steam's own store search (games only, most relevant first, 100 per page),
// which shows each game's review score, and adds games that are very unlikely to be
// clones: many reviews, mostly positive, a game rather than a software tool, not on the
// admin's exclusion list, and not reported as a clone. Developer and publisher come from
// the game's store details. Filters apply in stages, strictest first, until the list
// reaches the target. Each Steam app is checked in detail once; later runs only look at
// games it has not seen. Requests are spaced out to stay well inside Steam's rate limits.

const store = require('./db');

const STORE = 'https://store.steampowered.com';
const SOFTWARE_GENRES = ['Utilities', 'Design & Illustration', 'Animation & Modeling', 'Video Production', 'Audio Production',
  'Photo Editing', 'Web Publishing', 'Software Training', 'Education', 'Game Development', 'Accounting'];
const GAME_GENRES = ['Action', 'Adventure', 'RPG', 'Strategy', 'Simulation', 'Casual', 'Sports', 'Racing', 'Massively Multiplayer'];
const NOT_A_GAME = /\b(soundtrack|ost|dedicated server|sdk|demo|playtest|test server|benchmark|artbook|wallpaper)\b/i;

// Filter stages, strictest first: the best-known games go in before the scanner relaxes.
// Override with STEAM_SCAN_STAGES="1000:80,300:80,100:75" (min reviews : min % positive).
function parseStages(str) {
  const out = String(str || '').split(',').map((x) => x.split(':').map(Number))
    .filter(([r, p]) => r > 0 && p > 0 && p <= 100).map(([minReviews, minPositive]) => ({ minReviews, minPositive }));
  return out.length ? out : null;
}

const defaults = {
  target: Number(process.env.STEAM_SCAN_TARGET ?? 25000),       // stop once the list has this many games
  stages: parseStages(process.env.STEAM_SCAN_STAGES) || [
    { minReviews: 1000, minPositive: 80 },
    { minReviews: 300, minPositive: 80 },
    { minReviews: 100, minPositive: 75 },
  ],
  maxPages: Number(process.env.STEAM_SCAN_MAX_PAGES ?? 2000), // 100 games per page
  pageDelayMs: 2_000,
  detailDelayMs: 1_600,
  backoffMs: 5 * 60_000,                                        // after Steam says "too many requests"
};

const state = { running: false, lastStart: null, lastEnd: null, lastAdded: 0, lastError: null, stage: null, page: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch JSON; on HTTP 429 wait and try once more.
async function getJson(url, fetchImpl, wait, backoffMs) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; original-games-scanner/1.0)' } });
    if (res.status === 429 && attempt === 0) { await wait(backoffMs); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
    return res.json();
  }
}

const decode = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Turn one page of Steam store search results (its results_html) into
// [{ appid, name, positive_pct, reviews }]. Bundles and packages are left out.
function parseSearchPage(html) {
  const out = [];
  for (const chunk of String(html || '').split('<a href=').slice(1)) {
    const id = /data-ds-appid="(\d+)"/.exec(chunk);
    const title = /<span class="title">([^<]*)<\/span>/.exec(chunk);
    if (!id || !title) continue;
    const review = /(\d+)% of the ([\d,.]+) user reviews/.exec(decode(chunk));
    out.push({
      appid: Number(id[1]),
      name: decode(title[1]).trim(),
      positive_pct: review ? Number(review[1]) : null,
      reviews: review ? Number(review[2].replace(/[,.]/g, '')) : 0,
    });
  }
  return out;
}

// Decide from the search result alone. Returns null when the game passes.
function quickReject(g, o) {
  if (!g.name || NOT_A_GAME.test(g.name)) return 'not a game';
  if ((g.reviews || 0) < o.minReviews) return 'too few reviews';
  if ((g.positive_pct || 0) < o.minPositive) return 'reviews not positive enough';
  return null;
}

// details = the "data" object from the store's appdetails API.
function isSoftware(details) {
  const genres = (details.genres || []).map((x) => x.description);
  return genres.some((x) => SOFTWARE_GENRES.includes(x)) && !genres.some((x) => GAME_GENRES.includes(x));
}

async function scanSteam(opts = {}) {
  const o = { ...defaults, ...opts };
  const fetchImpl = o.fetch || globalThis.fetch;
  const wait = o.sleep || sleep;
  const log = o.log || console.log;
  if (state.running) return { skipped: 'already running' };
  Object.assign(state, { running: true, lastStart: new Date().toISOString(), lastAdded: 0, lastError: null, stage: 1, page: 0 });
  let added = 0;
  const full = () => store.countOriginals() >= o.target;

  // Look at one game under one stage's filters. Review-count rejections are not remembered,
  // because a later stage (or a later day, as reviews grow) may accept the game.
  async function consider(g, filters) {
    const appid = Number(g.appid);
    if (!Number.isSafeInteger(appid) || appid <= 0 || store.scanSeen(appid)) return;
    const why = quickReject(g, filters);
    if (why === 'not a game') { store.scanMark(appid, 'skipped', why); return; }
    if (why) return;
    await wait(o.detailDelayMs);
    let details;
    try {
      const body = await getJson(`${STORE}/api/appdetails?appids=${appid}&cc=us&l=english`, fetchImpl, wait, o.backoffMs);
      details = body && body[appid];
    } catch (err) { log(`scanner: details for ${appid} failed: ${err.message}`); return; } // retried next run
    if (!details || !details.success || !details.data) { store.scanMark(appid, 'skipped', 'no store details'); return; }
    const d = details.data;
    if (d.type && d.type !== 'game') { store.scanMark(appid, 'skipped', `not a game (${d.type})`); return; }
    if (isSoftware(d)) { store.scanMark(appid, 'skipped', 'software, not a game'); return; }
    const list = (x) => (Array.isArray(x) ? x.filter(Boolean).join(', ').slice(0, 200) : null) || null;
    const result = store.addScanned({
      appid, name: g.name, developer: list(d.developers), publisher: list(d.publishers),
      positive_pct: g.positive_pct, reviews: g.reviews,
    });
    store.scanMark(appid, result === 'added' ? 'added' : 'skipped', result === 'added' ? null : result);
    if (result === 'added') { added++; state.lastAdded = added; }
  }

  try {
    // Stage 1 runs while the pages download; the pages are kept (only the fields we need)
    // so the later, looser stages don't have to download everything again.
    const cache = [];
    const [first, ...rest] = o.stages;
    for (let page = 0; page < o.maxPages && !full(); page++) {
      state.page = page;
      if (page > 0) await wait(o.pageDelayMs);
      const url = `${STORE}/search/results/?infinite=1&start=${page * 100}&count=100&category1=998&cc=us&l=english`;
      const body = await getJson(url, fetchImpl, wait, o.backoffMs);
      const games = parseSearchPage(body && body.results_html);
      if (!games.length) break;
      cache.push(...games);
      for (const g of games) { if (full()) break; await consider(g, first); }
      if (page % 10 === 0) log(`scanner: page ${page} done, ${added} added so far, ${store.countOriginals()} games listed`);
    }
    // Later stages: biggest games (most reviews) first.
    cache.sort((a, b) => b.reviews - a.reviews);
    for (const [i, filters] of rest.entries()) {
      if (full()) break;
      state.stage = i + 2; state.page = null;
      for (const g of cache) { if (full()) break; await consider(g, filters); }
      log(`scanner: stage ${i + 2} (${filters.minReviews}+ reviews, ${filters.minPositive}%+) done, ${added} added so far, ${store.countOriginals()} games listed`);
    }
  } catch (err) {
    state.lastError = err.message;
    log(`scanner: stopped: ${err.message}`);
  } finally {
    Object.assign(state, { running: false, lastEnd: new Date().toISOString(), lastAdded: added, stage: null, page: null });
  }
  return { added, total: store.countOriginals() };
}

// Run shortly after start, then once a day: classic consoles first (a few minutes),
// then Steam (hours on the first run, quick afterwards).
function startSchedule({ firstDelayMs = 60_000, everyMs = 24 * 3600 * 1000 } = {}) {
  const { scanClassic } = require('./classic');
  const run = async () => {
    try { if (process.env.CLASSIC_SCAN !== '0') await scanClassic(); } catch (err) { console.error('classic:', err); }
    try { await scanSteam(); } catch (err) { console.error('scanner:', err); }
  };
  setTimeout(run, firstDelayMs).unref();
  setInterval(run, everyMs).unref();
}

module.exports = { scanSteam, startSchedule, state, quickReject, isSoftware, parseSearchPage, parseStages };

if (require.main === module) {
  // npm run scan: one pass now, printing progress.
  scanSteam().then((r) => console.log('scanner finished:', r));
}
