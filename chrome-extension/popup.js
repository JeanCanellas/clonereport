const statusEl = document.getElementById('status');

function el(tag, text, attrs = {}) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function list(entries) {
  const ul = el('ul');
  for (const e of entries) {
    const li = el('li');
    const href = e.url || e.steamUrl;
    li.append(href ? el('a', e.name, { href, target: '_blank' }) : e.name);
    if (e.storeName) li.append(` (${e.storeName})`);
    if (e.reportUrl) li.append(' (', el('a', 'report', { href: e.reportUrl, target: '_blank' }), ')');
    ul.append(li);
  }
  return ul;
}

document.getElementById('options').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

(async () => {
  const base = await chrome.runtime.sendMessage({ type: 'getApiBase' });
  const site = document.getElementById('site');
  site.href = base;
  site.textContent = new URL(base).host;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  // Ask the page which game it is showing now. No answer means the extension
  // isn't running there (not a game page, or the tab was open before install).
  let page = null;
  try { page = await chrome.tabs.sendMessage(tab.id, { type: 'whichGame' }); } catch {}
  if (!page) return;
  const key = `tab:${tab.id}`;
  const r = (await chrome.storage.session.get(key))[key];
  if (!r || r.game?.store !== page.store || String(r.game?.id) !== String(page.id)) {
    statusEl.textContent = 'Checking this game… Reopen this window in a few seconds.';
    return;
  }

  const gameName = r.game?.name || 'This game';
  statusEl.textContent = '';
  if (r.error) {
    statusEl.textContent = `Couldn't reach ${new URL(base).host}: ${r.error}`;
  } else if (!r.cloneOf.length && !r.clonedBy.length) {
    statusEl.append(`${gameName} has no clone reports. `);
    statusEl.append(el('a', 'Report a clone', { href: `${base}/submit?clone_name=${encodeURIComponent(r.game?.name || '')}`, target: '_blank' }));
  } else {
    if (r.cloneOf.length) {
      statusEl.classList.add('clone');
      statusEl.append(el('strong', `${gameName} is reported as a clone of:`), list(r.cloneOf));
    }
    if (r.clonedBy.length) {
      if (!r.cloneOf.length) statusEl.classList.add('cloned');
      statusEl.append(el('strong', `${gameName} has been cloned by:`), list(r.clonedBy));
    }
  }
})();
