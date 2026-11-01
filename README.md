# Guest House Portal

Client-facing inventory and occupancy dashboard for corporate guest houses managed by **Zuna Travel Solutions**.
Signed-in users see live occupancy, a room rack, night-wise availability, the booking register (with gender and
single/double occupancy checks) and guest-house details, and can download colour-coded PDF and Excel reports.

Production today: Cloudflare Worker `ltmgh` + Cloudflare D1 database, served at **https://gh.zuna.ai**
(the older host ltmgh.zuna.ai redirects there). The same build also runs on any server with Node.js 22 or Docker.

---

## Contents

1. [How it works](#how-it-works)
2. [Repository layout](#repository-layout)
3. [Build](#build)
4. [Deploy option A: Cloudflare Workers + D1](#deploy-option-a-cloudflare-workers--d1)
5. [Deploy option B: own server (Node.js or Docker)](#deploy-option-b-own-server-nodejs-or-docker)
6. [Configuration](#configuration)
7. [Data feed format](#data-feed-format)
8. [User accounts](#user-accounts)
9. [Security](#security)
10. [Testing](#testing)

---

## How it works

```
Browser ──HTTPS──> app (Cloudflare Worker, or server/server.mjs on Node)
                    ├─ GET  /              login page, or the dashboard when signed in
                    ├─ POST /api/login     email/user ID + password  → HttpOnly session cookie
                    ├─ POST /api/forgot    e-mails a 6-digit reset code (optional, needs RESEND_API_KEY)
                    ├─ POST /api/reset     code + new password
                    └─ GET  /logout
                   database (D1 or SQLite): datasets · users · sessions · resets
```

* The whole UI (login page, dashboard, splash screen, PDF/Excel generators) is compiled into **one file**,
  `worker.js` (plus an identical `worker.mjs`). Only the chart library is loaded from a CDN
  (`cdn.jsdelivr.net/npm/apexcharts@3.54.1`).
* Dashboard data is read from the `datasets` table on every page load and injected into the page.
  A separate hourly job (run by Zuna) refreshes that table from operator confirmations,
  vouchers and travel requests. See [Data feed format](#data-feed-format).
* Every number on the dashboard is computed in the browser from those three datasets; there is no
  other backend.
* An open dashboard reloads itself every 10 minutes (quietly, keeping the current page) so new data
  appears without a manual refresh.

## Repository layout

| Path | Purpose |
|---|---|
| `src.html` | Dashboard page source (Tailwind classes + vanilla JS). Placeholders are filled by `build.py`. |
| `export_app.js` | Client-side PDF and XLSX report generators (no libraries). |
| `login_form.html`, `gen_login.py` | Login form markup/script and the generator that assembles the login page. |
| `globe.js`, `dots.json` | Animated dotted globe on the login page. |
| `splash.html` | Branded loading screen shown after sign-in. |
| `worker_src.js` | Server logic: auth, sessions, password reset, page serving, security headers. |
| `build.py` | Builds everything into `worker.js` / `worker.mjs` (and local preview pages). |
| `input.css`, `tailwind.config.js` | Styles (brand colours: indigo `#12005A`, green `#02C988`). |
| `assets/`, `icons.json` | Logos (base64) and the icon set. |
| `server/server.mjs` | Self-hosted HTTP server that runs the same app on Node.js with SQLite. |
| `server/db.mjs` | SQLite adapter with the same API as Cloudflare D1, plus the schema. |
| `server/admin.mjs` | Admin CLI for self-hosting: load data, apply SQL, list/disable users. |
| `tools/make_users.py` | Creates accounts / resets passwords (generates passwords + SQL). |
| `data/` | **Sample** data (fictional guests) for local preview and tests. |
| `test/smoke.mjs`, `test/schema.sql` | Automated end-to-end test and its sample database. |
| `Dockerfile`, `.env.example`, `wrangler.toml.example` | Deployment templates. |

## Build

Requirements: **Node.js 22.13+** and **Python 3.9+** (build only).

```bash
npm ci
npm run build        # -> worker.js, worker.mjs, preview.html (sample data), login_page.html
npm test             # 21 end-to-end checks, no network needed
```

Open `preview.html` in a browser to see the dashboard with the sample data (no server needed).

## Deploy option A: Cloudflare Workers + D1

1. Create a D1 database and a Worker; bind the database to the Worker as **`DB`**.
2. Create the tables once (D1 console):
   ```sql
   CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, salt TEXT, hash TEXT, active INTEGER DEFAULT 1, failed INTEGER DEFAULT 0, locked_until TEXT, last_login TEXT);
   CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, email TEXT, expires TEXT, created TEXT);
   ```
   (`resets` is created automatically on first use.)
3. `npm run build`, then either paste `worker.js` into **Workers & Pages → (worker) → Edit code → Deploy**, or copy
   `wrangler.toml.example` to `wrangler.toml`, set the database id and run `npx wrangler deploy`.
4. Add the custom domain under **Settings → Domains & Routes**.
   **Automatic deploys:** `.github/workflows/deploy.yml` builds, tests and deploys on every push to `main` once the
   repository has secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_D1_DATABASE_ID` and the variable
   `CF_DEPLOY=true` (optional `CF_WORKER_NAME`, `CF_DOMAIN`). Worker secrets and dashboard variables are kept.
5. Optional settings under **Settings → Variables and Secrets**: `RESEND_API_KEY` (secret), `MAIL_FROM`, `PRIMARY_HOST`.

## Deploy option B: own server (Node.js or Docker)

The app listens on plain HTTP; **terminate HTTPS at a reverse proxy** (nginx, IIS ARR, a cloud load balancer) that
forwards `Host` and `X-Forwarded-Proto`. Session cookies are `Secure`, so the site must be reached over HTTPS.

### Docker

```bash
cp .env.example .env                      # edit values
docker build -t guesthouse-portal .       # also runs the test suite
docker run -d --name guesthouse -p 8080:8080 -v ghdata:/data --env-file .env --restart unless-stopped guesthouse-portal

# load data and create users inside the container
docker cp data/. guesthouse:/tmp/data/
docker exec guesthouse node server/admin.mjs load-data /tmp/data/ltm_gh_bookings.csv /tmp/data/ltm_gh_properties.csv /tmp/data/ltm_gh_period.json
python3 tools/make_users.py people.csv && docker cp accounts_out/users.sql guesthouse:/tmp/users.sql
docker exec guesthouse node server/admin.mjs apply-sql /tmp/users.sql
```

The SQLite database lives on the `/data` volume; back up `ltmgh.sqlite` from it.

### Plain Node.js (systemd, PM2, Windows service…)

```bash
npm ci && npm run build
cp .env.example .env    # or set the variables in your service manager
npm run admin -- load-data data/ltm_gh_bookings.csv data/ltm_gh_properties.csv data/ltm_gh_period.json
npm start               # listens on $PORT (default 8080)
```

Example nginx site:

```nginx
server {
  listen 443 ssl http2;
  server_name gh.example.com;
  # ssl_certificate ... ; ssl_certificate_key ... ;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Configuration

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `DB` | Cloudflare binding | – | D1 database |
| `DB_PATH` | self-hosted | `./var/ltmgh.sqlite` | SQLite file (created automatically with all tables) |
| `PORT`, `HOST` | self-hosted | `8080`, `0.0.0.0` | Listen address |
| `RESEND_API_KEY` | both (secret) | empty | Enables "Forgot password" e-mails through resend.com. Without it the reset screen asks users to contact the Zuna Hotel Desk. |
| `MAIL_FROM` | both | `Zuna Hotel Desk <noreply@zuna.ai>` | Sender of reset e-mails (domain must be verified in Resend). |
| `PRIMARY_HOST` | both | empty | Canonical host; other `*.zuna.ai` hosts answering for the app 301-redirect to it. |
| `VOUCHER_TOKEN` | both (secret) | empty | Enables `POST /api/vouchers` (see below). Long random string shared with the mail job. |
| `TRUST_PROXY` | self-hosted | `1` | Use `X-Forwarded-Proto` / `X-Forwarded-Host` from the proxy. |
| `INSECURE_COOKIES` | self-hosted | `0` | `1` drops the `Secure` cookie flag for plain-HTTP testing only. |

## Data feed format

Table `datasets(id, json, updated_at)` holds three rows. `json` is a JSON **array of objects whose values are all
strings**; `updated_at` is `YYYY-MM-DD`.

**`bookings`**: one object per guest stay

| Key | Example | Notes |
|---|---|---|
| `property` | `My Home Bhooja` | Must match a `properties[].property` |
| `guest` | `Mr. Arjun Mehta` | Title (Mr/Ms/Mrs/Miss) is used for gender when `gender` is empty |
| `grade`, `base` | `E1`, `Bengaluru` | `Not stated` if unknown |
| `check_in`, `check_out` | `2026-11-03` | `check_out` is the departure date (not a night) |
| `nights` | `1` | |
| `room` | `1001-101` or `Not assigned` | Two guests with the same room on overlapping nights = shared room |
| `status` | `Confirmed` or `Not available` | `Not available` = request declined by the property |
| `concur_tr`, `note` | `SAMPLE07`, free text | |
| `gender` | `Male` / `Female` / `Not stated` | Optional |
| `occupancy` | `Single` / `Double` | Optional; `Double` is also inferred from a shared room |

A male and a female guest sharing a room on the same night is flagged everywhere (Overview banner, room rack,
booking register, detail panels and exports). Double occupancy is allowed only for two male or two female guests.

**`properties`**: `property, city, address, rooms, room_nos (e.g. "1001-101 to 1001-104"), eligible, operator,
status (Live / Coming soon), poc_name, poc_phone, poc_email`.

**`period`**: `[{"from": "2026-10-27", "to": "2026-12-31"}]`, the reporting window.

Self-hosted: load CSV/JSON files with `npm run admin -- load-data <bookings.csv> <properties.csv> <period.json>`
(see `data/` for the exact columns), or write the rows directly with any SQLite client.

## Admin panel (multi-client)

`/admin` is available to users with `role = 'admin'` (Zuna staff). It manages:

* **Clients**: name, logo (PNG/JPG/WEBP, resized in the browser), grade list, active flag.
* **Guest houses** per client: name, country, state, city, address (with address lookup), Google Maps link, operator, Live / Coming soon,
  room types (rooms, room numbers, bed type, occupancy Single / Double, eligible grades), inclusions, amenities,
  cancellation policy, photos, contacts (name, designation, email, phone), and per-section **show to client**
  switches (amenities, inclusions, cancellation policy, photos, contacts).
* **Users** per client: create (a password is generated and shown once), reset password, disable / enable.
* **Documents** per guest house: agreements, licences, NOCs etc. (PDF or image, max 1.4 MB) with number, issue and
  expiry dates, a reminder window and a "visible to client" switch. A daily job (Cloudflare cron `30 2 * * *`, or every
  6 hours on the self-hosted server) e-mails Zuna admins and the client's admins when a document reaches its reminder
  window, 7 days, 1 day and the expiry date, then weekly for four weeks after expiry (needs `RESEND_API_KEY`).
* **Weekly GH report** (dashboard → Room rack or Bookings → *Weekly GH report*): an Excel file in the client's weekly
  format for any range of nights (default: last Monday–Sunday): one column per room bed, guest names per night, bed and
  room occupancy with totals, and the master guest list. "Guest Circle Name" comes from the client's *Company name in
  reports* (Client settings).
* **Roles**: client users are *Viewers* or *Client admins*. Client admins get **Users & access** (`/manage`) in their
  dashboard, where they add users, reset passwords, disable users and change roles for their own client only.
* **Bookings** per client: add, edit and cancel stays (guest, title/gender, grade, base, dates, room, occupancy,
  status, travel request, note), with warnings for room clashes and mixed-gender sharing. Saves update the
  `bookings` dataset at once and are also kept in the `manual` dataset, which any external feed should apply last;
  a `manual` row with status `Cancelled` means that stay (same guest + check-in) is removed.

Client users (`role = 'client'`, `client_id` set) see only their client's guest houses and bookings, with their logo.
Images are stored in table `files` (base64) and served at `/files/<id>` only to the owning client's users and admins.
Tables: `clients`, `guesthouses`, `room_types`, `contacts`, `photos`, `files` (created automatically); `users` gains
`role` and `client_id`. Once at least one client exists, guest-house details come from these tables instead of the
`properties` dataset, and bookings are matched to guest houses by name.

## Voucher intake

Operators e-mail a confirmation voucher (PDF) for each booking. A small mail job (Google Apps Script, every 10 minutes)
posts each new voucher to `POST /api/vouchers` with `Authorization: Bearer <VOUCHER_TOKEN>`:

```json
{"known": ["<key>", "..."]}                       // → {"known": [keys already stored]}
{"key": "<msgId>#<n>", "received": "2026-10-30 13:36", "from": "...", "subject": "...", "file": "x.pdf", "pdf": "<base64>"}
```

The app extracts the PDF's text itself (no external service: Flate/ASCII85/Hex streams, object streams, ToUnicode
font maps) and stores it in table `vouchers` (`key, received_ist, sender, subject, file, guest, room_guess,
occupancy_guess, text, pdf, created, applied`). If the voucher names a guest, arrival date and room number that match a
confirmed booking whose room is not yet assigned, the room is written to the bookings dataset straight away (so the
dashboard shows it within one auto-refresh). It is **not** applied when it would put 3+ guests in a room, put two
single-occupancy guests together, create mixed-gender sharing, or when the voucher's Mr/Ms contradicts the booking;
the reason is stored in `applied`. `{"reapply": true}` re-checks stored vouchers that were not applied yet.
The hourly data feed also reads the table and applies the same rules.
Scanned (image-only) PDFs have no text layer and are stored with empty text.

## User accounts

```bash
# people.csv: columns email,name  (optional: password). A plain user ID instead of an e-mail also works.
python3 tools/make_users.py people.csv        # -> accounts_out/users.sql, credentials.csv, users.json
```

* Apply `users.sql` (Cloudflare D1 console, or `npm run admin -- apply-sql accounts_out/users.sql`).
* Share each password from `credentials.csv` privately, then delete the file. `accounts_out/` is git-ignored.
* Re-running for an existing e-mail resets that password and unlocks the account.
* Disable / enable: `UPDATE users SET active = 0 WHERE email = '…'` (self-hosted: `npm run admin -- disable <email>`).
* Users can reset their own password ("Forgot password?") when `RESEND_API_KEY` is configured.

## Security

* Passwords: PBKDF2-SHA256 with a per-user random salt (10,000 iterations, chosen for the Cloudflare Workers CPU
  limit; on self-hosted servers this can be raised in `worker_src.js` (`ITER`), but every password then has to be reset).
* Sessions: random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie; only its SHA-256 is stored.
  12 hours, or 30 days with "Keep me signed in". Logout and password reset delete the sessions.
* Brute force: 5 wrong passwords lock the account for 15 minutes. Unknown accounts get the same answer and timing.
* Password reset: 6-digit e-mailed code, valid 15 minutes, 5 attempts, one e-mail per minute; new passwords need
  10+ characters with letters and numbers. The forgot endpoint never reveals whether an account exists.
* API: JSON-only POSTs, same-origin check on `Origin`.
* Headers: Content-Security-Policy, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`,
  Permissions-Policy, COOP, `Cache-Control: no-store`, `X-Robots-Tag: noindex`.
* No guest data is stored in this repository; `data/` and `test/schema.sql` contain fictional sample records.

## Testing

```bash
npm run build && npm test
```

`test/smoke.mjs` runs the built app against an in-memory database and checks login, lockout, cookies, security
headers, the dashboard, the password-reset flow (with a stubbed mail service), logout and the host redirect.

---

© Zuna Travel Solutions. All rights reserved. Proprietary and confidential.
