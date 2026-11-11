// Clone Report background service worker: does the API lookups (so CORS on the
// site doesn't matter), caches results briefly, and sets the toolbar badge.

const DEFAULT_API_BASE = 'https://clonereport.com';
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getApiBase() {
  const { apiBase } = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE });
  return String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
}

function emptyResult() {
  return { found: false, cloneOf: [], clonedBy: [] };
}

// Keep only well-formed entries and safe http(s) links.
function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
function normalizeEntry(e) {
  if (!e || typeof e.name !== 'string' || !e.name.trim()) return null;
  const appid = Number.isInteger(Number(e.appid)) && Number(e.appid) > 0 ? Number(e.appid) : null;
  return {
    name: e.name.trim().slice(0, 200),
    appid,
    steamUrl: safeUrl(e.steamUrl) || (appid ? `https://store.steampowered.com/app/${appid}/` : null),
    url: safeUrl(e.url),
    store: typeof e.store === 'string' ? e.store.slice(0, 20) : null,
    storeName: typeof e.storeName === 'string' && e.storeName.trim() ? e.storeName.trim().slice(0, 60) : null,
    developer: typeof e.developer === 'string' && e.developer.trim() ? e.developer.trim().slice(0, 120) : null,
    reportUrl: safeUrl(e.reportUrl),
    summary: typeof e.summary === 'string' ? e.summary.trim().slice(0, 300) : ''
  };
}
function normalize(data) {
  if (!data || typeof data !== 'object') return emptyResult();
  const cloneOf = (Array.isArray(data.cloneOf) ? data.cloneOf : []).map(normalizeEntry).filter(Boolean);
  const clonedBy = (Array.isArray(data.clonedBy) ? data.clonedBy : []).map(normalizeEntry).filter(Boolean);
  return { found: cloneOf.length > 0 || clonedBy.length > 0, cloneOf, clonedBy };
}

// store/id come from stores.js (e.g. { store: 'xbox', id: '9PP5G1F153J1' }).
async function lookup({ store, id, name }) {
  const base = await getApiBase();
  const key = `lookup:${base}:${store || ''}:${id || ''}:${(name || '').toLowerCase()}`;
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  const params = new URLSearchParams();
  // Steam lookups keep the original ?appid= form so older servers still answer them.
  if (store === 'steam' && id) params.set('appid', String(id));
  else if (store && id) { params.set('store', store); params.set('id', String(id)); }
  if (name) params.set('name', name);
  const res = await fetch(`${base}/api/lookup?${params}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Lookup failed (HTTP ${res.status})`);
  const result = normalize(await res.json());
  result.siteUrl = base;
  await chrome.storage.session.set({ [key]: { at: Date.now(), result } });
  return result;
}

function setBadge(tabId, result) {
  if (tabId == null) return;
  let text = '';
  let color = '#888888';
  let title = 'Clone Report: no reports for this game';
  if (result?.error) {
    text = '?';
    title = 'Clone Report: could not reach the site';
  } else if (result?.cloneOf?.length) {
    text = 'CLN';
    color = '#c62828';
    title = `Clone Report: reported as a clone of ${result.cloneOf.map(e => e.name).join(', ')}`;
  } else if (result?.clonedBy?.length) {
    text = String(result.clonedBy.length);
    color = '#ef6c00';
    title = `Clone Report: ${result.clonedBy.length} game(s) reported as copies of this one`;
  }
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setTitle({ tabId, title });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'lookup') {
    const tabId = sender.tab?.id;
    lookup(msg)
      .then(result => {
        const stored = { ...result, game: { store: msg.store, id: msg.id, name: msg.name } };
        if (tabId != null) chrome.storage.session.set({ [`tab:${tabId}`]: stored });
        setBadge(tabId, result);
        sendResponse(result);
      })
      .catch(err => {
        const stored = { ...emptyResult(), error: String(err.message || err), game: { store: msg.store, id: msg.id, name: msg.name } };
        if (tabId != null) chrome.storage.session.set({ [`tab:${tabId}`]: stored });
        setBadge(tabId, stored);
        sendResponse(stored);
      });
    return true; // async response
  }
  // The tab moved to a page that is not a game (store sites change pages without reloading).
  if (msg?.type === 'clear') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      chrome.storage.session.remove(`tab:${tabId}`);
      chrome.action.setBadgeText({ tabId, text: '' });
      chrome.action.setTitle({ tabId, title: 'Clone Report' });
    }
    return;
  }
  if (msg?.type === 'getApiBase') {
    getApiBase().then(base => sendResponse(base));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(`tab:${tabId}`));
