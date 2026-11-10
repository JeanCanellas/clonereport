'use strict';
process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert');
const store = require('../db');
const { scanSteam, quickReject, isSoftware, parseOwners } = require('../scanner');

const o = { minReviews: 1000, minPositive: 80 };
const game = (appid, name, positive, negative, owners = '1,000,000 .. 2,000,000') => ({ appid, name, developer: 'Dev ' + appid, publisher: 'Pub', positive, negative, owners });

test('filters', () => {
  assert.equal(quickReject(game(1, 'Great Game', 9000, 1000), o), null);
  assert.equal(quickReject(game(1, 'Small Game', 500, 10), o), 'too few reviews');
  assert.equal(quickReject(game(1, 'Mixed Game', 6000, 4000), o), 'reviews not positive enough');
  assert.equal(quickReject(game(1, 'Great Game Soundtrack', 9000, 10), o), 'not a game');
  assert.equal(isSoftware({ genre: 'Utilities, Design & Illustration' }), true);
  assert.equal(isSoftware({ genre: 'Action, Indie' }), false);
  assert.equal(isSoftware({ genre: 'Simulation, Utilities' }), false);
  assert.equal(parseOwners('20,000,000 .. 50,000,000'), 20000000);
});

test('scan adds good games, skips the rest, and never re-adds removed ones', async () => {
  // An approved report says app 5 is a clone.
  const rid = store.createReport({ clone_name: 'Copycat', clone_url: 'https://store.steampowered.com/app/5/', original_name: 'Real', original_url: 'https://example.com' }, 'x');
  store.setStatus(rid, 'approved');

  const pages = [{
    1: game(1, 'Big Original', 50000, 2000, '10,000,000 .. 20,000,000'),
    2: game(2, 'Paint Tool', 20000, 100),
    3: game(3, 'Tiny Game', 50, 1),
    4: game(4, 'Disliked Game', 3000, 3000),
    5: game(5, 'Copycat', 9000, 100),
    6: game(6, 'Second Original', 8000, 400),
  }, {}];
  const details = { 1: { genre: 'Action' }, 2: { genre: 'Utilities' }, 5: { genre: 'Casual' }, 6: { genre: 'Indie, RPG' } };
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const body = u.searchParams.get('request') === 'all' ? pages[Number(u.searchParams.get('page'))] : details[u.searchParams.get('appid')];
    return { ok: true, json: async () => body };
  };
  const opts = { fetch, sleep: async () => {}, log: () => {}, target: 100, minReviews: 1000, minPositive: 80 };

  let r = await scanSteam(opts);
  assert.equal(r.added, 2);
  const g1 = store.findOriginal(1, '');
  assert.equal(g1.name, 'Big Original');
  assert.equal(g1.source, 'steam-scan');
  assert.equal(g1.positive_pct, 96);
  assert.ok(store.findOriginal(6, ''));
  for (const id of [2, 3, 4, 5]) assert.equal(store.findOriginal(id, ''), null, `app ${id} skipped`);

  // Admin removes one; a second run checks nothing new and adds nothing back.
  store.excludeOriginal(g1.id, 'test');
  calls.length = 0;
  r = await scanSteam(opts);
  assert.equal(r.added, 0);
  assert.equal(store.findOriginal(1, ''), null);
  assert.ok(calls.every((u) => u.includes('request=all')), 'already-seen apps are not fetched again');

  // The hand-checked seed list also respects the exclusion.
  store.seedOriginals([{ name: 'Big Original', steam_appid: 1 }]);
  assert.equal(store.findOriginal(1, ''), null);

  // Stops at the target.
  r = await scanSteam({ ...opts, target: store.countOriginals() });
  assert.equal(r.added, 0);
});
