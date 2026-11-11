'use strict';
// SQLite storage using Node's built-in driver (Node 22.13+). The database file
// and its tables are created automatically on first start.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const stores = require('./stores');

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
    platforms   TEXT,                            -- classic consoles, e.g. "SNES, Game Boy"
    year        INTEGER,                         -- first release year
    wiki_url    TEXT,                            -- English Wikipedia article
    wikidata_id TEXT,                            -- e.g. Q12345
    wiki_langs  INTEGER,                         -- number of Wikipedia language editions
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

// Store columns on reports: which store each link points to and the game's id
// there (see stores.js), so lookups work for PlayStation, Xbox, mobile and itch.io
// pages too, not only Steam. Older rows are filled in from their links.
{
  const cols = new Set(db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name));
  const added = [];
  for (const c of ['clone_store', 'clone_store_id', 'original_store', 'original_store_id'])
    if (!cols.has(c)) { db.exec(`ALTER TABLE reports ADD COLUMN ${c} TEXT`); added.push(c); }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_clone_store ON reports(clone_store, clone_store_id);
    CREATE INDEX IF NOT EXISTS idx_reports_orig_store ON reports(original_store, original_store_id);`);
  if (added.length) {
    const upd = db.prepare('UPDATE reports SET clone_store = ?, clone_store_id = ?, original_store = ?, original_store_id = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, clone_url, original_url FROM reports').all()) {
      const c = stores.parseStoreUrl(r.clone_url), o = stores.parseStoreUrl(r.original_url);
      if (c || o) upd.run(c?.store ?? null, c?.id ?? null, o?.store ?? null, o?.id ?? null, r.id);
    }
  }
}

// Columns added after the first release of the originals table.
{
  const cols = new Set(db.prepare('PRAGMA table_info(originals)').all().map((c) => c.name));
  if (!cols.has('source')) db.exec(`ALTER TABLE originals ADD COLUMN source TEXT NOT NULL DEFAULT 'checked'`);
  if (!cols.has('positive_pct')) db.exec('ALTER TABLE originals ADD COLUMN positive_pct INTEGER');
  if (!cols.has('reviews')) db.exec('ALTER TABLE originals ADD COLUMN reviews INTEGER');
  for (const [c, t] of [['platforms', 'TEXT'], ['year', 'INTEGER'], ['wiki_url', 'TEXT'], ['wikidata_id', 'TEXT'], ['wiki_langs', 'INTEGER']])
    if (!cols.has(c)) db.exec(`ALTER TABLE originals ADD COLUMN ${c} ${t}`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_originals_wikidata ON originals(wikidata_id)');
}
// Comparison details on reports (release dates, images, shared mechanics).
{
  const cols = new Set(db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name));
  for (const c of ['clone_released', 'original_released', 'clone_image', 'original_image', 'mechanics'])
    if (!cols.has(c)) db.exec(`ALTER TABLE reports ADD COLUMN ${c} TEXT`);
}

const { devKey } = require('./keys');
{
  const cols = new Set(db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name));
  for (const c of ['clone_dev_key', 'original_dev_key']) if (!cols.has(c)) db.exec(`ALTER TABLE reports ADD COLUMN ${c} TEXT`);
  const ocols = new Set(db.prepare('PRAGMA table_info(originals)').all().map((c) => c.name));
  if (!ocols.has('dev_key')) db.exec('ALTER TABLE originals ADD COLUMN dev_key TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_cdev ON reports(clone_dev_key);
    CREATE INDEX IF NOT EXISTS idx_reports_odev ON reports(original_dev_key);
    CREATE INDEX IF NOT EXISTS idx_originals_dev ON originals(dev_key);`);
  // Fill keys for rows saved before this column existed (and after any edit, see syncDevKeys).
  const fixR = db.prepare('UPDATE reports SET clone_dev_key = ?, original_dev_key = ? WHERE id = ?');
  for (const r of db.prepare(`SELECT id, clone_developer, original_developer FROM reports
      WHERE (clone_developer IS NOT NULL AND clone_dev_key IS NULL) OR (original_developer IS NOT NULL AND original_dev_key IS NULL)`).all())
    fixR.run(devKey(r.clone_developer), devKey(r.original_developer), r.id);
  const fixO = db.prepare('UPDATE originals SET dev_key = ? WHERE id = ?');
  for (const g of db.prepare('SELECT id, developer FROM originals WHERE developer IS NOT NULL AND dev_key IS NULL').all())
    fixO.run(devKey(g.developer), g.id);
}

