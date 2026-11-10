'use strict';
// Steam scanner: keeps the "original games" list growing on its own.
//
// It walks SteamSpy's list of Steam games (most-owned first, 1,000 per page) and adds
// games that are very unlikely to be clones: many reviews, mostly positive, not a
// software tool, not on the admin's exclusion list, and not reported as a clone.
// It applies its filters in stages, strictest first, until the list reaches the target.
// Each Steam app is checked in detail once; later runs only look at games it has not seen.
// SteamSpy asks for at most 1 "all" request per minute and 1 "appdetails" request per second.

const store = require('./db');

const API = 'https://steamspy.com/api.php';
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
  maxPages: Number(process.env.STEAM_SCAN_MAX_PAGES ?? 150),
  pageDelayMs: 61_000,
  detailDelayMs: 1_100,
};

const state = { running: false, lastStart: null, lastEnd: null, lastAdded: 0, lastError: null, stage: null, page: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'clonereport-scanner/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// Decide from the SteamSpy list entry alone. Returns null when the game passes.
function quickReject(g, o) {
  const pos = Number(g.positive) || 0, neg = Number(g.negative) || 0;
  const reviews = pos + neg;
  if (!g.name || NOT_A_GAME.test(g.name)) return 'not a game';
  if (reviews < o.minReviews) return 'too few reviews';
  if ((pos * 100) / reviews < o.minPositive) return 'reviews not positive enough';
  return null;
}

function isSoftware(details) {
  const genres = String(details.genre || '').split(',').map((s) => s.trim()).filter(Boolean);
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
    try { details = await getJson(`${API}?request=appdetails&appid=${appid}`, fetchImpl); }
    catch (err) { log(`scanner: details for ${appid} failed: ${err.message}`); return; } // retried next run
    if (isSoftware(details)) { store.scanMark(appid, 'skipped', 'software, not a game'); return; }
    const pos = Number(g.positive), neg = Number(g.negative);
    const result = store.addScanned({
      appid, name: g.name, developer: g.developer, publisher: g.publisher,
      positive_pct: Math.round((pos * 100) / (pos + neg)), reviews: pos + neg,
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
      const list = await getJson(`${API}?request=all&page=${page}`, fetchImpl);
      const games = Object.values(list || {}).map(({ appid, name, developer, publisher, positive, negative, owners }) =>
        ({ appid, name, developer, publisher, positive, negative, owners: parseOwners(owners) }));
      if (!games.length) break;
      games.sort((a, b) => b.owners - a.owners); // most-owned first
      cache.push(...games);
      for (const g of games) { if (full()) break; await consider(g, first); }
      log(`scanner: page ${page} done, ${added} added so far, ${store.countOriginals()} games listed`);
    }
    cache.sort((a, b) => b.owners - a.owners);
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

// "20,000,000 .. 50,000,000" -> 20000000
function parseOwners(s) {
  return Number(String(s || '').split('..')[0].replace(/[^\d]/g, '')) || 0;
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

module.exports = { scanSteam, startSchedule, state, quickReject, isSoftware, parseOwners, parseStages };

if (require.main === module) {
  // npm run scan: one pass now, printing progress.
  scanSteam().then((r) => console.log('scanner finished:', r));
}
