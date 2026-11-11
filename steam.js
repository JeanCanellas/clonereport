'use strict';
// Fills in comparison details (release date, header image, developer) from Steam's
// public store API when a report is approved. Best effort: failures are ignored.
// Set STEAM_ENRICH=0 to turn it off.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Steam dates look like "21 Feb, 2017", "Feb 21, 2017", "Feb 2017", "2017" or "Coming soon".
function parseSteamDate(s) {
  s = String(s || '').trim();
  let m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]*,? (\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /^([A-Za-z]{3})[a-z]* (\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}`;
  m = /^(\d{4})$/.exec(s);
  return m ? m[1] : null;
}

async function appDetails(appid, fetchImpl = fetch) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic,release_date,developers`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'clonereport/1.0' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const d = (await res.json())?.[appid];
  if (!d?.success || !d.data) return null;
  const img = String(d.data.header_image || '');
  return {
    released: parseSteamDate(d.data.release_date?.date),
    image: /^https:\/\/[a-z0-9.-]+\.steamstatic\.com\//i.test(img) ? img.slice(0, 500) : null,
    developer: Array.isArray(d.data.developers) && d.data.developers[0] ? String(d.data.developers[0]).slice(0, 120) : null,
  };
}

// Returns the fields to fill for a report, looked up from Steam for each side with an app id.
async function comparisonFor(r, fetchImpl = fetch) {
  const out = {};
  for (const side of ['clone', 'original']) {
    const appid = r[side + '_steam_appid'];
    if (!appid) continue;
    try {
      const d = await appDetails(appid, fetchImpl);
      if (!d) continue;
      out[side + '_released'] = d.released;
      out[side + '_image'] = d.image;
      out[side + '_developer'] = d.developer;
    } catch { /* Steam unreachable: leave the fields empty */ }
  }
  return out;
}

module.exports = { parseSteamDate, appDetails, comparisonFor };
