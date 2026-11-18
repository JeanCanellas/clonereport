'use strict';
process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert');
const store = require('../db');
const { scanSteam, quickReject, isSoftware, parseSearchPage } = require('../scanner');

const o = { minReviews: 1000, minPositive: 80 };
// One search result the way Steam's store search renders it.
const item = (appid, name, pct, reviews) => `<a href="https://store.steampowered.com/app/${appid}/x/?snr=1" data-ds-appid="${appid}" data-ds-itemkey="App_${appid}" class="search_result_row">
<div class="search_name ellipsis"><span class="title">${name}</span></div>
<div class="search_reviewscore responsive_secondrow"><span class="search_review_summary positive" data-tooltip-html="Very Positive&lt;br&gt;${pct}% of the ${Number(reviews).toLocaleString('en-US')} user reviews for this game are positive.">
</span></div></a>`;

test('parses Steam search results and filters', () => {
  const html = '<!-- List Items -->' + item(10, 'Tom &amp; Jerry&#39;s', 91, 12345)
    + '<a href="https://store.steampowered.com/bundle/5/" data-ds-bundleid="5" data-ds-appid="1,2"><span class="title">A Bundle</span></a>'
    + '<a href="https://store.steampowered.com/app/11/" data-ds-appid="11"><span class="title">No Reviews Yet</span></a>';
  assert.deepEqual(parseSearchPage(html), [
    { appid: 10, name: "Tom & Jerry's", positive_pct: 91, reviews: 12345 },
    { appid: 11, name: 'No Reviews Yet', positive_pct: null, reviews: 0 },
  ]);
  assert.equal(quickReject({ name: 'Great Game', positive_pct: 90, reviews: 10000 }, o), null);
  assert.equal(quickReject({ name: 'Small Game', positive_pct: 99, reviews: 500 }, o), 'too few reviews');
  assert.equal(quickReject({ name: 'Mixed Game', positive_pct: 60, reviews: 10000 }, o), 'reviews not positive enough');
  assert.equal(quickReject({ name: 'Great Game Soundtrack', positive_pct: 99, reviews: 9000 }, o), 'not a game');
  assert.equal(isSoftware({ genres: [{ description: 'Utilities' }, { description: 'Design & Illustration' }] }), true);
  assert.equal(isSoftware({ genres: [{ description: 'Action' }, { description: 'Indie' }] }), false);
  assert.equal(isSoftware({ genres: [{ description: 'Simulation' }, { description: 'Utilities' }] }), false);
});

test('scan adds good games, skips the rest, and never re-adds removed ones', async () => {
  // An approved report says app 5 is a clone.
  const rid = store.createReport({ clone_name: 'Copycat', clone_url: 'https://store.steampowered.com/app/5/', original_name: 'Real', original_url: 'https://example.com' }, 'x');
  store.setStatus(rid, 'approved');

  const pages = [
    item(1, 'Big Original', 96, 52000) + item(2, 'Paint Tool', 99, 20100) + item(3, 'Tiny Game', 98, 51)
      + item(4, 'Disliked Game', 50, 6000) + item(5, 'Copycat', 99, 9100) + item(6, 'Second Original', 95, 8400)
      + item(7, 'Smaller Original', 90, 500) + item(8, 'A Video', 99, 5000),
    '',
  ];
  const data = (o) => ({ success: true, data: { type: 'game', developers: ['Dev'], publishers: ['Pub'], genres: [{ description: 'Action' }], ...o } });
  const details = { 1: data(), 2: data({ genres: [{ description: 'Utilities' }] }), 5: data(), 6: data({ developers: ['A', 'B'] }), 7: data(), 8: data({ type: 'video' }) };
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.startsWith('/search/')) {
      const page = Number(u.searchParams.get('start')) / 100;
      return { ok: true, status: 200, json: async () => ({ success: 1, results_html: pages[page] || '' }) };
    }
    const id = u.searchParams.get('appids');
    return { ok: true, status: 200, json: async () => ({ [id]: details[id] || { success: false } }) };
  };
  const opts = { fetch, sleep: async () => {}, log: () => {}, target: 100, stages: [{ minReviews: 1000, minPositive: 80 }] };

  let r = await scanSteam(opts);
  assert.equal(r.added, 2);
  const g1 = store.findOriginal(1, '');
  assert.equal(g1.name, 'Big Original');
  assert.equal(g1.source, 'steam-scan');
  assert.equal(g1.positive_pct, 96);
  assert.equal(g1.reviews, 52000);
  assert.equal(g1.developer, 'Dev');
  assert.equal(store.findOriginal(6, '').developer, 'A, B');
  for (const id of [2, 3, 4, 5, 8]) assert.equal(store.findOriginal(id, ''), null, `app ${id} skipped`);

  // Admin removes one; a second run checks nothing new in detail and adds nothing back.
  store.excludeOriginal(g1.id, 'test');
  calls.length = 0;
  r = await scanSteam(opts);
  assert.equal(r.added, 0);
  assert.equal(store.findOriginal(1, ''), null);
  assert.ok(calls.every((u) => u.includes('/search/')), 'already-seen apps are not fetched again');

  // The hand-checked seed list also respects the exclusion.
  store.seedOriginals([{ name: 'Big Original', steam_appid: 1 }]);
  assert.equal(store.findOriginal(1, ''), null);

  // A looser second stage picks up the smaller game the first stage passed over.
  assert.equal(store.findOriginal(7, ''), null);
  r = await scanSteam({ ...opts, stages: [{ minReviews: 1000, minPositive: 80 }, { minReviews: 300, minPositive: 80 }] });
  assert.equal(r.added, 1);
  assert.equal(store.findOriginal(7, '').name, 'Smaller Original');

  // Stops at the target.
  r = await scanSteam({ ...opts, target: store.countOriginals() });
  assert.equal(r.added, 0);
});

