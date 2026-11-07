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

## Pages

- `/` search + recently added, `/search?q=`, `/report/:id`, `/submit`, `/admin`
- `GET /api/lookup?appid=<steam app id>&name=<game name>` JSON lookup (used by the browser extension). Steam app ids are taken automatically from `store.steampowered.com/app/<id>` links in reports.

## Deploy

Any host that runs Node 22 with a persistent disk works. `render.yaml` sets up Render (web service + 1 GB disk); a `Dockerfile` is included for Fly.io, Railway or a VPS. Then point the clonereport.com DNS at the host.
