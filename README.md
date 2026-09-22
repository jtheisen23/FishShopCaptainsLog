# Fish Shop Captain's Log

A digital version of the shift card your managers run the restaurant from. It's
a web app built for a phone in an apron pocket or a tablet on the office desk —
no app store, no install, just a URL you sign into.

Every check records **who** ticked it and **when**. Anything worth remembering
gets a note or a flag, and the whole shift lands in the next manager's inbox as
a recap when the shift closes.

## What it does

- **The full shift card**, in order: Daily Admin → Before Open → Open →
  Pre-Peak → Peak → Post-Peak → Transition. All four Deck Walks are called out
  where they fall.
- **Who and when on every check** — no more "I thought someone did the line check".
- **Notes and flags on any item.** A flag means *the next manager needs to see
  this*; flagged items lead the recap.
- **A running log** of the shift, built automatically from every action, plus
  free-text entries for anything off-card ("lost power for 6 minutes at 7:10").
- **Shared across devices.** Anyone signed in sees the same live card — the
  opener's tablet and the closer's phone are looking at one shift, and the
  screen refreshes itself while it's open.
- **Emailed shift recap** with the summary, what was flagged, what wasn't
  finished, every note, and the timeline.
- **Shift history** for any location and date range.
- Works in daylight and in dark mode, and prints cleanly if you want it on paper.

## Getting it running locally

Requires **Node 22 or newer**. You do *not* need to install a database — with
no `DATABASE_URL` set, the app runs PostgreSQL embedded in the process.

```bash
npm install
npm run seed              # creates your first admin account
npm start                 # http://localhost:3000
```

`npm run seed` prompts for an email, name and password, or takes them from the
environment:

```bash
SEED_ADMIN_EMAIL=gm@fishshop.com \
SEED_ADMIN_NAME="Gina Marsh" \
SEED_ADMIN_PASSWORD='pick-something-long' npm run seed
```

Sign in as that admin, then add your managers and staff under **Menu → Team &
settings**. Each person gets a temporary password and is made to choose their
own the first time they sign in.

