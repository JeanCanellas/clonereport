'use strict';
// HTML templates. Every user-supplied value goes through esc().

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (url, text) => (url ? `<a href="${esc(url)}" rel="nofollow ugc noopener" target="_blank">${esc(text)}</a>` : esc(text));
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
  <p>Reports are submitted by the community and reviewed before they appear. They are claims, not legal findings.</p>
  <p><a href="/privacy">Privacy policy</a></p>
</footer>
</body>
</html>`;
}

function card(r) {
  return `<li class="card">
  <a class="card-link" href="/report/${r.id}">
    <div class="pair">
      <div><span class="tag clone">Clone</span><strong>${esc(r.clone_name)}</strong>${r.clone_developer ? `<small>by ${esc(r.clone_developer)}</small>` : ''}</div>
      <div class="arrow" aria-hidden="true">copies</div>
      <div><span class="tag orig">Original</span><strong>${esc(r.original_name)}</strong>${r.original_developer ? `<small>by ${esc(r.original_developer)}</small>` : ''}</div>
    </div>
  </a>
</li>`;
}

const steamLink = (g) => (g.steam_appid ? `https://store.steampowered.com/app/${g.steam_appid}/` : null);
const stores = (g) => [g.steam_appid && 'Steam', g.eshop_url && 'Nintendo eShop'].filter(Boolean).join(' · ');

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
  ${originals ? `<p class="muted"><a href="/originals">Browse ${originals.toLocaleString('en-US')} original games</a> from Steam and the Nintendo eShop that are not clones.</p>` : ''}
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

function reportPage(r) {
  return layout(`${r.clone_name} is a clone of ${r.original_name}`, `
${r.status !== 'approved' ? `<p class="notice">This report is <strong>${esc(r.status)}</strong> and only visible to admins.</p>` : ''}
<article class="report">
  <h1><span class="tag clone">Clone</span> ${esc(r.clone_name)}</h1>
  <p class="lead">Reported as a clone of <strong>${esc(r.original_name)}</strong>.</p>
  <div class="grid2">
    <section class="box">
      <h2>The original</h2>
      <dl>
        <dt>Game</dt><dd>${link(r.original_url, r.original_name)}</dd>
        ${r.original_developer ? `<dt>Developer</dt><dd>${esc(r.original_developer)}</dd>` : ''}
      </dl>
      ${r.original_url ? `<a class="btn" href="${esc(r.original_url)}" rel="nofollow ugc noopener" target="_blank">Go to the original</a>` : ''}
    </section>
    <section class="box">
      <h2>The clone</h2>
      <dl>
        <dt>Game</dt><dd>${link(r.clone_url, r.clone_name)}</dd>
        ${r.clone_developer ? `<dt>Developer</dt><dd>${esc(r.clone_developer)}</dd>` : ''}
        ${r.platform ? `<dt>Platform</dt><dd>${esc(r.platform)}</dd>` : ''}
      </dl>
    </section>
  </div>
  ${r.notes ? `<section><h2>Details from the reporter</h2><p class="notes">${esc(r.notes)}</p></section>` : ''}
  <p class="muted">Reported ${date(r.created_at)}. This is a community claim reviewed by a moderator, not a legal finding.</p>
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
    : 'Checked by Clone Report.'} If you think this game copies another, <a href="/submit?clone_name=${encodeURIComponent(g.name)}">report it</a>.</p>
  ${asClone.length ? `<p class="notice">Note: ${asClone.length} community report${asClone.length === 1 ? '' : 's'} claim${asClone.length === 1 ? 's' : ''} this game copies another: ${asClone.map((r) => `<a href="/report/${r.id}">${esc(r.original_name)}</a>`).join(', ')}.</p>` : ''}
  <section class="box">
    <dl>
      <dt>Game</dt><dd>${esc(g.name)}</dd>
      ${g.developer ? `<dt>Developer</dt><dd>${esc(g.developer)}</dd>` : ''}
      ${g.publisher ? `<dt>Publisher</dt><dd>${esc(g.publisher)}</dd>` : ''}
      <dt>Available on</dt><dd>${esc(stores(g))}</dd>
    </dl>
    <p class="links">
      ${steam ? `<a class="btn" href="${esc(steam)}" rel="noopener" target="_blank">View on Steam</a>` : ''}
      ${g.eshop_url ? `<a class="btn" href="${esc(g.eshop_url)}" rel="noopener" target="_blank">View on Nintendo eShop</a>` : ''}
    </p>
  </section>
  <h2>Clones of ${esc(g.name)}</h2>
  ${clones.length ? `<ul class="cards">${clones.map(card).join('')}</ul>` : `<p class="muted">No clones of this game have been reported yet.</p>`}
  <p><a href="/submit?original_name=${encodeURIComponent(g.name)}">Report a clone of ${esc(g.name)}</a></p>
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
<p>Games from Steam and the Nintendo eShop that are originals, not clones. Search any of them to see whether someone has copied it.</p>
<nav class="tabs">${tab('', 'All')}${tab('steam', 'Steam')}${tab('nintendo', 'Nintendo eShop')}</nav>
<p class="muted">${total.toLocaleString('en-US')} game${total === 1 ? '' : 's'}</p>
<ul class="cards">${games.map(originalCard).join('')}</ul>
${nav}`);
}

