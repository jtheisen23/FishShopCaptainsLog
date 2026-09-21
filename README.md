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

## Getting it running

Requires **Node 22.5 or newer** (it uses Node's built-in SQLite — there's no
database server to install and nothing to compile).

```bash
npm install
cp .env.example .env      # then edit it — see below
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

That gets it running on one machine. To put it in front of staff on their own
phones, see [Deploying to Render](#deploying-to-render) below.

## Configuration

Everything lives in `.env` (see `.env.example` for the annotated list).

| Setting | What it's for |
| --- | --- |
| `PORT` | Port to listen on. Default `3000`. |
| `DB_PATH` | Where the SQLite file lives. **Put this on a persistent disk.** |
| `APP_URL` | Public URL, used for the link inside recap emails. |
| `TIMEZONE` | Restaurant time. Business dates and every displayed time use it. Default `America/Los_Angeles`. |
| `SECURE_COOKIES` | Leave `true` when serving over HTTPS. |
| `TRUST_PROXY` | `true` behind a load balancer or reverse proxy. |
| `SMTP_*`, `MAIL_FROM` | Outbound email for recaps. |

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

## Deploying to Render

The repo carries a [`render.yaml`](render.yaml) blueprint, so most of this is
click-through.

1. **Create the service.** In the Render dashboard: **New → Blueprint**, pick
   this repository, and let it read `render.yaml`. It will ask you for the
   values it can't guess — leave the `SMTP_*` and `MAIL_FROM` boxes blank for
   now if you don't have email credentials yet, and put anything in `APP_URL`;
   you'll correct it in step 2.
2. **Set `APP_URL`.** Once the first deploy finishes, Render shows you the
   service's URL (something like `https://fish-shop-captains-log.onrender.com`).
   Put that in the `APP_URL` environment variable and save — recap emails link
   back to it, so it needs to be right.
3. **Create your first login.** Open the **Shell** tab on the service and run:

   ```bash
   npm run seed
   ```

   It asks for an email, name and password. That account is an admin; everyone
   else you add from inside the app under **Team & settings**.
4. **Sign in** at your Render URL and add your managers and staff.
5. **Add email when you're ready** by filling in `SMTP_HOST`, `SMTP_PORT`,
   `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`. After it restarts, use **Test the
   email connection** in Settings to confirm it before a manager relies on it.

### Two things not to change

- **Keep it on one instance.** Every shift lives in a single SQLite file, which
  allows one writer. Scaling to two instances would corrupt data, so the
  blueprint pins `numInstances: 1`.
- **Keep the disk.** `DB_PATH` points at `/var/data` on the attached disk. A
  free Render instance can't have a disk, which is why the blueprint asks for a
  paid one — on a diskless service, every deploy would silently start you over
  with an empty database.

### Backups

The whole system is one file. From the Render shell:

```bash
npm run backup                     # → /var/backups/captains-log-YYYY-MM-DD.db
npm run backup /var/data/copy.db   # or a path you choose
```

This uses SQLite's online-backup, which is the safe way to copy a database the
app is still writing to — a plain `cp` can catch it mid-write and produce a file
that won't open. Write the copy somewhere on the disk, download it, or add a
Render cron job to push it off-box.

To restore, stop the service, replace the file at `DB_PATH` with your backup,
and start it again.

### Hosting it somewhere else

Nothing here is Render-specific beyond `render.yaml`. Any host that runs Node
works — Railway, Fly.io, or a machine in the office. The same two rules apply:
`DB_PATH` on storage that survives restarts, and one instance only.

## Tests

```bash
npm test
```

27 tests covering the API, roles and permissions, the closed-shift rule, recap
contents and HTML escaping, plus real SMTP delivery against a fake mail server.

## How it's built

No build step and no framework — the browser gets the files as they are on disk.

```
src/
  server.js        Express app and error handling
  config.js        .env loading and settings
  db.js            SQLite schema, settings, the event log
  auth.js          scrypt passwords, sessions, roles
  template.js      THE CHECKLIST — edit this to change the card
  shifts.js        Shifts, checks, notes, flags, business dates
  recap.js         Recap as text and as HTML email
  mail.js          SMTP
  routes/          auth · shifts · admin
public/            The client: index.html, app.js, styles.css
test/              API and email integration tests
```

Dependencies: `express` and `nodemailer`. That's the whole list.