That runs on one machine. To put it in front of staff on their own phones, see
[Deploying](#deploying) below.

## Configuration

Everything lives in `.env` (see `.env.example` for the annotated list).

| Setting | What it's for |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. **Set this in production.** Unset locally to use the embedded database. Check it with `npm run check-db`. |
| `PGLITE_DIR` | Where the embedded database keeps its files. Default `./data/pgdata`. |
| `PORT` | Port to listen on. Default `3000`. |
| `APP_URL` | Public URL, used for the link inside recap emails. |
| `TIMEZONE` | Restaurant time. Business dates and every displayed time use it. Default `America/Los_Angeles`. |
| `SECURE_COOKIES` | Leave `true` when serving over HTTPS. |
| `TRUST_PROXY` | `true` behind a load balancer or reverse proxy. |
| `SMTP_*`, `MAIL_FROM` | Outbound email for recaps. |
| `SEED_ADMIN_*` | Creates the first admin at startup when the database has no accounts. For hosts without free shell access. |
| `SEED_ADMIN_RESET` | `true` resets that admin's password instead of creating an account — the way back in if you're locked out. Clear it afterwards. |

Locations, shift types (AM/PM/Mid/…) and the default recap recipients are
edited in the app under **Team & settings → Shop**, not in `.env`.

### Email

Recaps go out over plain SMTP, so anything works — SendGrid, Mailgun, Postmark,
Google Workspace. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and
`MAIL_FROM`, restart, then use **Test the email connection** in Settings to
confirm the credentials before you rely on it.

Without SMTP configured the app still runs — managers just can't email a recap.
The recap is always readable in the app and at `/api/shifts/:id/recap.html`.

## Who can do what

| | Staff | Manager | Admin |
| --- | :-: | :-: | :-: |
| Open a shift, check items, add notes and flags | ● | ● | ● |
| Close a shift, reopen one, send a recap | | ● | ● |
| Add and remove people, edit locations and settings | | | ● |

A closed shift is read-only — that's what makes the recap trustworthy. If
something needs fixing after the fact, a manager reopens it, and the reopen is
recorded in the log.

## Changing the checklist

The card lives in [`src/template.js`](src/template.js) as plain data. Edit an
item's `label` any time. Adding, removing or re-keying items means bumping
`TEMPLATE_VERSION` in the same file.

One rule: **never reuse or rename an existing item `key`.** Completed checks are
stored against those keys, so a rename silently rewrites history. New item, new
key.

## Deploying

The app keeps nothing on disk, so it runs on free hosting. Two pieces: somewhere
to run Node, and a Postgres database.

### 1. Create the database

Sign up at [Supabase](https://supabase.com) or [Neon](https://neon.tech) — both
have free tiers that don't expire — create a project, and copy its connection
string. Everything the restaurant logs lives here. The app creates its own
tables on first start; there is nothing to set up by hand, no SQL to run, and
no schema to design in their dashboard.

> Render's own free Postgres expires after 30 days, which is why this points
> elsewhere. A paid Render database works fine too if you'd rather keep it all
> in one place.

**On Supabase**, the connection string is under **Project Settings → Database →
Connection string**, and it offers more than one. Use the **Session pooler**
(or the Transaction pooler); both have been tested against this app.

Avoid **Direct connection**: Supabase serves it over IPv6 only, and many hosts —
Render included — make outbound connections over IPv4, so it fails with a
confusing "could not connect" rather than anything about IPv6.

The string looks like this, and the `[YOUR-PASSWORD]` placeholder is literal —
replace it with the database password you set when creating the project (reset
it on that same page if you've lost it):

```
postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-us-west-1.pooler.supabase.com:5432/postgres
```

Only four characters need percent-encoding, because they're the separators the
URL format itself uses: `@` → `%40`, `:` → `%3A`, `/` → `%2F`, `#` → `%23`.
Everything else — `$`, `!`, `*`, `-`, `_`, `.` — passes through as-is.

If your provider already shows the password encoded (`$` as `%24`, say), leave
it alone. Encoding it a second time turns `%24` into `%2524` and authentication
fails. When in doubt, reset the password to letters and numbers only.

Connecting your Supabase project to GitHub is unrelated to any of this; that
feature creates preview databases per branch. It does no harm, but the
connection string is the only thing this app needs.

**Check the string before you deploy** — it's much easier to fix here than in
a failing deploy:

```bash
DATABASE_URL='postgresql://…' npm run check-db
```

It connects, reports what it found, and names the likely cause when it can't:
an IPv6-only host, a password that needs percent-encoding, a placeholder left
in, a typo'd hostname. It never prints your password.

### 2. Deploy the app

The repo carries a [`render.yaml`](render.yaml) blueprint, so this is mostly
click-through.

1. Render dashboard → **New → Blueprint** → pick this repository.
2. It asks for the values it can't guess. Paste your connection string into
   `DATABASE_URL`, put anything in `APP_URL` for now, and leave the `SMTP_*`
   and `MAIL_FROM` boxes blank if you don't have email credentials yet.
3. When the first deploy finishes, Render shows the service's URL. Put that
   into `APP_URL` and save — recap emails link back to it.
4. Create your admin login. If your plan includes shell access, open the
   **Shell** tab and run `npm run seed`. Otherwise do it with environment
   variables — add these three, save, and the app creates the account as it
   restarts:

   ```
   SEED_ADMIN_EMAIL=you@fishshop.com
   SEED_ADMIN_NAME=Your Name
   SEED_ADMIN_PASSWORD=pick-a-good-one
   ```

   The deploy log will confirm: `Created the first admin account: …`. It only
   fires when there are no accounts at all, so it can't overwrite anyone.
   **Remove `SEED_ADMIN_PASSWORD` once you've signed in** — no reason to leave
   a password in a dashboard.

### Locked out?

If you lose the admin password and have no other admin to reset it for you, add
`SEED_ADMIN_RESET=true` alongside `SEED_ADMIN_EMAIL` and a new
`SEED_ADMIN_PASSWORD`, and save. On restart that account's password becomes the
one you set, its admin access is restored, and every existing session for it is
signed out. Remove all three variables afterwards.

This is no weaker than the deployment already is — anyone who can edit these
variables could already repoint the app at a different database — but it is
worth clearing once you're back in.
5. Sign in at your Render URL and add your team.
6. Fill in the `SMTP_*` values whenever you're ready for emailed recaps, then
   use **Test the email connection** in Settings.

### What free costs you

A free Render instance **sleeps after a stretch with no traffic**, and the next
person to open it waits roughly a minute while it wakes up. A free Postgres
database suspends when idle too, adding a second or two on top. Once it's awake
everything runs at normal speed.

For a manager opening the app at the start of a shift, that wait is usually
fine. If it becomes annoying, the fixes in increasing order of cost are:

- Point a free uptime monitor at `/api/health` every few minutes to keep the
  instance awake. Check your host's terms first.
- Move the web service to Render's paid instance type, which never sleeps.

Nothing about the app changes in either case.

### Hosting it somewhere else

Nothing here is Render-specific beyond `render.yaml`. Anything that runs Node
and can reach Postgres works — Railway, Fly.io, or a box in the office. Set
`DATABASE_URL`, `APP_URL`, `SECURE_COOKIES=true` and `TRUST_PROXY=true`, and
serve it over HTTPS: staff type passwords into it over restaurant wifi.

Because the data lives in Postgres rather than on the instance, you can run
more than one copy behind a load balancer if you ever need to.

## Backups

Your database provider keeps its own backups — Neon and Supabase both do — but
it costs nothing to keep your own copy:

```bash
npm run export                  # → ./backups/captains-log-YYYY-MM-DD.json
npm run export /tmp/mine.json   # or a path you choose
```

That writes every shift, check, note and log entry to one JSON file. Password
hashes and session tokens are deliberately left out.

## Tests

```bash
npm test                      # embedded Postgres; no setup, no server needed
scripts/test-postgres.sh      # the same suite against a real Postgres server
```

41 tests covering the API, roles and permissions, the closed-shift rule, recap
contents and HTML escaping, concurrent edits from two devices, multi-device
sign-in, the admin bootstrap and recovery paths, and real SMTP delivery against
a fake mail server.

The second command is the one that proves the production path — the network
driver, connection pooling and transactions — rather than the embedded engine.
Point it at any server with `PGURL=postgres://…`, including a connection pooler:
the suite has been run against PgBouncer in transaction mode, which is how
Supabase serves connections.

## How it's built

No build step and no framework — the browser gets the files as they are on disk.

```
src/
  server.js        Express app, startup and error handling
  config.js        .env loading and settings
  db.js            Postgres access, schema, settings, the event log
  auth.js          scrypt passwords, sessions, roles
  template.js      THE CHECKLIST — edit this to change the card
  shifts.js        Shifts, checks, notes, flags, business dates
  recap.js         Recap as text and as HTML email
  mail.js          SMTP
  routes/          auth · shifts · admin
public/            The client: index.html, app.js, styles.css
scripts/           seed · check-db · export · test-postgres
test/              API, concurrency and email integration tests
```

One SQL dialect, two ways of reaching it: `pg` against a real server in
production, and [PGlite](https://pglite.dev) — genuine Postgres compiled to
WebAssembly — in development and tests, so there's nothing to install to work
on this. `src/db.js` picks between them based on whether `DATABASE_URL` is set.

Dependencies: `express`, `nodemailer`, `pg`, `@electric-sql/pglite`.
