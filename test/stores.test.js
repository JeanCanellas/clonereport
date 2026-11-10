'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const s = require('../stores');

test('store links are recognised', () => {
  const cases = {
    'https://store.steampowered.com/app/620/Portal_2/': ['steam', '620'],
    'https://store.playstation.com/en-us/concept/10000176': ['playstation', 'concept/10000176'],
    'https://store.playstation.com/en-gb/product/UP9000-PPSA01411_00-RATCHETANDCLANK0': ['playstation', 'product/UP9000-PPSA01411_00-RATCHETANDCLANK0'],
    'https://www.xbox.com/en-US/games/store/halo-infinite/9PP5G1F153J1': ['xbox', '9PP5G1F153J1'],
    'https://www.xbox.com/en-US/games/store/halo-infinite/9pp5g1f153j1/0010': ['xbox', '9PP5G1F153J1'],
    'https://www.microsoft.com/en-us/p/minecraft/9nblggh2jhxj': ['xbox', '9NBLGGH2JHXJ'],
    'https://apps.microsoft.com/detail/9nblggh2jhxj?hl=en-us': ['xbox', '9NBLGGH2JHXJ'],
    'https://www.nintendo.com/us/store/products/hollow-knight-switch/': ['nintendo', 'hollow-knight-switch'],
    'https://apps.apple.com/us/app/flappy-bird/id642848232': ['appstore', '642848232'],
    'https://play.google.com/store/apps/details?id=com.dotgears.flappybird&hl=en': ['googleplay', 'com.dotgears.flappybird'],
    'https://MaddyMakesGames.itch.io/celeste-classic': ['itch', 'maddymakesgames/celeste-classic'],
  };
  for (const [url, [store, id]] of Object.entries(cases)) {
    assert.deepEqual(s.parseStoreUrl(url), { store, id }, url);
    // The canonical link built from the id parses back to the same id.
    assert.deepEqual(s.parseStoreUrl(s.storeUrl(store, id)), { store, id }, `round trip ${url}`);
  }
  for (const url of ['https://itch.io/games', 'https://www.itch.io/x', 'https://someone.itch.io/', 'https://someone.itch.io/game/devlog',
    'https://play.google.com/store/apps/details?id=nodots', 'https://example.com/app/620', 'javascript:alert(1)', '', null,
    'https://store.steampowered.com/bundle/232/', 'https://www.xbox.com/en-US/games/store/x/SHORT'])
    assert.equal(s.parseStoreUrl(url), null, String(url));
});

test('ids passed on their own are validated', () => {
  assert.equal(s.normalizeId('xbox', '9pp5g1f153j1'), '9PP5G1F153J1');
  assert.equal(s.normalizeId('itch', 'User/Game'), 'user/game');
  assert.equal(s.normalizeId('itch', '../../evil'), null);
  assert.equal(s.normalizeId('appstore', 'id1'), null);
  assert.equal(s.normalizeId('nope', '1'), null);
  assert.equal(s.storeName('googleplay'), 'Google Play');
  assert.equal(s.storeName('__proto__'), null);
});

test('older reports get their store ids filled in on start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'));
  const file = path.join(dir, 'old.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, clone_name TEXT NOT NULL, clone_url TEXT, clone_developer TEXT,
    original_name TEXT NOT NULL, original_url TEXT, original_developer TEXT, platform TEXT, clone_steam_appid INTEGER, original_steam_appid INTEGER,
    notes TEXT, contact TEXT, status TEXT NOT NULL DEFAULT 'pending', ip_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT);
    INSERT INTO reports (clone_name, clone_url, original_name, original_url, status)
      VALUES ('Copy', 'https://play.google.com/store/apps/details?id=com.copy.game', 'Real', 'https://store.steampowered.com/app/620/', 'approved');`);
  old.close();
  const out = execFileSync(process.execPath, ['--no-warnings', '-e',
    `const db = require(${JSON.stringify(path.join(__dirname, '..', 'db'))});
     const r = db.lookup({ store: 'googleplay', id: 'com.copy.game' }, '');
     process.stdout.write(JSON.stringify([r.asClone.map((x) => x.original_name), db.lookup(620, '').asOriginal.map((x) => x.clone_name)]));`],
  { env: { ...process.env, DB_PATH: file } }).toString();
  assert.deepEqual(JSON.parse(out), [['Real'], ['Copy']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the Chrome extension ships the same stores.js', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  assert.equal(read('chrome-extension/stores.js'), read('stores.js'), 'copy stores.js into chrome-extension/ after changing it');
});
