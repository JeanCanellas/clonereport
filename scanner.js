'use strict';
// Steam scanner: keeps the "original games" list growing on its own.
//
// It walks SteamSpy's list of Steam games (most-owned first, 1,000 per page) and adds
// games that are very unlikely to be clones: many reviews, mostly positive, not a
// software tool, not on the admin's exclusion list, and not reported as a clone.
// Each Steam app is checked once; later runs only look at games it has not seen.
// SteamSpy asks for at most 1 "all" request per minute and 1 "appdetails" request per second.

const store = require('./db');

const API = 'https://steamspy.com/api.php';
const SOFTWARE_GENRES = ['Utilities', 'Design & Illustration', 'Animation & Modeling', 'Video Production', 'Audio Production',
  'Photo Editing', 'Web Publishing', 'Software Training', 'Education', 'Game Development', 'Accounting'];
const GAME_GENRES = ['Action', 'Adventure', 'RPG', 'Strategy', 'Simulation', 'Casual', 'Sports', 'Racing', 'Massively Multiplayer'];
const NOT_A_GAME = /\b(soundtrack|ost|dedicated server|sdk|demo|playtest|test server|benchmark|artbook|wallpaper)\b/i;

const defaults = {
  target: Number(process.env.STEAM_SCAN_TARGET ?? 5000),       // stop once the list has this many games
  minReviews: Number(process.env.STEAM_SCAN_MIN_REVIEWS ?? 1000),
  minPositive: Number(process.env.STEAM_SCAN_MIN_POSITIVE ?? 80), // percent
  maxPages: Number(process.env.STEAM_SCAN_MAX_PAGES ?? 40),
  pageDelayMs: 61_000,
  detailDelayMs: 1_100,
};

const state = { running: false, lastStart: null, lastEnd: null, lastAdded: 0, lastError: null };

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
  Object.assign(state, { running: true, lastStart: new Date().toISOString(), lastAdded: 0, lastError: null });
  let added = 0;
  try {
    for (let page = 0; page < o.maxPages && store.countOriginals() < o.target; page++) {
      if (page > 0) await wait(o.pageDelayMs);
      const list = await getJson(`${API}?request=all&page=${page}`, fetchImpl);
      const games = Object.values(list || {});
      if (!games.length) break;
      // Most-owned first.
      games.sort((a, b) => parseOwners(b.owners) - parseOwners(a.owners));
      for (const g of games) {
        if (store.countOriginals() >= o.target) break;
        const appid = Number(g.appid);
        if (!Number.isSafeInteger(appid) || appid <= 0 || store.scanSeen(appid)) continue;
        const why = quickReject(g, o);
        if (why) { store.scanMark(appid, 'skipped', why); continue; }
        await wait(o.detailDelayMs);
        let details;
        try { details = await getJson(`${API}?request=appdetails&appid=${appid}`, fetchImpl); }
        catch (err) { log(`scanner: details for ${appid} failed: ${err.message}`); continue; } // retried next run
        if (isSoftware(details)) { store.scanMark(appid, 'skipped', 'software, not a game'); continue; }
        const pos = Number(g.positive), neg = Number(g.negative);
        const result = store.addScanned({
          appid, name: g.name, developer: g.developer, publisher: g.publisher,
          positive_pct: Math.round((pos * 100) / (pos + neg)), reviews: pos + neg,
        });
        store.scanMark(appid, result === 'added' ? 'added' : 'skipped', result === 'added' ? null : result);
        if (result === 'added') { added++; state.lastAdded = added; }
      }
      log(`scanner: page ${page} done, ${added} added so far, ${store.countOriginals()} games listed`);
    }
  } catch (err) {
    state.lastError = err.message;
    log(`scanner: stopped: ${err.message}`);
  } finally {
    Object.assign(state, { running: false, lastEnd: new Date().toISOString(), lastAdded: added });
  }
  return { added, total: store.countOriginals() };
}

// "20,000,000 .. 50,000,000" -> 20000000
function parseOwners(s) {
  return Number(String(s || '').split('..')[0].replace(/[^\d]/g, '')) || 0;
}

// Run shortly after start, then once a day.
function startSchedule({ firstDelayMs = 60_000, everyMs = 24 * 3600 * 1000 } = {}) {
  const run = () => scanSteam().catch((err) => console.error('scanner:', err));
  setTimeout(run, firstDelayMs).unref();
  setInterval(run, everyMs).unref();
}

module.exports = { scanSteam, startSchedule, state, quickReject, isSoftware, parseOwners };

if (require.main === module) {
  // npm run scan: one pass now, printing progress.
  scanSteam().then((r) => console.log('scanner finished:', r));
}
