'use strict';
// "Original of" family trees, built from approved reports. Each report is an edge
// clone -> original. Games are matched by Steam app id when known, otherwise by name.

const MAX_DEPTH = 6;
const MAX_NODES = 300;

function buildGraph(edges) {
  const byAppid = new Map(); // steam app id -> node key
  const aliases = new Map(); // name key -> node key (when the name belongs to an app id node)
  const names = new Map();   // node key -> display name (null for alias-only name keys)
  const keyOf = (name, appid) => {
    const nk = 'n:' + String(name).trim().toLowerCase();
    if (appid) {
      // First time we see this app id: reuse an existing node with the same name, if any.
      if (!byAppid.has(appid)) byAppid.set(appid, aliases.get(nk) || (names.get(nk) ? nk : 'a:' + appid));
      const k = byAppid.get(appid);
      if (!names.has(k)) names.set(k, name);
      if (nk !== k) { if (!names.has(nk)) names.set(nk, null); aliases.set(nk, k); }
      return k;
    }
    const k = aliases.get(nk) || nk;
    if (!names.has(k) || names.get(k) === null) names.set(k, name);
    return k;
  };
  const up = new Map(), down = new Map(); // key -> [{ key, report }]
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const e of edges) {
    // A clone with the same name as its original (different studio) is a different game.
    const same = e.clone_name.trim().toLowerCase() === e.original_name.trim().toLowerCase() && !(e.clone_steam_appid && e.original_steam_appid);
    const o = keyOf(e.original_name, e.original_steam_appid);
    const c = same ? `r:${e.id}` : keyOf(e.clone_name, e.clone_steam_appid);
    if (same) names.set(c, `${e.clone_name}${e.clone_developer ? ` (${e.clone_developer})` : ''}`);
    if (o === c) continue;
    add(up, c, { key: o, report: e.id });
    add(down, o, { key: c, report: e.id });
  }
  const resolve = (name, appid) => {
    if (appid && byAppid.has(appid)) return byAppid.get(appid);
    const nk = 'n:' + String(name || '').trim().toLowerCase();
    return aliases.get(nk) || (names.has(nk) ? nk : null);
  };
  return { up, down, names, resolve };
}

// Nested tree in one direction: [{ name, report, children: [...] }]
function walk(g, start, dir) {
  const seen = new Set([start]);
  let count = 0;
  const go = (k, depth) => (depth >= MAX_DEPTH ? [] : (g[dir].get(k) || []).flatMap((e) => {
    if (seen.has(e.key) || count >= MAX_NODES) return [];
    seen.add(e.key); count++;
    return [{ name: g.names.get(e.key), report: e.report, children: go(e.key, depth + 1) }];
  }));
  return go(start, 0);
}

function familyTree(edges, name, appid) {
  const g = buildGraph(edges);
  const key = g.resolve(name, appid);
  if (!key) return null;
  return { name: g.names.get(key), ancestors: walk(g, key, 'up'), descendants: walk(g, key, 'down') };
}

module.exports = { familyTree, buildGraph };
