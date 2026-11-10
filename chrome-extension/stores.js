'use strict';
// Game stores Clone Report understands. Turns a store page link into a
// { store, id } pair so reports can be matched exactly, whatever the store.
//
// This file is shared with the Chrome extension (chrome-extension/stores.js is
// a copy), so it must run both in Node and in a browser with no dependencies.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CloneReportStores = api;
})(typeof self !== 'undefined' ? self : this, () => {
  // Each store: display name, a function that pulls the id out of a URL, and
  // a function that builds a canonical link back from the id.
  const STORES = {
    steam: {
      name: 'Steam',
      parse(u) {
        if (u.hostname !== 'store.steampowered.com') return null;
        const m = /^\/app\/(\d{1,10})(?:\/|$)/.exec(u.pathname);
        return m ? String(Number(m[1])) : null;
      },
      url: (id) => `https://store.steampowered.com/app/${id}/`,
    },
    playstation: {
      name: 'PlayStation Store',
      // https://store.playstation.com/en-us/concept/10000176
      // https://store.playstation.com/en-us/product/UP9000-PPSA01411_00-RATCHETANDCLANK0
      parse(u) {
        if (u.hostname !== 'store.playstation.com') return null;
        const m = /^\/(?:[a-z]{2}-[a-z]{2}\/)?(concept|product)\/([A-Za-z0-9_-]{1,64})(?:\/|$)/i.exec(u.pathname);
        return m ? `${m[1].toLowerCase()}/${m[2].toUpperCase()}` : null;
      },
      url: (id) => `https://store.playstation.com/en-us/${id}`,
    },
    xbox: {
      name: 'Xbox / Microsoft Store',
      // https://www.xbox.com/en-US/games/store/halo-infinite/9PP5G1F153J1
      // https://www.microsoft.com/en-us/p/minecraft/9nblggh2jhxj
      // https://apps.microsoft.com/detail/9nblggh2jhxj
      parse(u) {
        const id = '([A-Za-z0-9]{12})(?:\\/|$)';
        let m = null;
        if (u.hostname === 'www.xbox.com' || u.hostname === 'xbox.com')
          m = new RegExp(`^/(?:[a-z]{2}-[a-z]{2}/)?games/store/[^/]+/${id}`, 'i').exec(u.pathname);
        else if (u.hostname === 'www.microsoft.com')
          m = new RegExp(`^/(?:[a-z]{2}-[a-z]{2}/)?(?:p/[^/]+|store/productid)/${id}`, 'i').exec(u.pathname);
        else if (u.hostname === 'apps.microsoft.com')
          m = new RegExp(`^/(?:store/)?detail/(?:[^/]+/)?${id}`, 'i').exec(u.pathname);
        return m ? m[1].toUpperCase() : null;
      },
      url: (id) => `https://www.xbox.com/en-US/games/store/game/${id}`,
    },
    nintendo: {
      name: 'Nintendo eShop',
      // https://www.nintendo.com/us/store/products/hollow-knight-switch/
      parse(u) {
        if (u.hostname !== 'www.nintendo.com' && u.hostname !== 'nintendo.com') return null;
        const m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?store\/products\/([a-z0-9-]{1,120})(?:\/|$)/i.exec(u.pathname);
        return m ? m[1].toLowerCase() : null;
      },
      url: (id) => `https://www.nintendo.com/us/store/products/${id}/`,
    },
    appstore: {
      name: 'App Store',
      // https://apps.apple.com/us/app/flappy-bird/id642848232
      parse(u) {
        if (u.hostname !== 'apps.apple.com' && u.hostname !== 'itunes.apple.com') return null;
        const m = /\/id(\d{1,12})(?:\/|$)/.exec(u.pathname);
        return m ? String(Number(m[1])) : null;
      },
      url: (id) => `https://apps.apple.com/app/id${id}`,
    },
    googleplay: {
      name: 'Google Play',
      // https://play.google.com/store/apps/details?id=com.dotgears.flappybird
      parse(u) {
        if (u.hostname !== 'play.google.com' || !/^\/store\/apps\/details\/?$/.test(u.pathname)) return null;
        const id = u.searchParams.get('id') || '';
        return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(id) && id.length <= 150 ? id : null;
      },
      url: (id) => `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}`,
    },
    itch: {
      name: 'itch.io',
      // https://maddymakesgames.itch.io/celeste-classic
      parse(u) {
        const h = /^([a-z0-9][a-z0-9-]{0,62})\.itch\.io$/i.exec(u.hostname);
        if (!h || h[1].toLowerCase() === 'www') return null;
        const m = /^\/([a-z0-9][a-z0-9_-]{0,99})\/?$/i.exec(u.pathname);
        return m ? `${h[1]}/${m[1]}`.toLowerCase() : null;
      },
      url: (id) => { const [user, game] = id.split('/'); return `https://${user}.itch.io/${game}`; },
    },
  };

  // Returns { store, id } for a recognised store page link, otherwise null.
  function parseStoreUrl(link) {
    let u;
    try { u = new URL(String(link || '').trim()); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hostname = u.hostname.toLowerCase();
    for (const [store, s] of Object.entries(STORES)) {
      const id = s.parse(u);
      if (id) return { store, id };
    }
    return null;
  }

  const isStore = (key) => Object.prototype.hasOwnProperty.call(STORES, key);
  const storeName = (key) => (isStore(key) ? STORES[key].name : null);
  const storeUrl = (key, id) => (isStore(key) && id ? STORES[key].url(id) : null);
  const storeKeys = () => Object.keys(STORES);

  // Clean up an id that arrives on its own (e.g. ?store=xbox&id=...), the same
  // way parseStoreUrl would have written it. Returns null when it is not valid.
  function normalizeId(key, id) {
    if (!isStore(key) || id == null) return null;
    const url = STORES[key].url(String(id).trim().slice(0, 200));
    const parsed = parseStoreUrl(url);
    return parsed && parsed.store === key ? parsed.id : null;
  }

  return { parseStoreUrl, storeName, storeUrl, storeKeys, isStore, normalizeId };
});
