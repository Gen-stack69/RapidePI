# RAPIDÉ POS-IMS

Till (point of sale) and stock app for small shops in Laos, in **Lao and English**. Vanilla JS + Vite frontend (installable PWA), Supabase (Postgres, Auth, Realtime, Storage) backend.

**Status:** in testing, close to a demo. No shop uses it day to day yet. See `PROJECT.md` for the full picture.

**Online:** all three sites are Cloudflare Workers, rebuilt from GitHub on every push to `master`. They aren't on Cloudflare Pages because Lao Telecom blocks `*.pages.dev`.

| Site | Address | Config |
|---|---|---|
| The app | https://rapidepi.rapidewms.workers.dev/ | `wrangler.jsonc` |
| Cashier site | https://cashier.rapidewms.workers.dev/ | `wrangler.cashier.jsonc` (same build, `VITE_APP_MODE=cashier`) |
| Landing page | https://rapidewms.rapidewms.workers.dev/ | `wrangler.landing.jsonc` |

The Supabase keys for these are build variables in the Cloudflare dashboard, never in this repository: **it is public**.

A demo-mode build (no server; data stays in each visitor's browser) is also published to GitHub Pages by `.github/workflows/pages.yml`, after the tests pass.

## First-time setup

1. Create a free project at https://supabase.com (region: Singapore is closest to Laos).
2. In the Supabase dashboard open **SQL Editor**, paste the whole of `supabase/migrations/001_schema.sql` and run it, then do the same with `002_pos.sql` (the till, expiry dates and product kinds) and `003_offline.sql` (selling with no internet), and so on up to the highest number (today `024_advisor_lints.sql`). Run each file once, in order; a project that already has some only needs the ones after. Never edit a file that has already been run: put a change in a new numbered file.
3. **Project Settings → API**: copy the Project URL and the `anon` public key.
4. Copy `.env.example` to `.env` and paste both values in.
5. `npm install`, then `npm run dev` and open http://localhost:5173.

Optional: **Authentication → Providers → Email** lets you turn "Confirm email" off while testing.

**For password reset to work**, add the app's address to **Authentication → URL Configuration → Redirect URLs** (for example `http://localhost:5173/` while developing, and the deployed address in production). Supabase only honours a `redirectTo` that is on that list; otherwise the reset email sends people to the project's Site URL instead.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server with hot reload |
| `npm run dev:lan` | Dev server over HTTPS on port 5443, so a phone on the same Wi-Fi can use the camera |
| `npm run dev:landing` | Dev server for the landing page |
| `npm run build` | Production build into `dist/` (the app and the cashier site) |
| `npm run build:landing` | Landing page build into `dist-landing/` |
| `npm run test:db` | Runs the schema in an in-memory Postgres and checks shop isolation, stock rules, orders, automation, expiry lots, the till, offline sync, staff and cashier rights, billing and plan limits |
| `npm run check-i18n` | Checks that every text key exists in English, is translated into Lao, is still used, and that no visible text is hardcoded |
| `npm run test:unit` | Tests front-end logic that needs no browser (table paging, backup retention, expiry-date reading, product typing, the offline queue) |
| `npm test` | Runs all three checks, the same as CI |
| `npm run backup` | Backs up the live database to a gzipped file outside this repo |
| `npm run backup:verify` | Restores the newest backup into a throwaway database and checks it |

## How it fits together

- `supabase/migrations/` holds the database. Row-level security keeps every shop's data separate. Stock only changes through `adjust_stock` / `set_stock` / `complete_order` / `create_sale` / `void_sale` / `write_off_lot`, so every change is logged and stock can't go negative. A sale is one transaction with a client-made id, so pressing Charge twice never sells twice.
- Members are **Owner**, **Manager** (`staff` in the database) or **Cashier**. The database decides what each may do; the cashier site only shows less.
- Dated stock lives in `lots` (product + expiry date + qty, and a batch / production number). A delivery with no date but a batch number is its own lot too. Selling takes the soonest in-date lot first, then undated stock, and expired stock last; a void puts units back into the exact lots they came from.
- `src/data/store.js` picks the backend: `remote.js` (Supabase, with realtime refresh between devices) when `.env` has keys, otherwise `local.js` (in-browser demo). Offline work: `queue.js` (what waits to be sent), `cache.js` (IndexedDB: the shop copy and the queue) and `apply.js` (the stock and sale rules, shared by the demo and the offline copy). `delta.js` downloads only what changed since the last sync, not the whole shop. See `PROJECT.md` for the full overview.
- `src/views/` has one file per screen (`admin.js` is the Rapide-only Admin screen). Buttons use `data-act="..."`, handled in `src/main.js`.
- `landing/` is the landing page, built separately with `vite.landing.config.js`.
- `src/lib/` holds escaping, CSV import/export, and PDF/Excel/ZIP export (loaded on demand); `camera.js` (barcode camera with the green box), `expiry.js` (reading dates and GS1 codes), `ocr.js` (reading a date from a photo) and `receipt.js`.
- `src/i18n/` holds the text. `en.js` is the source of truth, `lo.js` the Lao translation; views call `t("key")`, so adding a language means adding one file. Lao is the default for Lao-language browsers. CSV and Excel column headers stay English on purpose, because the importer matches them; PDFs embed a Lao font, so they follow the app language.

## Install it as an app

It's a PWA, so it installs on Windows and Android from the same build — no
separate desktop project, no `.exe` to sign or distribute, and updates arrive by
themselves.

In Chrome or Edge, open the app and use **⬇ Install app** in the header (or the
install icon in the address bar). Afterwards RAPIDÉ POS-IMS is in the Start menu or
on the home screen, with its own icon and window.

**What works with no internet:** the app opens, the Lao font renders and the
barcode scanner runs (the service worker precaches them). A real Supabase shop
opens from the copy each device keeps, and the till, voids, stock in/out and
expiry write-offs keep working. The header says **Offline – data from 10:42**
and how much is **waiting to send**.

**When the network returns**, each device sends what it did, one piece at a
time, in the order it happened, and the server files each sale, stock change and
void at the time it really happened, so history from every till lines up. Every
piece carries an id from the device, so sending twice changes nothing.

- **Receipt numbers work offline:** each device registers once as a till (A, B,
  C…) the first time it opens the shop online, and numbers its own receipts
  A-0001, A-0002…, so two tills offline together never print the same number.
- **A sale made offline is never refused for stock.** The customer already left
  with the goods. If another till sold the last units meanwhile, the sale is
  kept, stock goes below zero, and the dashboard's **Check** list asks for a
  recount. Sales at an old price, and tills with a wrong clock, show there too.
  Online sales are still refused below zero.
- **Anything else the server refuses** (the plan ran out, the product was
  deleted) goes to the Check list with Retry and Discard, never silently lost.
- **Still online only:** adding or editing products, orders, settings, import.
- **Keep it installed:** iPhone Safari may clear a website's data after a week
  unused, which would lose unsent work; an installed app is kept. Let a device
  send everything before clearing the browser or swapping phones.

The export libraries (Excel, PDF, ZIP — about 1.4 MB) are left out of the
precache on purpose and cached the first time they're used, so installing over a
phone connection stays small.

## Backups

Supabase's free plan includes no backups at all, so until you run this the only
copy of a shop's data is the live database.

```
npm run backup          # writes ../rapidewms-backups/rapide-pos-ims-<timestamp>.ndjson.gz
npm run backup:verify   # restores the newest one and checks it holds together
```

It needs `SUPABASE_DB_URL` in `.env` (see `.env.example`). Take the **session
pooler** URI from the dashboard under **Connect → Direct**, not the direct
connection: direct connections are IPv6-only unless you pay for the IPv4 add-on.

The whole dump is read in one repeatable-read snapshot, so a sale landing
mid-backup can't leave stock and history disagreeing. Backups are written
*outside* the repository on purpose — this repo is public, and for the same
reason they must never go into a GitHub Actions artifact.

`backup:verify` is the part that matters: it builds a fresh database from
`supabase/migrations`, replays the backup with every foreign key and constraint
enforced, and re-derives each product's stock from its movement history. It
refuses a file that was cut short, and fails if the numbers don't add up. Run it
now and again — a backup nobody has restored is only a hope.

To take one every day:

```
powershell -ExecutionPolicy Bypass -File scripts\schedule-backup.ps1
```

That registers a daily Windows task (no admin rights needed; add `-WhatIf` to
see what it would do first). It doubles as a keep-alive: free Supabase projects
pause after about a week of inactivity, and a paused project is a shop that
cannot sell. If the machine will be off for longer than that, run a backup
before you go.

Kept: every backup for a fortnight, then one a week for ten weeks, one a month
for a year, and one a year for ever — corruption often surfaces weeks later, and
Lao tax invoices must be kept for ten years.

## Billing

New shops get a 14-day trial (`shops.plan_until`). To pay, the owner opens **Shop & backup → Subscription**, pays Rapide's bank QR (amount and reference filled in), and taps **I've paid** with a screenshot of the transfer. A Rapide admin approves it on the **Admin** screen and the shop is extended at once.

Make an account an admin once, in the SQL Editor:

```sql
insert into platform_admins (user_id) select id from auth.users where email = 'you@example.com';
```

Then set Rapide's bank QR on the Admin screen.

Each plan limits tills, products, staff and product photos:

| Plan | Tills | Products | Staff | Photos |
|---|---|---|---|---|
| Trial | 2 | 2,000 | 3 | 500 |
| Small shop | 1 | 2,000 | 3 | 500 |
| Minimart | 4 | 10,000 | 10 | 3,000 |

The manual way still works, in the SQL Editor:

```sql
update shops set plan = 'paid', plan_until = now() + interval '1 month', max_tills = 4 where name = 'Shop name';
```

Expired shops can still view and export their data but cannot change it.
