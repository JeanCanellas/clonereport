// Runs on game store pages: Steam, PlayStation Store, Xbox / Microsoft Store,
// Nintendo eShop, App Store, Google Play and itch.io. stores.js (loaded first)
// turns the page address into a { store, id } pair; this file finds the game's
// name on the page, asks clonereport.com about it, and shows a banner.
(() => {
  const { parseStoreUrl, storeName } = self.CloneReportStores;

  // Where each store shows the game's name. The first match with text wins;
  // og:title and the document title are the fallbacks.
  const NAME_SELECTORS = {
    steam: ['#appHubAppName', '.apphub_AppName'],
    playstation: ['[data-qa="mfe-game-title#name"]', 'h1'],
    xbox: ['h1'],
    nintendo: ['h1'],
    appstore: ['h1.product-header__title', 'h1'],
    googleplay: ['h1 [itemprop="name"]', 'h1'],
    itch: ['h1.game_title', '.game_title'],
  };
  // Store suffixes to strip from og:title / document.title.
  const TITLE_SUFFIX = /\s*(?:on Steam|\| PlayStation Store|\|\s*Xbox|- Microsoft Store|\| Nintendo.*|on the App Store|- Apps on Google Play|by [^|]+ - itch\.io|- itch\.io)\s*$/i;

  function textOf(node) {
    if (!node) return '';
    // App Store headings include a badge like "4+" in a nested span; drop child badges.
    const clone = node.cloneNode(true);
    clone.querySelectorAll('.badge, .product-header__badge').forEach(n => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function findName(store) {
    for (const sel of NAME_SELECTORS[store] || []) {
      const t = textOf(document.querySelector(sel));
      if (t) return t.slice(0, 120);
    }
    const og = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
    return og.replace(TITLE_SUFFIX, '').trim().slice(0, 120);
  }

  // itch.io user pages share the address shape of game pages; only game pages
  // carry <meta name="itch:path" content="games/...">.
  const isGamePage = (store) => store !== 'itch' || /^games\//.test(document.querySelector('meta[name="itch:path"]')?.content || '');

  // Store pages built as single-page apps render the name late, so wait for it.
  async function waitForName(store) {
    for (let i = 0; i < 20; i++) {
      const sel = NAME_SELECTORS[store] || [];
      if (sel.some(s => textOf(document.querySelector(s)))) break;
      await new Promise(r => setTimeout(r, 400));
    }
    return findName(store);
  }

  let current = null; // the href we last looked up
  let banner = null;

  async function check() {
    if (location.href === current) return;
    current = location.href;
    banner?.remove();
    banner = null;

    const page = parseStoreUrl(location.href);
    if (!page || !isGamePage(page.store)) {
      chrome.runtime.sendMessage({ type: 'clear' }).catch(() => {});
      return;
    }
    const name = await waitForName(page.store);
    if (location.href !== current) return; // navigated away while waiting
    chrome.runtime.sendMessage({ type: 'lookup', store: page.store, id: page.id, name }, result => {
      if (chrome.runtime.lastError || !result || result.error) return; // stay quiet on errors; badge shows "?"
      if (location.href !== current) return;
      if (!result.cloneOf.length && !result.clonedBy.length) return;
      render(result, name, page.store);
    });
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function link(href, text) {
    return href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : el('span', {}, text);
  }

  function entryList(entries, pageStore) {
    const ul = el('ul', { class: 'cr-list' });
    for (const e of entries) {
      // Prefer a link to the same store the visitor is browsing, then any store link.
      const href = (pageStore === 'steam' && e.steamUrl) || e.url || e.steamUrl;
      const li = el('li', {}, el('strong', {}, link(href, e.name)));
      if (e.storeName && e.store !== pageStore) li.append(' ', el('span', { class: 'cr-summary' }, `(${e.storeName})`));
      if (e.developer) li.append(' ', el('span', { class: 'cr-summary' }, `by ${e.developer}`));
      if (e.summary) li.append(' ', el('span', { class: 'cr-summary' }, `— ${e.summary}`));
      if (e.reportUrl) li.append(' ', el('a', { class: 'cr-report', href: e.reportUrl, target: '_blank', rel: 'noopener noreferrer' }, 'View report'));
      ul.append(li);
    }
    return ul;
  }

  function render(result, name, pageStore) {
    const isClone = result.cloneOf.length > 0;
    banner = el('div', { class: `cr-banner ${isClone ? 'cr-clone' : 'cr-cloned'}`, role: 'alert' });

    if (isClone) {
      banner.append(
        el('div', { class: 'cr-title' }, '⚠ Reported as a clone'),
        el('div', { class: 'cr-text' }, `Clone Report users say ${name || 'this game'} is a clone of:`),
        entryList(result.cloneOf, pageStore)
      );
    }
    if (result.clonedBy.length) {
      if (isClone) banner.append(el('div', { class: 'cr-text cr-gap' }, 'It has also been cloned by:'));
      else banner.append(
        el('div', { class: 'cr-title' }, '★ This game has been cloned'),
        el('div', { class: 'cr-text' }, `Clone Report users say these games copy ${name || 'this game'}:`)
      );
      banner.append(entryList(result.clonedBy, pageStore));
    }

    const close = el('button', { class: 'cr-close', type: 'button', 'aria-label': 'Dismiss' }, '×');
    close.addEventListener('click', () => { banner.remove(); banner = null; });
    banner.append(
      close,
      el('div', { class: 'cr-footer' }, 'From ', link(result.siteUrl, result.siteUrl ? new URL(result.siteUrl).host : 'clonereport.com'),
        ` · ${storeName(pageStore)} page`)
    );

    // Steam pages are server-rendered, so the banner sits under the title.
    // The other stores re-render their pages, so it floats above them instead.
    const anchor = pageStore === 'steam' && (document.querySelector('.page_title_area') ||
      document.querySelector('.apphub_HomeHeaderContent') || document.querySelector('.page_content_ctn'));
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(banner, anchor.nextSibling);
    else {
      banner.classList.add('cr-float');
      document.body.append(banner);
    }
  }

  // The toolbar popup asks which game this tab is on, so it never shows an
  // older game's result after the store switched pages without reloading.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'whichGame') return;
    const page = parseStoreUrl(location.href);
    sendResponse(page && isGamePage(page.store) ? page : null);
  });

  check();
  // Most stores change pages without a reload; look again when the address changes.
  setInterval(check, 1000);
})();
