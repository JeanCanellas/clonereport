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

function home(recent, total) {
  return layout('Find the original game', `
<section class="hero">
  <h1>Is this game a clone?</h1>
  <p>Search any game to see whether it has been reported as a copy, and find the original it was based on.</p>
  <form class="big-search" action="/search" method="get" role="search">
    <input name="q" placeholder="Type a game name" aria-label="Game name" autofocus required>
    <button class="btn">Search</button>
  </form>
  <p class="muted">${total} approved report${total === 1 ? '' : 's'} so far. Was your game cloned? <a href="/submit">Report it</a>.</p>
</section>
${recent.length ? `<h2>Recently added</h2><ul class="cards">${recent.map(card).join('')}</ul>` : ''}`);
}

function searchPage(q, results) {
  const body = !q
    ? `<p>Type a game name to search.</p>`
    : results.length
      ? `<h1>Results for “${esc(q)}”</h1><ul class="cards">${results.map(card).join('')}</ul>
         <p class="muted">Know about another clone? <a href="/submit?clone_name=${encodeURIComponent(q)}">Report it</a>.</p>`
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
  return layout('Admin', `<h1>Moderation</h1><nav class="tabs">${tabs}</nav>
${rows.length ? `<ul class="admin-list">${rows.map(row).join('')}</ul>` : `<p class="muted">Nothing here.</p>`}`);
}

const notFound = () => layout('Not found', `<h1>Not found</h1><p>That page does not exist. <a href="/">Search for a game</a>.</p>`);

module.exports = { esc, layout, home, searchPage, reportPage, submitPage, thanksPage, adminPage, notFound };