function adminOriginalsPage(q, rows, total, scan) {
  const row = (g) => `<li class="admin-row">
  <div>
    <a href="/game/${g.id}"><strong>${esc(g.name)}</strong></a>${g.developer ? ` <span class="muted">by ${esc(g.developer)}</span>` : ''}
    <div class="muted">#${g.id} · ${g.source === 'steam-scan' ? `auto from Steam${g.positive_pct ? ` (${esc(g.positive_pct)}% positive, ${esc(g.reviews)} reviews)` : ''}` : 'hand-checked'} · ${esc(stores(g))}</div>
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
<p class="muted">${scanLine} Removing a game keeps it off the list for good: the scanner and the seed file will not add it back.</p>
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
  </fieldset>
  <fieldset>
    <legend>The clone</legend>
    ${field('clone_name', 'Clone name', v, { required: true })}
    ${field('clone_developer', 'Clone developer or studio', v)}
    ${field('clone_url', 'Link to the clone', v, { type: 'url', placeholder: 'https://' })}
    ${field('platform', 'Platform', v, { placeholder: 'e.g. iOS, Android, Steam, web', max: 60 })}
  </fieldset>
  <label class="field">
    <span>What was copied?</span>
    <textarea name="notes" rows="5" maxlength="2000" placeholder="Gameplay, art, name, code, level design… Links to comparisons or screenshots help.">${esc(v.notes)}</textarea>
  </label>
  ${field('contact', 'Your email (optional, private)', v, { type: 'email', hint: 'Only moderators see this, in case we have questions.', max: 200 })}
  <button class="btn">Submit report</button>
</form>`);
}

const thanksPage = () => layout('Thanks', `
<h1>Thanks for your report</h1>
<p>A moderator will review it soon. Once approved, it will show up in search.</p>
<p><a class="btn" href="/">Back to search</a></p>`);

function adminPage(status, rows, counts) {
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
    ${action(r, 'delete', 'Delete', 'danger')}
  </div>
</li>`;
  return layout('Admin', `<h1>Moderation</h1><nav class="tabs">${tabs}<a class="tab" href="/admin/originals">Original games</a></nav>
${rows.length ? `<ul class="admin-list">${rows.map(row).join('')}</ul>` : `<p class="muted">Nothing here.</p>`}`);
}

// Privacy policy for the site and the Clone Report browser extension. The
// Chrome Web Store listing links here, so keep it in step with what the
// extension actually sends (chrome-extension/background.js).
const privacyPage = () => layout('Privacy policy', `<article class="prose">
<h1>Privacy policy</h1>
<p class="muted">Last updated 10 November 2026</p>
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
<p><strong>Request logs.</strong> Like any website, our hosting provider keeps short-lived server logs (IP address, time, page requested, browser type) for security and debugging.</p>
<p><strong>Cookies.</strong> The site does not set cookies for visitors.</p>

<h2>Sharing</h2>
<p>We do not sell, rent or share personal data with third parties, except our hosting provider, which runs the site on our behalf, or when the law requires it.</p>

<h2>Your choices</h2>
<p>You can uninstall the extension at any time from your browser's extensions page, which removes everything it stored. To have a report you submitted, or your email, removed, submit a request through the <a href="/submit">report form</a> mentioning the report, or use the contact email on the extension's Chrome Web Store page.</p>

<h2>Changes</h2>
<p>If we change what the extension or the site collects, we will update this page and the date at the top before the change takes effect.</p>
</article>`);

const notFound = () => layout('Not found', `<h1>Not found</h1><p>That page does not exist. <a href="/">Search for a game</a>.</p>`);

module.exports = { esc, layout, home, searchPage, reportPage, gamePage, originalsPage, adminOriginalsPage, submitPage, thanksPage, adminPage, notFound, privacyPage };
