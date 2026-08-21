# tmwork-schedule-sync

Pulls your work schedule from TeamWork / ScheduleSource (tmwork.net) and
publishes it as an ICS calendar feed you can subscribe to from Outlook (or
any calendar app that supports "subscribe from URL").

It runs on a schedule via GitHub Actions, fetches shifts (today, +7 days,
+14 days, each a `range=month` call), dedupes them by `Id`, converts them
to ICS events, and pushes the result to a GitHub Gist. The three calls
heavily overlap now that each pulls a full month, but that's harmless
since results are deduped by `Id` — it just means comfortably more
lookahead than the ~21 days the offsets alone would suggest. If anything
fails — most commonly expired auth — it sends you a push notification via
[ntfy.sh](https://ntfy.sh) so you know to fix it.

tmwork's `emplist` endpoint requires two things from your logged-in
browser session: a `Cookie` header and an `X-Api-Token` header. Both are
captured from dev tools together (step 6) and both are treated as a single
credential pair that expires and gets refreshed together — see "About
auth expiring" below. When either expires, the workflow logs back into
tmwork on its own and refreshes both automatically — see the same section
for exactly what that means and the risk tradeoffs involved.

> **Heads up: the Gist is public-but-unlisted, not private.** GitHub
> "secret" gists are unlisted (not searchable, not shown on your profile)
> but anyone with the raw URL can view them — that's what makes them
> subscribable from Outlook without auth. Only shift times, locations, and
> notes go into it. Don't add anything more sensitive.

## Setup

Do these in order.

### 1. Create the placeholder Gist

Go to [gist.github.com](https://gist.github.com), create a **new secret
gist**:

- Filename: `job1-schedule.ics`
- Content: anything as a placeholder, e.g.:
  ```
  BEGIN:VCALENDAR
  VERSION:2.0
  END:VCALENDAR
  ```
- Click **Create secret gist**.

Copy the Gist ID from the URL — it's the long hex string after your
username, e.g. `https://gist.github.com/yourname/abc123...` → `abc123...`.
You'll need it as `GIST_ID`.

### 2. Create a fine-grained GitHub PAT scoped to just that gist

1. Go to **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens** ([direct link](https://github.com/settings/personal-access-tokens/new)).
2. Give it a name like `tmwork-sync-gist`.
3. Set an expiration (GitHub will require you to rotate it eventually —
   that's fine, this repo isn't set up to auto-renew it).
4. Under **Resource owner**, pick yourself.
5. Under permissions, find **Gists** and set it to **Read and write**.
   Fine-grained PATs don't let you scope to a single gist ID directly, but
   this keeps the token limited to the Gists API only — it can't touch your
   repos, issues, etc.
6. Generate the token and save it somewhere — you'll paste it into a repo
   secret next (`GIST_TOKEN`) and won't be able to view it again.

### 3. Create a fine-grained GitHub PAT scoped to Actions secrets

This one lets the workflow rewrite `TMWORK_COOKIE` on its own when tmwork's
session expires. It's more powerful than the gist token (it can read/write
*any* Actions secret in this repo), which is why it gets its own token
instead of reusing `GIST_TOKEN` — see "About auth expiring" below for why
that tradeoff exists at all before you create this.

1. Go to **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens** ([direct link](https://github.com/settings/personal-access-tokens/new)).
2. Name it `tmwork-sync-secrets-admin`, set an expiration.
3. **Resource owner**: yourself.
4. **Repository access**: **Only select repositories** → pick this repo
   specifically. Do not leave it at "All repositories."
5. Under **Repository permissions**, find **Secrets** and set it to
   **Read and write**. Leave everything else at "No access."
6. Generate the token and save it — you'll paste it into `SECRETS_ADMIN_TOKEN`
   in step 5.

### 4. Install ntfy and pick an obscure topic

1. Install the [ntfy Android app](https://play.store) (also available on
   iOS, or use the web app at ntfy.sh) from the Play Store / App Store.
2. Pick a topic name that's hard to guess — ntfy topics are public by
   topic name, so anyone who knows it can read/post to it. Something like
   `khatri-tmwork-sync-x7q2p` works well. This is your `NTFY_TOPIC` value.
3. In the app, subscribe to that exact topic name.
4. Sanity check it works:
   ```bash
   curl -d "test notification" ntfy.sh/your-topic-name
   ```
   You should see it land on your phone.

### 5. Add the 9 secrets to the repo

In this repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add:

| Secret name           | Value                                          |
| ---------------------- | ------------------------------------------------ |
| `TMWORK_COOKIE`        | See step 6 below                                |
| `TMWORK_API_TOKEN`     | See step 6 below                                |
| `TMWORK_CODE`          | The "Code" you normally use to sign in to tmwork |
| `TMWORK_USER`          | Your tmwork username                            |
| `TMWORK_PASSWORD`      | Your tmwork password                            |
| `GIST_ID`              | The Gist ID from step 1                         |
| `GIST_TOKEN`           | The fine-grained PAT from step 2                |
| `SECRETS_ADMIN_TOKEN`  | The fine-grained PAT from step 3                |
| `NTFY_TOPIC`           | The topic name from step 4                      |

`TMWORK_CODE`/`TMWORK_USER`/`TMWORK_PASSWORD` are only ever used by the
`refresh-auth` job to log back into tmwork when the session expires — the
regular sync job never sees them.

### 6. Get `TMWORK_COOKIE` and `TMWORK_API_TOKEN` from browser dev tools

The `emplist` endpoint requires both a session cookie *and* an
`X-Api-Token` request header — grab both from the same request:

1. Log in to tmwork.net normally in your browser and open your schedule.
2. Open dev tools (F12 or Cmd+Option+I) → **Network** tab.
3. Reload the page, or navigate to trigger a schedule fetch.
4. Find the request to `emplist` (filter by "emplist" if needed).
5. Click it → **Headers** → scroll to **Request Headers**.
6. Copy the *entire* value of the **Cookie** header (it'll be a long
   string of `name=value; name2=value2; ...` pairs) → paste as
   `TMWORK_COOKIE`.
7. Copy the value of the **X-Api-Token** header → paste as
   `TMWORK_API_TOKEN`.

Both represent your logged-in session, so treat them like passwords —
they're already GitHub Actions secrets, which is the right place for
them. You'll only need to do this manually once at initial setup — after
that, the workflow refreshes `TMWORK_COOKIE` on its own (see "About auth
expiring" below).

### 7. Trigger the workflow manually to verify it works

Go to **Actions → Sync tmwork schedule → Run workflow**. Watch the run:

- If it succeeds, the Gist should now contain real ICS data — open the
  Gist and check the file content.
- If it fails, check the logs. If it's an auth failure, a `refresh-auth`
  job should kick off right after — check that it succeeds and that the
  next `sync` run (or a manual re-run) picks up the new cookie.

### 8. Subscribe from Outlook

Use this URL format (raw Gist URL, filename included):

```
https://gist.githubusercontent.com/{username}/{gist_id}/raw/job1-schedule.ics
```

In Outlook: **Add calendar → Subscribe from web**, paste that URL. Outlook
polls subscribed calendars periodically (interval isn't fully under your
control, typically every few hours), which pairs fine with this repo's
4-hour sync schedule.

## About auth expiring

Both the tmwork session cookie **and** `X-Api-Token` **will** expire at
some point — the exact interval isn't documented and may vary. **This is
expected, not a bug.** (Earlier drafts of this README assumed the api
token was static; testing showed otherwise — an old token paired with a
freshly logged-in cookie still gets a 401, so it's minted per login just
like the cookie.)

### It self-heals in CI

When `sync` gets a 401/403, it exits with a specific code that triggers a
second job, `refresh-auth` (see `.github/workflows/sync.yml`), which:

1. Logs into tmwork.net directly over HTTP using the `TMWORK_CODE` /
   `TMWORK_USER` / `TMWORK_PASSWORD` secrets (same request the login page
   itself makes — no headless browser).
2. Extracts the fresh api token from a global `APP.Token = "..."`
   assignment embedded in the post-login `/emp/` page.
3. Validates the new cookie + api token pair against the emplist API.
4. Pushes both to the `TMWORK_COOKIE` and `TMWORK_API_TOKEN` secrets via
   `gh secret set`, authenticated with `SECRETS_ADMIN_TOKEN`.
5. Immediately retries `sync` in the same job run, using the fresh values
   directly (not by re-reading the secrets — GitHub resolves `secrets.*`
   once at job start, so just-updated secrets wouldn't be visible yet to a
   later step in that same job anyway). This closes the gap that would
   otherwise leave the Gist stale for up to 4 hours waiting on the next
   scheduled run — if refresh succeeds, the calendar is caught up within
   the same run, not the next cron tick.

You still get an ntfy push for the original expiry, and a second one
specifically if the refresh and/or the retry fails (wrong password,
tmwork's login flow changed, etc.) — that's your signal something needs a
manual look.

**Know what this trades away before you rely on it:** `SECRETS_ADMIN_TOKEN`
can read/write every secret in this repo (there's no way to scope a PAT to
a single secret name), and `TMWORK_PASSWORD` — your actual password, not a
revocable session artifact — now sits in Actions secrets and flows through
a job that runs `npm install` six times a day. A compromised dependency in
that job could exfiltrate everything in one shot, and CI runner IPs are
also more likely than your home network to get flagged by tmwork's own
bot/rate-limit defenses. This repo has no access to anything beyond its own
secrets, which caps the blast radius, but it's still a meaningfully bigger
attack surface than a plain read-only sync. If that tradeoff stops being
worth it, disable/delete the `refresh-auth` job and fall back to one of the
options below.

### Fallback: `npm run refresh-auth` (local)

Same login flow, run from your own machine on demand instead of
automatically in CI — keeps your password off GitHub entirely.

```bash
cp .env.local.example .env.local
```

Fill in `.env.local` with `TMWORK_CODE`, `TMWORK_USER`, and
`TMWORK_PASSWORD`. This file is gitignored and never committed — it stays
on your machine, but treat it like a password vault since your tmwork
password sits in it in plaintext. Then, whenever needed:

```bash
npm run refresh-auth
```

Requires the [GitHub CLI](https://cli.github.com) installed and logged in
locally (`gh auth login`) with permission to write this repo's secrets.

### Fallback: manual, from dev tools

If none of the above is set up, or tmwork changes its login flow enough
to break `refresh-auth`:

1. Repeat step 6 above to grab a fresh cookie and API token from dev tools.
2. Update both secrets in **Settings → Secrets and variables → Actions**.

No code changes needed in any of these paths — the ntfy alert *is* the
refresh signal, one way or another.

## Local development

```bash
npm install
TMWORK_COOKIE="..." TMWORK_API_TOKEN="..." GIST_ID="..." GIST_TOKEN="..." NTFY_TOPIC="..." npx tsx src/sync.ts
```

## How it works

- `src/sync.ts` — the sync script. Fetches 3 overlapping `range=month`
  windows of shifts, dedupes by `Id`, builds an ICS file, PATCHes it to
  the Gist, and notifies via ntfy on any failure. Exits 2 specifically for
  an expired-cookie failure, 1 for anything else.
- `scripts/refresh-auth.ts` — the re-auth helper (see "About auth
  expiring" above). Runs either locally (`npm run refresh-auth`, reading
  `.env.local`) or as a CI job (reading repo secrets) — same code, same
  login flow, different credential source and different `gh`-authenticated
  identity pushing the result.
- `.github/workflows/sync.yml` — two jobs: `sync` runs every 4 hours plus
  on-demand via `workflow_dispatch`; `refresh-auth` runs only when `sync`
  exits with code 2, pushes a fresh `TMWORK_COOKIE`, and immediately
  retries `sync` in the same job so the Gist doesn't sit stale until the
  next scheduled run.
- Event times are written as floating local time (no `TZID`), matching the
  timestamps tmwork returns as-is.
