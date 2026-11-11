'use strict';
// Serves the Chrome extension from the site: zips chrome-extension/ in memory at
// start (no dependencies), so the download always matches the source in the repo.
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

// Minimal ZIP writer (deflate, no ZIP64): fine for a few small files.
function buildZip(dir = DIR) {
  const locals = [], centrals = [];
  let offset = 0;
  // 2026-01-01 00:00 in DOS time, so the zip is identical on every start.
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const rel of listFiles(dir)) {
    const data = fs.readFileSync(path.join(dir, rel));
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
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')).version; } catch { return null; }
}

module.exports = { buildZip, version };
