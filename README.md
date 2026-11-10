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
| `MAX_VOTES_PER_HOUR` | `100` | Community votes allowed per IP per hour |
| `API_PER_MINUTE` | `120` | Public API requests allowed per IP per minute |
| `RESEND_API_KEY` | *(none: email alerts off)* | API key from [Resend](https://resend.com), used to send alert emails |
| `ALERT_FROM` | *(none)* | Sender for alert emails, e.g. `Clone Report <alerts@clonereport.com>` (the domain must be verified in Resend) |
| `STEAM_ENRICH` | on | Set to `0` to stop filling release dates, images and developers from Steam when a report is approved |
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

## Comparisons and community votes

Each report page (`/report/:id`) is a side-by-side comparison of the original and the clone: images, developers, release dates, platform, store links, and a list of the mechanics they share. Reporters can fill these in on the submit form; admins can change any of them at `/admin/:id/edit`. When a report with Steam links is approved, missing release dates, header images and developers are filled in from Steam's store API (it never overwrites what is already there).

Visitors vote on each approved report: **Clone**, **Inspired by** or **Original**. Each visitor (by salted IP hash) has one vote per report and can change it. The **clone score** is the share of votes saying "clone", with "inspired by" counting half. After 3 votes the report shows a verdict: *Likely a clone* (67% or more), *Inspired by* (34–66%) or *Likely original* (33% or less). The verdict shows on the report page and on report cards in search and on the home page.

## Moderation tools

- **Evidence links.** Reporters can add up to 8 links (comparison videos, articles, screenshots), one per line. They show under "Evidence" on the report page, and admins can change them at `/admin/:id/edit`.
- **Disputes.** Every approved report has a "Dispute this report" link (`/report/:id/dispute`) for the developers involved. They give their name, role, a private email, an explanation and optional links. Disputes land in `/admin/disputes`, where a moderator can **publish** the developer's message as a response next to the report, **dismiss** it, or reopen it. To take a report down, reject it from the Reports tab. Disputes use the same spam protection as the submit form.
- **Edit history.** `/report/:id/history` lists every change to a report: submitted, approved or rejected, edited by a moderator (field by field, old and new values), filled in from Steam, disputes received and responses published. It never shows contact emails or IP hashes. Changes made before this feature was added are not listed.

## Public API and alerts

`/api` documents a free, read-only JSON API (CORS open, cached 5 minutes, 120 requests per minute per IP). Only approved reports are exposed, never contact details.

- `GET /api/v1/games?appid=&name=`: one game's clone status (`reported-clone`, `verified-original`, `cloned-by-others`, `unknown`) with reports both ways and its clone score
- `GET /api/v1/reports?q=&developer=&since_id=&limit=&offset=` and `GET /api/v1/reports/:id`
- `GET /api/v1/developers/:key` and `GET /api/v1/tree?game=`

The older `/api/lookup` used by the browser extension is unchanged.

**RSS:** `/feed.xml` (every newly approved report), `/feed.xml?game=<name>` (clones of one game) and `/feed.xml?dev=<key>` (one developer).

**Email alerts:** each game and report page links to `/follow?game=<name>`. Visitors enter an email, confirm it from a link (double opt-in), and then get one email each time a clone of that game is approved for the first time. Every email has an unsubscribe link. Emails go out through [Resend](https://resend.com): set `RESEND_API_KEY` and `ALERT_FROM` to turn them on. Without them, the follow page offers the RSS feed only.

## Developer pages and family trees

`/dev/:key` gathers every approved report about one studio: games it was reported to have cloned, its games that others cloned, and its original games. Developer names are matched loosely ("Copycat Studios, Inc." and "copycat studios inc" are the same page). A studio with 3 or more games reported as clones gets a "repeat reports" note. `/developers` ranks studios by reports.

`/tree?game=<name>` shows a game's family tree: what it copies (and what that copied, up the chain) and what copied it (and their clones), built from approved reports. Games are matched by Steam app id when known, otherwise by name.

## Pages

- `/` search + recently added, `/search?q=`, `/report/:id` (comparison and votes), `POST /report/:id/vote`, `/admin/:id/edit`, `/follow?game=`, `/feed.xml`, `/api`, `/api/v1/…`, `/report/:id/history`, `/report/:id/dispute`, `/admin/disputes`, `/dev/:key`, `/developers`, `/tree?game=`, `/game/:id`, `/originals`, `/submit`, `/admin`, `/admin/originals`
- `GET /api/lookup?appid=<steam app id>&name=<game name>` JSON lookup (used by the browser extension). Steam app ids are taken automatically from `store.steampowered.com/app/<id>` links in reports.

## Deploy

Any host that runs Node 22 with a persistent disk works. `render.yaml` sets up Render (web service + 1 GB disk); a `Dockerfile` is included for Fly.io, Railway or a VPS. Then point the clonereport.com DNS at the host.
