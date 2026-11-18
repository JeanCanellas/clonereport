'use strict';
// Serves the browser extension from the site: zips chrome-extension/ in memory at
// start (no dependencies), so the download always matches the source in the repo.
// The Firefox build is the same files with a Firefox manifest (firefoxManifest()),
// so there is one copy of the code for both browsers.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIR = path.join(__dirname, 'chrome-extension');

function listFiles(dir, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix + e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel + '/'));
    else out.push(rel);
  }
  return out;
}

function chromeManifest(dir = DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

// Firefox add-on id. It must never change once the add-on is on addons.mozilla.org.
const FIREFOX_ID = 'clone-report@clonereport.com';

// The Chrome manifest, changed where Firefox differs: an event page instead of
// a service worker, an add-on id, and the data collection declaration that
// addons.mozilla.org requires (the page's store, game id and name are sent to
// clonereport.com, which Mozilla counts as browsing activity). Firefox 140 is
// the first release that shows that declaration at install (142 on Android).
function firefoxManifest(dir = DIR) {
  const m = chromeManifest(dir);
  m.background = { scripts: ['background.js'] };
  m.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['browsingActivity'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  };
  return m;
}

// Minimal ZIP writer (deflate, no ZIP64): fine for a few small files.
// browser 'firefox' swaps in the Firefox manifest.
function buildZip(dir = DIR, { browser = 'chrome' } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  // 2026-01-01 00:00 in DOS time, so the zip is identical on every start.
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const rel of listFiles(dir)) {
    const data = browser === 'firefox' && rel === 'manifest.json'
      ? Buffer.from(JSON.stringify(firefoxManifest(dir), null, 2) + '\n')
      : fs.readFileSync(path.join(dir, rel));
    const comp = zlib.deflateRawSync(data);
    const name = Buffer.from(rel, 'utf8');
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(head, name, comp);
    centrals.push(cen, name);
    offset += head.length + name.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const count = centrals.length / 2;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function version() {
  try { return chromeManifest().version; } catch { return null; }
}

// The published Chrome Web Store listing. CHROME_STORE_URL overrides it (for a test listing).
const STORE_URL = process.env.CHROME_STORE_URL || 'https://chromewebstore.google.com/detail/ijagfhebglljkibhfdmedhgkdbicibgk';

// The Firefox Add-ons listing. Empty until the add-on is approved there; the site
// then says the Firefox version is coming soon. FIREFOX_ADDON_URL overrides it.
const FIREFOX_URL = process.env.FIREFOX_ADDON_URL || '';

// `node extension.js firefox [out.zip]` writes the zip to upload to addons.mozilla.org.
if (require.main === module) {
  const browser = process.argv[2] === 'firefox' ? 'firefox' : 'chrome';
  const out = process.argv[3] || `clone-report-${browser}-${version()}.zip`;
  fs.writeFileSync(out, buildZip(DIR, { browser }));
  console.log(`Wrote ${out}`);
}

module.exports = { buildZip, version, firefoxManifest, FIREFOX_ID, STORE_URL, FIREFOX_URL };