test('scan backs off once when Steam says too many requests, and reports errors', async () => {
  let n = 0;
  const waits = [];
  const fetch = async () => (++n === 1 ? { ok: false, status: 429 } : { ok: false, status: 403 });
  const { state } = require('../scanner');
  const r = await scanSteam({ fetch, sleep: async (ms) => waits.push(ms), log: () => {}, target: 100000, backoffMs: 123 });
  assert.equal(r.added, 0);
  assert.ok(waits.includes(123));
  assert.match(state.lastError, /HTTP 403/);
});

test('classic console scan: adds famous games, merges consoles, respects exclusions', async () => {
  const { scanClassic, CONSOLES, toGame } = require('../classic');
  const row = (q, name, langs, extra = {}) => ({
    game: { value: 'http://www.wikidata.org/entity/' + q }, gameLabel: { value: name }, langs: { value: String(langs) },
    article: { value: 'https://en.wikipedia.org/wiki/' + name.replace(/ /g, '_') }, developers: { value: 'Dev' }, publishers: { value: 'Pub' },
    year: { value: '1991' }, ...extra,
  });
  const byConsole = {
    Sega_Genesis: [row('Q901', 'Sonic Test', 60), row('Q903', 'Q903', 30)],
    Master_System: [row('Q901', 'Sonic Test', 60), row('Q902', 'Lesser Known', 6)],
  };
  const fetch = async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('query'));
    const article = q.match(/en\.wikipedia\.org\/wiki\/([^>]+)>/)[1];
    return { ok: true, json: async () => ({ results: { bindings: byConsole[article] || [] } }) };
  };
  const opts = { fetch, sleep: async () => {}, log: () => {}, target: 1000, stages: [20, 5] };
  assert.equal(CONSOLES.length, 24);
  assert.equal(toGame(row('Q1', 'A', 9), 'SNES').wiki_url, 'https://en.wikipedia.org/wiki/A');

  let r = await scanClassic(opts);
  assert.equal(r.added, 2);
  const sonic = store.findOriginal(null, 'Sonic Test');
  assert.equal(sonic.source, 'classic-scan');
  assert.equal(sonic.platforms, 'Master System, Sega Genesis');
  assert.equal(sonic.year, 1991);
  assert.equal(sonic.wiki_langs, 60);
  assert.equal(store.findOriginal(null, 'Q903'), null, 'games without an English name are skipped');
  assert.ok(store.pageOriginals('classic', 50, 0).total >= 2);

  store.excludeOriginal(store.findOriginal(null, 'Lesser Known').id, 'test');
  r = await scanClassic(opts);
  assert.equal(r.added, 0);
  assert.equal(store.findOriginal(null, 'Lesser Known'), null);
});

test('parsed search results do not keep the page HTML in memory', () => {
  const v8 = require('node:v8');
  v8.setFlagsFromString('--expose-gc');
  const gc = require('node:vm').runInNewContext('gc');
  const padding = '<div class="search_capsule"><img src="https://shared.akamai.steamstatic.com/x.jpg"></div>'.repeat(40);
  const page = (n) => Array.from({ length: 100 }, (_, i) => item(n * 100 + i + 1, `Plain Name ${n * 100 + i}`, 90, 500) + padding).join('');
  gc();
  const before = process.memoryUsage().heapUsed;
  const kept = [];
  for (let n = 0; n < 100; n++) kept.push(...parseSearchPage(page(n))); // ~40 MB of HTML in total
  gc();
  const grown = process.memoryUsage().heapUsed - before;
  assert.equal(kept.length, 10_000);
  assert.ok(grown < 10e6, `kept ${Math.round(grown / 1e6)} MB for 10,000 results`);
});
