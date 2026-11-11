# clonereport.com

Anyone can report that a game was cloned. Visitors search a game name and find the original.

- **Stack:** Node.js 22.13+ with its built-in SQLite. No npm dependencies.
- **Database:** one SQLite file (`data/clonereport.db` by default). The app creates it and its tables on first start. Open it with any SQLite viewer (e.g. DB Browser for SQLite) to inspect or edit reports.
- **Moderation:** every report starts as *pending* and only appears publicly after approval at `/admin` (password protected).
- **Spam protection:** hidden honeypot field, signed form token with a minimum fill time, per-IP rate limit (5/hour by default), link validation, length limits. IPs are stored only as salted hashes.

## Run locally

```sh
npm run dev        # http://localhost:3000, admin password "admin"
npm test
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSWORD` | *(none: admin disabled)* | Password for `/admin` (any username) |
| `SECRET` | random per start | Signs form tokens and hashes IPs. Set a long random value in production. |
| `DB_PATH` | `./data/clonereport.db` | SQLite file location (put it on a persistent disk) |
| `PUBLIC_URL` | from request | e.g. `https://clonereport.com`, used in API links |
| `TRUST_PROXY` | off | Set to `1` behind Render/Railway/Fly so the real visitor IP is used |
| `MAX_PER_HOUR` | `5` | Reports allowed per IP per hour |
| `MIN_FILL_MS` | `4000` | Minimum time between loading and submitting the form |
| `SEED_ORIGINALS` | on | Set to `0` to skip loading `seed/originals.json` at start |
| `CHROME_STORE_URL` | *(none)* | Chrome Web Store listing for the extension; until set, `/extension` offers the zip and install steps |
| `STEAM_SCAN` | on | Set to `0` to turn off both daily scans |
| `CLASSIC_SCAN` | on | Set to `0` to turn off only the classic console scan |
| `STEAM_SCAN_TARGET` | `25000` | The scanners stop adding once the list has this many games |
| `STEAM_SCAN_STAGES` | `1000:80,300:80,100:75` | Steam filter stages: min reviews : min % positive |
| `CLASSIC_SCAN_STAGES` | `20,10,5` | Classic filter stages: min Wikipedia languages |
| `SCANNER_USER_AGENT` | generic | How the scanners identify themselves to Wikidata |

## Original games list

`seed/originals.json` lists well-known games from Steam and the Nintendo eShop that are originals, not clones (name, developer, publisher, Steam app id and/or Nintendo eShop link; facts only, no store art). The server loads it into the `originals` table on every start, updating existing rows and never duplicating them, so a redeploy is all it takes to publish changes to the list. Set `SEED_ORIGINALS=0` to skip loading it.

### Scanners

Two scanners grow the list on their own. About a minute after the server starts, and then once a day, they run one after the other until the list holds 25,000 games (`STEAM_SCAN_TARGET`).

**Classic consoles (`classic.js`)** asks Wikidata, the structured data behind Wikipedia, for games on 24 consoles from the Atari 2600 and NES to the PS3, Wii U and handhelds. A game qualifies if it has an English Wikipedia article plus articles in several other languages (a sign it is well known), and is not marked as "based on" or "inspired by" another video game (this filters out remakes, ports and known copies). The most famous go in first: 20+ languages, then 10+, then 5+ (`CLASSIC_SCAN_STAGES`). A game on several consoles gets one entry listing all of them. It takes a few minutes. Wikimedia asks automated clients to identify themselves, so set `SCANNER_USER_AGENT` to something like `MySiteScanner/1.0 (https://example.com; you@example.com)`.

**Steam (`scanner.js`)** reads Steam's own store search (games only, 100 per page), which shows each game's review score, and adds games that are well reviewed and not software tools; developer and publisher come from each game's store details. It starts strict and loosens in steps once those run out (`STEAM_SCAN_STAGES`, default `1000:80,300:80,100:75`, meaning at least 1,000 reviews and 80% positive, then 300 and 80%, then 100 and 75%). Each game is checked in detail once, and requests are spaced out (and back off if Steam says "too many requests"), so a full run can take most of a day; later runs are quicker. If it stops, the reason shows on `/admin/originals`.

Both skip games an admin removed and games an approved report names as clones. Run them by hand with `npm run scan` (Steam) or `npm run scan:classic`.

Admins manage the list at `/admin/originals`: find a game and remove it. A removed game stays off for good (neither the scanner nor the seed file adds it back), and approving a clone report removes the clone from the list automatically.

Each game gets a page at `/game/:id` marked "Not a clone", shows up in search, and is listed at `/originals` (filter with `?store=steam` or `?store=nintendo`). `/api/lookup` returns it as `verifiedOriginal`.

## Pages

- `/` search + recently added, `/extension` (Chrome extension download), `/search?q=`, `/report/:id`, `/game/:id`, `/originals`, `/submit`, `/admin`, `/admin/originals`
- `GET /api/lookup?appid=<steam app id>&name=<game name>` or `GET /api/lookup?store=<store>&id=<store id>&name=<game name>` JSON lookup (used by the browser extension).

## Supported stores

`stores.js` recognises store page links for **Steam, PlayStation Store, Xbox / Microsoft Store, Nintendo eShop, App Store, Google Play and itch.io**. When a report links to one of them, the store and the game's id there are saved with the report, so:

- `/api/lookup?store=xbox&id=9PP5G1F153J1` (or `playstation` + `concept/10000176`, `appstore` + `642848232`, `googleplay` + `com.example.game`, `itch` + `user/game`, `nintendo` + `hollow-knight-switch`) matches it exactly. Entries in the answer carry `store`, `storeName` and `storeId`.
- Pasting a store link into search lists the reports about that page.
- The report page names the store, and the platform is filled in from the clone's link when the reporter leaves it empty.

Reports saved before this change get their store ids filled in from their links on the next start.

## Chrome extension

`chrome-extension/` is the Clone Report browser extension. It shows a banner on game pages of every store above. The site recommends it on the home, report and game pages and has an install page at `/extension`, which serves `/extension/clone-report-extension.zip` (zipped from `chrome-extension/` when the server starts, so it always matches the code). Once the extension is on the Chrome Web Store, set `CHROME_STORE_URL` to its listing and the page shows an "Add to Chrome" button instead of the install steps. Its `stores.js` must stay identical to the site's (a test checks this). See `chrome-extension/README.md`.

## Deploy

Any host that runs Node 22 with a persistent disk works. `render.yaml` sets up Render (web service + 1 GB disk); a `Dockerfile` is included for Fly.io, Railway or a VPS. Then point the clonereport.com DNS at the host.
