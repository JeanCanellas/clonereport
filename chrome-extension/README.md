# Clone Report (Chrome extension)

Shows a banner on game store pages when the game is reported on clonereport.com. It works on:

- Steam (`store.steampowered.com/app/...`)
- PlayStation Store (`store.playstation.com/.../concept/...` and `/product/...`)
- Xbox and the Microsoft Store (`xbox.com/.../games/store/...`, `microsoft.com/.../p/...`, `apps.microsoft.com/detail/...`)
- Nintendo eShop (`nintendo.com/.../store/products/...`)
- App Store (`apps.apple.com/.../id<number>`)
- Google Play (`play.google.com/store/apps/details?id=...`)
- itch.io game pages (`<creator>.itch.io/<game>`)

What it shows:

- **Red "Reported as a clone"** banner listing the original game(s), with links to their store pages and the report.
- **Orange "This game has been cloned"** banner listing the reported clones. Games from a different store are labelled with that store.
- Nothing on the page when there are no reports. The toolbar icon still shows status (CLN, a count, or blank) and its popup has a "Report a clone" link.

On Steam the banner sits under the game title. The other stores redraw their pages as you browse, so there it floats in the bottom right corner. Those stores also change pages without reloading, so the extension checks again whenever the address changes.

Manifest V3. `stores.js` (shared with the site) turns the page address into a store and game id. Lookups go through `GET /api/lookup?store=&id=&name=` on the site (Steam still uses `?appid=`), matched by store id first, then exact name, and are cached for 5 minutes. All text from the API is inserted as plain text and only http(s) links are used.

## Try it

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this folder.
2. Until clonereport.com is live, open the extension's **Settings** (right-click the icon > Options) and set the site address to `http://localhost:3000` while running the site with `npm run dev`. Chrome will ask to allow access to localhost.
3. Approve a report in `/admin` whose clone or original link is a store page from the list above, then open that page.

## Publish to the Chrome Web Store

Zip this folder's contents, then upload it at https://chrome.google.com/webstore/devconsole (one-time $5 developer fee). You'll need a privacy policy URL; the extension sends only the store, the game id and the game name of the page you're viewing to clonereport.com and stores nothing else. The store listing will say it can "read and change your data" on the store sites above, because it adds the banner to their pages.
