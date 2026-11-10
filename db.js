'use strict';
// SQLite storage using Node's built-in driver (Node 22.13+). The database file
// and its tables are created automatically on first start.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'clonereport.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reports (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    clone_name         TEXT NOT NULL,
    clone_url          TEXT,
    clone_developer    TEXT,
    original_name      TEXT NOT NULL,
    original_url       TEXT,
    original_developer TEXT,
    platform           TEXT,
    clone_steam_appid    INTEGER,
    original_steam_appid INTEGER,
    notes              TEXT,
    contact            TEXT,            -- private, only shown to admins
    status             TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    ip_hash            TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  CREATE INDEX IF NOT EXISTS idx_reports_clone_appid ON reports(clone_steam_appid);
  CREATE INDEX IF NOT EXISTS idx_reports_orig_appid ON reports(original_steam_appid);
  -- Games checked to be originals (not clones), e.g. seeded from seed/originals.json.
  CREATE TABLE IF NOT EXISTS originals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    developer   TEXT,
    publisher   TEXT,
    steam_appid INTEGER,
    eshop_url   TEXT,
    note        TEXT,
    source      TEXT NOT NULL DEFAULT 'checked', -- checked (hand-checked list) | steam-scan (automatic)
    positive_pct INTEGER,                        -- Steam review score at scan time
    reviews     INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_originals_appid ON originals(steam_appid);
  -- Games an admin removed from the originals list (or that were approved as clones).
  -- Neither the seed file nor the Steam scanner adds them back.
  CREATE TABLE IF NOT EXISTS excluded_games (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT COLLATE NOCASE,
    steam_appid INTEGER,
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Every Steam app the scanner has looked at, so it only checks new ones.
  CREATE TABLE IF NOT EXISTS steam_scan (
    appid      INTEGER PRIMARY KEY,
    result     TEXT NOT NULL,  -- added | skipped
    reason     TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS submissions_log (
    ip_hash    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Columns added after the first release of the originals table.
{
  const cols = new Set(db.prepare('PRAGMA table_info(originals)').all().map((c) => c.name));
  if (!cols.has('source')) db.exec(`ALTER TABLE originals ADD COLUMN source TEXT NOT NULL DEFAULT 'checked'`);
  if (!cols.has('positive_pct')) db.exec('ALTER TABLE originals ADD COLUMN positive_pct INTEGER');
  if (!cols.has('reviews')) db.exec('ALTER TABLE originals ADD COLUMN reviews INTEGER');
}

const stmts = {
  insert: db.prepare(`INSERT INTO reports
    (clone_name, clone_url, clone_developer, original_name, original_url, original_developer, platform, notes, contact, ip_hash,
     clone_steam_appid, original_steam_appid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  // Lookup for the browser extension: match by Steam app id or exact (case-insensitive) name.
  asClone: db.prepare(`SELECT * FROM reports WHERE status = 'approved'
    AND ((? IS NOT NULL AND clone_steam_appid = ?) OR (? <> '' AND lower(clone_name) = lower(?))) ORDER BY id DESC LIMIT 20`),
  asOriginal: db.prepare(`SELECT * FROM reports WHERE status = 'approved'
    AND ((? IS NOT NULL AND original_steam_appid = ?) OR (? <> '' AND lower(original_name) = lower(?))) ORDER BY id DESC LIMIT 50`),
  search: db.prepare(`SELECT * FROM reports
    WHERE status = 'approved'
      AND (clone_name LIKE ? ESCAPE '\\' OR original_name LIKE ? ESCAPE '\\'
           OR clone_developer LIKE ? ESCAPE '\\' OR original_developer LIKE ? ESCAPE '\\')
    ORDER BY (lower(clone_name) = lower(?) OR lower(original_name) = lower(?)) DESC, created_at DESC
    LIMIT 100`),
  recent: db.prepare(`SELECT * FROM reports WHERE status = 'approved' ORDER BY reviewed_at DESC, id DESC LIMIT ?`),
  get: db.prepare(`SELECT * FROM reports WHERE id = ?`),
  byStatus: db.prepare(`SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT 200`),
  setStatus: db.prepare(`UPDATE reports SET status = ?, reviewed_at = datetime('now') WHERE id = ?`),
  del: db.prepare(`DELETE FROM reports WHERE id = ?`),
  counts: db.prepare(`SELECT status, COUNT(*) AS n FROM reports GROUP BY status`),
  upsertOriginal: db.prepare(`INSERT INTO originals (name, developer, publisher, steam_appid, eshop_url, note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET developer = excluded.developer, publisher = excluded.publisher,
      steam_appid = excluded.steam_appid, eshop_url = excluded.eshop_url, note = excluded.note, source = 'checked'`),
  insertScanned: db.prepare(`INSERT OR IGNORE INTO originals (name, developer, publisher, steam_appid, source, positive_pct, reviews)
    VALUES (?, ?, ?, ?, 'steam-scan', ?, ?)`),
  isExcluded: db.prepare(`SELECT 1 FROM excluded_games WHERE (? IS NOT NULL AND steam_appid = ?) OR name = ? LIMIT 1`),
  exclude: db.prepare(`INSERT INTO excluded_games (name, steam_appid, reason) VALUES (?, ?, ?)`),
  delOriginal: db.prepare(`DELETE FROM originals WHERE id = ?`),
  scanSeen: db.prepare(`SELECT 1 FROM steam_scan WHERE appid = ?`),
  scanMark: db.prepare(`INSERT OR REPLACE INTO steam_scan (appid, result, reason) VALUES (?, ?, ?)`),
  isApprovedClone: db.prepare(`SELECT 1 FROM reports WHERE status = 'approved'
    AND ((? IS NOT NULL AND clone_steam_appid = ?) OR lower(clone_name) = lower(?)) LIMIT 1`),
  pageOriginals: db.prepare(`SELECT * FROM originals
    WHERE (? = '' OR (? = 'steam' AND steam_appid IS NOT NULL) OR (? = 'nintendo' AND eshop_url IS NOT NULL))
    ORDER BY name LIMIT ? OFFSET ?`),
  countOriginalsBy: db.prepare(`SELECT COUNT(*) AS n FROM originals
    WHERE (? = '' OR (? = 'steam' AND steam_appid IS NOT NULL) OR (? = 'nintendo' AND eshop_url IS NOT NULL))`),
  getOriginal: db.prepare(`SELECT * FROM originals WHERE id = ?`),
  originalByAppid: db.prepare(`SELECT * FROM originals WHERE steam_appid = ? LIMIT 1`),
  originalByName: db.prepare(`SELECT * FROM originals WHERE name = ? LIMIT 1`),
  searchOriginals: db.prepare(`SELECT * FROM originals
    WHERE name LIKE ? ESCAPE '\\' OR developer LIKE ? ESCAPE '\\' OR publisher LIKE ? ESCAPE '\\'
    ORDER BY (name = ?) DESC, name LIMIT 50`),
  allOriginals: db.prepare(`SELECT * FROM originals ORDER BY name`),
  countOriginals: db.prepare(`SELECT COUNT(*) AS n FROM originals`),
  // Approved reports that name this game as the original (for its page).
  clonesOf: db.prepare(`SELECT * FROM reports WHERE status = 'approved'
    AND ((? IS NOT NULL AND original_steam_appid = ?) OR lower(original_name) = lower(?)) ORDER BY id DESC LIMIT 50`),
  // Approved reports that say this game is itself a clone.
  reportedAsClone: db.prepare(`SELECT * FROM reports WHERE status = 'approved'
    AND ((? IS NOT NULL AND clone_steam_appid = ?) OR lower(clone_name) = lower(?)) ORDER BY id DESC LIMIT 20`),
  logSubmission: db.prepare(`INSERT INTO submissions_log (ip_hash, created_at) VALUES (?, ?)`),
  countRecent: db.prepare(`SELECT COUNT(*) AS n FROM submissions_log WHERE ip_hash = ? AND created_at > ?`),
  pruneLog: db.prepare(`DELETE FROM submissions_log WHERE created_at < ?`),
};

// Pull the app id out of a Steam store link, e.g. https://store.steampowered.com/app/620/Portal_2/
function steamAppId(url) {
  const m = /^https?:\/\/store\.steampowered\.com\/app\/(\d+)/i.exec(url || '');
  return m ? Number(m[1]) : null;
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

module.exports = {
  db,
  createReport(input, ipHash) {
    const r = {};
    for (const k of ['clone_name', 'clone_url', 'clone_developer', 'original_name', 'original_url', 'original_developer', 'platform', 'notes', 'contact'])
      r[k] = input[k] || null;
    const res = stmts.insert.run(r.clone_name, r.clone_url, r.clone_developer, r.original_name, r.original_url,
      r.original_developer, r.platform, r.notes, r.contact, ipHash, steamAppId(r.clone_url), steamAppId(r.original_url));
    return Number(res.lastInsertRowid);
  },
  search(q) {
    const like = `%${likeEscape(q)}%`;
    return stmts.search.all(like, like, like, like, q, q);
  },
  steamAppId,
  lookup(appid, name) {
    const a = Number.isSafeInteger(appid) && appid > 0 ? appid : null;
    const n = String(name || '').trim();
    // Steam app id wins; only fall back to the name when the id finds nothing.
    const run = (stmt) => {
      const byId = a ? stmt.all(a, a, '', '') : [];
      return byId.length || !n ? byId : stmt.all(null, null, n, n);
    };
    return { asClone: run(stmts.asClone), asOriginal: run(stmts.asOriginal) };
  },
  recent: (n = 10) => stmts.recent.all(n),
  get: (id) => stmts.get.get(id),
  byStatus: (s) => stmts.byStatus.all(s),
  setStatus: (id, s) => stmts.setStatus.run(s, id),
  remove: (id) => stmts.del.run(id),
  counts() {
    const out = { pending: 0, approved: 0, rejected: 0 };
    for (const row of stmts.counts.all()) out[row.status] = row.n;
    return out;
  },
  // Returns how many submissions this IP made in the window, then logs this one.
  rateCheck(ipHash, windowMs) {
    const now = Date.now();
    stmts.pruneLog.run(now - 24 * 3600 * 1000);
    return stmts.countRecent.get(ipHash, now - windowMs).n;
  },
  // Insert or refresh the list of verified original games. Safe to run on every start.
  seedOriginals(list) {
    let n = 0;
    db.exec('BEGIN');
    try {
      for (const g of list) {
        if (!g || typeof g.name !== 'string' || !g.name.trim()) continue;
        const appid = Number.isSafeInteger(g.steam_appid) && g.steam_appid > 0 ? g.steam_appid : null;
        if (stmts.isExcluded.get(appid, appid, g.name.trim())) continue;
        // A scanned row for the same Steam game under another name gives way to the checked entry.
        const dup = appid && stmts.originalByAppid.get(appid);
        if (dup && dup.name.toLowerCase() !== g.name.trim().toLowerCase()) stmts.delOriginal.run(dup.id);
        stmts.upsertOriginal.run(g.name.trim(), g.developer || null, g.publisher || null, appid, g.eshop_url || null, g.note || null);
        n++;
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    return n;
  },
  getOriginal: (id) => stmts.getOriginal.get(id),
  findOriginal(appid, name) {
    const a = Number.isSafeInteger(appid) && appid > 0 ? appid : null;
    const n = String(name || '').trim();
    return (a && stmts.originalByAppid.get(a)) || (n && stmts.originalByName.get(n)) || null;
  },
  searchOriginals(q) {
    const like = `%${likeEscape(q)}%`;
    return stmts.searchOriginals.all(like, like, like, q);
  },
  allOriginals: () => stmts.allOriginals.all(),
  pageOriginals(storeFilter, limit, offset) {
    const f = storeFilter || '';
    return { rows: stmts.pageOriginals.all(f, f, f, limit, offset), total: stmts.countOriginalsBy.get(f, f, f).n };
  },
  // Remove a game from the originals list for good (the seed file and the scanner skip it).
  excludeOriginal(id, reason) {
    const g = stmts.getOriginal.get(id);
    if (!g) return false;
    stmts.exclude.run(g.name, g.steam_appid ?? null, reason || null);
    stmts.delOriginal.run(id);
    return true;
  },
  // Used by the Steam scanner. Returns 'added' or the reason it was skipped.
  addScanned(g) {
    const name = String(g.name || '').trim();
    if (!name) return 'no name';
    if (stmts.isExcluded.get(g.appid, g.appid, name)) return 'excluded by admin';
    if (stmts.isApprovedClone.get(g.appid, g.appid, name)) return 'reported as a clone';
    if (stmts.originalByAppid.get(g.appid)) return 'already listed';
    const res = stmts.insertScanned.run(name.slice(0, 200), g.developer || null, g.publisher || null, g.appid, g.positive_pct ?? null, g.reviews ?? null);
    return res.changes ? 'added' : 'name already listed';
  },
  scanSeen: (appid) => !!stmts.scanSeen.get(appid),
  scanMark: (appid, result, reason) => stmts.scanMark.run(appid, result, reason || null),
  countOriginals: () => stmts.countOriginals.get().n,
  reportsAbout(g) {
    const a = g.steam_appid ?? null;
    return { clones: stmts.clonesOf.all(a, a, g.name), asClone: stmts.reportedAsClone.all(a, a, g.name) };
  },
  logSubmission: (ipHash) => stmts.logSubmission.run(ipHash, Date.now()),
};
