'use strict';
// HTML templates. Every user-supplied value goes through esc().

const { devKey } = require('./keys');
const { MIN_VOTES, tally, verdict } = require('./scoring');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (url, text) => (url ? `<a href="${esc(url)}" rel="nofollow ugc noopener" target="_blank">${esc(text)}</a>` : esc(text));
const devLink = (name) => (name && devKey(name) ? `<a href="/dev/${devKey(name)}">${esc(name)}</a>` : esc(name));
const treeUrl = (name) => `/tree?game=${encodeURIComponent(name)}`;
const date = (s) => (s ? esc(String(s).slice(0, 10)) : '');

function layout(title, body, { q = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Clone Report</title>
<meta name="description" content="Clone Report: search any game to find out whether it is a clone, and discover the original.">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="site">
  <div class="wrap bar">
    <a class="brand" href="/">Clone<span>Report</span></a>
    <form class="mini-search" action="/search" method="get" role="search">
      <input name="q" value="${esc(q)}" placeholder="Search a game…" aria-label="Search a game">
    </form>
    <a class="btn small" href="/submit">Report a clone</a>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="wrap site-foot">
  <nav class="foot-nav"><a href="/originals">Original games</a> · <a href="/developers">Developers</a> · <a href="/tree">Family trees</a> · <a href="/feed.xml">RSS</a> · <a href="/api">API</a> · <a href="/submit">Report a clone</a></nav>
  <p>Reports are submitted by the community and reviewed before they appear. They are claims, not legal findings.</p>
  <p><a href="/privacy">Privacy policy</a></p>
</footer>
</body>
</html>`;
}

// ---------- community votes ----------
const CHOICES = [['clone', 'Clone', 'It copies the original'], ['inspired', 'Inspired by', 'Borrows ideas but is its own game'], ['original', 'Original', 'Not a copy']];
const pct = (n, total) => (total ? Math.round((100 * n) / total) : 0);
function scoreBadge(r) {
  const t = tally(r);
  const v = verdict(t);
  return v ? `<span class="score s${t.score >= 67 ? 'hi' : t.score >= 34 ? 'mid' : 'lo'}" title="${t.total} community votes">${esc(v)} · ${t.score}%</span>` : '';
}

function card(r) {
  return `<li class="card">
  <a class="card-link" href="/report/${r.id}">
    <div class="pair">
      <div><span class="tag clone">Clone</span><strong>${esc(r.clone_name)}</strong>${r.clone_developer ? `<small>by ${esc(r.clone_developer)}</small>` : ''}</div>
      <div class="arrow" aria-hidden="true">copies</div>
      <div><span class="tag orig">Original</span><strong>${esc(r.original_name)}</strong>${r.original_developer ? `<small>by ${esc(r.original_developer)}</small>` : ''}</div>
    </div>
    ${scoreBadge(r)}
  </a>
</li>`;
}

const steamLink = (g) => (g.steam_appid ? `https://store.steampowered.com/app/${g.steam_appid}/` : null);
const stores = (g) => [g.steam_appid && 'Steam', g.eshop_url && 'Nintendo eShop', g.platforms].filter(Boolean).join(' · ');

function originalCard(g) {
  return `<li class="card">
  <a class="card-link" href="/game/${g.id}">
    <div class="solo">
      <div><span class="tag orig">Not a clone</span><strong>${esc(g.name)}</strong>${g.developer ? `<small>by ${esc(g.developer)}</small>` : ''}</div>
      <small class="muted">${esc(stores(g))}</small>
    </div>
  </a>
</li>`;
}

function home(recent, total, originals = 0) {
  return layout('Find the original game', `
<section class="hero">
  <h1>Is this game a clone?</h1>
  <p>Search any game to see whether it has been reported as a copy, and find the original it was based on.</p>
  <form class="big-search" action="/search" method="get" role="search">
    <input name="q" placeholder="Type a game name" aria-label="Game name" autofocus required>
    <button class="btn">Search</button>
  </form>
  <p class="muted">${total} approved report${total === 1 ? '' : 's'} so far. Was your game cloned? <a href="/submit">Report it</a>.</p>
  ${originals ? `<p class="muted"><a href="/originals">Browse ${originals.toLocaleString('en-US')} original games</a> from Steam, the Nintendo eShop and classic consoles that are not clones.</p>` : ''}
</section>
${recent.length ? `<h2>Recently added</h2><ul class="cards">${recent.map(card).join('')}</ul>` : ''}`);
}

function searchPage(q, results, originals = []) {
  const origList = originals.length
    ? `<h2>Original games</h2><p class="muted">Listed on Clone Report as originals, not clones.</p>
       <ul class="cards">${originals.map(originalCard).join('')}</ul>` : '';
  const body = !q
    ? `<p>Type a game name to search.</p>`
    : results.length
      ? `<h1>Results for “${esc(q)}”</h1><h2>Clone reports</h2><ul class="cards">${results.map(card).join('')}</ul>${origList}
         <p class="muted">Know about another clone? <a href="/submit?clone_name=${encodeURIComponent(q)}">Report it</a>.</p>`
      : originals.length
        ? `<h1>Results for “${esc(q)}”</h1><p>No clone reports for “${esc(q)}”.</p>${origList}
           <p class="muted">Know about a clone? <a href="/submit?clone_name=${encodeURIComponent(q)}">Report it</a>.</p>`
        : `<h1>No reports for “${esc(q)}”</h1>
         <p>Nobody has reported this game yet. If it is a clone, or if someone cloned it, you can
         <a href="/submit?clone_name=${encodeURIComponent(q)}">submit a report</a>.</p>`;
  return layout(q ? `Search: ${q}` : 'Search', body, { q });
}

const year = (d) => (d ? Number(String(d).slice(0, 4)) : null);
function releaseNote(r) {
  const a = r.original_released, b = r.clone_released;
  if (!a || !b) return '';
  const n = Math.min(a.length, b.length);
  if (a.slice(0, n) === b.slice(0, n)) return '<p class="muted">Both games came out around the same time.</p>';
  if (a.slice(0, n) > b.slice(0, n)) return '<p class="notice">Note: the listed release date of the clone is earlier than the original\'s.</p>';
  const yrs = year(b) - year(a);
  return `<p class="muted">The original came out ${yrs >= 1 ? `${yrs} year${yrs === 1 ? '' : 's'}` : 'shortly'} before the clone.</p>`;
}
const shot = (url, name) => (url
  ? `<img class="shot" src="${esc(url)}" alt="${esc(name)}" loading="lazy" referrerpolicy="no-referrer">`
  : `<div class="shot none">No image yet</div>`);

function voteBox(r, { myVote, voteToken, voteMsg }) {
  const t = tally(r);
  const v = verdict(t);
  // An SVG bar, since the CSP does not allow inline styles.
  let x = 0;
  const bar = t.total ? `<svg class="vbar" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 1">${CHOICES.map(([k]) => {
    const w = (100 * t[k]) / t.total; const rect = w ? `<rect class="v-${k}" x="${x}" y="0" width="${w}" height="1"/>` : ''; x += w; return rect;
  }).join('')}</svg>` : '';
  return `<section class="box vote" id="vote">
  <h2>What do you think?</h2>
  <p class="muted">${v ? `Community verdict: <strong>${esc(v)}</strong>, clone score ${t.score}% from ${t.total} vote${t.total === 1 ? '' : 's'}.`
    : `${t.total ? `${t.total} vote${t.total === 1 ? '' : 's'} so far. ` : ''}The community verdict shows after ${MIN_VOTES} votes.`}</p>
  ${bar}
  ${voteMsg ? `<p class="notice" role="status">${esc(voteMsg)}</p>` : ''}
  <form method="post" action="/report/${r.id}/vote" class="vote-form">
    <input type="hidden" name="token" value="${esc(voteToken || '')}">
    ${CHOICES.map(([k, label, hint]) => `<button class="vote-btn v-${k}${myVote === k ? ' on' : ''}" name="choice" value="${k}" aria-pressed="${myVote === k}">
      <strong>${label}</strong><small>${hint}</small><span class="count">${t[k]} · ${pct(t[k], t.total)}%</span></button>`).join('')}
  </form>
  ${myVote ? '<p class="muted">You can change your vote at any time.</p>' : ''}
</section>`;
}

const ROLES = { 'clone-developer': 'Developer of the game reported as a clone', 'original-developer': 'Developer of the original game', other: 'Other' };
function evidenceList(text, title = 'Evidence') {
  const links = String(text || '').split('\n').filter(Boolean);
  if (!links.length) return '';
  const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
  return `<section><h2>${esc(title)}</h2><ul class="evidence">${links.map((u) => `<li>${link(u, host(u))} <small class="muted">${esc(u.length > 80 ? u.slice(0, 77) + '…' : u)}</small></li>`).join('')}</ul></section>`;
}

function reportPage(r, opts = {}) {
  const mech = String(r.mechanics || '').split('\n').filter(Boolean);
  const row = (label, o, c) => (o || c ? `<div class="crow"><div class="clabel">${label}</div><div>${o || '<span class="muted">Unknown</span>'}</div><div>${c || '<span class="muted">Unknown</span>'}</div></div>` : '');
  const steamUrl = (id) => (id ? `https://store.steampowered.com/app/${id}/` : null);
  return layout(`${r.clone_name} vs ${r.original_name}: clone comparison`, `
${r.status !== 'approved' ? `<p class="notice">This report is <strong>${esc(r.status)}</strong> and only visible to admins.</p>` : ''}
<article class="report">
  <h1><span class="tag clone">Clone</span> ${esc(r.clone_name)}</h1>
  <p class="lead">Reported as a clone of <strong>${esc(r.original_name)}</strong>. ${scoreBadge(r)}</p>
  <section class="compare" aria-label="Side-by-side comparison">
    <div class="crow chead"><div class="clabel"></div><div><span class="tag orig">Original</span></div><div><span class="tag clone">Clone</span></div></div>
    ${r.original_image || r.clone_image ? `<div class="crow"><div class="clabel"></div><div>${shot(r.original_image, r.original_name)}</div><div>${shot(r.clone_image, r.clone_name)}</div></div>` : ''}
    ${row('Game', `<strong>${link(r.original_url, r.original_name)}</strong>`, `<strong>${link(r.clone_url, r.clone_name)}</strong>`)}
    ${row('Developer', devLink(r.original_developer), devLink(r.clone_developer))}
    ${row('Released', date(r.original_released), date(r.clone_released))}
    ${row('Platform', r.platform ? '<span class="muted">Not listed</span>' : '', esc(r.platform))}
    ${row('Steam', r.original_steam_appid ? link(steamUrl(r.original_steam_appid), 'Store page') : '', r.clone_steam_appid ? link(steamUrl(r.clone_steam_appid), 'Store page') : '')}
  </section>
  ${releaseNote(r)}
  <p class="links">${r.original_url ? `<a class="btn" href="${esc(r.original_url)}" rel="nofollow ugc noopener" target="_blank">Go to the original</a>` : ''}
    <a class="btn ghost" href="${treeUrl(r.original_name)}">Family tree of ${esc(r.original_name)}</a>
    <a class="btn ghost" href="/follow?game=${encodeURIComponent(r.original_name)}">Follow ${esc(r.original_name)}</a></p>
  ${mech.length ? `<section><h2>What they share</h2><ul class="chips">${mech.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
  ${r.notes ? `<section><h2>Details from the reporter</h2><p class="notes">${esc(r.notes)}</p></section>` : ''}
  ${evidenceList(r.evidence)}
  ${(opts.responses || []).map((d) => `<section class="box response"><h2>Response from ${esc(d.name)}</h2>
    <p class="muted">${esc(ROLES[d.role] || 'Response')} · ${date(d.created_at)}</p><p class="notes">${esc(d.message)}</p>${evidenceList(d.links, 'Their links')}</section>`).join('')}
  ${r.status === 'approved' ? voteBox(r, opts) : ''}
  <p class="muted">Reported ${date(r.created_at)}. This is a community claim reviewed by a moderator, not a legal finding.
    <a href="/report/${r.id}/history">Edit history</a>${r.status === 'approved' ? ` · <a href="/report/${r.id}/dispute">Are you the developer? Dispute this report</a>` : ''}</p>
</article>`);
}

function gamePage(g, { clones, asClone }) {
  const steam = steamLink(g);
  return layout(`${g.name}: original game, not a clone`, `
<article class="report">
  <h1><span class="tag orig">Not a clone</span> ${esc(g.name)}</h1>
  <p class="lead">${esc(g.name)} is an original game${g.developer ? ` made by <strong>${esc(g.developer)}</strong>` : ''}. It is not a copy of another game.</p>
  <p class="muted">${g.source === 'steam-scan'
    ? `Listed automatically: one of Steam's most-owned games${g.positive_pct ? `, with ${esc(g.positive_pct)}% positive reviews out of ${esc(Number(g.reviews || 0).toLocaleString('en-US'))}` : ''}, and no approved clone reports.`
    : g.source === 'classic-scan'
      ? `Listed automatically: a well-known console game${g.wiki_langs ? ` with Wikipedia articles in ${esc(g.wiki_langs)} languages` : ''}, not marked as based on or inspired by another game, and with no approved clone reports.`
      : 'Checked by Clone Report.'} If you think this game copies another, <a href="/submit?clone_name=${encodeURIComponent(g.name)}">report it</a>.</p>
  ${asClone.length ? `<p class="notice">Note: ${asClone.length} community report${asClone.length === 1 ? '' : 's'} claim${asClone.length === 1 ? 's' : ''} this game copies another: ${asClone.map((r) => `<a href="/report/${r.id}">${esc(r.original_name)}</a>`).join(', ')}.</p>` : ''}
  <section class="box">
    <dl>
      <dt>Game</dt><dd>${esc(g.name)}</dd>
      ${g.developer ? `<dt>Developer</dt><dd>${devLink(g.developer)}</dd>` : ''}
      ${g.publisher ? `<dt>Publisher</dt><dd>${esc(g.publisher)}</dd>` : ''}
      <dt>${g.platforms && !g.steam_appid && !g.eshop_url ? 'Platforms' : 'Available on'}</dt><dd>${esc(stores(g))}</dd>
      ${g.year ? `<dt>Released</dt><dd>${esc(g.year)}</dd>` : ''}
    </dl>
    <p class="links">
      ${steam ? `<a class="btn" href="${esc(steam)}" rel="noopener" target="_blank">View on Steam</a>` : ''}
      ${g.eshop_url ? `<a class="btn" href="${esc(g.eshop_url)}" rel="noopener" target="_blank">View on Nintendo eShop</a>` : ''}
      ${g.wiki_url ? `<a class="btn ghost" href="${esc(g.wiki_url)}" rel="noopener" target="_blank">Read about it on Wikipedia</a>` : ''}
    </p>
  </section>
  <h2>Clones of ${esc(g.name)}</h2>
  ${clones.length ? `<ul class="cards">${clones.map(card).join('')}</ul>` : `<p class="muted">No clones of this game have been reported yet.</p>`}
  <p class="links"><a href="/submit?original_name=${encodeURIComponent(g.name)}">Report a clone of ${esc(g.name)}</a>
    ${clones.length || asClone.length ? `· <a href="${treeUrl(g.name)}">See the family tree</a>` : ''}
    · <a href="/follow?game=${encodeURIComponent(g.name)}">Get alerts for new clones</a></p>
</article>`);
}

function originalsPage(games, { storeFilter = '', page = 1, pages = 1, total = games.length } = {}) {
  const qs = (o) => { const u = new URLSearchParams(); if (o.store) u.set('store', o.store); if (o.page > 1) u.set('page', o.page); const t = u.toString(); return '/originals' + (t ? '?' + t : ''); };
  const tab = (key, label) => `<a class="tab${storeFilter === key ? ' on' : ''}" href="${qs({ store: key })}">${label}</a>`;
  const nav = pages > 1 ? `<nav class="pager">
    ${page > 1 ? `<a class="btn small ghost" href="${qs({ store: storeFilter, page: page - 1 })}">Previous</a>` : ''}
    <span class="muted">Page ${page} of ${pages}</span>
    ${page < pages ? `<a class="btn small ghost" href="${qs({ store: storeFilter, page: page + 1 })}">Next</a>` : ''}
  </nav>` : '';
  return layout('Original games', `
<h1>Original games</h1>
<p>Games from Steam, the Nintendo eShop and classic consoles that are originals, not clones. Search any of them to see whether someone has copied it.</p>
<nav class="tabs">${tab('', 'All')}${tab('steam', 'Steam')}${tab('nintendo', 'Nintendo eShop')}${tab('classic', 'Classic consoles')}</nav>
<p class="muted">${total.toLocaleString('en-US')} game${total === 1 ? '' : 's'}</p>
<ul class="cards">${games.map(originalCard).join('')}</ul>
${nav}`);
}

function adminOriginalsPage(q, rows, total, scan, classicScan = {}) {
  const row = (g) => `<li class="admin-row">
  <div>
    <a href="/game/${g.id}"><strong>${esc(g.name)}</strong></a>${g.developer ? ` <span class="muted">by ${esc(g.developer)}</span>` : ''}
    <div class="muted">#${g.id} · ${g.source === 'steam-scan' ? `auto from Steam${g.positive_pct ? ` (${esc(g.positive_pct)}% positive, ${esc(g.reviews)} reviews)` : ''}`
      : g.source === 'classic-scan' ? `auto from Wikidata (${esc(g.wiki_langs)} languages)` : 'hand-checked'} · ${esc(stores(g))}${g.year ? ' · ' + esc(g.year) : ''}</div>
  </div>
  <div class="actions">
    <form method="post" action="/admin/originals/${g.id}/remove?q=${encodeURIComponent(q)}"><button class="btn small danger">Remove</button></form>
  </div>
</li>`;
  const scanLine = scan.running ? `Steam scan running since ${esc(scan.lastStart)} (${esc(scan.lastAdded)} added so far).`
    : scan.lastEnd ? `Last Steam scan finished ${esc(scan.lastEnd)}, added ${esc(scan.lastAdded)}${scan.lastError ? `, stopped early: ${esc(scan.lastError)}` : ''}.`
    : 'The Steam scan has not run since the server started.';
  return layout('Admin: original games', `<h1>Original games</h1>
<nav class="tabs"><a class="tab" href="/admin">Reports</a><a class="tab on" href="/admin/originals">Original games (${total})</a></nav>
<p class="muted">${scanLine} ${classicScan.running ? 'Classic console scan running now.' : classicScan.lastEnd ? `Last classic console scan finished ${esc(classicScan.lastEnd)}, added ${esc(classicScan.lastAdded)}.` : ''} Removing a game keeps it off the list for good: the scanner and the seed file will not add it back.</p>
<form class="big-search" action="/admin/originals" method="get"><input name="q" value="${esc(q)}" placeholder="Find a game to remove" aria-label="Find a game"><button class="btn">Find</button></form>
${rows.length ? `<ul class="admin-list">${rows.map(row).join('')}</ul>` : '<p class="muted">No games found.</p>'}`);
}

const field = (name, label, v, { type = 'text', required = false, hint = '', placeholder = '', max = 120 } = {}) => `
<label class="field">
  <span>${esc(label)}${required ? ' <em>*</em>' : ''}</span>
  <input type="${type}" name="${name}" value="${esc(v[name])}" maxlength="${type === 'url' ? 500 : max}" ${required ? 'required' : ''} placeholder="${esc(placeholder)}">
  ${hint ? `<small>${esc(hint)}</small>` : ''}
</label>`;

function submitPage({ token, values = {}, errors = [] }) {
  const v = values;
  return layout('Report a clone', `
<h1>Report a cloned game</h1>
<p>Tell us which game copied which. A moderator checks each report before it goes public.</p>
${errors.length ? `<div class="errors" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form class="report-form" method="post" action="/submit">
  <input type="hidden" name="token" value="${esc(token)}">
  <div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
  <fieldset>
    <legend>The original game</legend>
    ${field('original_name', 'Game name', v, { required: true, placeholder: 'e.g. Flappy Bird' })}
    ${field('original_developer', 'Developer or studio', v)}
    ${field('original_url', 'Link to the original (store page or website)', v, { type: 'url', placeholder: 'https://' })}
    ${field('original_released', 'Release date', v, { placeholder: 'e.g. 2013 or 2013-05-24', max: 10 })}
    ${field('original_image', 'Screenshot link (optional)', v, { type: 'url', placeholder: 'https://' })}
  </fieldset>
  <fieldset>
    <legend>The clone</legend>
    ${field('clone_name', 'Clone name', v, { required: true })}
    ${field('clone_developer', 'Clone developer or studio', v)}
    ${field('clone_url', 'Link to the clone', v, { type: 'url', placeholder: 'https://' })}
    ${field('platform', 'Platform', v, { placeholder: 'e.g. iOS, Android, Steam, web', max: 60 })}
    ${field('clone_released', 'Release date', v, { placeholder: 'e.g. 2014 or 2014-01-30', max: 10 })}
    ${field('clone_image', 'Screenshot link (optional)', v, { type: 'url', placeholder: 'https://' })}
  </fieldset>
  <label class="field">
    <span>Shared mechanics</span>
    <input name="mechanics" value="${esc(v.mechanics)}" maxlength="600" placeholder="e.g. tap to flap, pipes as obstacles, one-button controls">
    <small>Separate them with commas. Steam games get their release dates and images filled in automatically.</small>
  </label>
  <label class="field">
    <span>What was copied?</span>
    <textarea name="notes" rows="5" maxlength="2000" placeholder="Gameplay, art, name, code, level design… Links to comparisons or screenshots help.">${esc(v.notes)}</textarea>
  </label>
  <label class="field">
    <span>Evidence links</span>
    <textarea name="evidence" rows="3" maxlength="4000" placeholder="https://youtube.com/… comparison video&#10;https://… article">${esc(v.evidence)}</textarea>
    <small>Up to 8 links, one per line: comparison videos, articles, screenshots.</small>
  </label>
  ${field('contact', 'Your email (optional, private)', v, { type: 'email', hint: 'Only moderators see this, in case we have questions.', max: 200 })}
  <button class="btn">Submit report</button>
</form>`);
}

const thanksPage = () => layout('Thanks', `
<h1>Thanks for your report</h1>
<p>A moderator will review it soon. Once approved, it will show up in search.</p>
<p><a class="btn" href="/">Back to search</a></p>`);

function adminPage(status, rows, counts, openDisputes = 0) {
  const tabs = ['pending', 'approved', 'rejected'].map((s) =>
    `<a class="tab${s === status ? ' on' : ''}" href="/admin?status=${s}">${s} (${counts[s] || 0})</a>`).join('');
  const action = (r, act, label, cls = '') =>
    `<form method="post" action="/admin/${r.id}/${act}?back=${status}"><button class="btn small ${cls}">${label}</button></form>`;
  const row = (r) => `<li class="admin-row">
  <div>
    <a href="/report/${r.id}"><strong>${esc(r.clone_name)}</strong> → ${esc(r.original_name)}</a>
    <div class="muted">#${r.id} · ${date(r.created_at)}${r.platform ? ' · ' + esc(r.platform) : ''}${r.contact ? ' · contact: ' + esc(r.contact) : ''}</div>
    <div class="muted">Original: ${link(r.original_url, r.original_url || 'no link')} · Clone: ${link(r.clone_url, r.clone_url || 'no link')}</div>
    ${r.notes ? `<p class="notes">${esc(r.notes)}</p>` : ''}
  </div>
  <div class="actions">
    ${status !== 'approved' ? action(r, 'approve', 'Approve') : ''}
    ${status !== 'rejected' ? action(r, 'reject', 'Reject', 'ghost') : ''}
    <a class="btn small ghost" href="/admin/${r.id}/edit">Edit</a>
    ${action(r, 'delete', 'Delete', 'danger')}
  </div>
</li>`;
  return layout('Admin', `<h1>Moderation</h1><nav class="tabs">${tabs}<a class="tab" href="/admin/disputes">Disputes (${openDisputes} open)</a><a class="tab" href="/admin/originals">Original games</a></nav>
${rows.length ? `<ul class="admin-list">${rows.map(row).join('')}</ul>` : `<p class="muted">Nothing here.</p>`}`);
}

function adminEditPage(r, { values, errors = [] }) {
  const v = { ...values };
  return layout(`Edit report #${r.id}`, `
<h1>Edit report #${r.id}</h1>
<p><a href="/report/${r.id}">View the report</a> · <a href="/admin?status=${esc(r.status)}">Back to moderation</a></p>
${errors.length ? `<div class="errors" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form class="report-form" method="post" action="/admin/${r.id}/edit">
  <fieldset>
    <legend>The original game</legend>
    ${field('original_name', 'Game name', v, { required: true })}
    ${field('original_developer', 'Developer or studio', v)}
    ${field('original_url', 'Link', v, { type: 'url' })}
    ${field('original_released', 'Release date', v, { max: 10 })}
    ${field('original_image', 'Screenshot link', v, { type: 'url' })}
  </fieldset>
  <fieldset>
    <legend>The clone</legend>
    ${field('clone_name', 'Clone name', v, { required: true })}
    ${field('clone_developer', 'Developer or studio', v)}
    ${field('clone_url', 'Link', v, { type: 'url' })}
    ${field('platform', 'Platform', v, { max: 60 })}
    ${field('clone_released', 'Release date', v, { max: 10 })}
    ${field('clone_image', 'Screenshot link', v, { type: 'url' })}
  </fieldset>
  <label class="field"><span>Shared mechanics (one per line or comma separated)</span>
    <textarea name="mechanics" rows="4" maxlength="600">${esc(v.mechanics)}</textarea></label>
  <label class="field"><span>Details</span><textarea name="notes" rows="6" maxlength="2000">${esc(v.notes)}</textarea></label>
  <label class="field"><span>Evidence links (one per line, up to 8)</span><textarea name="evidence" rows="4" maxlength="4000">${esc(v.evidence)}</textarea></label>
  <button class="btn">Save changes</button>
</form>`);
}

// ---------- disputes and history ----------
function disputePage(r, { token, values = {}, errors = [] }) {
  const v = values;
  const opt = (k, label) => `<label class="radio"><input type="radio" name="role" value="${k}" ${v.role === k ? 'checked' : ''} required> ${esc(label)}</label>`;
  return layout(`Dispute: ${r.clone_name}`, `
<h1>Dispute this report</h1>
<p>Report: <a href="/report/${r.id}"><strong>${esc(r.clone_name)}</strong> reported as a clone of <strong>${esc(r.original_name)}</strong></a>.</p>
<p class="muted">If you made one of these games and think the report is wrong or unfair, tell us why. A moderator reads every message and may update or remove the report, or publish your response next to it. Your email stays private.</p>
${errors.length ? `<div class="errors" role="alert"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form class="report-form" method="post" action="/report/${r.id}/dispute">
  <input type="hidden" name="token" value="${esc(token)}">
  <div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
  <fieldset><legend>Who are you?</legend>
    ${opt('clone-developer', `I made ${r.clone_name} (the game reported as a clone)`)}
    ${opt('original-developer', `I made ${r.original_name} (the original)`)}
    ${opt('other', 'Something else')}
    ${field('name', 'Your name or studio', v, { required: true })}
    ${field('contact', 'Email (private)', v, { type: 'email', required: true, max: 200, hint: 'Only moderators see this.' })}
  </fieldset>
  <label class="field"><span>Why is the report wrong? <em>*</em></span>
    <textarea name="message" rows="7" maxlength="4000" required>${esc(v.message)}</textarea>
    <small>If we publish a response, this is the text people will see.</small></label>
  <label class="field"><span>Supporting links (optional, one per line)</span>
    <textarea name="links" rows="3" maxlength="2000" placeholder="e.g. design documents, earlier release dates, licenses">${esc(v.links)}</textarea></label>
  <button class="btn">Send dispute</button>
</form>`);
}

const disputeThanksPage = (id) => layout('Dispute received', `
<h1>Thanks, we got your message</h1>
<p>A moderator will review it and may contact you by email.</p>
<p><a class="btn" href="/report/${id}">Back to the report</a></p>`);

const FIELD_LABELS = { clone_name: 'Clone name', clone_url: 'Clone link', clone_developer: 'Clone developer', original_name: 'Original name',
  original_url: 'Original link', original_developer: 'Original developer', platform: 'Platform', notes: 'Details', clone_released: 'Clone release date',
  original_released: 'Original release date', clone_image: 'Clone image', original_image: 'Original image', mechanics: 'Shared mechanics',
  evidence: 'Evidence', status: 'Status' };
const ACTORS = { reporter: 'Reporter', admin: 'Moderator', steam: 'Steam', developer: 'Developer', seed: 'Clone Report' };
function historyPage(r, rows) {
  const val = (x) => (x == null || x === '' ? '<span class="muted">empty</span>' : `<span class="notes">${esc(x)}</span>`);
  return layout(`Edit history: ${r.clone_name}`, `
<h1>Edit history</h1>
<p><a href="/report/${r.id}"><strong>${esc(r.clone_name)}</strong> reported as a clone of <strong>${esc(r.original_name)}</strong></a></p>
<ol class="history">${rows.map((h) => `<li><div><strong>${esc(h.action[0].toUpperCase() + h.action.slice(1))}</strong>
  <span class="muted">by ${esc(ACTORS[h.actor] || h.actor)} · ${esc(String(h.created_at).slice(0, 16))} UTC</span></div>
  ${h.changes ? `<dl>${Object.entries(h.changes).map(([k, [a, b]]) => `<dt>${esc(FIELD_LABELS[k] || k)}</dt><dd>${val(a)} → ${val(b)}</dd>`).join('')}</dl>` : ''}</li>`).join('')}</ol>
<p class="muted">Changes made before edit history was added are not listed.</p>`);
}

function adminDisputesPage(status, rows, counts) {
  const tabs = ['open', 'published', 'dismissed'].map((s) => `<a class="tab${s === status ? ' on' : ''}" href="/admin/disputes?status=${s}">${s} (${counts[s] || 0})</a>`).join('');
  const action = (d, act, label, cls = '') => `<form method="post" action="/admin/disputes/${d.id}/${act}?back=${status}"><button class="btn small ${cls}">${label}</button></form>`;
  const row = (d) => `<li class="admin-row">
  <div>
    <a href="/report/${d.report_id}"><strong>${esc(d.clone_name || 'deleted report')}</strong> → ${esc(d.original_name || '')}</a>
    <div class="muted">#${d.id} · ${date(d.created_at)} · ${esc(d.name)} · ${esc(ROLES[d.role] || d.role)} · ${esc(d.contact)}</div>
    <p class="notes">${esc(d.message)}</p>
    ${d.links ? `<div class="muted">${d.links.split('\n').map((u) => link(u, u)).join('<br>')}</div>` : ''}
  </div>
  <div class="actions">
    ${status !== 'published' ? action(d, 'publish', 'Publish response') : ''}
    ${status !== 'dismissed' ? action(d, 'dismiss', 'Dismiss', 'ghost') : ''}
    ${status !== 'open' ? action(d, 'reopen', 'Reopen', 'ghost') : ''}
    <a class="btn small ghost" href="/admin/${d.report_id}/edit">Edit report</a>
  </div>
</li>`;
  return layout('Admin: disputes', `<h1>Disputes</h1>
<nav class="tabs"><a class="tab" href="/admin">Reports</a>${tabs}<a class="tab" href="/admin/originals">Original games</a></nav>
<p class="muted">Publishing shows the developer's message on the report page as their response. To remove a report, reject it from Reports.</p>
${rows.length ? `<ul class="admin-list">${rows.map(row).join('')}</ul>` : '<p class="muted">Nothing here.</p>'}`);
}

// ---------- alerts and API ----------
function followPage(game, { token = '', emailOn = false, done = '', error = '', email = '' } = {}) {
  const feed = `/feed.xml?game=${encodeURIComponent(game)}`;
  const msg = { sent: 'Check your inbox: we sent a link to confirm. No alerts are sent until you click it.',
    confirmed: `You're all set. We'll email you when a new clone of ${game} is reported.`,
    unsubscribed: `You won't get any more emails about ${game}.` }[done];
  return layout(`Follow ${game}`, `
<h1>Follow ${esc(game)}</h1>
<p>Get told when someone reports a new clone of ${esc(game)} and a moderator approves it.</p>
${msg ? `<p class="notice" role="status">${esc(msg)}</p>` : ''}
${emailOn && !done ? `<form class="report-form" method="post" action="/follow?game=${encodeURIComponent(game)}">
  <input type="hidden" name="token" value="${esc(token)}">
  <div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
  ${error ? `<div class="errors" role="alert"><ul><li>${esc(error)}</li></ul></div>` : ''}
  <label class="field"><span>Email</span><input type="email" name="email" value="${esc(email)}" required maxlength="200">
    <small>We send one confirmation email, then one email per new clone. Every email has an unsubscribe link.</small></label>
  <button class="btn">Email me</button>
</form>` : ''}
<h2>RSS</h2>
<p>Add this feed to any RSS reader: <a href="${esc(feed)}">${esc(feed)}</a></p>
<p class="muted">There is also a feed of <a href="/feed.xml">every new report</a>, and one per developer at <code>/feed.xml?dev=&lt;developer&gt;</code>.</p>`);
}

function apiDocsPage(base) {
  const ep = (path, desc, example) => `<section class="box"><h2><code>GET ${esc(path)}</code></h2><p>${desc}</p>
    <p class="muted">Example: <a href="${esc(example)}"><code>${esc(base + example)}</code></a></p></section>`;
  return layout('API', `
<h1>Public API</h1>
<p>Free, read-only JSON for other sites, bots and tools. No key needed. CORS is open, responses are cached for 5 minutes,
and each IP can make 120 requests a minute. Only approved reports are included. Please link back to the report pages you use.</p>
${ep('/api/v1/games?appid=&name=', 'Clone status of one game: <code>reported-clone</code>, <code>verified-original</code>, <code>cloned-by-others</code> or <code>unknown</code>, with the reports in both directions and the highest clone score.', '/api/v1/games?name=Flappy%20Bird')}
${ep('/api/v1/reports?q=&developer=&since_id=&limit=&offset=', 'Approved reports, newest first. <code>q</code> searches game and developer names, <code>developer</code> takes a developer key (as in <code>/dev/&lt;key&gt;</code>), <code>since_id</code> returns only newer reports, <code>limit</code> is at most 100.', '/api/v1/reports?limit=5')}
${ep('/api/v1/reports/:id', 'One report with notes, evidence links, votes, clone score, verdict and published developer responses.', '/api/v1/reports/1')}
${ep('/api/v1/developers/:key', 'Every report about a developer, and its listed original games.', '/api/v1/developers/supercell')}
${ep('/api/v1/tree?game=', 'Family tree of a game: what it copies and what copied it, nested.', '/api/v1/tree?game=Tetris')}
<h2>Report fields</h2>
<p><code>clone</code> and <code>original</code> each have <code>name</code>, <code>developer</code>, <code>url</code>, <code>steamAppid</code>, <code>steamUrl</code>, <code>released</code> and <code>image</code>.
<code>votes</code> counts <code>clone</code>, <code>inspired</code> and <code>original</code> votes. <code>cloneScore</code> (0–100) is the share of "clone" votes with "inspired by" counting half, and
<code>verdict</code> is set once a report has 3 votes.</p>
<p class="muted">Feeds: <a href="/feed.xml">/feed.xml</a>, <code>/feed.xml?game=&lt;name&gt;</code>, <code>/feed.xml?dev=&lt;key&gt;</code>. The older <code>/api/lookup</code> endpoint used by the browser extension still works.</p>`);
}

// ---------- developer pages ----------
function developerPage(key, name, { cloned, wasCloned, originals }) {
  const repeat = cloned.length >= 3;
  return layout(`${name}: games and clone reports`, `
<article class="report">
  <h1>${esc(name)}</h1>
  <p class="lead">${[
    cloned.length ? `<strong>${cloned.length}</strong> game${cloned.length === 1 ? '' : 's'} reported as clones` : '',
    wasCloned.length ? `<strong>${wasCloned.length}</strong> report${wasCloned.length === 1 ? '' : 's'} of others cloning their games` : '',
    originals.length ? `<strong>${originals.length}</strong> original game${originals.length === 1 ? '' : 's'} listed` : '',
  ].filter(Boolean).join(' · ') || 'No approved reports yet.'}</p>
  ${repeat ? `<p class="notice">Repeat reports: the community has reported ${cloned.length} games from this developer as clones.</p>` : ''}
  ${cloned.length ? `<h2>Reported as clones</h2><ul class="cards">${cloned.map(card).join('')}</ul>` : ''}
  ${wasCloned.length ? `<h2>Their games that others cloned</h2><ul class="cards">${wasCloned.map(card).join('')}</ul>` : ''}
  ${originals.length ? `<h2>Original games</h2><ul class="cards">${originals.map(originalCard).join('')}</ul>` : ''}
  <p class="muted">Reports are matched by the developer name given in each report. <a href="/developers">All developers</a></p>
</article>`);
}

function developersPage({ cloners, cloned }) {
  const list = (rows, one, many) => (rows.length ? `<ol class="rank">${rows.map((d) => `<li><a href="/dev/${esc(d.dev_key)}">${esc(d.name)}</a>
    <span class="muted">${d.n} ${d.n === 1 ? one : many}</span></li>`).join('')}</ol>` : '<p class="muted">No reports yet.</p>');
  return layout('Developers', `
<h1>Developers</h1>
<p>Studios ranked by approved community reports. Open one to see every report about it.</p>
<div class="grid2">
  <section><h2>Most reported for cloning</h2>${list(cloners, 'game reported as a clone', 'games reported as clones')}</section>
  <section><h2>Most cloned</h2>${list(cloned, 'clone report', 'clone reports')}</section>
</div>`);
}

// ---------- family trees ----------
function treeList(nodes, label) {
  if (!nodes.length) return '';
  return `<ul class="tree">${nodes.map((n) => `<li><a href="${treeUrl(n.name)}">${esc(n.name)}</a>
    <a class="muted small-link" href="/report/${n.report}">${label}</a>${treeList(n.children, label)}</li>`).join('')}</ul>`;
}
function treePage(q, t) {
  if (!t) return layout('Family tree', `<h1>Family tree</h1>
<form class="big-search" action="/tree" method="get"><input name="game" value="${esc(q)}" placeholder="Game name" aria-label="Game name" required><button class="btn">Show tree</button></form>
${q ? `<p>No approved reports mention “${esc(q)}”. <a href="/search?q=${encodeURIComponent(q)}">Search instead</a>.</p>` : '<p>Type a game to see what it copied and what copied it.</p>'}`, { q });
  return layout(`${t.name}: family tree`, `
<h1>Family tree of ${esc(t.name)}</h1>
<p class="muted">Built from approved community reports. Click a game to center the tree on it.</p>
<div class="grid2">
  <section class="box"><h2>${esc(t.name)} copies</h2>${t.ancestors.length ? treeList(t.ancestors, 'report') : '<p class="muted">Nothing reported. As far as Clone Report knows, it is an original.</p>'}</section>
  <section class="box"><h2>Copied by</h2>${t.descendants.length ? treeList(t.descendants, 'report') : '<p class="muted">No clones reported yet.</p>'}</section>
</div>
<p><a href="/search?q=${encodeURIComponent(t.name)}">Search reports for ${esc(t.name)}</a></p>`, { q });
}

// Privacy policy for the site and the Clone Report browser extension. The
// Chrome Web Store listing links here, so keep it in step with what the
// extension actually sends (chrome-extension/background.js).
const privacyPage = () => layout('Privacy policy', `<article class="prose">
<h1>Privacy policy</h1>
<p class="muted">Last updated 11 November 2026</p>
<p>This policy covers clonereport.com and the Clone Report browser extension. We collect as little as we can, we never sell data, and we do not use advertising or analytics trackers.</p>

<h2>The Clone Report browser extension</h2>
<p>The extension checks whether the game you are looking at has been reported as a clone, or has been cloned. It runs only on game pages of these stores: Steam, PlayStation Store, Xbox and the Microsoft Store, Nintendo eShop, the App Store, Google Play and itch.io.</p>
<p><strong>What it sends.</strong> When you open a game page on one of those stores, the extension sends three things to clonereport.com: which store it is (for example "steam"), the game's id from the page address, and the game's name as shown on the page. Nothing else from the page is read or sent. It does not read your browsing history, your account on the store, cookies, passwords, payment details or anything you type.</p>
<p><strong>What it stores.</strong> Lookup results are kept in your browser's session storage for five minutes so the same page is not looked up twice, and are deleted when you close the browser. If you change the site address in the extension's settings, that one setting is saved with Chrome's sync storage. Nothing is stored on our servers about you or your lookups beyond the standard web server request logs described below.</p>
<p><strong>What it shows.</strong> If there is a report, the extension adds a banner to the store page and a badge to its toolbar icon. It does not change anything else on the page.</p>
<p>The extension contains no remote code, no ads and no trackers. Its use of data complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.</p>

<h2>The website</h2>
<p><strong>Reports you submit.</strong> When you report a clone we store what you enter in the form: game names, links, developers, platform and notes. These appear publicly once a moderator approves the report. The optional email field is private: only moderators see it, and only to ask you about your report.</p>
<p><strong>Spam protection.</strong> To limit spam we store a one-way keyed hash of your IP address with each submission and use it to count submissions per hour. We do not store the IP address itself.</p>
<p><strong>Votes.</strong> When you vote on a report we store your choice with a one-way keyed hash of your IP address, so each visitor has one vote per report and the number of votes per hour can be limited. Only vote totals are shown.</p>
<p><strong>Disputes.</strong> If you dispute a report, we store your name, role, email and message. Moderators see all of it; if they publish your response, your name, role and message appear on the report page. Your email is never shown.</p>
<p><strong>Email alerts.</strong> If you follow a game, we store your email address and the game's name, and send a confirmation email first. Nothing else is sent until you confirm. Every alert has a link that deletes your follow at once. Alert emails are delivered by our email provider, Resend, which receives your address and the message only to deliver it.</p>
<p><strong>Images from other sites.</strong> Report pages can show game images hosted elsewhere, such as Steam's image servers. Your browser loads them directly from those sites, which can see your IP address, as with any image on the web.</p>
<p><strong>Request logs.</strong> Like any website, our hosting provider keeps short-lived server logs (IP address, time, page requested, browser type) for security and debugging.</p>
<p><strong>Cookies.</strong> The site does not set cookies for visitors.</p>

<h2>Sharing</h2>
<p>We do not sell, rent or share personal data with third parties, except our hosting provider, which runs the site on our behalf, our email provider for alert emails, or when the law requires it.</p>

<h2>Your choices</h2>
<p>You can uninstall the extension at any time from your browser's extensions page, which removes everything it stored. To stop email alerts, use the unsubscribe link in any alert. To have a report you submitted, or your email, removed, submit a request through the <a href="/submit">report form</a> mentioning the report, or use the contact email on the extension's Chrome Web Store page.</p>

<h2>Changes</h2>
<p>If we change what the extension or the site collects, we will update this page and the date at the top before the change takes effect.</p>
</article>`);

const notFound = () => layout('Not found', `<h1>Not found</h1><p>That page does not exist. <a href="/">Search for a game</a>.</p>`);

module.exports = { esc, layout, home, searchPage, reportPage, gamePage, originalsPage, adminOriginalsPage, submitPage, thanksPage, adminPage, adminEditPage, adminDisputesPage, disputePage, disputeThanksPage, historyPage, apiDocsPage, followPage, developerPage, developersPage, treePage, notFound, privacyPage };
