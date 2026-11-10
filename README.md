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
| `STEAM_SCAN` | on | Set to `0` to turn off the daily Steam scan |
| `STEAM_SCAN_TARGET` | `5000` | The scanner stops adding once the list has this many games |
| `STEAM_SCAN_MIN_REVIEWS` | `1000` | Minimum Steam reviews for a game to be added |
| `STEAM_SCAN_MIN_POSITIVE` | `80` | Minimum percent of positive reviews |

## Original games list

`seed/originals.json` lists well-known games from Steam and the Nintendo eShop that are originals, not clones (name, developer, publisher, Steam app id and/or Nintendo eShop link; facts only, no store art). The server loads it into the `originals` table on every start, updating existing rows and never duplicating them, so a redeploy is all it takes to publish changes to the list. Set `SEED_ORIGINALS=0` to skip loading it.

### Steam scanner

`scanner.js` grows the list on its own. About a minute after the server starts, and then once a day, it walks SteamSpy's list of Steam games (most-owned first) and adds games that are very unlikely to be clones: at least 1,000 reviews, at least 80% positive, not a software tool, not removed by an admin, and not the clone in an approved report. It stops once the list holds 5,000 games and only checks each Steam app once, so later runs pick up new games quickly. It respects SteamSpy's rate limits, so the first full run takes about an hour and a half. Run one pass by hand with `npm run scan`.

Admins manage the list at `/admin/originals`: find a game and remove it. A removed game stays off for good (neither the scanner nor the seed file adds it back), and approving a clone report removes the clone from the list automatically.

Each game gets a page at `/game/:id` marked "Not a clone", shows up in search, and is listed at `/originals` (filter with `?store=steam` or `?store=nintendo`). `/api/lookup` returns it as `verifiedOriginal`.

## Pages

- `/` search + recently added, `/search?q=`, `/report/:id`, `/game/:id`, `/originals`, `/submit`, `/admin`, `/admin/originals`
- `GET /api/lookup?appid=<steam app id>&name=<game name>` JSON lookup (used by the browser extension). Steam app ids are taken automatically from `store.steampowered.com/app/<id>` links in reports.

## Deploy

Any host that runs Node 22 with a persistent disk works. `render.yaml` sets up Render (web service + 1 GB disk); a `Dockerfile` is included for Fly.io, Railway or a VPS. Then point the clonereport.com DNS at the host.