// Moderation: evidence links, developer disputes, edit history.
{
  const cols = new Set(db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name));
  if (!cols.has('evidence')) db.exec('ALTER TABLE reports ADD COLUMN evidence TEXT'); // one https link per line
}
db.exec(`
  CREATE TABLE IF NOT EXISTS disputes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  INTEGER NOT NULL,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL,      -- clone-developer | original-developer | other
    contact    TEXT NOT NULL,      -- private, only shown to admins
    message    TEXT NOT NULL,
    links      TEXT,               -- one per line
    status     TEXT NOT NULL DEFAULT 'open', -- open | published | dismissed
    ip_hash    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_disputes_report ON disputes(report_id);
  CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
  -- Every change to a report: who (submitter, admin, steam, developer), what, and the old and new values.
  CREATE TABLE IF NOT EXISTS report_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  INTEGER NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    changes    TEXT,               -- JSON { field: [old, new] }
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_history_report ON report_history(report_id, id);
`);

// Email alerts: follow a game, get an email when a clone of it is approved.
db.exec(`
  CREATE TABLE IF NOT EXISTS follows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL COLLATE NOCASE,
    game       TEXT NOT NULL COLLATE NOCASE,   -- the game's name as typed on the site
    token      TEXT NOT NULL UNIQUE,            -- secret used in confirm and unsubscribe links
    confirmed  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (email, game)
  );
  CREATE INDEX IF NOT EXISTS idx_follows_game ON follows(game, confirmed);
`);

// Community votes: one per visitor (salted IP hash) per report; voting again changes it.
db.exec(`
  CREATE TABLE IF NOT EXISTS votes (
    report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    voter      TEXT NOT NULL,
    choice     TEXT NOT NULL CHECK (choice IN ('clone', 'inspired', 'original')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (report_id, voter)
  );
  CREATE INDEX IF NOT EXISTS idx_votes_voter ON votes(voter, updated_at);
  -- Reports with their vote counts. Rebuilt on every start so changes to it apply.
  DROP VIEW IF EXISTS reports_v;
  CREATE VIEW reports_v AS SELECT r.*,
    (SELECT COUNT(*) FROM votes v WHERE v.report_id = r.id AND v.choice = 'clone')    AS votes_clone,
    (SELECT COUNT(*) FROM votes v WHERE v.report_id = r.id AND v.choice = 'inspired') AS votes_inspired,
    (SELECT COUNT(*) FROM votes v WHERE v.report_id = r.id AND v.choice = 'original') AS votes_original
    FROM reports r;
`);

// Terms of Service: which version of the terms the reporter agreed to when submitting.
{
  const cols = new Set(db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name));
  if (!cols.has('terms_accepted')) db.exec('ALTER TABLE reports ADD COLUMN terms_accepted TEXT');
}
// Takedown, correction and legal requests sent through /contact. Only admins see them.
db.exec(`
  CREATE TABLE IF NOT EXISTS contact_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,      -- removal | correction | copyright | privacy | legal | other
    report_id   INTEGER,            -- the report it is about, if any
    name        TEXT NOT NULL,
    organization TEXT,
    email       TEXT NOT NULL,      -- private
    message     TEXT NOT NULL,
    links       TEXT,               -- one per line
    sworn       INTEGER NOT NULL DEFAULT 0, -- confirmed the statement is accurate and made in good faith
    status      TEXT NOT NULL DEFAULT 'open', -- open | done
    ip_hash     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_requests_status ON contact_requests(status);
`);

