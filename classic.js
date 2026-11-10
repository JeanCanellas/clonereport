'use strict';
// Classic console scanner: adds well-known games from older consoles to the originals list.
//
// Source: Wikidata (the structured data behind Wikipedia), via its public SPARQL endpoint.
// For each console it asks for video games that
//   - have an English Wikipedia article and articles in several other languages (well known),
//   - are not marked "based on" or "inspired by" another video game (filters out remakes,
//     ports and known copies such as games inspired by Super Mario Bros.).
// Like the Steam scanner it fills the list in stages, most famous games first, and it skips
// games an admin removed or that an approved report says are clones.

const store = require('./db');

const ENDPOINT = 'https://query.wikidata.org/sparql';
// Wikimedia asks automated clients to identify themselves; put a contact URL or email here.
const USER_AGENT = process.env.SCANNER_USER_AGENT || 'original-games-scanner/1.0 (Node.js)';

// English Wikipedia article of each console -> the name shown on the site.
const CONSOLES = [
  ['Atari_2600', 'Atari 2600'],
  ['Nintendo_Entertainment_System', 'NES'],
  ['Master_System', 'Master System'],
  ['Sega_Genesis', 'Sega Genesis'],
  ['TurboGrafx-16', 'TurboGrafx-16'],
  ['Game_Boy', 'Game Boy'],
  ['Super_Nintendo_Entertainment_System', 'SNES'],
  ['Sega_Saturn', 'Sega Saturn'],
  ['PlayStation_(console)', 'PlayStation'],
  ['Nintendo_64', 'Nintendo 64'],
  ['Game_Boy_Color', 'Game Boy Color'],
  ['Dreamcast', 'Dreamcast'],
  ['PlayStation_2', 'PlayStation 2'],
  ['Game_Boy_Advance', 'Game Boy Advance'],
  ['GameCube', 'GameCube'],
  ['Xbox_(console)', 'Xbox'],
  ['Nintendo_DS', 'Nintendo DS'],
  ['PlayStation_Portable', 'PSP'],
  ['Xbox_360', 'Xbox 360'],
  ['Wii', 'Wii'],
  ['PlayStation_3', 'PlayStation 3'],
  ['Nintendo_3DS', 'Nintendo 3DS'],
  ['Wii_U', 'Wii U'],
  ['PlayStation_Vita', 'PS Vita'],
];

// Minimum number of Wikipedia language editions, strictest first.
function parseStages(str) {
  const out = String(str || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return out.length ? out : null;
}

const defaults = {
  target: Number(process.env.STEAM_SCAN_TARGET ?? 25000),
  stages: parseStages(process.env.CLASSIC_SCAN_STAGES) || [20, 10, 5],
  queryDelayMs: 5_000,
};

const state = { running: false, lastStart: null, lastEnd: null, lastAdded: 0, lastError: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function query(article, minLangs) {
  return `SELECT ?game ?gameLabel ?article ?langs
  (GROUP_CONCAT(DISTINCT ?devName; separator=", ") AS ?developers)
  (GROUP_CONCAT(DISTINCT ?pubName; separator=", ") AS ?publishers)
  (MIN(YEAR(?date)) AS ?year)
WHERE {
  <https://en.wikipedia.org/wiki/${article}> schema:about ?console .
  ?game wdt:P31 wd:Q7889 ;
        wdt:P400 ?console ;
        wikibase:sitelinks ?langs .
  FILTER(?langs >= ${Number(minLangs)})
  ?article schema:about ?game ; schema:isPartOf <https://en.wikipedia.org/> .
  FILTER NOT EXISTS { ?game wdt:P144 ?basedOn . ?basedOn wdt:P31 wd:Q7889 . }
  FILTER NOT EXISTS { ?game wdt:P941 ?inspiredBy . ?inspiredBy wdt:P31 wd:Q7889 . }
  OPTIONAL { ?game wdt:P178 ?dev . ?dev rdfs:label ?devName . FILTER(LANG(?devName) = "en") }
  OPTIONAL { ?game wdt:P123 ?pub . ?pub rdfs:label ?pubName . FILTER(LANG(?pubName) = "en") }
  OPTIONAL { ?game wdt:P577 ?date }
  ?game rdfs:label ?gameLabel . FILTER(LANG(?gameLabel) = "en")
}
GROUP BY ?game ?gameLabel ?article ?langs`;
}

// One SPARQL result row -> the fields the store needs.
function toGame(b, platform) {
  const v = (k) => (b[k] ? b[k].value : '');
  const id = (v('game').match(/Q\d+$/) || [])[0];
  const article = v('article');
  return {
    wikidata_id: id || null,
    name: v('gameLabel'),
    developer: v('developers').slice(0, 200) || null,
    publisher: v('publishers').slice(0, 200) || null,
    year: Number(v('year')) || null,
    wiki_url: /^https:\/\/en\.wikipedia\.org\/wiki\//.test(article) ? article : null,
    wiki_langs: Number(v('langs')) || null,
    platform,
  };
}

async function scanClassic(opts = {}) {
  const o = { ...defaults, ...opts };
  const fetchImpl = o.fetch || globalThis.fetch;
  const wait = o.sleep || sleep;
  const log = o.log || console.log;
  if (state.running) return { skipped: 'already running' };
  Object.assign(state, { running: true, lastStart: new Date().toISOString(), lastAdded: 0, lastError: null });
  let added = 0;
  const full = () => store.countOriginals() >= o.target;
  try {
    // Download each console once at the loosest stage, then add in stages, most famous first.
    const loosest = Math.min(...o.stages);
    const games = [];
    for (const [i, [article, platform]] of CONSOLES.entries()) {
      if (i > 0) await wait(o.queryDelayMs);
      try {
        const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query(article, loosest))}`;
        const res = await fetchImpl(url, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = ((await res.json()).results || {}).bindings || [];
        for (const b of rows) games.push(toGame(b, platform));
        log(`classic: ${platform}: ${rows.length} games found`);
      } catch (err) { log(`classic: ${platform} failed: ${err.message}`); } // tried again next run
    }
    games.sort((a, b) => (b.wiki_langs || 0) - (a.wiki_langs || 0));
    for (const min of [...o.stages].sort((a, b) => b - a)) {
      for (const g of games) {
        if (full()) break;
        if (!g.wikidata_id || !g.name || (g.wiki_langs || 0) < min) continue;
        // Wikidata sometimes has no English name and falls back to the id.
        if (/^Q\d+$/.test(g.name)) continue;
        if (store.addClassic(g) === 'added') { added++; state.lastAdded = added; }
      }
      log(`classic: stage ${min}+ languages done, ${added} added so far, ${store.countOriginals()} games listed`);
    }
  } catch (err) {
    state.lastError = err.message;
    log(`classic: stopped: ${err.message}`);
  } finally {
    Object.assign(state, { running: false, lastEnd: new Date().toISOString(), lastAdded: added });
  }
  return { added, total: store.countOriginals() };
}

module.exports = { scanClassic, state, CONSOLES, query, toGame, parseStages };

if (require.main === module) scanClassic().then((r) => console.log('classic scan finished:', r));