const stmts = {
  insert: db.prepare(`INSERT INTO reports
    (clone_name, clone_url, clone_developer, original_name, original_url, original_developer, platform, notes, contact, ip_hash,
     clone_steam_appid, original_steam_appid, clone_released, original_released, clone_image, original_image, mechanics, evidence,
     clone_store, clone_store_id, original_store, original_store_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  follow: db.prepare(`INSERT INTO follows (email, game, token) VALUES (?, ?, ?)
    ON CONFLICT(email, game) DO UPDATE SET token = CASE WHEN confirmed THEN token ELSE excluded.token END RETURNING *`),
  followByToken: db.prepare(`SELECT * FROM follows WHERE token = ?`),
  confirmFollow: db.prepare(`UPDATE follows SET confirmed = 1 WHERE token = ?`),
  unfollow: db.prepare(`DELETE FROM follows WHERE token = ?`),
  followersOf: db.prepare(`SELECT * FROM follows WHERE confirmed = 1 AND game = ?`),
  apiReports: db.prepare(`SELECT * FROM reports_v WHERE status = 'approved'
    AND (? = '' OR clone_name LIKE ? ESCAPE '\\' OR original_name LIKE ? ESCAPE '\\' OR clone_developer LIKE ? ESCAPE '\\' OR original_developer LIKE ? ESCAPE '\\')
    AND (? = '' OR clone_dev_key = ? OR original_dev_key = ?)
    AND (? = 0 OR id > ?)
    ORDER BY id DESC LIMIT ? OFFSET ?`),
  feed: db.prepare(`SELECT * FROM reports_v WHERE status = 'approved'
    AND (? = '' OR lower(original_name) = lower(?) OR lower(clone_name) = lower(?))
    AND (? = '' OR clone_dev_key = ? OR original_dev_key = ?)
    ORDER BY reviewed_at DESC, id DESC LIMIT 50`),
  logHistory: db.prepare(`INSERT INTO report_history (report_id, actor, action, changes) VALUES (?, ?, ?, ?)`),
  history: db.prepare(`SELECT * FROM report_history WHERE report_id = ? ORDER BY id`),
  delHistory: db.prepare(`DELETE FROM report_history WHERE report_id = ?`),
  insertDispute: db.prepare(`INSERT INTO disputes (report_id, name, role, contact, message, links, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  getDispute: db.prepare(`SELECT * FROM disputes WHERE id = ?`),
  disputesFor: db.prepare(`SELECT * FROM disputes WHERE report_id = ? AND status = ? ORDER BY id`),
  disputesByStatus: db.prepare(`SELECT d.*, r.clone_name, r.original_name FROM disputes d LEFT JOIN reports r ON r.id = d.report_id
    WHERE d.status = ? ORDER BY d.id DESC LIMIT 200`),
  disputeCounts: db.prepare(`SELECT status, COUNT(*) AS n FROM disputes GROUP BY status`),
  setDispute: db.prepare(`UPDATE disputes SET status = ?, resolved_at = datetime('now') WHERE id = ?`),
  delDisputes: db.prepare(`DELETE FROM disputes WHERE report_id = ?`),
  setTerms: db.prepare(`UPDATE reports SET terms_accepted = ? WHERE id = ?`),
  insertRequest: db.prepare(`INSERT INTO contact_requests (kind, report_id, name, organization, email, message, links, sworn, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getRequest: db.prepare(`SELECT * FROM contact_requests WHERE id = ?`),
  requestsByStatus: db.prepare(`SELECT q.*, r.clone_name, r.original_name FROM contact_requests q LEFT JOIN reports r ON r.id = q.report_id
    WHERE q.status = ? ORDER BY q.id DESC LIMIT 200`),
  requestCounts: db.prepare(`SELECT status, COUNT(*) AS n FROM contact_requests GROUP BY status`),
  setRequest: db.prepare(`UPDATE contact_requests SET status = ?, resolved_at = CASE WHEN ? = 'done' THEN datetime('now') END WHERE id = ?`),
  update: db.prepare(`UPDATE reports SET clone_name = ?, clone_url = ?, clone_developer = ?, original_name = ?, original_url = ?,
    original_developer = ?, platform = ?, notes = ?, clone_released = ?, original_released = ?, clone_image = ?, original_image = ?,
    mechanics = ?, evidence = ?, clone_steam_appid = ?, original_steam_appid = ?,
    clone_store = ?, clone_store_id = ?, original_store = ?, original_store_id = ? WHERE id = ?`),
  vote: db.prepare(`INSERT INTO votes (report_id, voter, choice, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(report_id, voter) DO UPDATE SET choice = excluded.choice, updated_at = excluded.updated_at`),
  myVote: db.prepare(`SELECT choice FROM votes WHERE report_id = ? AND voter = ?`),
  votesByVoter: db.prepare(`SELECT COUNT(*) AS n FROM votes WHERE voter = ? AND updated_at > ?`),
  delVotes: db.prepare(`DELETE FROM votes WHERE report_id = ?`),
  // Lookup for the browser extension: match by store id (any store) or exact (case-insensitive) name.
  asClone: db.prepare(`SELECT * FROM reports_v WHERE status = 'approved'
    AND ((? IS NOT NULL AND clone_store = ? AND clone_store_id = ?) OR (? <> '' AND lower(clone_name) = lower(?))) ORDER BY id DESC LIMIT 20`),
  asOriginal: db.prepare(`SELECT * FROM reports_v WHERE status = 'approved'
    AND ((? IS NOT NULL AND original_store = ? AND original_store_id = ?) OR (? <> '' AND lower(original_name) = lower(?))) ORDER BY id DESC LIMIT 50`),
  // Search by a pasted store link: approved reports where either game is that store page.
  byStoreId: db.prepare(`SELECT * FROM reports_v WHERE status = 'approved'
    AND ((clone_store = ? AND clone_store_id = ?) OR (original_store = ? AND original_store_id = ?)) ORDER BY id DESC LIMIT 100`),
  search: db.prepare(`SELECT * FROM reports_v
    WHERE status = 'approved'
      AND (clone_name LIKE ? ESCAPE '\\' OR original_name LIKE ? ESCAPE '\\'
           OR clone_developer LIKE ? ESCAPE '\\' OR original_developer LIKE ? ESCAPE '\\')
    ORDER BY (lower(clone_name) = lower(?) OR lower(original_name) = lower(?)) DESC, created_at DESC
    LIMIT 100`),
  recent: db.prepare(`SELECT * FROM reports_v WHERE status = 'approved' ORDER BY reviewed_at DESC, id DESC LIMIT ?`),
  get: db.prepare(`SELECT * FROM reports_v WHERE id = ?`),
  byStatus: db.prepare(`SELECT * FROM reports_v WHERE status = ? ORDER BY created_at DESC LIMIT 200`),
  setStatus: db.prepare(`UPDATE reports SET status = ?, reviewed_at = datetime('now') WHERE id = ?`),
  del: db.prepare(`DELETE FROM reports WHERE id = ?`),
  setComparison: db.prepare(`UPDATE reports SET
    clone_released = coalesce(clone_released, ?), original_released = coalesce(original_released, ?),
    clone_image = coalesce(clone_image, ?), original_image = coalesce(original_image, ?),
    clone_developer = coalesce(clone_developer, ?), original_developer = coalesce(original_developer, ?) WHERE id = ?`),
  syncDevKeys: db.prepare('UPDATE reports SET clone_dev_key = ?, original_dev_key = ? WHERE id = ?'),
  byDev: db.prepare(`SELECT * FROM reports_v WHERE status = 'approved' AND (clone_dev_key = ? OR original_dev_key = ?) ORDER BY id DESC LIMIT 500`),
  originalsByDev: db.prepare(`SELECT * FROM originals WHERE dev_key = ? ORDER BY name LIMIT 500`),
  topCloners: db.prepare(`SELECT clone_dev_key AS dev_key, max(clone_developer) AS name, COUNT(*) AS n FROM reports
    WHERE status = 'approved' AND clone_dev_key IS NOT NULL GROUP BY clone_dev_key ORDER BY n DESC, name LIMIT ?`),
  topCloned: db.prepare(`SELECT original_dev_key AS dev_key, max(original_developer) AS name, COUNT(*) AS n FROM reports
    WHERE status = 'approved' AND original_dev_key IS NOT NULL GROUP BY original_dev_key ORDER BY n DESC, name LIMIT ?`),
  approvedEdges: db.prepare(`SELECT id, clone_name, original_name, clone_steam_appid, original_steam_appid, clone_developer, original_developer
    FROM reports WHERE status = 'approved'`),
  counts: db.prepare(`SELECT status, COUNT(*) AS n FROM reports GROUP BY status`),
  upsertOriginal: db.prepare(`INSERT INTO originals (name, developer, publisher, steam_appid, eshop_url, note, dev_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET developer = excluded.developer, dev_key = excluded.dev_key, publisher = excluded.publisher,
      steam_appid = excluded.steam_appid, eshop_url = excluded.eshop_url, note = excluded.note, source = 'checked'`),
  insertScanned: db.prepare(`INSERT OR IGNORE INTO originals (name, developer, publisher, steam_appid, source, positive_pct, reviews, dev_key)
    VALUES (?, ?, ?, ?, 'steam-scan', ?, ?, ?)`),
  insertClassic: db.prepare(`INSERT OR IGNORE INTO originals (name, developer, publisher, source, platforms, year, wiki_url, wikidata_id, wiki_langs, dev_key)
    VALUES (?, ?, ?, 'classic-scan', ?, ?, ?, ?, ?, ?)`),
  originalByWikidata: db.prepare(`SELECT * FROM originals WHERE wikidata_id = ? LIMIT 1`),
  setPlatforms: db.prepare(`UPDATE originals SET platforms = ? WHERE id = ?`),
  isExcluded: db.prepare(`SELECT 1 FROM excluded_games WHERE (? IS NOT NULL AND steam_appid = ?) OR name = ? LIMIT 1`),
  exclude: db.prepare(`INSERT INTO excluded_games (name, steam_appid, reason) VALUES (?, ?, ?)`),
  delOriginal: db.prepare(`DELETE FROM originals WHERE id = ?`),
  scanSeen: db.prepare(`SELECT 1 FROM steam_scan WHERE appid = ?`),
  scanMark: db.prepare(`INSERT OR REPLACE INTO steam_scan (appid, result, reason) VALUES (?, ?, ?)`),
  isApprovedClone: db.prepare(`SELECT 1 FROM reports WHERE status = 'approved'
    AND ((? IS NOT NULL AND clone_steam_appid = ?) OR lower(clone_name) = lower(?)) LIMIT 1`),
  pageOriginals: db.prepare(`SELECT * FROM originals
    WHERE (? = '' OR (? = 'steam' AND steam_appid IS NOT NULL) OR (? = 'nintendo' AND eshop_url IS NOT NULL) OR (? = 'classic' AND platforms IS NOT NULL))
    ORDER BY name LIMIT ? OFFSET ?`),
  countOriginalsBy: db.prepare(`SELECT COUNT(*) AS n FROM originals
    WHERE (? = '' OR (? = 'steam' AND steam_appid IS NOT NULL) OR (? = 'nintendo' AND eshop_url IS NOT NULL) OR (? = 'classic' AND platforms IS NOT NULL))`),
  getOriginal: db.prepare(`SELECT * FROM originals WHERE id = ?`),
  originalByAppid: db.prepare(`SELECT * FROM originals WHERE steam_appid = ? LIMIT 1`),
  originalByName: db.prepare(`SELECT * FROM originals WHERE name = ? LIMIT 1`),
  searchOriginals: db.prepare(`SELECT * FROM originals
    WHERE name LIKE ? ESCAPE '\\' OR developer LIKE ? ESCAPE '\\' OR publisher LIKE ? ESCAPE '\\'
    ORDER BY (name = ?) DESC, name LIMIT 50`),
  allOriginals: db.prepare(`SELECT * FROM originals ORDER BY name`),
  countOriginals: db.prepare(`SELECT COUNT(*) AS n FROM originals`),
  // Approved reports that name this game as the original (for its page).
  clonesOf: db.prepare(`SELECT * FROM reports_v WHERE status = 'approved'
    AND ((? IS NOT NULL AND original_steam_appid = ?) OR lower(original_name) = lower(?)) ORDER BY id DESC LIMIT 50`),
  // Approved reports that say this game is itself a clone.
  reportedAsClone: db.prepare(`SELECT * FROM reports_v WHERE status = 'approved'
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

// Fields shown in the public edit history (never contact details or IP hashes).
const HISTORY_FIELDS = ['clone_name', 'clone_url', 'clone_developer', 'original_name', 'original_url', 'original_developer', 'platform', 'notes',
  'clone_released', 'original_released', 'clone_image', 'original_image', 'mechanics', 'evidence'];
function diff(before, after) {
  const out = {};
  for (const k of HISTORY_FIELDS) if ((before[k] || null) !== (after[k] || null)) out[k] = [before[k] || null, after[k] || null];
  return out;
}
const logHistory = (id, actor, action, changes) =>
  stmts.logHistory.run(id, actor, action, changes && Object.keys(changes).length ? JSON.stringify(changes) : null);

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

module.exports = {
  db,
  createReport(input, ipHash) {
    const r = {};
    for (const k of ['clone_name', 'clone_url', 'clone_developer', 'original_name', 'original_url', 'original_developer', 'platform', 'notes', 'contact',
      'clone_released', 'original_released', 'clone_image', 'original_image', 'mechanics', 'evidence'])
      r[k] = input[k] || null;
    const c = stores.parseStoreUrl(r.clone_url), o = stores.parseStoreUrl(r.original_url);
    const res = stmts.insert.run(r.clone_name, r.clone_url, r.clone_developer, r.original_name, r.original_url,
      r.original_developer, r.platform, r.notes, r.contact, ipHash, steamAppId(r.clone_url), steamAppId(r.original_url),
      r.clone_released, r.original_released, r.clone_image, r.original_image, r.mechanics, r.evidence,
      c?.store ?? null, c?.id ?? null, o?.store ?? null, o?.id ?? null);
    const id = Number(res.lastInsertRowid);
    stmts.syncDevKeys.run(devKey(r.clone_developer), devKey(r.original_developer), id);
    logHistory(id, 'reporter', 'submitted');
    return id;
  },
  search(q) {
    const like = `%${likeEscape(q)}%`;
    return stmts.search.all(like, like, like, like, q, q);
  },
  steamAppId,
  // Approved reports where either game is the given store page.
  byStoreId: (store, id) => stmts.byStoreId.all(store, id, store, id),
  // lookup(appid, name) for Steam, or lookup({ store, id }, name) for any store.
  lookup(key, name) {
    let st = null, id = null;
    if (key && typeof key === 'object') {
      id = stores.normalizeId(key.store, key.id);
      st = id ? key.store : null;
    } else if (Number.isSafeInteger(key) && key > 0) { st = 'steam'; id = String(key); }
    const n = String(name || '').trim();
    // The store id wins; only fall back to the name when the id finds nothing.
    const run = (stmt) => {
      const byId = id ? stmt.all(st, st, id, '', '') : [];
      return byId.length || !n ? byId : stmt.all(null, null, null, n, n);
    };
    return { asClone: run(stmts.asClone), asOriginal: run(stmts.asOriginal) };
  },
  recent: (n = 10) => stmts.recent.all(n),
  get: (id) => stmts.get.get(id),
  byStatus: (s) => stmts.byStatus.all(s),
  setStatus(id, s, actor = 'admin') {
    const before = stmts.get.get(id);
    stmts.setStatus.run(s, id);
    if (before && before.status !== s) logHistory(id, actor, s, { status: [before.status, s] });
  },
  // Admin edit of a report's public fields.
  updateReport(id, r, actor = 'admin', note = '') {
    const before = stmts.get.get(id);
    const v = (k) => r[k] || null;
    const cs = stores.parseStoreUrl(r.clone_url), os = stores.parseStoreUrl(r.original_url);
    stmts.update.run(v('clone_name'), v('clone_url'), v('clone_developer'), v('original_name'), v('original_url'), v('original_developer'),
      v('platform'), v('notes'), v('clone_released'), v('original_released'), v('clone_image'), v('original_image'), v('mechanics'), v('evidence'),
      steamAppId(r.clone_url), steamAppId(r.original_url),
      cs?.store ?? null, cs?.id ?? null, os?.store ?? null, os?.id ?? null, id);
    stmts.syncDevKeys.run(devKey(r.clone_developer), devKey(r.original_developer), id);
    const changes = before ? diff(before, stmts.get.get(id)) : {};
    if (Object.keys(changes).length || note) logHistory(id, actor, note || 'edited', changes);
  },
  history: (id) => stmts.history.all(id).map((h) => ({ ...h, changes: h.changes ? JSON.parse(h.changes) : null })),
  remove(id) { stmts.delVotes.run(id); stmts.delHistory.run(id); stmts.delDisputes.run(id); stmts.del.run(id); },
  // Follows (email alerts). Returns the row; an existing confirmed follow keeps its token.
  follow: (email, game, token) => stmts.follow.get(email, game, token),
  followByToken: (t) => stmts.followByToken.get(t),
  confirmFollow: (t) => stmts.confirmFollow.run(t).changes > 0,
  unfollow: (t) => stmts.unfollow.run(t).changes > 0,
  followersOf: (game) => stmts.followersOf.all(game),
  // Public API list. Filters: text query, developer key, only ids after `since`.
  apiReports({ q = '', dev = '', since = 0, limit = 50, offset = 0 } = {}) {
    const like = `%${likeEscape(q)}%`;
    return stmts.apiReports.all(q, like, like, like, like, dev, dev, dev, since, since, limit, offset);
  },
  feed: ({ game = '', dev = '' } = {}) => stmts.feed.all(game, game, game, dev, dev, dev),
  // Developer disputes.
  createDispute(reportId, d, ipHash) {
    const res = stmts.insertDispute.run(reportId, d.name, d.role, d.contact, d.message, d.links || null, ipHash);
    logHistory(reportId, 'developer', 'dispute received');
    return Number(res.lastInsertRowid);
  },
  getDispute: (id) => stmts.getDispute.get(id),
  disputesFor: (reportId, status = 'published') => stmts.disputesFor.all(reportId, status),
  disputesByStatus: (s) => stmts.disputesByStatus.all(s),
  disputeCounts() {
    const out = { open: 0, published: 0, dismissed: 0 };
    for (const row of stmts.disputeCounts.all()) out[row.status] = row.n;
    return out;
  },
  setDisputeStatus(id, s) {
    const d = stmts.getDispute.get(id);
    if (!d || d.status === s) return;
    stmts.setDispute.run(s, id);
    logHistory(d.report_id, 'admin', s === 'published' ? 'developer response published' : s === 'dismissed' ? 'dispute dismissed' : 'dispute reopened');
  },
  // Fill comparison details that are still empty (from Steam). Never overwrites.
  fillComparison(id, d) {
    const before = stmts.get.get(id);
    stmts.setComparison.run(d.clone_released ?? null, d.original_released ?? null, d.clone_image ?? null, d.original_image ?? null,
      d.clone_developer ?? null, d.original_developer ?? null, id);
    const r = stmts.get.get(id);
    if (!r) return;
    stmts.syncDevKeys.run(devKey(r.clone_developer), devKey(r.original_developer), id);
    const changes = diff(before, r);
    if (Object.keys(changes).length) logHistory(id, 'steam', 'filled from Steam', changes);
  },
  devKey,
  // Every approved report and original game for one developer.
  developer(key) {
    const reports = stmts.byDev.all(key, key);
    return { cloned: reports.filter((r) => r.clone_dev_key === key), wasCloned: reports.filter((r) => r.original_dev_key === key),
      originals: stmts.originalsByDev.all(key) };
  },
  topDevelopers: (n = 50) => ({ cloners: stmts.topCloners.all(n), cloned: stmts.topCloned.all(n) }),
  approvedEdges: () => stmts.approvedEdges.all(),
  vote: (id, voter, choice) => stmts.vote.run(id, voter, choice, Date.now()),
  myVote: (id, voter) => stmts.myVote.get(id, voter)?.choice || null,
  votesByVoter: (voter, windowMs) => stmts.votesByVoter.get(voter, Date.now() - windowMs).n,
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
        stmts.upsertOriginal.run(g.name.trim(), g.developer || null, g.publisher || null, appid, g.eshop_url || null, g.note || null, devKey(g.developer));
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
    return { rows: stmts.pageOriginals.all(f, f, f, f, limit, offset), total: stmts.countOriginalsBy.get(f, f, f, f).n };
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
    const res = stmts.insertScanned.run(name.slice(0, 200), g.developer || null, g.publisher || null, g.appid, g.positive_pct ?? null, g.reviews ?? null, devKey(g.developer));
    return res.changes ? 'added' : 'name already listed';
  },
  // Used by the classic console scanner. Returns 'added', 'updated' or why it was skipped.
  addClassic(g) {
    const name = String(g.name || '').trim();
    if (!name || !g.wikidata_id) return 'no name';
    const same = stmts.originalByWikidata.get(g.wikidata_id);
    if (same) {
      // Same game seen on another console: add the console to its list.
      const list = String(same.platforms || '').split(', ').filter(Boolean);
      if (g.platform && !list.includes(g.platform)) { stmts.setPlatforms.run([...list, g.platform].join(', '), same.id); return 'updated'; }
      return 'already listed';
    }
    if (stmts.isExcluded.get(null, null, name)) return 'excluded by admin';
    if (stmts.isApprovedClone.get(null, null, name)) return 'reported as a clone';
    const res = stmts.insertClassic.run(name.slice(0, 200), g.developer || null, g.publisher || null, g.platform || null,
      g.year ?? null, g.wiki_url || null, g.wikidata_id, g.wiki_langs ?? null, devKey(g.developer));
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
  setTermsAccepted: (id, version) => stmts.setTerms.run(version, id),
  // Takedown and contact requests.
  createRequest(q, ipHash) {
    const res = stmts.insertRequest.run(q.kind, q.report_id || null, q.name, q.organization || null, q.email, q.message, q.links || null, q.sworn ? 1 : 0, ipHash);
    return Number(res.lastInsertRowid);
  },
  getRequest: (id) => stmts.getRequest.get(id),
  requestsByStatus: (s) => stmts.requestsByStatus.all(s),
  requestCounts() {
    const out = { open: 0, done: 0 };
    for (const row of stmts.requestCounts.all()) out[row.status] = row.n;
    return out;
  },
  setRequestStatus: (id, s) => stmts.setRequest.run(s, s, id).changes > 0,
  // Close the database cleanly (on shutdown): folds the WAL back into the main file.
  close() {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    try { db.close(); } catch { /* already closed */ }
  },
};
